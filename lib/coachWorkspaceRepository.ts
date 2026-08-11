import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import {
  createDailyRecommendation,
  applyActionAdjustment,
  type ActionAdjustment,
  type CoachWorkspaceAction,
  type CoachMetric,
  type DailyRecommendation,
  type DailyRecommendationInput,
} from '@/lib/coachWorkspace';
import { getCalibration } from '@/lib/brain/baselines';
import { applySkipPlanMutation } from '@/lib/coachWorkspaceSkip';
import { resolveReplayBeforeEligibility } from '@/lib/coachWorkspaceActionReplay';
import { hydrationInteractionPredicate } from '@/lib/coachWorkspaceQueries';
import {
  adjustmentWithMaterialSignature,
  assertActionAllowedForRecommendation,
  deriveCoachWorkspaceState,
  materialSignatureFromAdjustment,
  shouldMutatePlanForAction,
  type CoachWorkspaceState,
  type HydrationAction,
  type HydrationInteraction,
} from '@/lib/coachWorkspaceState';

const METRICS = ['hrv_sdnn', 'resting_hr', 'sleep_minutes'] as const;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function baselineMean(row: typeof schema.baselines.$inferSelect | undefined): number | null {
  const stats = row?.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
  return numberOrNull((stats as Record<string, unknown>).mean30);
}

function metricInput(
  metric: typeof METRICS[number],
  metricRows: Array<typeof schema.daily_metrics.$inferSelect>,
  baselineRows: Array<typeof schema.baselines.$inferSelect>,
): CoachMetric {
  const row = metricRows.find(candidate => candidate.metric === metric);
  const baseline = baselineRows.find(candidate => candidate.metric === metric);
  return { value: row?.value ?? null, baseline: baselineMean(baseline), observedAt: row?.updated_at ?? null };
}

/** Reads the only allowed inputs to the deterministic workspace selector. */
export async function loadDailyRecommendationInput(
  userId: string,
  localDay: string,
  now: Date,
): Promise<DailyRecommendationInput> {
  const [metricRows, baselineRows, constraintRows, calibration] = await Promise.all([
    db.select().from(schema.daily_metrics).where(and(
      eq(schema.daily_metrics.user_id, userId),
      eq(schema.daily_metrics.date, localDay),
      inArray(schema.daily_metrics.metric, METRICS),
    )),
    db.select().from(schema.baselines).where(and(
      eq(schema.baselines.user_id, userId),
      inArray(schema.baselines.metric, METRICS),
    )),
    db.select({ id: schema.nodes.id, type: schema.nodes.type, label: schema.nodes.label })
      .from(schema.nodes)
      .where(and(eq(schema.nodes.user_id, userId), eq(schema.nodes.source, 'confirmed'))),
    getCalibration(userId),
  ]);

  return {
    localDay,
    now,
    calibration,
    metrics: {
      hrv: metricInput('hrv_sdnn', metricRows, baselineRows),
      restingHr: metricInput('resting_hr', metricRows, baselineRows),
      sleep: metricInput('sleep_minutes', metricRows, baselineRows),
    },
    // Only confirmed canonical ontology is permitted to gate a prescription.
    // Do not read filesystem memory, pending facts, or model-generated notes.
    confirmedConstraints: constraintRows.filter(row =>
      ['Allergy', 'Condition', 'Medication', 'Injury'].includes(row.type),
    ),
  };
}

export type PersistedRecommendation = typeof schema.daily_coach_recommendations.$inferSelect;

export async function persistDailyRecommendation(
  userId: string,
  localDay: string,
  recommendation: DailyRecommendation,
): Promise<PersistedRecommendation> {
  // One atomic upsert covers a simultaneous first request. The signature is
  // stable unless the material action/safety state changes, while evidence is
  // intentionally refreshed for every request without creating another row.
  const [persisted] = await db.insert(schema.daily_coach_recommendations).values({
    user_id: userId,
    local_day: localDay,
    category: recommendation.category,
    action: recommendation.action,
    evidence: recommendation.evidence,
    material_signature: recommendation.materialSignature,
  }).onConflictDoUpdate({
    target: [schema.daily_coach_recommendations.user_id, schema.daily_coach_recommendations.local_day],
    set: {
      category: recommendation.category,
      action: recommendation.action,
      evidence: recommendation.evidence,
      material_signature: recommendation.materialSignature,
      updated_at: new Date(),
    },
  }).returning();
  return persisted;
}

export async function createOrLoadDailyRecommendation(userId: string, localDay: string, now: Date): Promise<PersistedRecommendation> {
  const input = await loadDailyRecommendationInput(userId, localDay, now);
  return persistDailyRecommendation(userId, localDay, createDailyRecommendation(input));
}

/** Restores the persisted Coach Workspace state for a recommendation. */
export async function hydrateCoachWorkspaceState(
  userId: string,
  recommendation: PersistedRecommendation,
): Promise<CoachWorkspaceState> {
  if (recommendation.category === 'calibration') {
    return deriveCoachWorkspaceState({
      category: recommendation.category,
      action: recommendation.action,
      materialSignature: recommendation.material_signature,
      userId,
      localDay: recommendation.local_day,
      interactions: [],
      planItem: null,
    });
  }

  const rows = await db.select({
    action: schema.coach_recommendation_interactions.action,
    adjustment: schema.coach_recommendation_interactions.adjustment,
    planItemId: schema.coach_recommendation_interactions.plan_item_id,
    createdAt: schema.coach_recommendation_interactions.created_at,
  }).from(schema.coach_recommendation_interactions)
    .where(hydrationInteractionPredicate(userId, recommendation.id))
    .orderBy(desc(schema.coach_recommendation_interactions.created_at)).limit(50);

  const interactions: HydrationInteraction[] = rows
    .filter(row => ['accept', 'adjust', 'skip', 'complete'].includes(row.action))
    .map(row => ({
      action: row.action as HydrationAction,
      adjustment: row.adjustment,
      planItemId: row.planItemId,
      createdAt: row.createdAt,
      materialSignature: materialSignatureFromAdjustment(row.adjustment),
    }));
  const latestPlanId = interactions.find(interaction => interaction.planItemId != null)?.planItemId ?? null;

  let planItem: { id: string; userId: string; localDay: string; status: string; kind: string } | null = null;
  if (latestPlanId) {
    const [row] = await db.select({
      id: schema.plan_items.id,
      userId: schema.plan_items.user_id,
      localDay: schema.plan_items.local_day,
      status: schema.plan_items.status,
      kind: schema.plan_items.kind,
    }).from(schema.plan_items).where(and(
      eq(schema.plan_items.id, latestPlanId),
      eq(schema.plan_items.user_id, userId),
      eq(schema.plan_items.local_day, recommendation.local_day),
    )).limit(1);
    planItem = row ?? null;
  }

  return deriveCoachWorkspaceState({
    category: recommendation.category,
    action: recommendation.action,
    materialSignature: recommendation.material_signature,
    userId,
    localDay: recommendation.local_day,
    interactions,
    planItem,
  });
}

export type CoachWorkspaceInteractionAction = 'accept' | 'adjust' | 'skip' | 'complete' | 'open_chat';

export interface ApplyCoachActionInput {
  userId: string;
  recommendationId: string;
  actionId: string;
  action: CoachWorkspaceInteractionAction;
  adjustment?: ActionAdjustment;
}

function asPersistedAction(value: unknown): CoachWorkspaceAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recommendation action is invalid.');
  const action = value as Record<string, unknown>;
  if (typeof action.title !== 'string' || typeof action.copy !== 'string'
    || !['move', 'rest', 'sleep', 'other'].includes(String(action.kind))
    || !Number.isInteger(action.timeMinutes)) throw new Error('Recommendation action is invalid.');
  return {
    title: action.title,
    copy: action.copy,
    kind: action.kind as CoachWorkspaceAction['kind'],
    timeMinutes: action.timeMinutes as number,
    durationMinutes: typeof action.durationMinutes === 'number' ? action.durationMinutes : null,
    intensity: action.intensity === 'easy' || action.intensity === 'moderate' ? action.intensity : null,
  };
}

function planSubtitle(action: CoachWorkspaceAction): string {
  const details = [
    action.durationMinutes != null ? `${action.durationMinutes} min` : null,
    action.intensity,
  ].filter(Boolean);
  return details.length > 0 ? `${action.copy} · ${details.join(' · ')}` : action.copy;
}

/**
 * Performs a user action and all required plan mutations in one transaction.
 * A committed idempotent replay is resolved before current recommendation
 * eligibility. A concurrent insert conflict is reloaded after the insert.
 */
export async function applyCoachAction(input: ApplyCoachActionInput): Promise<{
  created: boolean;
  interaction: typeof schema.coach_recommendation_interactions.$inferSelect;
}> {
  return db.transaction(async tx => {
    const resolved = await resolveReplayBeforeEligibility({
      findReplay: async () => {
        const [existing] = await tx.select().from(schema.coach_recommendation_interactions).where(and(
          eq(schema.coach_recommendation_interactions.user_id, input.userId),
          eq(schema.coach_recommendation_interactions.action_id, input.actionId),
        )).limit(1);
        return existing ?? null;
      },
      loadRecommendation: async () => {
        const [recommendation] = await tx.select().from(schema.daily_coach_recommendations).where(and(
          eq(schema.daily_coach_recommendations.id, input.recommendationId),
          eq(schema.daily_coach_recommendations.user_id, input.userId),
        )).limit(1);
        return recommendation ?? null;
      },
      assertEligible: recommendation => {
        assertActionAllowedForRecommendation(recommendation.category, input.action);
      },
    });
    if (resolved.replay) return { created: false, interaction: resolved.replay };
    const recommendation = resolved.recommendation;

    const [inserted] = await tx.insert(schema.coach_recommendation_interactions).values({
      user_id: input.userId,
      recommendation_id: recommendation.id,
      action_id: input.actionId,
      action: input.action,
      adjustment: adjustmentWithMaterialSignature(input.adjustment, recommendation.material_signature),
      plan_item_id: null,
    }).onConflictDoNothing().returning();

    if (!inserted) {
      const [existing] = await tx.select().from(schema.coach_recommendation_interactions).where(and(
        eq(schema.coach_recommendation_interactions.user_id, input.userId),
        eq(schema.coach_recommendation_interactions.action_id, input.actionId),
      )).limit(1);
      if (!existing) throw new Error('Unable to reload idempotent action.');
      return { created: false, interaction: existing };
    }

    if (!shouldMutatePlanForAction(recommendation.category, input.action)) {
      return { created: true, interaction: inserted };
    }

    if (input.action === 'skip') {
      const interaction = await applySkipPlanMutation({
        latestLinkedPlanId: async ({ userId, recommendationId }) => {
          const [link] = await tx.select({ planItemId: schema.coach_recommendation_interactions.plan_item_id })
            .from(schema.coach_recommendation_interactions)
            .where(and(
              eq(schema.coach_recommendation_interactions.recommendation_id, recommendationId),
              eq(schema.coach_recommendation_interactions.user_id, userId),
              isNotNull(schema.coach_recommendation_interactions.plan_item_id),
            )).orderBy(desc(schema.coach_recommendation_interactions.created_at)).limit(1);
          return link?.planItemId ?? null;
        },
        markPlanSkipped: async ({ userId, localDay, planItemId }) => {
          const [updated] = await tx.update(schema.plan_items).set({ status: 'skipped', updated_at: new Date() })
            .where(and(
              eq(schema.plan_items.id, planItemId),
              eq(schema.plan_items.user_id, userId),
              eq(schema.plan_items.local_day, localDay),
            )).returning({ id: schema.plan_items.id });
          return updated != null;
        },
        linkInteraction: async ({ interactionId, planItemId }) => {
          const [linked] = await tx.update(schema.coach_recommendation_interactions).set({ plan_item_id: planItemId })
            .where(eq(schema.coach_recommendation_interactions.id, interactionId)).returning();
          if (!linked) throw new Error('Unable to link skipped plan item.');
          return linked;
        },
      }, {
        userId: input.userId,
        recommendationId: recommendation.id,
        localDay: recommendation.local_day,
        interaction: inserted,
      });
      return { created: true, interaction };
    }

    const baseAction = asPersistedAction(recommendation.action);
    const action = input.action === 'adjust'
      ? applyActionAdjustment(baseAction, input.adjustment ?? {})
      : baseAction;

    const [existingPlanLink] = await tx.select({ planItemId: schema.coach_recommendation_interactions.plan_item_id })
      .from(schema.coach_recommendation_interactions)
      .where(and(
        eq(schema.coach_recommendation_interactions.recommendation_id, recommendation.id),
        eq(schema.coach_recommendation_interactions.user_id, input.userId),
        isNotNull(schema.coach_recommendation_interactions.plan_item_id),
      )).orderBy(desc(schema.coach_recommendation_interactions.created_at)).limit(1);

    let planItemId = existingPlanLink?.planItemId ?? null;
    if (input.action === 'complete') {
      if (!planItemId) throw new Error('No plan item is linked to this recommendation.');
      const [completed] = await tx.update(schema.plan_items).set({ status: 'done', updated_at: new Date() }).where(and(
        eq(schema.plan_items.id, planItemId),
        eq(schema.plan_items.user_id, input.userId),
        eq(schema.plan_items.local_day, recommendation.local_day),
      )).returning();
      if (!completed) throw new Error('Linked plan item not found.');
    } else if (planItemId) {
      const [updated] = await tx.update(schema.plan_items).set({
        time_minutes: action.timeMinutes,
        title: action.title,
        subtitle: planSubtitle(action),
        kind: action.kind,
        status: 'pending',
        updated_at: new Date(),
      }).where(and(
        eq(schema.plan_items.id, planItemId),
        eq(schema.plan_items.user_id, input.userId),
        eq(schema.plan_items.local_day, recommendation.local_day),
      )).returning();
      if (!updated) throw new Error('Linked plan item not found.');
    } else {
      const [planItem] = await tx.insert(schema.plan_items).values({
        user_id: input.userId,
        local_day: recommendation.local_day,
        time_minutes: action.timeMinutes,
        title: action.title,
        subtitle: planSubtitle(action),
        kind: action.kind,
        source: 'coach',
        status: 'pending',
        kcal: null,
      }).returning();
      planItemId = planItem.id;
    }

    const [interaction] = await tx.update(schema.coach_recommendation_interactions).set({ plan_item_id: planItemId })
      .where(eq(schema.coach_recommendation_interactions.id, inserted.id)).returning();
    return { created: true, interaction };
  });
}
