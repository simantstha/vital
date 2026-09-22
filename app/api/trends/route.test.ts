import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../db/schema';

/**
 * Drives the real GET handler (both the legacy ?metric= branch and the
 * ?metrics= batch branch) against fakes for `@/db`, `@/lib/brain/tools`,
 * `@/lib/brain/baselines`, and `@/lib/weightRepository` — no Postgres.
 * mock.module() must run before ./route is first imported; node:test
 * isolates each test file in its own subprocess.
 *
 * Focus: the regression fix where iOS has zero callers of
 * POST/GET /api/weight-log, so the lazy legacy weight-log.json import
 * (lib/weightRepository.importLegacyWeightLogIfPresent) needed a second
 * call site here — otherwise a legacy file entry would never appear in
 * Trends' manual-weight overlay. The fake importLegacyWeightLogIfPresent
 * below only populates its backing store when called, and
 * queryManualWeightOverlay only ever reads that store — so these tests fail
 * if the route reads the overlay before calling the import.
 */

const state: {
  usersRow: Array<{ timezone: string | null }>;
  legacyEntries: Array<{ localDay: string; valueKg: number }>;
} = { usersRow: [{ timezone: 'UTC' }], legacyEntries: [] };

let importedStore: Array<{ localDay: string; valueKg: number }> = [];
let importCalls: Array<{ userId: string; timezone: unknown }> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) return { where: () => ({ limit: async () => state.usersRow }) };
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/baselines', {
  namedExports: { getCalibration: async () => ({ status: 'ready', metrics: {} }) },
});
mock.module('@/lib/brain/tools', {
  namedExports: {
    queryMetricPoints: async () => [],
    queryMetricPointsMulti: async () => [],
    queryMetricDataDays: async () => [],
    queryAllBaselines: async () => [],
  },
});
mock.module('@/lib/weightRepository', {
  namedExports: {
    // Only source of truth for what queryManualWeightOverlay can see — proves
    // the route calls this BEFORE reading the overlay, not just eventually.
    importLegacyWeightLogIfPresent: async (userId: string, timezone: unknown) => {
      importCalls.push({ userId, timezone });
      importedStore = importedStore.concat(state.legacyEntries);
    },
    queryManualWeightOverlay: async () => {
      const map = new Map<string, number>();
      for (const e of importedStore) map.set(e.localDay, e.valueKg);
      return map;
    },
  },
});

const routePromise = import('./route');

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://local/api/trends${query}`, { headers });
}

test('legacy ?metric=weight branch: a legacy weight-log.json entry appears in the response on first read', async () => {
  importCalls = [];
  importedStore = [];
  state.legacyEntries = [{ localDay: '2026-07-15', valueKg: 80.4 }];
  state.usersRow = [{ timezone: 'America/Chicago' }];

  const { GET } = await routePromise;
  const res = await GET(request('?metric=weight&days=90', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(importCalls.length, 1);
  assert.equal(importCalls[0].timezone, 'America/Chicago');

  const point = body.points.find((p: { date: string }) => p.date === '2026-07-15');
  assert.ok(point, 'legacy entry should surface in the weight series on the very first read');
  assert.equal(point.value, 80.4);
});

test('legacy ?metric= branch never imports for a non-weight metric', async () => {
  importCalls = [];
  const { GET } = await routePromise;
  await GET(request('?metric=hrv&days=30', { 'x-user-id': 'user-1' }));
  assert.equal(importCalls.length, 0);
});

test('?metrics= batch branch: a legacy entry appears when body_mass_kg is requested, imported before the overlay read', async () => {
  importCalls = [];
  importedStore = [];
  state.legacyEntries = [{ localDay: '2026-07-20', valueKg: 79.1 }];

  const { GET } = await routePromise;
  const res = await GET(request('?metrics=body_mass_kg&days=90', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(importCalls.length, 1);
  const point = body.series.body_mass_kg.points.find((p: { date: string }) => p.date === '2026-07-20');
  assert.ok(point, 'legacy entry should surface in the batch series on the very first read');
  assert.equal(point.value, 79.1);
});

test('?metrics= batch branch never imports when body_mass_kg is not requested', async () => {
  importCalls = [];
  const { GET } = await routePromise;
  await GET(request('?metrics=hrv_sdnn,steps&days=30', { 'x-user-id': 'user-1' }));
  assert.equal(importCalls.length, 0);
});
