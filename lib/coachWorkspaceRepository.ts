import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db';
import {
  createDailyRecommendation,
  type CoachMetric,
  type DailyRecommendation,
  type DailyRecommendationInput,
} from '@/lib/coachWorkspace';
import { getCalibration } from '@/lib/brain/baselines';

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
    db.select({ type: schema.nodes.type, label: schema.nodes.label })
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
  const [existing] = await db.select().from(schema.daily_coach_recommendations).where(and(
    eq(schema.daily_coach_recommendations.user_id, userId),
    eq(schema.daily_coach_recommendations.local_day, localDay),
  )).limit(1);

  if (existing?.material_signature === recommendation.materialSignature) return existing;

  if (existing) {
    const [updated] = await db.update(schema.daily_coach_recommendations).set({
      category: recommendation.category,
      action: recommendation.action,
      evidence: recommendation.evidence,
      material_signature: recommendation.materialSignature,
      updated_at: new Date(),
    }).where(eq(schema.daily_coach_recommendations.id, existing.id)).returning();
    return updated;
  }

  const [inserted] = await db.insert(schema.daily_coach_recommendations).values({
    user_id: userId,
    local_day: localDay,
    category: recommendation.category,
    action: recommendation.action,
    evidence: recommendation.evidence,
    material_signature: recommendation.materialSignature,
  }).returning();
  return inserted;
}

export async function createOrLoadDailyRecommendation(userId: string, localDay: string, now: Date): Promise<PersistedRecommendation> {
  const input = await loadDailyRecommendationInput(userId, localDay, now);
  return persistDailyRecommendation(userId, localDay, createDailyRecommendation(input));
}

export async function findRecommendationForUser(userId: string, recommendationId: string) {
  const [recommendation] = await db.select().from(schema.daily_coach_recommendations).where(and(
    eq(schema.daily_coach_recommendations.id, recommendationId),
    eq(schema.daily_coach_recommendations.user_id, userId),
  )).limit(1);
  return recommendation;
}

export async function findInteractionByActionId(userId: string, actionId: string) {
  const [interaction] = await db.select().from(schema.coach_recommendation_interactions).where(and(
    eq(schema.coach_recommendation_interactions.user_id, userId),
    eq(schema.coach_recommendation_interactions.action_id, actionId),
  )).limit(1);
  return interaction;
}

export async function userPlanItem(userId: string, planItemId: string) {
  const [item] = await db.select().from(schema.plan_items).where(and(
    eq(schema.plan_items.id, planItemId),
    eq(schema.plan_items.user_id, userId),
  )).limit(1);
  return item;
}

export async function createInteraction(input: {
  userId: string;
  recommendationId: string;
  actionId: string;
  action: 'accept' | 'dismiss' | 'complete';
  planItemId: string | null;
}) {
  const [interaction] = await db.insert(schema.coach_recommendation_interactions).values({
    user_id: input.userId,
    recommendation_id: input.recommendationId,
    action_id: input.actionId,
    action: input.action,
    plan_item_id: input.planItemId,
  }).returning();
  return interaction;
}
