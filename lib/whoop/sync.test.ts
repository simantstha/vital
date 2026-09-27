import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { WhoopConnectionSnapshot, WhoopTokenStore, WhoopTokenStoreTx, WhoopSleep, WhoopWorkout } from './client';
import type {
  PersistedWhoopSleepAnalysis,
  WhoopAnalysisTransaction,
  WhoopSleepAnalysisUpsert,
  WhoopWorkoutAnalysisUpsert,
  WhoopSyncRepository,
  WorkoutSessionCandidate,
} from './sync';
import type { WhoopSyncWindowInput } from './mapping';

/**
 * lib/whoop/sync.ts imports recomputeBaselines from ../brain/baselines,
 * which imports `@/db` at module scope (throws without a live
 * DATABASE_URL). We mock the relative `../brain/baselines` specifier here —
 * it resolves from this file the same way it resolves from sync.ts, since
 * both live in lib/whoop/ — so sync.ts never touches Postgres in this test
 * file. `node:test` runs each test file in its own subprocess, so this mock
 * doesn't leak into client.test.ts / mapping.test.ts.
 */
const recomputeCalls: Array<{ userId: string; metrics: string[] }> = [];
mock.module('../brain/baselines', {
  namedExports: {
    recomputeBaselines: async (userId: string, metrics: string[]) => {
      recomputeCalls.push({ userId, metrics: [...metrics] });
    },
  },
});

const syncModule = import('./sync');

function emptyWindowInput(): WhoopSyncWindowInput {
  return { cycles: [], recoveries: [], sleeps: [], workouts: [] };
}

class FakeSyncRepository implements WhoopSyncRepository {
  upsertCalls: Array<{ userId: string; rows: unknown[] }> = [];
  insertCalls: Array<{ userId: string; events: unknown[] }> = [];
  existingWorkoutIds = new Set<string>();
  listCalls: Array<{ userId: string; windowStart: Date; windowEnd: Date; whoopIds: string[] }> = [];
  markSyncedCalls: Array<{ connectionId: string; syncedAt: Date }> = [];

  // Analysis-side state — a stand-in for workout_analyses/sleep_analyses.
  lockCalls: string[] = [];
  workoutAnalyses = new Map<string, WorkoutSessionCandidate>();
  workoutUpsertCalls: WhoopWorkoutAnalysisUpsert[] = [];
  sleepAnalyses = new Map<string, PersistedWhoopSleepAnalysis>();
  sleepUpsertCalls: WhoopSleepAnalysisUpsert[] = [];

  async upsertDailyMetrics(userId: string, rows: Array<{ date: string; metric: string; value: number; payload: unknown }>): Promise<void> {
    this.upsertCalls.push({ userId, rows });
  }
  async listExistingWorkoutIds(userId: string, windowStart: Date, windowEnd: Date, whoopIds: string[]): Promise<Set<string>> {
    this.listCalls.push({ userId, windowStart, windowEnd, whoopIds });
    return new Set([...this.existingWorkoutIds].filter((id) => whoopIds.includes(id)));
  }
  async insertWorkoutEvents(userId: string, events: Array<{ timestamp: Date; payload: unknown }>): Promise<void> {
    this.insertCalls.push({ userId, events });
  }
  async markSynced(connectionId: string, syncedAt: Date): Promise<void> {
    this.markSyncedCalls.push({ connectionId, syncedAt });
  }
  async withUserAnalysisLock<T>(userId: string, fn: (tx: WhoopAnalysisTransaction) => Promise<T>): Promise<T> {
    this.lockCalls.push(userId);
    const tx: WhoopAnalysisTransaction = {
      listWorkoutSessionCandidates: async () => [...this.workoutAnalyses.values()],
      upsertWhoopWorkoutAnalysis: async (entry) => {
        this.workoutUpsertCalls.push(entry);
        this.workoutAnalyses.set(entry.hkUuid, {
          hkUuid: entry.hkUuid, source: 'whoop', sourceBundleId: null,
          startedAt: entry.startedAt, endedAt: entry.endedAt, notified: false,
        });
      },
      getSleepAnalysisForWakeDate: async (wakeDate) => this.sleepAnalyses.get(wakeDate) ?? null,
      upsertWhoopSleepAnalysis: async (entry) => {
        this.sleepUpsertCalls.push(entry);
        this.sleepAnalyses.set(entry.wakeDate, { source: 'whoop', notified: false, fingerprint: entry.fingerprint });
      },
    };
    return fn(tx);
  }
}

const windowStart = new Date('2026-07-01T00:00:00.000Z');
const windowEnd = new Date('2026-07-19T00:00:00.000Z');
const NOT_FIRST_SYNC = new Date('2026-06-01T00:00:00.000Z');

test('syncWhoopWindow upserts mapped daily metrics and reports touched metrics', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = {
    ...emptyWindowInput(),
    cycles: [{ id: 1, user_id: 1, start: '2026-07-10T12:00:00.000Z', end: null, score_state: 'SCORED', score: { strain: 9, kilojoule: 100, average_heart_rate: 70, max_heart_rate: 120 } }],
  };

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.upsertCalls.length, 1);
  assert.equal(repo.upsertCalls[0].userId, 'user-1');
  assert.deepEqual(repo.upsertCalls[0].rows, [{ date: '2026-07-10', metric: 'whoop_day_strain', value: 9, payload: null }]);
  assert.deepEqual(result.touchedMetrics, ['whoop_day_strain']);
  assert.equal(result.dailyMetricsWritten, 1);
  assert.equal(result.workoutEventsWritten, 0);
  assert.equal(repo.listCalls.length, 0); // no workouts in this window — never even asked
});

test('syncWhoopWindow skips the upsert call entirely when there is nothing mapped', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, emptyWindowInput(), NOT_FIRST_SYNC);

  assert.equal(repo.upsertCalls.length, 0);
  assert.deepEqual(result.touchedMetrics, []);
});

test('syncWhoopWindow dedupes workout events already present in the window, by whoopId', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  repo.existingWorkoutIds.add('workout-old');
  const input: WhoopSyncWindowInput = {
    ...emptyWindowInput(),
    workouts: [
      { id: 'workout-old', user_id: 1, start: '2026-07-10T12:00:00.000Z', end: '2026-07-10T13:00:00.000Z', sport_name: 'running', score_state: 'SCORED', score: { strain: 5, average_heart_rate: 100, max_heart_rate: 140, kilojoule: 500 } },
      { id: 'workout-new', user_id: 1, start: '2026-07-11T12:00:00.000Z', end: '2026-07-11T13:00:00.000Z', sport_name: 'cycling', score_state: 'SCORED', score: { strain: 6, average_heart_rate: 110, max_heart_rate: 150, kilojoule: 800 } },
    ],
  };

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.listCalls.length, 1);
  assert.deepEqual(repo.listCalls[0].whoopIds.sort(), ['workout-new', 'workout-old']);
  assert.equal(repo.insertCalls.length, 1);
  assert.equal(repo.insertCalls[0].events.length, 1);
  assert.equal((repo.insertCalls[0].events[0] as { timestamp: Date }).timestamp.toISOString(), '2026-07-11T12:00:00.000Z');
  assert.equal(result.workoutEventsWritten, 1);
});

test('syncWhoopWindow skips insertWorkoutEvents entirely when every workout already exists', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  repo.existingWorkoutIds.add('workout-old');
  const input: WhoopSyncWindowInput = {
    ...emptyWindowInput(),
    workouts: [{ id: 'workout-old', user_id: 1, start: '2026-07-10T12:00:00.000Z', end: '2026-07-10T13:00:00.000Z', sport_name: 'running', score_state: 'SCORED', score: { strain: 5, average_heart_rate: 100, max_heart_rate: 140, kilojoule: 500 } }],
  };

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.insertCalls.length, 0);
  assert.equal(result.workoutEventsWritten, 0);
});

// ─── syncWhoopWindow: creating WHOOP workout/sleep analyses ─────────────────

function whoopWorkout(overrides: Partial<WhoopWorkout> = {}): WhoopWorkout {
  return {
    id: 'w-1', user_id: 1,
    start: '2026-07-18T11:30:00.000Z', end: '2026-07-18T12:00:00.000Z', // 12h before windowEnd — within the 24h gate
    sport_name: 'running', score_state: 'SCORED',
    score: { strain: 10, average_heart_rate: 140, max_heart_rate: 170, kilojoule: 2000, distance_meter: 5000 },
    ...overrides,
  };
}

function whoopSleep(overrides: Partial<WhoopSleep> = {}): WhoopSleep {
  return {
    id: 's-1', user_id: 1,
    start: '2026-07-17T23:00:00.000Z', end: '2026-07-18T07:00:00.000Z', // ends well within the 24h gate
    nap: false, score_state: 'SCORED',
    score: {
      stage_summary: {
        total_in_bed_time_milli: 480 * 60_000,
        total_awake_time_milli: 30 * 60_000,
        total_light_sleep_time_milli: 200 * 60_000,
        total_slow_wave_sleep_time_milli: 100 * 60_000,
        total_rem_sleep_time_milli: 150 * 60_000,
      },
    },
    ...overrides,
  };
}

test('syncWhoopWindow creates a WHOOP workout analysis for a fresh, in-gate workout', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), workouts: [whoopWorkout()] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.deepEqual(repo.lockCalls, ['user-1']);
  assert.equal(repo.workoutUpsertCalls.length, 1);
  const entry = repo.workoutUpsertCalls[0];
  assert.equal(entry.hkUuid, 'whoop:w-1');
  assert.equal(entry.input.type, 'Running');
  assert.equal(entry.nextAttemptAt.toISOString(), '2026-07-18T12:20:00.000Z'); // ended_at + 20 min
});

test('syncWhoopWindow never creates a workout analysis on the connection\'s first sync', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), workouts: [whoopWorkout()] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, null);

  assert.equal(repo.workoutUpsertCalls.length, 0);
});

test('syncWhoopWindow never creates a workout analysis for a session that ended over 24h ago', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = {
    ...emptyWindowInput(),
    workouts: [whoopWorkout({ start: '2026-07-15T11:30:00.000Z', end: '2026-07-15T12:00:00.000Z' })],
  };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.workoutUpsertCalls.length, 0);
});

test('syncWhoopWindow skips a WHOOP workout when a surviving same-session HealthKit row already exists', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  repo.workoutAnalyses.set('hk-1', {
    hkUuid: 'hk-1', source: 'healthkit', sourceBundleId: 'com.apple.health',
    startedAt: new Date('2026-07-18T11:32:00.000Z'), endedAt: new Date('2026-07-18T12:02:00.000Z'),
    notified: false,
  });
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), workouts: [whoopWorkout()] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.workoutUpsertCalls.length, 0);
});

test('syncWhoopWindow creates a WHOOP sleep analysis for a fresh, scored, in-gate sleep', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), sleeps: [whoopSleep()] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.sleepUpsertCalls.length, 1);
  const entry = repo.sleepUpsertCalls[0];
  assert.equal(entry.wakeDate, '2026-07-18');
  assert.equal(entry.input.minutes, 450);
  assert.equal(entry.analyzeAfter.toISOString(), '2026-07-19T00:30:00.000Z'); // windowEnd + 30 min
});

test('syncWhoopWindow skips an unscored sleep (no stage_summary yet)', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), sleeps: [whoopSleep({ score: null })] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.sleepUpsertCalls.length, 0);
});

test('syncWhoopWindow never overwrites an already-notified HealthKit sleep row for the same wake date', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  repo.sleepAnalyses.set('2026-07-18', { source: 'healthkit', notified: true, fingerprint: 'hk-fp' });
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), sleeps: [whoopSleep()] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.sleepUpsertCalls.length, 0);
});

test('syncWhoopWindow (WHOOP owns the night) overwrites an existing un-notified HealthKit sleep row', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  repo.sleepAnalyses.set('2026-07-18', { source: 'healthkit', notified: false, fingerprint: 'hk-fp' });
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), sleeps: [whoopSleep()] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.equal(repo.sleepUpsertCalls.length, 1);
});

test('syncWhoopWindow re-syncing the identical WHOOP sleep content is a no-op (idempotent)', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), sleeps: [whoopSleep()] };
  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);
  assert.equal(repo.sleepUpsertCalls.length, 1);

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);
  assert.equal(repo.sleepUpsertCalls.length, 1); // still 1 — the second identical sync wrote nothing new
});

test('syncWhoopWindow never takes the per-user lock when there are no workouts or sleeps to consider', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = { ...emptyWindowInput(), cycles: [{ id: 1, user_id: 1, start: '2026-07-18T00:00:00.000Z', end: null, score_state: 'SCORED', score: { strain: 5, kilojoule: 100, average_heart_rate: 60, max_heart_rate: 100 } }] };

  await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input, NOT_FIRST_SYNC);

  assert.deepEqual(repo.lockCalls, []);
});

// ─── runWhoopSync (end-to-end: client fetch → map → upsert → baselines) ─────

class FakeTokenStore implements WhoopTokenStore, WhoopTokenStoreTx {
  saved: unknown[] = [];
  constructor(private row: WhoopConnectionSnapshot | null) {}
  async transaction<T>(fn: (tx: WhoopTokenStoreTx) => Promise<T>): Promise<T> { return fn(this); }
  async lockConnection(): Promise<WhoopConnectionSnapshot | null> { return this.row; }
  async saveTokens(): Promise<void> { /* not exercised — token is far from expiry in these tests */ }
  async markError(): Promise<void> { /* not exercised */ }
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

test('runWhoopSync fetches all four record types, maps, upserts, and recomputes touched baselines', async (t) => {
  recomputeCalls.length = 0;
  const { runWhoopSync } = await syncModule;

  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/cycle')) {
      return jsonResponse({ records: [{ id: 1, user_id: 1, start: '2026-07-10T12:00:00.000Z', end: null, score_state: 'SCORED', score: { strain: 9, kilojoule: 100, average_heart_rate: 70, max_heart_rate: 120 } }], next_token: null });
    }
    if (url.includes('/recovery')) return jsonResponse({ records: [], next_token: null });
    if (url.includes('/activity/sleep')) return jsonResponse({ records: [], next_token: null });
    if (url.includes('/activity/workout')) return jsonResponse({ records: [], next_token: null });
    throw new Error(`unexpected fetch: ${url}`);
  });

  const tokenStore = new FakeTokenStore({
    id: 'conn-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 60 * 60_000), status: 'active',
  });
  const repo = new FakeSyncRepository();

  const result = await runWhoopSync(
    { connectionId: 'conn-1', userId: 'user-1', timezone: 'UTC', lastSyncedAt: NOT_FIRST_SYNC },
    tokenStore,
    repo,
    windowStart,
    windowEnd,
  );

  assert.deepEqual(result.touchedMetrics, ['whoop_day_strain']);
  assert.equal(repo.upsertCalls.length, 1);
  assert.equal(recomputeCalls.length, 1);
  assert.equal(recomputeCalls[0].userId, 'user-1');
  assert.deepEqual(recomputeCalls[0].metrics, ['whoop_day_strain']);
});

test('runWhoopSync never calls recomputeBaselines when nothing was mapped', async (t) => {
  recomputeCalls.length = 0;
  const { runWhoopSync } = await syncModule;

  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ records: [], next_token: null }));

  const tokenStore = new FakeTokenStore({
    id: 'conn-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 60 * 60_000), status: 'active',
  });
  const repo = new FakeSyncRepository();

  const result = await runWhoopSync(
    { connectionId: 'conn-1', userId: 'user-1', timezone: 'UTC', lastSyncedAt: NOT_FIRST_SYNC },
    tokenStore,
    repo,
    windowStart,
    windowEnd,
  );

  assert.deepEqual(result.touchedMetrics, []);
  assert.equal(repo.upsertCalls.length, 0);
  assert.equal(recomputeCalls.length, 0);
});

test('runWhoopSync stamps last_synced_at with windowEnd on success', async (t) => {
  recomputeCalls.length = 0;
  const { runWhoopSync } = await syncModule;

  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ records: [], next_token: null }));

  const tokenStore = new FakeTokenStore({
    id: 'conn-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 60 * 60_000), status: 'active',
  });
  const repo = new FakeSyncRepository();

  await runWhoopSync(
    { connectionId: 'conn-1', userId: 'user-1', timezone: 'UTC', lastSyncedAt: NOT_FIRST_SYNC },
    tokenStore,
    repo,
    windowStart,
    windowEnd,
  );

  assert.equal(repo.markSyncedCalls.length, 1);
  assert.equal(repo.markSyncedCalls[0].connectionId, 'conn-1');
  assert.equal(repo.markSyncedCalls[0].syncedAt.getTime(), windowEnd.getTime());
});

test('runWhoopSync does not call markSynced when the sync throws', async (t) => {
  recomputeCalls.length = 0;
  const { runWhoopSync } = await syncModule;

  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network exploded'); });

  const tokenStore = new FakeTokenStore({
    id: 'conn-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 60 * 60_000), status: 'active',
  });
  const repo = new FakeSyncRepository();

  await assert.rejects(() => runWhoopSync(
    { connectionId: 'conn-1', userId: 'user-1', timezone: 'UTC', lastSyncedAt: NOT_FIRST_SYNC },
    tokenStore,
    repo,
    windowStart,
    windowEnd,
  ));

  assert.equal(repo.markSyncedCalls.length, 0);
});

// ─── createWhoopSyncRepository.upsertDailyMetrics (Drizzle-backed repository) ─

test('upsertDailyMetrics dedupes rows by (date, metric) using last-wins semantics', async () => {
  const { createWhoopSyncRepository } = await syncModule;

  // Create a fake database that captures what rows are passed to .values()
  const recordedValuesCalls: Array<Array<Record<string, unknown>>> = [];
  const mockSchema = {
    daily_metrics: { user_id: {}, date: {}, metric: {} },
    events: {},
  };
  const fakeDb = {
    insert() {
      return {
        values(rows: Array<Record<string, unknown>>) {
          recordedValuesCalls.push(rows);
          return {
            async onConflictDoUpdate() {
              // no-op for this test
            }
          };
        }
      };
    },
  };

  const repo = createWhoopSyncRepository(fakeDb as unknown, mockSchema as unknown);

  // Call with rows containing duplicate (date, metric) keys but different values
  await repo.upsertDailyMetrics('user-1', [
    { date: '2026-07-21', metric: 'whoop_day_strain', value: 8, payload: null },
    { date: '2026-07-21', metric: 'whoop_day_strain', value: 9, payload: null }, // same key, replaces above (last-wins)
    { date: '2026-07-21', metric: 'whoop_recovery', value: 50, payload: null },
    { date: '2026-07-21', metric: 'whoop_recovery', value: 60, payload: null }, // same key, replaces above (last-wins)
    { date: '2026-07-22', metric: 'whoop_day_strain', value: 7, payload: null }, // distinct (date, metric)
  ]);

  // Verify insert() was called exactly once with deduplicated rows
  assert.equal(recordedValuesCalls.length, 1, 'insert().values() should be called once');
  const [values] = recordedValuesCalls;
  assert.equal(values.length, 3, 'should have 3 unique (date, metric) pairs after deduplication');

  // Verify last-wins semantics: later rows replaced earlier ones with the same key
  const strain21 = values.find((r) => r.metric === 'whoop_day_strain' && r.date === '2026-07-21') as Record<string, unknown>;
  assert(strain21, 'should have whoop_day_strain for 2026-07-21');
  assert.equal(strain21.value, 9, 'whoop_day_strain 2026-07-21 should have last-wins value (9, not 8)');
  assert.equal(strain21.user_id, 'user-1');

  const recovery21 = values.find((r) => r.metric === 'whoop_recovery' && r.date === '2026-07-21') as Record<string, unknown>;
  assert(recovery21, 'should have whoop_recovery for 2026-07-21');
  assert.equal(recovery21.value, 60, 'whoop_recovery 2026-07-21 should have last-wins value (60, not 50)');

  const strain22 = values.find((r) => r.metric === 'whoop_day_strain' && r.date === '2026-07-22') as Record<string, unknown>;
  assert(strain22, 'should have whoop_day_strain for 2026-07-22');
  assert.equal(strain22.value, 7, 'distinct row should be preserved as-is');
});
