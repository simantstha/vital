import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../db/schema';

/**
 * Drives the real POST/GET handlers against a fake `@/db` (timezone lookup
 * only) and a fake `@/lib/weightRepository` (no Postgres, no filesystem) —
 * same pattern as app/api/whoop/status/route.test.ts and
 * lib/brain/tools.logMeal.test.ts. mock.module() must run before ./route is
 * first imported; node:test isolates each test file in its own subprocess.
 */

const state: {
  usersRow: Array<{ timezone: string | null }>;
  readings: Array<{ measuredAt: string; valueKg: number; source: 'manual' | 'healthkit' | 'coach'; localDay: string }>;
} = { usersRow: [{ timezone: 'UTC' }], readings: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) return { where: () => ({ limit: async () => state.usersRow }) };
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

let logWeightEntryCalls: Array<Record<string, unknown>> = [];
let importCalls: Array<{ userId: string; timezone: unknown }> = [];
let getWeightReadingsCalls: Array<{ userId: string; days: number; timezone: unknown }> = [];

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/weightRepository', {
  namedExports: {
    logWeightEntry: async (userId: string, input: Record<string, unknown>) => {
      logWeightEntryCalls.push({ userId, ...input });
      return { id: 'event-1', localDay: '2026-08-01', deduped: false };
    },
    importLegacyWeightLogIfPresent: async (userId: string, timezone: unknown) => {
      importCalls.push({ userId, timezone });
    },
    getWeightReadings: async (userId: string, days: number, timezone: unknown) => {
      getWeightReadingsCalls.push({ userId, days, timezone });
      return state.readings;
    },
  },
});

const routePromise = import('./route');

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/weight-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function getRequest(query = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://local/api/weight-log${query}`, { headers });
}

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await routePromise;
  const res = await POST(postRequest({ weight: 180, unit: 'lbs', date: '2026-08-01' }));
  assert.equal(res.status, 401);
});

test('POST 400s when weight or date is missing', async () => {
  const { POST } = await routePromise;
  const res1 = await POST(postRequest({ date: '2026-08-01' }, { 'x-user-id': 'user-1' }));
  assert.equal(res1.status, 400);
  const res2 = await POST(postRequest({ weight: 180 }, { 'x-user-id': 'user-1' }));
  assert.equal(res2.status, 400);
});

test('POST converts lbs to kg (default unit) and returns { ok: true } — backward-compatible shape', async () => {
  logWeightEntryCalls = [];
  importCalls = [];
  state.usersRow = [{ timezone: 'UTC' }];

  const { POST } = await routePromise;
  const res = await POST(postRequest({ weight: 180, date: '2026-01-01' }, { 'x-user-id': 'user-1' }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });

  assert.equal(importCalls.length, 1); // lazy legacy import attempted
  assert.equal(logWeightEntryCalls.length, 1);
  assert.equal(logWeightEntryCalls[0].source, 'manual');
  assert.ok(Math.abs((logWeightEntryCalls[0].valueKg as number) - 81.65) < 0.05);
});

test('POST with unit "kg" passes the value through unconverted', async () => {
  logWeightEntryCalls = [];

  const { POST } = await routePromise;
  await POST(postRequest({ weight: 81.5, unit: 'kg', date: '2026-01-01' }, { 'x-user-id': 'user-1' }));

  assert.equal(logWeightEntryCalls[0].valueKg, 81.5);
});

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  const res = await GET(getRequest());
  assert.equal(res.status, 401);
});

test('GET attempts the lazy legacy import, then returns entries + trend built from getWeightReadings', async () => {
  importCalls = [];
  getWeightReadingsCalls = [];
  state.readings = [
    { measuredAt: '2026-08-01T07:00:00.000Z', valueKg: 80, source: 'manual', localDay: '2026-08-01' },
    { measuredAt: '2026-08-02T07:00:00.000Z', valueKg: 79.8, source: 'healthkit', localDay: '2026-08-02' },
  ];

  const { GET } = await routePromise;
  const res = await GET(getRequest('?days=30', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(importCalls.length, 1);
  assert.equal(getWeightReadingsCalls[0].days, 30);

  assert.equal(body.entries.length, 2);
  assert.deepEqual(body.entries[0], { date: '2026-08-01', weight: 80, unit: 'kg', source: 'manual' });
  assert.equal(body.trend.days.length, 2);
  assert.equal(typeof body.trend.established, 'boolean');
});

test('GET defaults days to 90 and clamps an out-of-range value to 365', async () => {
  getWeightReadingsCalls = [];
  state.readings = [];

  const { GET } = await routePromise;
  await GET(getRequest('', { 'x-user-id': 'user-1' }));
  assert.equal(getWeightReadingsCalls[0].days, 90);

  await GET(getRequest('?days=999999', { 'x-user-id': 'user-1' }));
  assert.equal(getWeightReadingsCalls[1].days, 365);
});
