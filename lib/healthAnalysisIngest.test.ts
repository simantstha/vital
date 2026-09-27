import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileAnalysisIngest,
  type AnalysisIngestRepository,
  type PersistedSleepAnalysis,
  type PersistedWorkoutAnalysis,
  type WorkoutAnalysisUpsert,
  type SleepAnalysisUpsert,
  type WorkoutSessionCandidate,
} from './healthAnalysisIngest';
import { fingerprintHealthPayload } from './healthAnalysisReconciliation';

type FakeWorkoutRow = PersistedWorkoutAnalysis & {
  notificationState: string;
  notificationSentAt: Date | null;
  source?: 'healthkit' | 'whoop';
  sourceBundleId?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
};

class FakeRepository implements AnalysisIngestRepository {
  calls: string[] = [];
  workouts = new Map<string, FakeWorkoutRow>();
  sleeps = new Map<string, PersistedSleepAnalysis & {
    status: string;
    result: unknown;
    analyzeAfter: Date;
    notificationState: string;
  }>();

  async lockUser(): Promise<void> { this.calls.push('lock'); }
  async listWorkoutAnalyses(): Promise<PersistedWorkoutAnalysis[]> {
    this.calls.push('list-workouts');
    // Mirrors the production SQL's source='healthkit' scope (see the guard
    // comment on reconcilePersistedWorkouts) — a WHOOP row must never surface
    // here, or it would look "vanished" and get marked deleted.
    return [...this.workouts.values()].filter((row) => (row.source ?? 'healthkit') === 'healthkit');
  }
  async listWorkoutSessionCandidates(): Promise<WorkoutSessionCandidate[]> {
    this.calls.push('list-session-candidates');
    return [...this.workouts.values()]
      .filter((row) => row.status !== 'deleted')
      .map((row) => ({
        hkUuid: row.hkUuid,
        source: row.source ?? 'healthkit',
        sourceBundleId: row.sourceBundleId ?? null,
        startedAt: row.startedAt ?? null,
        endedAt: row.endedAt ?? null,
        notified: row.notificationSentAt != null || row.notificationState === 'sent',
      }));
  }
  async markWorkoutsDeleted(_userId: string, hkUuids: string[]): Promise<void> {
    this.calls.push('delete-workouts');
    for (const hkUuid of hkUuids) {
      const row = this.workouts.get(hkUuid);
      if (row) this.workouts.set(hkUuid, { ...row, status: 'deleted' });
    }
  }
  async suppressWorkout(_userId: string, hkUuid: string): Promise<void> {
    this.calls.push('suppress-workout');
    const row = this.workouts.get(hkUuid);
    if (row) this.workouts.set(hkUuid, { ...row, status: 'deleted', notificationState: 'suppressed' });
  }
  async upsertWorkout(_userId: string, entry: WorkoutAnalysisUpsert): Promise<void> {
    this.calls.push('upsert-workout');
    const existing = this.workouts.get(entry.workout.hkUuid);
    const sourceBundleId = (entry.workout as Record<string, unknown>).sourceBundleId;
    this.workouts.set(entry.workout.hkUuid, {
      hkUuid: entry.workout.hkUuid,
      workoutDate: entry.workoutDate,
      contentFingerprint: entry.fingerprint,
      status: 'pending',
      notificationState: entry.notificationState,
      notificationSentAt: existing?.notificationSentAt ?? null,
      source: 'healthkit',
      sourceBundleId: typeof sourceBundleId === 'string' ? sourceBundleId : null,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
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
      source: 'healthkit',
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
  assert.deepEqual(repo.calls, [
    'lock', 'list-workouts', 'list-session-candidates', 'list-sleeps', 'upsert-workout', 'upsert-sleep',
  ]);
});

// ─── Same-session conflict (HealthKit vs WHOOP / HealthKit vs HealthKit) ─────

test('a new Apple Watch workout suppresses an existing overlapping WHOOP row (WHOOP loses to Apple Health)', async () => {
  const repo = new FakeRepository();
  repo.workouts.set('whoop:abc', {
    hkUuid: 'whoop:abc', workoutDate: '2026-07-12', contentFingerprint: 'fp',
    status: 'pending', notificationState: 'pending', notificationSentAt: null,
    source: 'whoop',
    startedAt: new Date('2026-07-12T10:00:00.000Z'),
    endedAt: new Date('2026-07-12T10:30:00.000Z'),
  });

  const workout = {
    hkUuid: 'hk-1',
    startTime: '2026-07-12T10:05:00.000Z',
    durationMin: 25,
    sourceBundleId: 'com.apple.health',
  };
  await reconcileAnalysisIngest(repo, 'user', [{ workoutDate: '2026-07-12', workouts: [workout] }], [], receivedAt);

  assert.equal(repo.workouts.get('whoop:abc')?.status, 'deleted');
  assert.equal(repo.workouts.get('whoop:abc')?.notificationState, 'suppressed');
  assert.equal(repo.workouts.get('hk-1')?.status, 'pending');
});

test('a new WHOOP-bundle HealthKit copy loses to an existing plain HealthKit row for the same session', async () => {
  const repo = new FakeRepository();
  // The phone re-sends its FULL current day's workout list on every ingest
  // (see reconcilePersistedWorkouts's "vanished hkUuid -> deleted" contract),
  // so the pre-existing "hk-original" must be included, unchanged, alongside
  // the newly-arriving WHOOP-bundle copy for this to be a realistic same-day
  // ingest rather than accidentally exercising the deletion path instead.
  const hkOriginalWorkout = { hkUuid: 'hk-original', startTime: '2026-07-12T10:00:00.000Z', durationMin: 30 };
  repo.workouts.set('hk-original', {
    hkUuid: 'hk-original', workoutDate: '2026-07-12', contentFingerprint: fingerprintHealthPayload(hkOriginalWorkout),
    status: 'pending', notificationState: 'pending', notificationSentAt: null,
    source: 'healthkit', sourceBundleId: null,
    startedAt: new Date('2026-07-12T10:00:00.000Z'),
    endedAt: new Date('2026-07-12T10:30:00.000Z'),
  });

  const whoopCopyInHealthKit = {
    hkUuid: 'hk-whoop-copy',
    startTime: '2026-07-12T10:02:00.000Z',
    durationMin: 25,
    sourceBundleId: 'com.whoop.app',
  };
  await reconcileAnalysisIngest(repo, 'user', [
    { workoutDate: '2026-07-12', workouts: [hkOriginalWorkout, whoopCopyInHealthKit] },
  ], [], receivedAt);

  assert.equal(repo.workouts.get('hk-original')?.status, 'pending');
  assert.equal(repo.workouts.get('hk-whoop-copy')?.status, 'deleted');
  assert.equal(repo.workouts.get('hk-whoop-copy')?.notificationState, 'suppressed');
});

// ─── Same-batch, same-session conflicts (both rows brand new in ONE upload) ──

test('same batch, Watch first then the WHOOP-bundle copy: the Watch row survives', async () => {
  const repo = new FakeRepository();
  const watchWorkout = {
    hkUuid: 'watch-1',
    startTime: '2026-07-12T10:00:00.000Z',
    durationMin: 30,
    sourceBundleId: 'com.apple.health',
  };
  const whoopCopy = {
    hkUuid: 'whoop-copy-1',
    startTime: '2026-07-12T10:02:00.000Z',
    durationMin: 25,
    sourceBundleId: 'com.whoop.app',
  };

  await reconcileAnalysisIngest(repo, 'user', [
    { workoutDate: '2026-07-12', workouts: [watchWorkout, whoopCopy] },
  ], [], receivedAt);

  assert.equal(repo.workouts.get('watch-1')?.status, 'pending');
  assert.equal(repo.workouts.get('watch-1')?.notificationState, 'pending');
  assert.equal(repo.workouts.get('whoop-copy-1')?.status, 'deleted');
  assert.equal(repo.workouts.get('whoop-copy-1')?.notificationState, 'suppressed');
});

test('same batch, WHOOP-bundle copy first then the Watch row: the Watch row still survives (order-independent)', async () => {
  const repo = new FakeRepository();
  const watchWorkout = {
    hkUuid: 'watch-1',
    startTime: '2026-07-12T10:00:00.000Z',
    durationMin: 30,
    sourceBundleId: 'com.apple.health',
  };
  const whoopCopy = {
    hkUuid: 'whoop-copy-1',
    startTime: '2026-07-12T10:02:00.000Z',
    durationMin: 25,
    sourceBundleId: 'com.whoop.app',
  };

  // Same two workouts, reversed order within the same upload.
  await reconcileAnalysisIngest(repo, 'user', [
    { workoutDate: '2026-07-12', workouts: [whoopCopy, watchWorkout] },
  ], [], receivedAt);

  assert.equal(repo.workouts.get('watch-1')?.status, 'pending');
  assert.equal(repo.workouts.get('watch-1')?.notificationState, 'pending');
  assert.equal(repo.workouts.get('whoop-copy-1')?.status, 'deleted');
  assert.equal(repo.workouts.get('whoop-copy-1')?.notificationState, 'suppressed');
});

test('same batch, two genuinely separate (non-overlapping) workouts: both survive', async () => {
  const repo = new FakeRepository();
  const morningRun = { hkUuid: 'morning-run', startTime: '2026-07-12T06:00:00.000Z', durationMin: 30 };
  const eveningLift = { hkUuid: 'evening-lift', startTime: '2026-07-12T18:00:00.000Z', durationMin: 45 };

  await reconcileAnalysisIngest(repo, 'user', [
    { workoutDate: '2026-07-12', workouts: [morningRun, eveningLift] },
  ], [], receivedAt);

  assert.equal(repo.workouts.get('morning-run')?.status, 'pending');
  assert.equal(repo.workouts.get('evening-lift')?.status, 'pending');
});

test('an already-notified existing row is never suppressed, even by a higher-priority incoming workout', async () => {
  const repo = new FakeRepository();
  repo.workouts.set('whoop:abc', {
    hkUuid: 'whoop:abc', workoutDate: '2026-07-12', contentFingerprint: 'fp',
    status: 'ready', notificationState: 'sent', notificationSentAt: receivedAt,
    source: 'whoop',
    startedAt: new Date('2026-07-12T10:00:00.000Z'),
    endedAt: new Date('2026-07-12T10:30:00.000Z'),
  });

  const workout = {
    hkUuid: 'hk-1',
    startTime: '2026-07-12T10:05:00.000Z',
    durationMin: 25,
    sourceBundleId: 'com.apple.health',
  };
  await reconcileAnalysisIngest(repo, 'user', [{ workoutDate: '2026-07-12', workouts: [workout] }], [], receivedAt);

  // The already-notified WHOOP row is untouched...
  assert.equal(repo.workouts.get('whoop:abc')?.status, 'ready');
  assert.equal(repo.workouts.get('whoop:abc')?.notificationState, 'sent');
  // ...and the newcomer is suppressed instead.
  assert.equal(repo.workouts.get('hk-1')?.status, 'deleted');
  assert.equal(repo.workouts.get('hk-1')?.notificationState, 'suppressed');
});

test('non-overlapping workouts on the same day never conflict', async () => {
  const repo = new FakeRepository();
  repo.workouts.set('whoop:abc', {
    hkUuid: 'whoop:abc', workoutDate: '2026-07-12', contentFingerprint: 'fp',
    status: 'pending', notificationState: 'pending', notificationSentAt: null,
    source: 'whoop',
    startedAt: new Date('2026-07-12T06:00:00.000Z'),
    endedAt: new Date('2026-07-12T06:30:00.000Z'),
  });

  const workout = { hkUuid: 'hk-1', startTime: '2026-07-12T18:00:00.000Z', durationMin: 25 };
  await reconcileAnalysisIngest(repo, 'user', [{ workoutDate: '2026-07-12', workouts: [workout] }], [], receivedAt);

  assert.equal(repo.workouts.get('whoop:abc')?.status, 'pending');
  assert.equal(repo.workouts.get('hk-1')?.status, 'pending');
});

// ─── WHOOP owns the night (sleep) ────────────────────────────────────────────

test('a HealthKit sleep upsert never overwrites an existing WHOOP sleep row for the same wake date', async () => {
  const repo = new FakeRepository();
  repo.sleeps.set('2026-07-12', {
    wakeDate: '2026-07-12', contentFingerprint: 'whoop-fp',
    status: 'ready', result: { headline: 'WHOOP sleep' }, analyzeAfter: new Date(0),
    notificationState: 'pending', notificationSentAt: null, source: 'whoop',
  });

  await reconcileAnalysisIngest(repo, 'user', [], [
    { wakeDate: '2026-07-12', sleep: { minutes: 430 } },
  ], receivedAt);

  assert.ok(!repo.calls.includes('upsert-sleep'));
  assert.equal(repo.sleeps.get('2026-07-12')?.source, 'whoop');
  assert.deepEqual(repo.sleeps.get('2026-07-12')?.result, { headline: 'WHOOP sleep' });
});
