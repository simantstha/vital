import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileAnalysisIngest,
  type AnalysisIngestRepository,
  type PersistedSleepAnalysis,
  type PersistedWorkoutAnalysis,
  type WorkoutAnalysisUpsert,
  type SleepAnalysisUpsert,
} from './healthAnalysisIngest';
import { fingerprintHealthPayload } from './healthAnalysisReconciliation';

class FakeRepository implements AnalysisIngestRepository {
  calls: string[] = [];
  workouts = new Map<string, PersistedWorkoutAnalysis & { notificationState: string; notificationSentAt: Date | null }>();
  sleeps = new Map<string, PersistedSleepAnalysis & {
    status: string;
    result: unknown;
    analyzeAfter: Date;
    notificationState: string;
  }>();

  async lockUser(): Promise<void> { this.calls.push('lock'); }
  async listWorkoutAnalyses(): Promise<PersistedWorkoutAnalysis[]> {
    this.calls.push('list-workouts');
    return [...this.workouts.values()];
  }
  async markWorkoutsDeleted(_userId: string, hkUuids: string[]): Promise<void> {
    this.calls.push('delete-workouts');
    for (const hkUuid of hkUuids) {
      const row = this.workouts.get(hkUuid);
      if (row) this.workouts.set(hkUuid, { ...row, status: 'deleted' });
    }
  }
  async upsertWorkout(_userId: string, entry: WorkoutAnalysisUpsert): Promise<void> {
    this.calls.push('upsert-workout');
    const existing = this.workouts.get(entry.workout.hkUuid);
    this.workouts.set(entry.workout.hkUuid, {
      hkUuid: entry.workout.hkUuid,
      workoutDate: entry.workoutDate,
      contentFingerprint: entry.fingerprint,
      status: 'pending',
      notificationState: entry.notificationState,
      notificationSentAt: existing?.notificationSentAt ?? null,
    });
  }
  async listSleepAnalyses(): Promise<PersistedSleepAnalysis[]> {
    this.calls.push('list-sleeps');
    return [...this.sleeps.values()];
  }
  async upsertSleep(_userId: string, entry: SleepAnalysisUpsert): Promise<void> {
    this.calls.push('upsert-sleep');
    this.sleeps.set(entry.wakeDate, {
      wakeDate: entry.wakeDate,
      contentFingerprint: entry.fingerprint,
      status: 'pending',
      result: null,
      analyzeAfter: entry.analyzeAfter,
      notificationState: entry.notificationState,
      notificationSentAt: this.sleeps.get(entry.wakeDate)?.notificationSentAt ?? null,
    });
  }
}

const receivedAt = new Date('2026-07-12T12:00:00.000Z');

test('unchanged ready sleep preserves result, status, and quiet deadline', async () => {
  const repo = new FakeRepository();
  const sleep = { minutes: 430, stages: { deep: 60 } };
  const analyzeAfter = new Date('2026-07-12T11:30:00.000Z');
  repo.sleeps.set('2026-07-12', {
    wakeDate: '2026-07-12', contentFingerprint: fingerprintHealthPayload(sleep),
    status: 'ready', result: { headline: 'Rested' }, analyzeAfter,
    notificationState: 'sent', notificationSentAt: receivedAt,
  });

  await reconcileAnalysisIngest(repo, 'user', [], [{ wakeDate: '2026-07-12', sleep }], receivedAt);

  assert.equal(repo.sleeps.get('2026-07-12')?.status, 'ready');
  assert.deepEqual(repo.sleeps.get('2026-07-12')?.result, { headline: 'Rested' });
  assert.equal(repo.sleeps.get('2026-07-12')?.analyzeAfter, analyzeAfter);
  assert.ok(!repo.calls.includes('upsert-sleep'));
});

test('changed sleep resets analysis and starts a fresh quiet period', async () => {
  const repo = new FakeRepository();
  repo.sleeps.set('2026-07-12', {
    wakeDate: '2026-07-12', contentFingerprint: fingerprintHealthPayload({ minutes: 400 }),
    status: 'ready', result: { headline: 'Old' }, analyzeAfter: new Date(0),
    notificationState: 'sent', notificationSentAt: receivedAt,
  });

  await reconcileAnalysisIngest(repo, 'user', [], [
    { wakeDate: '2026-07-12', sleep: { minutes: 430 } },
  ], receivedAt);

  const row = repo.sleeps.get('2026-07-12');
  assert.equal(row?.status, 'pending');
  assert.equal(row?.result, null);
  assert.equal(row?.analyzeAfter.toISOString(), '2026-07-12T12:30:00.000Z');
  assert.equal(row?.notificationState, 'sent');
});

test('sent workout delete and re-add preserves durable sent state', async () => {
  const repo = new FakeRepository();
  const workout = { hkUuid: 'sent', duration: 30 };
  repo.workouts.set('sent', {
    hkUuid: 'sent', workoutDate: '2026-07-12', contentFingerprint: fingerprintHealthPayload(workout),
    status: 'ready', notificationState: 'sent', notificationSentAt: receivedAt,
  });

  await reconcileAnalysisIngest(repo, 'user', [{ workoutDate: '2026-07-12', workouts: [] }], [], receivedAt);
  await reconcileAnalysisIngest(repo, 'user', [{ workoutDate: '2026-07-12', workouts: [workout] }], [], receivedAt);

  assert.equal(repo.workouts.get('sent')?.notificationState, 'sent');
});

test('pre-migration workout without an analysis row is enqueued', async () => {
  const repo = new FakeRepository();
  await reconcileAnalysisIngest(repo, 'user', [{
    workoutDate: '2026-07-12', workouts: [{ hkUuid: 'legacy', duration: 30 }],
  }], [], receivedAt);
  assert.equal(repo.workouts.get('legacy')?.status, 'pending');
});

test('user serialization lock is acquired before reconciliation and writes', async () => {
  const repo = new FakeRepository();
  await reconcileAnalysisIngest(repo, 'user', [{
    workoutDate: '2026-07-12', workouts: [{ hkUuid: 'new', duration: 30 }],
  }], [{ wakeDate: '2026-07-12', sleep: { minutes: 430 } }], receivedAt);
  assert.deepEqual(repo.calls, ['lock', 'list-workouts', 'list-sleeps', 'upsert-workout', 'upsert-sleep']);
});
