import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real GET handler against a fake `@/db` — no Postgres.
 * mock.module() must run before ./route is first imported; node:test
 * isolates each test file in its own subprocess.
 */

const state: {
  usersRow: Array<{ timezone: string | null }>;
  eventRows: Array<{ timestamp: Date; payload: unknown }>;
  dailyMetricRows: Array<{ date: string; value: number; payload: unknown }>;
} = { usersRow: [{ timezone: 'UTC' }], eventRows: [], dailyMetricRows: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) return { where: () => ({ limit: async () => state.usersRow }) };
      if (table === realSchema.events) {
        return { where: () => Promise.resolve(state.eventRows) };
      }
      if (table === realSchema.daily_metrics) {
        return { where: () => Promise.resolve(state.dailyMetricRows) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const routePromise = import('./route');

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://local/api/trends/markers${query}`, { headers });
}

function resetState() {
  state.usersRow = [{ timezone: 'UTC' }];
  state.eventRows = [];
  state.dailyMetricRows = [];
}

test('no x-user-id -> 401', async () => {
  resetState();
  const { GET } = await routePromise;
  const res = await GET(request(''));
  assert.equal(res.status, 401);
});

test('default days is 90 when not provided', async () => {
  resetState();
  const { GET } = await routePromise;
  const res = await GET(request('', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.equal(body.days, 90);
});

test('days is clamped to [1, 365]', async () => {
  resetState();
  const { GET } = await routePromise;
  const tooBig = await (await GET(request('?days=9999', { 'x-user-id': 'user-1' }))).json();
  assert.equal(tooBig.days, 365);
  const tooSmall = await (await GET(request('?days=0', { 'x-user-id': 'user-1' }))).json();
  assert.equal(tooSmall.days, 1);
});

test('a non-numeric ?days= falls back to 90 instead of surviving as NaN', async () => {
  resetState();
  const { GET } = await routePromise;
  const res = await GET(request('?days=abc', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.equal(body.days, 90);
});

test('buckets workout_completed events into local-day markers, oldest to newest', async () => {
  resetState();
  state.eventRows = [
    { timestamp: new Date('2026-09-05T12:00:00Z'), payload: { type: 'running' } },
    { timestamp: new Date('2026-09-01T08:00:00Z'), payload: { type: 'cycling' } },
    { timestamp: new Date('2026-09-01T18:00:00Z'), payload: { type: 'yoga' } },
  ];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.markers, [
    { date: '2026-09-01', kind: 'workout', label: '2 workouts', count: 2 },
    { date: '2026-09-05', kind: 'workout', label: 'Running', count: 1 },
  ]);
});

test('empty result set yields no markers', async () => {
  resetState();
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.markers, []);
});

test('daily_metrics workouts row surfaces as a marker for a HealthKit-only user', async () => {
  resetState();
  state.dailyMetricRows = [
    { date: '2026-09-02', value: 1, payload: [{ hkUuid: 'a', type: 'running', durationMin: 30 }] },
  ];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.markers, [{ date: '2026-09-02', kind: 'workout', label: 'Running', count: 1 }]);
});

test('a day present in both sources is not double-counted: daily_metrics wins', async () => {
  resetState();
  state.dailyMetricRows = [
    { date: '2026-09-02', value: 1, payload: [{ hkUuid: 'a', type: 'running', durationMin: 30 }] },
  ];
  state.eventRows = [
    { timestamp: new Date('2026-09-02T20:00:00Z'), payload: { sport_name: 'cycling' } },
  ];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.markers, [{ date: '2026-09-02', kind: 'workout', label: 'Running', count: 1 }]);
});

test('a malformed daily_metrics payload falls back to the row value instead of dropping the day', async () => {
  resetState();
  state.dailyMetricRows = [{ date: '2026-09-02', value: 2, payload: null }];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.markers, [{ date: '2026-09-02', kind: 'workout', label: '2 workouts', count: 2 }]);
});

test('merges disjoint dates from both sources', async () => {
  resetState();
  state.dailyMetricRows = [
    { date: '2026-09-02', value: 1, payload: [{ hkUuid: 'a', type: 'running', durationMin: 30 }] },
  ];
  state.eventRows = [
    { timestamp: new Date('2026-09-05T12:00:00Z'), payload: { sport_name: 'cycling' } },
  ];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.markers, [
    { date: '2026-09-02', kind: 'workout', label: 'Running', count: 1 },
    { date: '2026-09-05', kind: 'workout', label: 'Cycling', count: 1 },
  ]);
});
