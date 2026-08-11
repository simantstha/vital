export interface ActionReplayBoundary<Interaction, Recommendation> {
  findReplay(): Promise<Interaction | null>;
  loadRecommendation(): Promise<Recommendation | null>;
  assertEligible(recommendation: Recommendation): void;
}

/** Ensures an already-committed idempotent action wins over current eligibility. */
export async function resolveReplayBeforeEligibility<Interaction, Recommendation>(
  boundary: ActionReplayBoundary<Interaction, Recommendation>,
): Promise<
  | { replay: Interaction; recommendation: null }
  | { replay: null; recommendation: Recommendation }
> {
  const replay = await boundary.findReplay();
  if (replay) return { replay, recommendation: null };

  const recommendation = await boundary.loadRecommendation();
  if (!recommendation) throw new Error('Recommendation not found.');
  boundary.assertEligible(recommendation);
  return { replay: null, recommendation };
}
