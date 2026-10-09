import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../db/schema';

/**
 * Drives the real GET/PATCH handlers against a fake `@/db` (no Postgres) and
 * fakes for the memory/weight-log file-backed modules (no filesystem writes)
 * — same pattern as app/api/whoop/status/route.test.ts and
 * lib/brain/tools.getSchedule.test.ts. mock.module() must run before the
 * route's first import; node:test isolates each test file in its own
 * subprocess, so this lives on its own.
 *
 * Focus: loggedDays (GET) and the weight-log day key (PATCH) must bucket by
 * the user's *local* day, not UTC — see app/api/profile/route.ts's comments
 * on both sites. A meal or weight-log write near local midnight in a
 * timezone behind UTC (e.g. America/Chicago) already rolled into the next
 * UTC day; bucketing by UTC would invent a phantom day / misfile the entry.
 */

const state: {
  userRow: Array<{
    name: string; onboarded_at: Date | null; created_at: Date;
    sleep_goal_minutes: number | null; lights_out_minutes: number | null;
    timezone: string | null; unit_system: string | null;
    target_date?: string | null; target_weight_kg?: number | null;
  }>;
  dmDates: Array<{ date: string }>;
  mealRows: Array<{ timestamp: Date }>;
  aggRow: Array<Record<string, unknown>>;
} = {
  userRow: [{
    name: 'Test User', onboarded_at: new Date('2026-01-01T00:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z'),
    sleep_goal_minutes: 480, lights_out_minutes: 1350, timezone: 'America/Chicago', unit_system: null,
  }],
  dmDates: [],
  mealRows: [],
  aggRow: [{ avg_hrv: null, workouts: 0, row_count: 0 }],
};

const userUpdateCalls: Array<Record<string, unknown>> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.userRow }) };
      }
      if (table === realSchema.events) {
        return { where: async () => state.mealRows };
      }
      throw new Error(`unexpected select().from(): ${String(table)}`);
    },
  }),
  selectDistinct: () => ({
    from: (table: unknown) => {
      if (table === realSchema.daily_metrics) {
        return { where: async () => state.dmDates };
      }
      throw new Error(`unexpected selectDistinct().from(): ${String(table)}`);
    },
  }),
  execute: async () => state.aggRow,
  update: (table: unknown) => ({
    set: (assigned: Record<string, unknown>) => {
      if (table === realSchema.users) userUpdateCalls.push(assigned);
      return {
        where: () => ({
          returning: async () => [{ ...state.userRow[0], ...assigned }],
        }),
      };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/baselines', {
  namedExports: { getCalibration: async () => ({ status: 'ready', metrics: {} }) },
});
mock.module('@/lib/memory', {
  namedExports: { readMemoryFile: () => null, writeMemoryFile: () => {} },
});
mock.module('@/lib/profileDetails', {
  namedExports: {
    parseProfileDetails: () => ({ age: null, biologicalSex: null, heightCm: null, weightKg: null }),
    updateIdentityLines: () => {},
    formatSleepSubtitle: (minutes: number) => `${minutes / 60}h target`,
  },
});
const loggedWeightCalls: Array<{ userId: string; valueKg: number; timezone: unknown }> = [];
const importLegacyCalls: Array<{ userId: string; timezone: unknown }> = [];
mock.module('@/lib/weightRepository', {
  namedExports: {
    logWeightEntry: async (userId: string, input: { valueKg: number; measuredAt: Date; source: string; timezone: unknown }) => {
      loggedWeightCalls.push({ userId, valueKg: input.valueKg, timezone: input.timezone });
      return { id: 'event-1', localDay: '2026-01-01', deduped: false };
    },
    importLegacyWeightLogIfPresent: async (userId: string, timezone: unknown) => {
      importLegacyCalls.push({ userId, timezone });
    },
  },
});

// Goal-target PATCH tests: no real trend lookup / cache — only the route's own
// validation and write decisions are under test.
mock.module('@/lib/goalStart', {
  namedExports: {
    buildGoalRestart: async () => ({ goal_started_at: new Date(), goal_start_weight_kg: null }),
    shouldReanchorGoalForTarget: async () => false,
  },
});
mock.module('@/lib/brain/goalProgressCache', {
  namedExports: { invalidateGoalProgress: () => {} },
});

const routePromise = import('./route');

function getRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/profile', { headers });
}

function patchRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET counts a meal logged just after local midnight (already the next UTC day) as one local day, not two', async () => {
  // 2026-07-14T05:30:00Z is 2026-07-14 00:30 America/Chicago (CDT, UTC-5) —
  // already local "Jul 14", but still UTC "Jul 14" too (a boundary case where
  // UTC and local agree) is not the interesting case; use a late-night entry
  // that IS a different UTC day than the local day it belongs to.
  state.dmDates = [{ date: '2026-07-13' }];
  // 2026-07-13 23:30 CDT == 2026-07-14 04:30 UTC — local day is Jul 13, but a
  // UTC-day bucketing would (wrongly) call this Jul 14, inventing a second
  // "logged day" alongside the daily_metrics Jul 13 entry above.
  state.mealRows = [{ timestamp: new Date('2026-07-14T04:30:00.000Z') }];

  const { GET } = await routePromise;
  const res = await GET(getRequest({ 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.stats.loggedDays, 1, 'meal and daily_metrics entry should collapse into the same local day');
});

test('GET counts a meal logged on a distinct local day as a separate logged day', async () => {
  state.dmDates = [{ date: '2026-07-13' }];
  // 2026-07-14 12:00 CDT == 2026-07-14 17:00 UTC — unambiguously the next
  // local day relative to the daily_metrics entry above.
  state.mealRows = [{ timestamp: new Date('2026-07-14T17:00:00.000Z') }];

  const { GET } = await routePromise;
  const res = await GET(getRequest({ 'x-user-id': 'user-1' }));
  const body = await res.json();

  assert.equal(body.stats.loggedDays, 2);
});

test('PATCH looks up the user\'s stored timezone and logs weight under lib/localDay\'s local-day key', async () => {
  // The route reads `new Date()` internally (not injectable), so a live
  // local-midnight-vs-UTC boundary can't be forced deterministically here;
  // that behavior is exhaustively covered for the shared localDayKey /
  // pickTimeZone helpers this route now delegates to in lib/streak.test.ts
  // (including a DST-transition case). This test instead proves the wiring:
  // PATCH fetches users.timezone and threads it into logWeightEntry's
  // timezone, rather than the bare UTC slice the route used before this fix.
  loggedWeightCalls.length = 0;
  importLegacyCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago' }];

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ weightKg: 81.2 }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  assert.equal(loggedWeightCalls.length, 1);
  assert.equal(loggedWeightCalls[0].timezone, 'America/Chicago');
  assert.equal(loggedWeightCalls[0].valueKg, 81.2);

  // The legacy weight-log.json import must run before the write, since iOS
  // has zero callers of /api/weight-log — this PATCH may be the only write
  // path a user's weigh-ins ever go through.
  assert.equal(importLegacyCalls.length, 1);
  assert.equal(importLegacyCalls[0].timezone, 'America/Chicago');
});

test('GET returns unitSystem: null when the column is unset', async () => {
  state.userRow = [{ ...state.userRow[0], unit_system: null }];

  const { GET } = await routePromise;
  const res = await GET(getRequest({ 'x-user-id': 'user-1' }));
  const body = await res.json();

  assert.equal(body.unitSystem, null);
});

test('GET returns unitSystem: "imperial" when the column is set', async () => {
  state.userRow = [{ ...state.userRow[0], unit_system: 'imperial' }];

  const { GET } = await routePromise;
  const res = await GET(getRequest({ 'x-user-id': 'user-1' }));
  const body = await res.json();

  assert.equal(body.unitSystem, 'imperial');
});

test('PATCH persists a valid unitSystem', async () => {
  userUpdateCalls.length = 0;

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ unitSystem: 'imperial' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  assert.equal(userUpdateCalls.length, 1);
  assert.equal(userUpdateCalls[0].unit_system, 'imperial');
});

test('PATCH 400s on a garbage unitSystem value', async () => {
  userUpdateCalls.length = 0;

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ unitSystem: 'us' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 400);

  assert.equal(userUpdateCalls.length, 0);
});

// ── Target date: a passed date must never dead-end goal edits ───────────────

/** 'YYYY-MM-DD' for today + `offsetDays` in the fixture user's timezone (America/Chicago). */
function chicagoDay(offsetDays: number): string {
  const ms = Date.now() + offsetDays * 86_400_000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
}

test('PATCH accepts an UNCHANGED past targetDate alongside a new target weight (200) and does not rewrite the date', async () => {
  userUpdateCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago', target_date: '2020-01-15', target_weight_kg: 80 }];

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ targetWeightKg: 76, targetDate: '2020-01-15' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  assert.equal(userUpdateCalls.length, 1);
  assert.equal(userUpdateCalls[0].target_weight_kg, 76);
  assert.equal('target_date' in userUpdateCalls[0], false, 'an unchanged date is not rewritten');
});

test('PATCH accepts the unchanged past targetDate on its own (200, nothing written)', async () => {
  userUpdateCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago', target_date: '2020-01-15', target_weight_kg: 80 }];

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ targetDate: '2020-01-15' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  assert.equal(userUpdateCalls.length, 0);
});

test('PATCH omitting targetDate still edits the target weight when the stored date has passed', async () => {
  userUpdateCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago', target_date: '2020-01-15', target_weight_kg: 80 }];

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ targetWeightKg: 75 }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  assert.equal(userUpdateCalls[0].target_weight_kg, 75);
  assert.equal('target_date' in userUpdateCalls[0], false);
});

test('PATCH 400s a NEW past targetDate with the specific "must be in the future" message', async () => {
  userUpdateCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago', target_date: '2020-01-15', target_weight_kg: 80 }];

  const { PATCH } = await routePromise;
  const res = await PATCH(patchRequest({ targetWeightKg: 76, targetDate: '2021-03-01' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Target date must be in the future' });
  assert.equal(userUpdateCalls.length, 0, 'a rejected request writes nothing');
});

test('PATCH 400s a new targetDate of today with the same message, and accepts tomorrow-or-later', async () => {
  userUpdateCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago', target_date: null, target_weight_kg: null }];

  const { PATCH } = await routePromise;
  const today = await PATCH(patchRequest({ targetDate: chicagoDay(0) }, { 'x-user-id': 'user-1' }));
  assert.equal(today.status, 400);
  assert.equal((await today.json()).error, 'Target date must be in the future');

  const later = chicagoDay(30);
  const ok = await PATCH(patchRequest({ targetDate: later }, { 'x-user-id': 'user-1' }));
  assert.equal(ok.status, 200);
  assert.equal(userUpdateCalls[0].target_date, later);
});

test('PATCH keeps the generic message for a malformed targetDate and still lets null clear it', async () => {
  userUpdateCalls.length = 0;
  state.userRow = [{ ...state.userRow[0], timezone: 'America/Chicago', target_date: '2020-01-15', target_weight_kg: 80 }];

  const { PATCH } = await routePromise;
  const bad = await PATCH(patchRequest({ targetDate: 'soon' }, { 'x-user-id': 'user-1' }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /targetDate must be a YYYY-MM-DD date in the future/);

  const cleared = await PATCH(patchRequest({ targetDate: null }, { 'x-user-id': 'user-1' }));
  assert.equal(cleared.status, 200);
  assert.equal(userUpdateCalls[0].target_date, null);
});
