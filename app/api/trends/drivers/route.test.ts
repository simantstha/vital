import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real GET handler against fakes for `@/db`, `@/lib/insights/series`
 * and `@/lib/insights/drivers` — no Postgres. mock.module() must run before
 * ./route is first imported; node:test isolates each test file in its own
 * subprocess. Focus: the route is a thin wrapper — auth, timezone resolution,
 * and handing off to `computeDrivers` — so these tests check request
 * validation and that the right arguments reach `computeDrivers`, not the
 * driver-selection logic itself (that's lib/insights/drivers.test.ts).
 */

const state: { usersRow: Array<{ timezone: string | null }> } = { usersRow: [{ timezone: 'America/Chicago' }] };

let computeDriversCalls: Array<{ userId: string; metric: string; localToday: string }> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) return { where: () => ({ limit: async () => state.usersRow }) };
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/insights/series', { namedExports: { loadSeries: async () => [] } });
mock.module('@/lib/insights/drivers', {
  namedExports: {
    latestComputedFor: async () => null,
    findingsForDay: async () => [],
    computeDrivers: async (_repo: unknown, userId: string, metric: string, localToday: string) => {
      computeDriversCalls.push({ userId, metric, localToday });
      return { metric, computedFor: '2026-09-20', drivers: [{ input: 'steps', lag: 0, direction: 'up', rho: 0.4, pairs: 40, high: null, low: null, highInputMean: null, lowInputMean: null }] };
    },
  },
});

const routePromise = import('./route');

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://local/api/trends/drivers${query}`, { headers });
}

test('missing metric -> 400', async () => {
  const { GET } = await routePromise;
  const res = await GET(request('', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 400);
});

test('no x-user-id -> 401', async () => {
  const { GET } = await routePromise;
  const res = await GET(request('?metric=hrv_sdnn'));
  assert.equal(res.status, 401);
});

test('valid request calls computeDrivers with the user id, metric, and resolved local day, and returns its result', async () => {
  computeDriversCalls = [];
  const { GET } = await routePromise;
  const res = await GET(request('?metric=hrv_sdnn', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(computeDriversCalls.length, 1);
  assert.equal(computeDriversCalls[0].userId, 'user-1');
  assert.equal(computeDriversCalls[0].metric, 'hrv_sdnn');
  assert.match(computeDriversCalls[0].localToday, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal(body.metric, 'hrv_sdnn');
  assert.equal(body.computedFor, '2026-09-20');
  assert.equal(body.drivers.length, 1);
});

test('a request-supplied ?tz= overrides the stored timezone', async (t) => {
  computeDriversCalls = [];
  state.usersRow = [{ timezone: 'America/Chicago' }];
  // 2026-09-01T23:30:00Z is 2026-09-02 in Tokyo (UTC+9) but still 2026-09-01
  // in Chicago (UTC-5 in September DST) — a real fork between the two.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-01T23:30:00Z') });
  const { GET } = await routePromise;
  await GET(request('?metric=hrv_sdnn&tz=Asia/Tokyo', { 'x-user-id': 'user-1' }));
  assert.equal(computeDriversCalls.length, 1);
  assert.equal(computeDriversCalls[0].localToday, '2026-09-02');
});
