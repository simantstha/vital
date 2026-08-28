import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';
import * as realSchema from '../../db/schema';
import { localDayKey, previousDayKey } from '../localDay';

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

type BaselineFixture = { stats: { mean30: number | null } | null; established: boolean; dataDays: number };
type MetricPointFixture = { date: string; value: number };
type SleepSummaryFixture = { nights: Array<{ date: string; minutes: number; stages: unknown }> };

const state: {
  userRow: Array<{ timezone: string | null; unit_system?: string | null; sleep_goal_minutes?: number | null }>;
  events: Array<{ type: string; timestamp: Date; payload: unknown }>;
  whoopConn: Array<{ status: string }>;
  baselines: Record<string, BaselineFixture | null>;
  metricPoints: Record<string, MetricPointFixture[]>;
  sleepSummaries: Record<string, SleepSummaryFixture>;
} = {
  userRow: [{ timezone: 'America/Chicago' }],
  events: [],
  whoopConn: [],
  baselines: {},
  metricPoints: {},
  sleepSummaries: {},
};

// The recovery-scoring additions (lib/brain/brief.ts reading whoop_connections
// + per-metric baselines/points) are opt-in per test via `state.whoopConn` /
// `state.baselines` / `state.metricPoints` / `state.sleepSummaries` — reset
// here so a test that sets them up doesn't leak into the next one. userRow
// and events are NOT reset here since every existing test already sets them
// explicitly at the top of its body.
beforeEach(() => {
  state.whoopConn = [];
  state.baselines = {};
  state.metricPoints = {};
  state.sleepSummaries = {};
});

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
      if (table === realSchema.whoop_connections) {
        return { where: () => ({ limit: async () => state.whoopConn }) };
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
    queryBaseline: async (_userId: string, metric: string) => state.baselines[metric] ?? null,
    queryMetricPoints: async (_userId: string, metric: string, _days: number) => state.metricPoints[metric] ?? [],
    querySleepSummary: async (_userId: string, _days: number, metric: string = 'sleep_minutes') =>
      state.sleepSummaries[metric] ?? { nights: [] },
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

/**
 * Recovery-scoring integration tests (lib/brain/recovery.ts wired through
 * lib/brain/brief.ts). These drive the REAL computeRecovery/selectHrvSource/
 * buildRecoveryHistory logic — only the DB reads (queryBaseline,
 * queryMetricPoints, querySleepSummary, the whoop_connections probe) are
 * faked via `state`.
 */

test('a user with no HRV data anywhere gets a suppressed (null) recovery score with insufficient confidence, never a fabricated number', async () => {
  state.userRow = [{ timezone: 'America/Chicago' }];
  state.events = [];
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  assert.equal(capturedCtx!.recovery, null);
  assert.equal(capturedCtx!.recoveryConfidence, 'insufficient');
});

test('whoopRecovery arrives as a field separate from recovery — WHOOP\'s own score never overwrites Vital\'s blend', async () => {
  state.userRow = [{ timezone: 'America/Chicago' }];
  state.events = [];
  state.whoopConn = [{ status: 'active' }];
  state.baselines = {
    whoop_hrv_rmssd: { stats: { mean30: 80 }, established: true, dataDays: 30 },
  };
  state.metricPoints = {
    whoop_hrv_rmssd: [{ date: '2026-08-08', value: 80 }],
    whoop_recovery:  [{ date: '2026-08-08', value: 45 }], // WHOOP's own score — deliberately different from Vital's blend
  };
  state.sleepSummaries = {
    // HealthKit reports zero nights, so brief.ts must fall back to
    // whoop_sleep_min (IN-BED time) and convert it via
    // sleepFromWhoopStageSummary — same fixture as recovery.test.ts's
    // "converts in-bed time to asleep time" case (480min in-bed, 45min
    // awake -> 435 asleep / 91% efficiency).
    whoop_sleep_min: { nights: [{ date: '2026-08-08', minutes: 480, stages: { total_awake_time_milli: 45 * 60_000 } }] },
  };
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  assert.equal(capturedCtx!.whoopRecovery, 45);
  assert.notEqual(capturedCtx!.recovery, null);
  assert.notEqual(capturedCtx!.recovery, capturedCtx!.whoopRecovery);
});

test('sleep_goal_minutes: 420 changes the resulting recovery score vs. the 480min default', async () => {
  state.events = [];
  state.baselines = {
    hrv_sdnn: { stats: { mean30: 80 }, established: true, dataDays: 30 },
  };
  state.metricPoints = {
    hrv_sdnn: [{ date: '2026-08-08', value: 80 }],
  };
  state.sleepSummaries = {
    sleep_minutes: { nights: [{ date: '2026-08-08', minutes: 420, stages: { awake: 47 } }] },
  };

  state.userRow = [{ timezone: 'America/Chicago' }]; // sleep_goal_minutes unset -> DEFAULT_SLEEP_GOAL_MIN (480)
  capturedCtx = null;
  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');
  const defaultGoalRecovery = capturedCtx!.recovery;

  state.userRow = [{ timezone: 'America/Chicago', sleep_goal_minutes: 420 }];
  capturedCtx = null;
  await generateDailyBriefFromDb('user-1');
  const customGoalRecovery = capturedCtx!.recovery;

  assert.notEqual(defaultGoalRecovery, null);
  assert.notEqual(customGoalRecovery, null);
  assert.notEqual(defaultGoalRecovery, customGoalRecovery);
});

/**
 * Local-day window-edge regression tests (lib/brain/brief.ts's `dayOf` /
 * `todayKey` / `recentDayKeys` / `nutritionDayKeys` scaffolding). Everything
 * above this point already covers map KEYS being local-day-aware; these cover
 * the WINDOW EDGES (todayEvents, recentEvents, weeklyDistance, the meal
 * window) which used to compare against raw UTC instants
 * (`todayStart`/`sevenDaysAgo`/`threeDaysAgo`/`weekStart`) regardless of the
 * user's timezone. Fixture timestamps are built relative to a computed
 * `utcMidnightToday`, never hardcoded calendar dates, so the suite passes on
 * any day of the year.
 */

test('a workout already local-"today" in a UTC-ahead timezone counts toward strain (UTC-ahead regression)', async () => {
  const tz = 'Asia/Tokyo'; // UTC+9, ahead of UTC — local day can be "today" while the UTC clock still reads yesterday

  // Pin the clock so the fixture's relationship to the tz boundary can't
  // drift with wall-clock time (a live `now` only reproduces this bug before
  // JST's ~15:00 UTC daily rollover point). 2026-03-10T10:00:00Z is safely
  // before that rollover, so JST's "today" still equals the UTC calendar
  // date at `now`.
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 2, 10, 10, 0, 0) });
  try {
    const now = new Date();
    const utcMidnightToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // 2h before UTC midnight = ~22:00 UTC yesterday = ~07:00 JST *today*
    // (Tokyo is UTC+9 year-round, no DST). The old UTC-anchored todayStart
    // excludes this from todayEvents (timestamp < todayStart); the
    // local-day-aware code must include it.
    state.userRow = [{ timezone: tz }];
    state.events = [{
      type: 'workout_completed',
      timestamp: new Date(utcMidnightToday.getTime() - 2 * 3_600_000),
      payload: { type: 'run', distance_m: 5000, duration_s: 1500 },
    }];
    capturedCtx = null;

    const { generateDailyBriefFromDb } = await briefPromise;
    await generateDailyBriefFromDb('user-1');

    assert.equal(capturedCtx!.strain, '–');
  } finally {
    mock.timers.reset();
  }
});

test('a workout that already rolled into UTC-"today" but is still local-yesterday in a UTC-behind timezone does not count toward strain (UTC-behind regression)', async () => {
  const tz = 'America/Chicago'; // UTC-5/-6, behind UTC — the UTC clock rolls to a new date before the local day does

  // Pin the clock for the same reason as the JST test above: 2026-01-15
  // (CST, no DST ambiguity) at 20:00 UTC is safely past Chicago's own daily
  // rollover, so Chicago's "today" already equals the UTC calendar date.
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 15, 20, 0, 0) });
  try {
    const now = new Date();
    const utcMidnightToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // 3h after UTC midnight = 03:00 UTC today = ~21:00 CST *yesterday* in
    // Chicago. The old UTC-anchored todayStart has no upper bound, so it
    // wrongly includes this in todayEvents (timestamp >= todayStart); the
    // local-day-aware code must exclude it.
    state.userRow = [{ timezone: tz }];
    state.events = [{
      type: 'workout_completed',
      timestamp: new Date(utcMidnightToday.getTime() + 3 * 3_600_000),
      payload: { type: 'run', distance_m: 5000, duration_s: 1500 },
    }];
    capturedCtx = null;

    const { generateDailyBriefFromDb } = await briefPromise;
    await generateDailyBriefFromDb('user-1');

    assert.equal(capturedCtx!.strain, '0.0');
  } finally {
    mock.timers.reset();
  }
});

test('weeklyDistance and weeklyMileage never diverge across the Saturday-night/Sunday-morning local boundary', async () => {
  const tz = 'America/Chicago';
  const now = new Date();
  const { weekStartKeyFromLocalDay } = await briefPromise;
  const todayKey = localDayKey(now, tz);
  const thisWeekKey = weekStartKeyFromLocalDay(todayKey);

  // Noon UTC on the Sunday that starts this local week: for Chicago's small,
  // fixed-sign UTC offset (-5/-6h), that instant is always mid-morning
  // *local* Sunday — never spills into the surrounding days. One run 8h
  // earlier lands in local Saturday night (last week); the noon-UTC run
  // itself lands in local Sunday morning (this week).
  const sundayNoonUTC = new Date(`${thisWeekKey}T12:00:00Z`);
  const saturdayNightRun = {
    type: 'workout_completed',
    timestamp: new Date(sundayNoonUTC.getTime() - 8 * 3_600_000),
    payload: { type: 'run', distance_m: 4000, duration_s: 1200 },
  };
  const sundayMorningRun = {
    type: 'workout_completed',
    timestamp: sundayNoonUTC,
    payload: { type: 'run', distance_m: 6000, duration_s: 1800 },
  };

  state.userRow = [{ timezone: tz }];
  state.events = [saturdayNightRun, sundayMorningRun];
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  // Expected value computed from the fixture using the SAME local-day/week
  // helpers the implementation uses (never hardcoded), so this is robust to
  // whatever real date CI runs on.
  const expectedKm = [saturdayNightRun, sundayMorningRun]
    .filter(e => weekStartKeyFromLocalDay(localDayKey(e.timestamp, tz)) === thisWeekKey)
    .reduce((sum, e) => sum + e.payload.distance_m / 1000, 0);

  assert.equal(capturedCtx!.weeklyDistance, Math.round(expectedKm * 10) / 10);

  const weeklyMileage = capturedCtx!.weeklyMileage as Array<{ weekStart: string; runDistance: number }>;
  const thisWeekBucket = weeklyMileage.find(w => w.weekStart === thisWeekKey);
  assert.ok(thisWeekBucket, 'expected a weeklyMileage bucket for the current local week');
  assert.equal(capturedCtx!.weeklyDistance, thisWeekBucket!.runDistance);
});

test('timeZone threads from userRow.timezone into ctx, and is undefined when unset', async () => {
  state.userRow = [{ timezone: 'America/Chicago' }];
  state.events = [];
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');
  assert.equal(capturedCtx!.timeZone, 'America/Chicago');

  state.userRow = [{ timezone: null }];
  capturedCtx = null;
  await generateDailyBriefFromDb('user-1');
  assert.equal(capturedCtx!.timeZone, undefined);
});

test('a null timezone keeps recentActivities dates byte-identical to the UTC-fallback ISO date (backward-compat)', async () => {
  const now = new Date();
  const events = [
    {
      type: 'workout_completed',
      timestamp: new Date(now.getTime() - 25 * 3_600_000),
      payload: { type: 'run', distance_m: 3000, duration_s: 900 },
    },
    {
      type: 'workout_completed',
      timestamp: new Date(now.getTime() - 49 * 3_600_000),
      payload: { type: 'run', distance_m: 3200, duration_s: 950 },
    },
  ];

  state.userRow = [{ timezone: null }];
  state.events = events;
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  const recentActivities = capturedCtx!.recentActivities as Array<{ date: string }>;
  assert.equal(recentActivities.length, events.length);
  for (let i = 0; i < events.length; i++) {
    assert.equal(recentActivities[i].date, events[i].timestamp.toISOString().slice(0, 10));
  }
});

test('recentNutrition never includes today, includes today-3, and excludes today-4 (local meal window)', async () => {
  const tz = 'America/Chicago';
  const now = new Date();
  const todayKey = localDayKey(now, tz);
  const today3 = previousDayKey(previousDayKey(previousDayKey(todayKey)));
  const today4 = previousDayKey(today3);

  // Noon UTC on each calendar day: for Chicago's small, fixed-sign UTC
  // offset, that instant always stays within the same local calendar day.
  const mealToday  = { type: 'meal_logged', timestamp: new Date(`${todayKey}T12:00:00Z`), payload: { kcal: 500, c: 50, p: 30, f: 20 } };
  const mealToday3 = { type: 'meal_logged', timestamp: new Date(`${today3}T12:00:00Z`),  payload: { kcal: 400, c: 40, p: 25, f: 15 } };
  const mealToday4 = { type: 'meal_logged', timestamp: new Date(`${today4}T12:00:00Z`),  payload: { kcal: 300, c: 30, p: 20, f: 10 } };

  state.userRow = [{ timezone: tz }];
  state.events = [mealToday, mealToday3, mealToday4];
  capturedCtx = null;

  const { generateDailyBriefFromDb } = await briefPromise;
  await generateDailyBriefFromDb('user-1');

  const recentNutrition = capturedCtx!.recentNutrition as Array<{ date: string }>;
  const dates = recentNutrition.map(n => n.date);
  assert.ok(!dates.includes(todayKey), 'today must never appear in recentNutrition');
  assert.ok(dates.includes(today3), 'today-3 must appear in recentNutrition');
  assert.ok(!dates.includes(today4), 'today-4 must not appear in recentNutrition');
});
