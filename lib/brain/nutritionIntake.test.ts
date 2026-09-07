import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * nutritionIntake.ts imports `@/db` (drizzle query builders + schema), so it
 * must be mocked before the module is first imported — same constraint
 * documented in lib/brain/dietBudget.test.ts and lib/brain/tools.logMeal.test.ts.
 * `and`/`eq`/`gte`/`lte`/`inArray` are the REAL drizzle-orm exports (they just
 * build query fragments off `realSchema` columns and never touch Postgres);
 * only `db.select(...).from(...).where(...)` is faked, and the fake ignores
 * the actual filter and returns whatever the test staged in `state` — the
 * precedence logic under test lives entirely in resolveDailyIntake's JS, not
 * in the SQL, so exact WHERE-clause fidelity isn't what these tests check.
 */
const state: {
  mealEvents: Array<{ timestamp: Date; payload: unknown }>;
  dietaryRows: Array<{ date: string; metric: string; value: number; payload: unknown }>;
} = { mealEvents: [], dietaryRows: [] };

const fakeDb = {
  select: (proj: Record<string, unknown>) => {
    if ('timestamp' in proj) {
      // meal_logged events query — resolveDailyIntake chains .orderBy()
      return { from: () => ({ where: () => ({ orderBy: async () => state.mealEvents }) }) };
    }
    if ('metric' in proj) {
      // daily_metrics dietary_* query — no .orderBy() chain
      return { from: () => ({ where: async () => state.dietaryRows }) };
    }
    throw new Error(`unexpected projection in select(): ${JSON.stringify(proj)}`);
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const nutritionIntakePromise = import('./nutritionIntake');

test.beforeEach(() => {
  state.mealEvents = [];
  state.dietaryRows = [];
});

test('precedence: a meal_logged event wins over a HealthKit dietary reading on the same day', async () => {
  const { resolveDailyIntake } = await nutritionIntakePromise;
  state.mealEvents = [
    { timestamp: new Date('2026-08-04T18:00:00Z'), payload: { kcal: 500, protein: 30, carbs: 40, fat: 10 } },
  ];
  state.dietaryRows = [
    { date: '2026-08-04', metric: 'dietary_energy_kcal', value: 2000, payload: null },
  ];

  const result = await resolveDailyIntake('user-1', ['2026-08-04'], 'America/Chicago');
  const intake = result.get('2026-08-04')!;

  assert.equal(intake.source, 'logged');
  assert.equal(intake.kcal, 500);
  assert.equal(intake.protein, 30);
});

test('a 0-kcal Vital log still beats HealthKit — presence of a log is the signal, not its sum', async () => {
  const { resolveDailyIntake } = await nutritionIntakePromise;
  state.mealEvents = [
    { timestamp: new Date('2026-08-04T18:00:00Z'), payload: { calories: 0 } },
  ];
  state.dietaryRows = [
    { date: '2026-08-04', metric: 'dietary_energy_kcal', value: 1800, payload: null },
  ];

  const result = await resolveDailyIntake('user-1', ['2026-08-04'], 'America/Chicago');
  const intake = result.get('2026-08-04')!;

  assert.equal(intake.source, 'logged');
  assert.equal(intake.kcal, 0);
});

test('the >0 guard: a present-but-zero dietary_energy_kcal row yields "none", never a measured zero', async () => {
  const { resolveDailyIntake } = await nutritionIntakePromise;
  state.dietaryRows = [
    { date: '2026-08-04', metric: 'dietary_energy_kcal', value: 0, payload: null },
  ];

  const result = await resolveDailyIntake('user-1', ['2026-08-04'], 'America/Chicago');
  const intake = result.get('2026-08-04')!;

  // A denied HealthKit read looks identical to "no data" — both surface as
  // an absent-or-zero dietary_energy_kcal row. Promoting this to 'healthkit'
  // would tell a denied user they ate a measured 0 kcal today.
  assert.equal(intake.source, 'none');
  assert.equal(intake.kcal, 0);
});

test('a real HealthKit reading with individually-missing macro rows defaults each to 0', async () => {
  const { resolveDailyIntake } = await nutritionIntakePromise;
  state.dietaryRows = [
    { date: '2026-08-04', metric: 'dietary_energy_kcal', value: 2140, payload: { sources: ['MyFitnessPal'] } },
    // no dietary_protein_g / dietary_carbs_g / dietary_fat_g rows this day
  ];

  const result = await resolveDailyIntake('user-1', ['2026-08-04'], 'America/Chicago');
  const intake = result.get('2026-08-04')!;

  assert.equal(intake.source, 'healthkit');
  assert.equal(intake.kcal, 2140);
  assert.equal(intake.protein, 0);
  assert.equal(intake.carbs, 0);
  assert.equal(intake.fat, 0);
  assert.equal(intake.sourceName, 'MyFitnessPal');
});

test('local-day bucketing: a meal event buckets by the local calendar day, not the UTC one', async () => {
  const { resolveDailyIntake } = await nutritionIntakePromise;
  // 2026-08-05T02:00:00Z is 2026-08-04 21:00 in America/Chicago (CDT, UTC-5) —
  // a naive UTC-date bucketing would misfile this under 2026-08-05.
  state.mealEvents = [
    { timestamp: new Date('2026-08-05T02:00:00Z'), payload: { kcal: 620, protein: 40, carbs: 60, fat: 20 } },
  ];

  const result = await resolveDailyIntake('user-1', ['2026-08-04', '2026-08-05'], 'America/Chicago');

  assert.equal(result.get('2026-08-04')!.source, 'logged');
  assert.equal(result.get('2026-08-04')!.kcal, 620);
  assert.equal(result.get('2026-08-05')!.source, 'none');
});
