import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import { localDayKey } from '../localDay';

/**
 * lib/brain/brief.ts's generateDailyBriefFromDb bucketed recentActivities /
 * weeklyMileage / recentNutrition day-keys off the raw UTC instant
 * (`e.timestamp.toISOString().split('T')[0]`), which misfiles any event that
 * happens near local midnight in a non-UTC timezone (the same class of bug
 * as app/api/profile/route.ts's loggedDays union). This drives the real
 * function against a fake `@/db` (no Postgres) and fakes for
 * lib/brain/tools, lib/brain/baselines, and lib/claude (no Anthropic call)
 * — same pattern as app/api/whoop/status/route.test.ts. mock.module() must
 * run before brief.ts is first imported; node:test isolates each test file
 * in its own subprocess, so this lives on its own.
 */

const state: {
  userRow: Array<{ timezone: string | null; unit_system?: string | null }>;
  events: Array<{ type: string; timestamp: Date; payload: unknown }>;
} = { userRow: [{ timezone: 'America/Chicago' }], events: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.userRow }) };
      }
      if (table === realSchema.events) {
        return { where: () => ({ orderBy: async () => state.events }) };
      }
      if (table === realSchema.nodes) {
        return { where: () => ({ orderBy: async () => [] }) };
      }
      throw new Error(`unexpected select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/baselines', {
  namedExports: { getCalibration: async () => ({ status: 'ready', metrics: {} }) },
});
mock.module('@/lib/brain/tools', {
  namedExports: {
    queryBaseline: async () => null,
    queryMetricPoints: async () => [],
    querySleepSummary: async () => ({ nights: [] }),
  },
});
let capturedCtx: Record<string, unknown> | null = null;
mock.module('@/lib/claude', {
  namedExports: {
    generateDailyBrief: async (_userId: string, ctx: Record<string, unknown>) => {
      capturedCtx = ctx;
      return { date: '2026-01-01', generatedAt: new Date().toISOString(), body: '', chips: [], meals: [] };
    },
  },
});

const briefPromise = import('./brief');

test('weekStartKeyFromLocalDay walks an already-local day back to that local week\'s Sunday', async () => {
  const { weekStartKeyFromLocalDay } = await briefPromise;
  // 2026-07-15 is a Wednesday; its week's Sunday is 2026-07-12.
  assert.equal(weekStartKeyFromLocalDay('2026-07-15'), '2026-07-12');
  // A Sunday maps to itself.
  assert.equal(weekStartKeyFromLocalDay('2026-07-12'), '2026-07-12');
});

test('weekStartKeyFromLocalDay buckets a late-night local Saturday into that week, not next week\'s UTC-shifted Sunday', async () => {
  const { weekStartKeyFromLocalDay } = await briefPromise;
  // The raw UTC day for an 11pm-Saturday-local instant in a UTC-behind
  // timezone can already read as Sunday — the bug this guards against is
  // computing the week key from that UTC-shifted Sunday (which would wrongly
  // start a NEW week) instead of from the correct local Saturday (still the
  // OLD week). Feeding the local day key in gives the old week's Sunday.
  assert.equal(weekStartKeyFromLocalDay('2026-07-18'), '2026-07-12'); // Sat 7/18 -> week of 7/12
  assert.equal(weekStartKeyFromLocalDay('2026-07-19'), '2026-07-19'); // Sun 7/19 -> new week
});

test('generateDailyBriefFromDb buckets a workout/meal by local day, not the UTC day it rolled into', async () => {
  const tz = 'America/Chicago';
  const now = new Date();
  const todayStartUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // Two days before "today" (UTC), at 02:00 UTC. In America/Chicago (UTC-5
  // or UTC-6 year-round), 02:00 UTC is still ~19:00-20:00 the PREVIOUS
  // calendar day locally — so the UTC date string and the local day key
  // disagree by exactly one day, regardless of DST. This instant is well
  // inside the 7-day recentActivities / 3-day recentNutrition windows.
  const instant = new Date(todayStartUTC - 2 * 24 * 3_600_000 + 2 * 3_600_000);
  const utcDateStr = instant.toISOString().slice(0, 10);
  const localDay = localDayKey(instant, tz);
  assert.notEqual(localDay, utcDateStr, 'test instant must actually straddle the UTC/local day boundary');

  state.userRow = [{ timezone: tz }];
  state.events = [
    { type: 'workout_completed', timestamp: instant, payload: { type: 'run', distance_m: 5000, duration_s: 1500 } },
    { type: 'meal_logged', timestamp: instant, payload: { kcal: 500, c: 50, p: 30, f: 20 } },
  ];
  capturedCtx = null;

  const { generateDailyBriefFromDb, weekStartKeyFromLocalDay } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  const recentActivities = capturedCtx!.recentActivities as Array<{ date: string }>;
  const recentNutrition = capturedCtx!.recentNutrition as Array<{ date: string }>;
  const weeklyMileage = capturedCtx!.weeklyMileage as Array<{ weekStart: string }>;

  assert.equal(recentActivities.length, 1);
  assert.equal(recentActivities[0].date, localDay);
  assert.notEqual(recentActivities[0].date, utcDateStr);

  assert.equal(recentNutrition.length, 1);
  assert.equal(recentNutrition[0].date, localDay);
  assert.notEqual(recentNutrition[0].date, utcDateStr);

  assert.equal(weeklyMileage.length, 1);
  assert.equal(weeklyMileage[0].weekStart, weekStartKeyFromLocalDay(localDay));
});

/**
 * Regression test for the pre-existing miles bug: this brief used to
 * hardcode `M_TO_MI` for every user regardless of `unit_system`, while coach
 * chat (lib/brain/context.ts) and the data tools (lib/brain/tools.ts)
 * hardcoded km — the two surfaces contradicted each other for a metric user.
 * A metric (or unset) `unit_system` must produce `distanceUnit: 'km'` and
 * km-valued distance fields.
 */
test('a metric user\'s brief carries km, not miles — the regression test for the miles-hardcoding bug', async () => {
  const now = new Date();
  state.userRow = [{ timezone: 'America/Chicago', unit_system: 'metric' }];
  state.events = [
    { type: 'workout_completed', timestamp: now, payload: { type: 'run', distance_m: 5000, duration_s: 1500 } },
  ];
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  assert.equal(capturedCtx!.distanceUnit, 'km');
  assert.equal(capturedCtx!.unitSystem, 'metric');
  assert.equal(capturedCtx!.weeklyDistance, 5); // 5000m -> 5.0km, not miles
  const lastRun = capturedCtx!.lastRun as { distance: string; pace: string } | null;
  assert.equal(lastRun?.distance, '5.0');
  assert.equal(lastRun?.pace, '5:00'); // 1500s / 5km = 5:00/km
});

test('an imperial user\'s brief carries mi, converted from the same metric-stored distance', async () => {
  const now = new Date();
  state.userRow = [{ timezone: 'America/Chicago', unit_system: 'imperial' }];
  state.events = [
    { type: 'workout_completed', timestamp: now, payload: { type: 'run', distance_m: 5000, duration_s: 1500 } },
  ];
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  assert.equal(capturedCtx!.distanceUnit, 'mi');
  assert.equal(capturedCtx!.unitSystem, 'imperial');
  const lastRun = capturedCtx!.lastRun as { distance: string } | null;
  assert.equal(lastRun?.distance, (5000 / 1000 / 1.609344).toFixed(1)); // "3.1"
});
