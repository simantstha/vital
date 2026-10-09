import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('@/lib/weightRepository', {
  namedExports: { getWeightReadings: async () => [] },
});

const modPromise = import('./goalStart');

test('first target (no previous one) starts a goal → re-anchor', async () => {
  const { shouldReanchorForTargetChange } = await modPromise;
  assert.equal(shouldReanchorForTargetChange(null, 75, 82), true);
});

test('same-direction target edit keeps the start weight and date', async () => {
  const { shouldReanchorForTargetChange } = await modPromise;
  // Losing: 80 → 78 while at 84 kg stays a loss goal; progress already made survives.
  assert.equal(shouldReanchorForTargetChange(80, 78, 84), false);
  assert.equal(shouldReanchorForTargetChange(80, 83, 84), false);
  // Gaining: 90 → 95 while at 84.
  assert.equal(shouldReanchorForTargetChange(90, 95, 84), false);
});

test('direction flip (loss <-> gain) re-anchors', async () => {
  const { shouldReanchorForTargetChange } = await modPromise;
  assert.equal(shouldReanchorForTargetChange(80, 90, 84), true);
  assert.equal(shouldReanchorForTargetChange(90, 80, 84), true);
});

test('unchanged target, or unknown current weight, never re-anchors', async () => {
  const { shouldReanchorForTargetChange } = await modPromise;
  assert.equal(shouldReanchorForTargetChange(80, 80, 84), false);
  assert.equal(shouldReanchorForTargetChange(80, 90, null), false);
});

test('targetDirection treats within 0.1 kg as hold', async () => {
  const { targetDirection } = await modPromise;
  assert.equal(targetDirection(80, 79.95), 'hold');
  assert.equal(targetDirection(80, 75), 'loss');
  assert.equal(targetDirection(80, 85), 'gain');
});
