import assert from 'node:assert/strict';
import test from 'node:test';
import { applySkipPlanMutation } from './coachWorkspaceSkip';

interface TestInteraction {
  id: string;
  planItemId: string | null;
}

test('skip marks the linked owned same-day plan item skipped and returns its linked interaction', async () => {
  const calls: string[] = [];
  const interaction = await applySkipPlanMutation<TestInteraction>({
    latestLinkedPlanId: async () => 'plan-1',
    markPlanSkipped: async input => {
      calls.push(`skip:${input.planItemId}:${input.localDay}`);
      return true;
    },
    linkInteraction: async input => ({ id: input.interactionId, planItemId: input.planItemId }),
  }, {
    userId: 'user-1', recommendationId: 'recommendation-1', localDay: '2026-08-11',
    interaction: { id: 'interaction-1', planItemId: null },
  });

  assert.deepEqual(interaction, { id: 'interaction-1', planItemId: 'plan-1' });
  assert.deepEqual(calls, ['skip:plan-1:2026-08-11']);
});

test('skip remains planless when no accepted or adjusted plan item is linked', async () => {
  const interaction: TestInteraction = { id: 'interaction-1', planItemId: null };
  const result = await applySkipPlanMutation<TestInteraction>({
    latestLinkedPlanId: async () => null,
    markPlanSkipped: async () => assert.fail('must not mutate a missing plan item'),
    linkInteraction: async () => assert.fail('must not link a missing plan item'),
  }, {
    userId: 'user-1', recommendationId: 'recommendation-1', localDay: '2026-08-11', interaction,
  });

  assert.equal(result, interaction);
});

test('skip fails atomically when the linked plan is not owned for the recommendation local day', async () => {
  await assert.rejects(() => applySkipPlanMutation<TestInteraction>({
    latestLinkedPlanId: async () => 'plan-other-day',
    markPlanSkipped: async () => false,
    linkInteraction: async input => ({ id: input.interactionId, planItemId: input.planItemId }),
  }, {
    userId: 'user-1', recommendationId: 'recommendation-1', localDay: '2026-08-11',
    interaction: { id: 'interaction-1', planItemId: null },
  }), /Linked plan item not found/);
});
