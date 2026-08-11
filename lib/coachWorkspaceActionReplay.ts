import { materialSignatureFromAdjustment } from '@/lib/coachWorkspaceState';

export interface ActionReplayBoundary<Interaction, Recommendation> {
  lockRecommendation(): Promise<Recommendation | null>;
  findReplay(): Promise<Interaction | null>;
  assertReplay(interaction: Interaction): void;
  assertEligible(recommendation: Recommendation): void;
}

interface PersistedActionOccurrence {
  recommendationId: string;
  action: string;
  adjustment: unknown;
}

interface SubmittedActionOccurrence {
  recommendationId: string;
  action: string;
  adjustment?: unknown;
  materialSignature: string;
}

export interface RecommendationMutationBoundary<Context, Recommendation> {
  transaction<Result>(operation: (context: Context) => Promise<Result>): Promise<Result>;
  lockRecommendation(context: Context): Promise<Recommendation | null>;
}

/** Holds one recommendation lock for the complete mutation transaction. */
export async function withLockedRecommendationMutation<Context, Recommendation, Result>(
  boundary: RecommendationMutationBoundary<Context, Recommendation>,
  mutation: (context: Context, recommendation: Recommendation) => Promise<Result>,
): Promise<Result> {
  return boundary.transaction(async context => {
    const recommendation = await boundary.lockRecommendation(context);
    if (!recommendation) throw new Error('Recommendation not found.');
    return mutation(context, recommendation);
  });
}

function adjustmentPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(
    ['timeMinutes', 'durationMinutes', 'intensity']
      .filter(key => Object.hasOwn(raw, key))
      .map(key => [key, raw[key]]),
  );
}

/** Rejects reuse of an idempotency key for any different action occurrence. */
export function assertReplayMatchesSubmission(
  existing: PersistedActionOccurrence,
  submitted: SubmittedActionOccurrence,
): void {
  const matches = existing.recommendationId === submitted.recommendationId
    && existing.action === submitted.action
    && materialSignatureFromAdjustment(existing.adjustment) === submitted.materialSignature
    && JSON.stringify(adjustmentPayload(existing.adjustment)) === JSON.stringify(adjustmentPayload(submitted.adjustment));
  if (!matches) throw new Error('actionId was already used with a different payload.');
}

export function assertCurrentMaterialSignature(current: string, submitted: string): void {
  if (current !== submitted) throw new Error('Stale Coach Workspace card.');
}

/** Ensures an already-committed idempotent action wins over current eligibility. */
export async function resolveReplayBeforeEligibility<Interaction, Recommendation>(
  boundary: ActionReplayBoundary<Interaction, Recommendation>,
): Promise<
  | { replay: Interaction; recommendation: null }
  | { replay: null; recommendation: Recommendation }
> {
  const recommendation = await boundary.lockRecommendation();
  if (!recommendation) throw new Error('Recommendation not found.');
  const replay = await boundary.findReplay();
  if (replay) {
    boundary.assertReplay(replay);
    return { replay, recommendation: null };
  }

  boundary.assertEligible(recommendation);
  return { replay: null, recommendation };
}
