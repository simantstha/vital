import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fingerprintHealthPayload,
  reconcileWorkouts,
  sleepAnalysisCandidate,
} from './healthAnalysisReconciliation';

test('fingerprints equivalent objects independent of key order', () => {
  assert.equal(
    fingerprintHealthPayload({ duration: 30, nested: { b: 2, a: 1 } }),
    fingerprintHealthPayload({ nested: { a: 1, b: 2 }, duration: 30 }),
  );
});

test('workout reconciliation identifies new, changed, unchanged, and removed UUIDs', () => {
  const previous = [
    { hkUuid: 'unchanged', duration: 30 },
    { hkUuid: 'changed', duration: 20 },
    { hkUuid: 'removed', duration: 15 },
  ];
  const current = [
    { hkUuid: 'unchanged', duration: 30 },
    { hkUuid: 'changed', duration: 25 },
    { hkUuid: 'new', duration: 40 },
  ];

  const result = reconcileWorkouts(previous, current);

  assert.deepEqual(result.upserts.map((entry) => entry.workout.hkUuid), ['changed', 'new']);
  assert.deepEqual(result.removedHkUuids, ['removed']);
});

test('sleep candidate uses the wake date and extends quiet period by thirty minutes', () => {
  const receivedAt = new Date('2026-07-12T12:00:00.000Z');
  const result = sleepAnalysisCandidate(
    '2026-07-12',
    { minutes: 430, stages: { deep: 60 } },
    receivedAt,
  );

  assert.equal(result.wakeDate, '2026-07-12');
  assert.equal(result.analyzeAfter.toISOString(), '2026-07-12T12:30:00.000Z');
  assert.equal(result.fingerprint, fingerprintHealthPayload({ minutes: 430, stages: { deep: 60 } }));
});
