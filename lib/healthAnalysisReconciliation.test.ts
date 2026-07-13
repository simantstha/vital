import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fingerprintHealthPayload,
  reconcilePersistedWorkouts,
  reconcileWorkouts,
  shouldRefreshSleepAnalysis,
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

test('unchanged ready sleep preserves its analysis state', () => {
  const fingerprint = fingerprintHealthPayload({ minutes: 430, stages: { deep: 60 } });
  assert.equal(shouldRefreshSleepAnalysis(fingerprint, fingerprint), false);
});

test('changed sleep refreshes its analysis state', () => {
  const previous = fingerprintHealthPayload({ minutes: 430 });
  const changed = fingerprintHealthPayload({ minutes: 445 });
  assert.equal(shouldRefreshSleepAnalysis(previous, changed), true);
});

test('persisted workout reconciliation inserts pre-migration workouts missing queue rows', () => {
  const result = reconcilePersistedWorkouts([], [
    { workoutDate: '2026-07-12', workout: { hkUuid: 'legacy', duration: 30 } },
  ]);

  assert.deepEqual(result.upserts.map((entry) => entry.workout.hkUuid), ['legacy']);
  assert.deepEqual(result.removedHkUuids, []);
});

test('sent deleted workout is reactivated without losing sent history', () => {
  const workout = { hkUuid: 'sent', duration: 30 };
  const fingerprint = fingerprintHealthPayload(workout);
  const removed = reconcilePersistedWorkouts([
    { hkUuid: 'sent', workoutDate: '2026-07-12', contentFingerprint: fingerprint },
  ], []);
  const readded = reconcilePersistedWorkouts([
    { hkUuid: 'sent', workoutDate: '2026-07-12', contentFingerprint: fingerprint, status: 'deleted' },
  ], [{ workoutDate: '2026-07-12', workout }]);

  assert.deepEqual(removed.removedHkUuids, ['sent']);
  assert.deepEqual(readded.upserts.map((entry) => entry.workout.hkUuid), ['sent']);
});

test('persisted fingerprints make a stale identical ingest a no-op', () => {
  const workout = { hkUuid: 'same', duration: 30 };
  const fingerprint = fingerprintHealthPayload(workout);
  const result = reconcilePersistedWorkouts([
    { hkUuid: 'same', workoutDate: '2026-07-12', contentFingerprint: fingerprint },
  ], [{ workoutDate: '2026-07-12', workout }]);

  assert.deepEqual(result, { upserts: [], removedHkUuids: [] });
});
