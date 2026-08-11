import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReplayBeforeEligibility } from './coachWorkspaceActionReplay';

test('existing accept, adjust, and complete actions replay unchanged before current eligibility', async () => {
  for (const action of ['accept', 'adjust', 'complete'] as const) {
    const order: string[] = [];
    const interaction = { id: `interaction-${action}`, action, adjustment: { durationMinutes: 30 } };
    const result = await resolveReplayBeforeEligibility({
      findReplay: async () => { order.push('replay'); return interaction; },
      loadRecommendation: async () => { order.push('recommendation'); return { category: 'calibration' }; },
      assertEligible: () => { order.push('eligibility'); throw new Error('not allowed'); },
    });

    assert.equal(result.replay, interaction);
    assert.equal(result.recommendation, null);
    assert.deepEqual(order, ['replay']);
  }
});

test('a new action id loads and validates the current recommendation', async () => {
  const order: string[] = [];
  await assert.rejects(() => resolveReplayBeforeEligibility({
    findReplay: async () => { order.push('replay'); return null; },
    loadRecommendation: async () => { order.push('recommendation'); return { category: 'calibration' }; },
    assertEligible: () => { order.push('eligibility'); throw new Error('accept is not allowed'); },
  }), /not allowed/);
  assert.deepEqual(order, ['replay', 'recommendation', 'eligibility']);
});
