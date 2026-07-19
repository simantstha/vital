import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { WhoopConnectionSnapshot, WhoopTokenStore, WhoopTokenStoreTx } from './client';
import type { WhoopSyncRepository } from './sync';
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
}

const windowStart = new Date('2026-07-01T00:00:00.000Z');
const windowEnd = new Date('2026-07-19T00:00:00.000Z');

test('syncWhoopWindow upserts mapped daily metrics and reports touched metrics', async () => {
  const { syncWhoopWindow } = await syncModule;
  const repo = new FakeSyncRepository();
  const input: WhoopSyncWindowInput = {
    ...emptyWindowInput(),
    cycles: [{ id: 1, user_id: 1, start: '2026-07-10T12:00:00.000Z', end: null, score_state: 'SCORED', score: { strain: 9, kilojoule: 100, average_heart_rate: 70, max_heart_rate: 120 } }],
  };

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input);

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

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, emptyWindowInput());

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

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input);

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

  const result = await syncWhoopWindow(repo, 'user-1', 'UTC', windowStart, windowEnd, input);

  assert.equal(repo.insertCalls.length, 0);
  assert.equal(result.workoutEventsWritten, 0);
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
    { connectionId: 'conn-1', userId: 'user-1', timezone: 'UTC' },
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
    { connectionId: 'conn-1', userId: 'user-1', timezone: 'UTC' },
    tokenStore,
    repo,
    windowStart,
    windowEnd,
  );

  assert.deepEqual(result.touchedMetrics, []);
  assert.equal(repo.upsertCalls.length, 0);
  assert.equal(recomputeCalls.length, 0);
});
