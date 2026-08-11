import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCurrentMaterialSignature,
  assertReplayMatchesSubmission,
  resolveReplayBeforeEligibility,
  withLockedRecommendationMutation,
} from './coachWorkspaceActionReplay';

test('existing accept, adjust, and complete actions replay unchanged before current eligibility', async () => {
  for (const action of ['accept', 'adjust', 'complete'] as const) {
    const order: string[] = [];
    const interaction = { id: `interaction-${action}`, action, adjustment: { durationMinutes: 30 } };
    const result = await resolveReplayBeforeEligibility({
      lockRecommendation: async () => { order.push('lock'); return { category: 'calibration' }; },
      findReplay: async () => { order.push('replay'); return interaction; },
      assertReplay: () => { order.push('replay-match'); },
      assertEligible: () => { order.push('eligibility'); throw new Error('not allowed'); },
    });

    assert.equal(result.replay, interaction);
    assert.equal(result.recommendation, null);
    assert.deepEqual(order, ['lock', 'replay', 'replay-match']);
  }
});

test('a new action id loads and validates the current recommendation', async () => {
  const order: string[] = [];
  await assert.rejects(() => resolveReplayBeforeEligibility({
    lockRecommendation: async () => { order.push('lock'); return { category: 'calibration' }; },
    findReplay: async () => { order.push('replay'); return null; },
    assertReplay: () => { order.push('replay-match'); },
    assertEligible: () => { order.push('eligibility'); throw new Error('accept is not allowed'); },
  }), /not allowed/);
  assert.deepEqual(order, ['lock', 'replay', 'eligibility']);
});

test('actionId replay requires the same recommendation, action, adjustment, and submitted signature', () => {
  const existing = {
    recommendationId: 'recommendation-1', action: 'adjust',
    adjustment: { durationMinutes: 30, __materialSignature: 'signature-a' },
  };
  const submission = {
    recommendationId: 'recommendation-1', action: 'adjust',
    adjustment: { durationMinutes: 30 }, materialSignature: 'signature-a',
  };

  assert.doesNotThrow(() => assertReplayMatchesSubmission(existing, submission));
  for (const mismatch of [
    { ...submission, recommendationId: 'recommendation-2' },
    { ...submission, action: 'accept' },
    { ...submission, adjustment: { durationMinutes: 45 } },
    { ...submission, materialSignature: 'signature-b' },
  ]) {
    assert.throws(() => assertReplayMatchesSubmission(existing, mismatch), /different payload/);
  }
});

test('a new action rejects a stale card after the recommendation materially changes', () => {
  assert.doesNotThrow(() => assertCurrentMaterialSignature('signature-b', 'signature-b'));
  assert.throws(
    () => assertCurrentMaterialSignature('signature-b', 'signature-a'),
    /Stale Coach Workspace card/,
  );
});

test('distinct concurrent action IDs serialize through one recommendation lock and create one plan', async () => {
  type Context = { release?: () => void };
  let previous = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  let planRows = 0;
  const interactions: string[] = [];
  const boundary = {
    async transaction<T>(operation: (context: Context) => Promise<T>): Promise<T> {
      const context: Context = {};
      try {
        return await operation(context);
      } finally {
        context.release?.();
      }
    },
    async lockRecommendation(context: Context) {
      const waitForPrevious = previous;
      let releaseCurrent = () => {};
      previous = new Promise<void>(resolve => { releaseCurrent = resolve; });
      await waitForPrevious;
      context.release = releaseCurrent;
      return { id: 'recommendation-1' };
    },
  };

  await Promise.all(['action-1', 'action-2'].map(actionId =>
    withLockedRecommendationMutation(boundary, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      if (planRows === 0) planRows += 1;
      interactions.push(actionId);
      active -= 1;
    }),
  ));

  assert.equal(maxActive, 1);
  assert.equal(planRows, 1);
  assert.deepEqual(interactions, ['action-1', 'action-2']);
});
