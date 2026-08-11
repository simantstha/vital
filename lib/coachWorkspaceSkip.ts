export interface SkipPlanMutationBoundary<Interaction> {
  latestLinkedPlanId(input: { userId: string; recommendationId: string }): Promise<string | null>;
  markPlanSkipped(input: { userId: string; localDay: string; planItemId: string }): Promise<boolean>;
  linkInteraction(input: { interactionId: string; planItemId: string }): Promise<Interaction>;
}

/**
 * Applies the plan portion of a skip action. Its caller supplies a transaction
 * boundary, so a failed ownership/day check rolls back the interaction insert.
 */
export async function applySkipPlanMutation<Interaction extends { id: string }>(
  boundary: SkipPlanMutationBoundary<Interaction>,
  input: {
    userId: string;
    recommendationId: string;
    localDay: string;
    interaction: Interaction;
  },
): Promise<Interaction> {
  const planItemId = await boundary.latestLinkedPlanId({
    userId: input.userId,
    recommendationId: input.recommendationId,
  });
  if (!planItemId) return input.interaction;

  const updated = await boundary.markPlanSkipped({
    userId: input.userId,
    localDay: input.localDay,
    planItemId,
  });
  if (!updated) throw new Error('Linked plan item not found.');

  return boundary.linkInteraction({ interactionId: input.interaction.id, planItemId });
}
