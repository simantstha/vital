import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';
import { plainSpaces } from './displayText';

/**
 * lib/weeklyReviewLoader.ts hands the pure review (lib/weeklyReview.ts) a budget. The review's "stay on maintenance"
 * copy for a reached fat-loss goal needs the formula TDEE in it; the loader used to pass null, so that branch never
 * fired in production. This drives the real computeLastWeekReview against a fake `@/db` and fake repositories (no
 * Postgres), changing only the diet budget's expenditure summary between cases.
 */

// Tuesday 2026-10-06 → the reviewed week is Mon 2026-09-28 … Sun 2026-10-04.
const NOW = new Date('2026-10-06T12:00:00Z');
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const WEEK = Array.from({ length: 7 }, (_, i) => addDays('2026-09-28', i));
const PREV = Array.from({ length: 7 }, (_, i) => addDays('2026-09-21', i));

const USER = {
  id: 'u1',
  timezone: 'UTC',
  goal: 'weight_loss',
  created_at: new Date('2026-06-01T09:00:00Z'),
  unit_system: 'metric',
  weekly_sessions_target: 3,
  target_weight_kg: 84,
  sleep_goal_minutes: null,
  weekly_distance_km_target: null,
  race_date: null,
  race_distance_km: null,
};

// The reviewed week crosses 84 kg on its third day; the calorie target is 2000 kcal.
const READINGS = [
  ...PREV.map((day, i) => ({ measuredAt: `${day}T07:00:00.000Z`, valueKg: 85.2 - i * 0.1, source: 'manual' as const, localDay: day })),
  ...WEEK.map((day, i) => ({ measuredAt: `${day}T07:00:00.000Z`, valueKg: i < 3 ? 84.4 - i * 0.2 : 84 + (i % 2 === 0 ? 0.05 : -0.05), source: 'manual' as const, localDay: day })),
];

const state: { expenditure: unknown } = { expenditure: undefined };

// `select().from(users).where().limit(1)` (the user, then the previous review row) and
// `selectDistinct().from().where()` (the exercise display names).
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({ limit: async () => (table === realSchema.users ? [USER] : []) }),
    }),
  }),
  selectDistinct: () => ({ from: () => ({ where: async () => [] }) }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/weightRepository', { namedExports: { getWeightReadings: async () => READINGS } });
mock.module('@/lib/workoutRepository', {
  namedExports: {
    getProgressionSummary: async () => ({}),
    getSetsSince: async () => [],
    completedLocalDays: () => [WEEK[1], WEEK[3], WEEK[5]],
  },
});
mock.module('@/lib/trainingSummary', { namedExports: { healthKitWorkoutDays: () => [] } });
mock.module('@/lib/brain/tools', { namedExports: { queryMetricPoints: async () => [], queryWorkouts: async () => [] } });
mock.module('@/lib/brain/nutritionIntake', {
  namedExports: {
    resolveDailyIntake: async (_u: string, days: string[]) =>
      new Map(days.map((day, i) => [day, { kcal: i === 12 || i === 13 ? 2450 : 1950, protein: 150, source: 'logged' }])),
  },
});
mock.module('@/lib/brain/dietBudget', {
  namedExports: {
    normalizeGoal: (g: unknown) => (typeof g === 'string' ? g : 'general'),
    resolveDietBudget: async () => ({
      mode: 'auto', goal: 'lose', targetKcal: 2000, protein: 150, carbs: 200, fat: 60,
      ...(state.expenditure === undefined ? {} : { expenditure: state.expenditure }),
    }),
  },
});
mock.module('@/lib/goalProgressLoader', {
  namedExports: {
    loadGoalProgress: async () => ({ verdict: 'reached', reachedAt: WEEK[2], target: { weightKg: 84 }, longRun: null, liftReturn: null }),
  },
});
mock.module('@/lib/injuryCheckInLoader', { namedExports: { loadActiveInjury: async () => null } });
mock.module('@/lib/racePeakLoader', { namedExports: { loadRacePeakWeekKm: async () => null } });
mock.module('@/lib/runHistoryLoader', { namedExports: { loadRunHistory: async () => undefined } });

const loaderPromise = import('./weeklyReviewLoader');

const expenditure = (formulaTdee: number) => ({
  formulaTdee, learnedTdee: formulaTdee, confidence: 'none', source: 'formula', daysUsed: 0, loggedDays: 0,
});

test('the review reads the formula TDEE off the diet budget: a calorie target already at maintenance says "already at maintenance"', async () => {
  const { computeLastWeekReview } = await loaderPromise;
  state.expenditure = expenditure(2050); // target 2000 is within 100 kcal of maintenance
  const r = await computeLastWeekReview('u1', { tz: 'UTC', now: NOW });
  assert.ok(r, 'a review');
  assert.equal(plainSpaces(r!.headline), 'You reached 84 kg this week');
  assert.match(r!.nextWeek, /already at maintenance/);
  assert.doesNotMatch(r!.nextWeek, /^Switch to maintenance/);
});

test('a calorie target still in a deficit (formula TDEE far above it) says "switch to maintenance"', async () => {
  const { computeLastWeekReview } = await loaderPromise;
  state.expenditure = expenditure(2500);
  const r = await computeLastWeekReview('u1', { tz: 'UTC', now: NOW });
  assert.equal(r!.nextWeek, 'Switch to maintenance in Goals so your calorie target stops pushing you lower.');
});

test('a custom (pinned) budget has no expenditure summary: the formula is unknown and the advice stays "switch to maintenance"', async () => {
  const { computeLastWeekReview } = await loaderPromise;
  state.expenditure = undefined;
  const r = await computeLastWeekReview('u1', { tz: 'UTC', now: NOW });
  assert.equal(r!.nextWeek, 'Switch to maintenance in Goals so your calorie target stops pushing you lower.');
});
