import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';
import { localDayKey } from '@/lib/localDay';

/**
 * `/api/logs` now resolves per-day nutrition intake via
 * lib/brain/nutritionIntake.ts's resolveDailyIntake — the same resolver
 * /api/today uses — so a HealthKit-only day (e.g. MyFitnessPal via Apple
 * Health) surfaces real numbers in `dietByDay` and gets a synthetic
 * read-only `nutrition_healthkit` feed item, while a day with a real
 * `meal_logged` event still wins (resolveDailyIntake's precedence rule) and
 * injects nothing.
 *
 * `@/db` must be mocked before the route module's first import — same
 * constraint documented in app/api/today/route.test.ts and
 * lib/brain/nutritionIntake.test.ts. The fake `select()` dispatches by
 * projection shape (matching nutritionIntake.test.ts's convention) with a
 * fallback to table identity for the route's own un-projected selects
 * (events, users) — one fake serves every `db.select(...)` call in the
 * route's full call graph (route itself, resolveDailyIntake, queryWorkouts,
 * queryMetricPoints, getUserUnitSystem).
 */

const state: {
  userRow: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  mealEvents: Array<{ timestamp: Date; payload: unknown }>;
  dietaryRows: Array<{ date: string; metric: string; value: number; payload: unknown }>;
} = {
  userRow: { id: 'user-1', timezone: 'UTC' },
  events: [],
  mealEvents: [],
  dietaryRows: [],
};

function fakeSelect(proj?: Record<string, unknown>) {
  return {
    from: (table: unknown) => {
      // nutritionIntake's meal_logged events query: { timestamp, payload }.
      if (proj && 'timestamp' in proj && !('metric' in proj)) {
        return { where: () => ({ orderBy: async () => state.mealEvents }) };
      }
      // nutritionIntake's dietary_* rows query: { date, metric, value, payload }.
      if (proj && 'metric' in proj) {
        return { where: async () => state.dietaryRows };
      }
      // queryMetricPoints ({ date, value }) / queryWorkouts ({ date, payload }) —
      // unused by these tests, always empty.
      if (proj && ('value' in proj || 'payload' in proj)) {
        return { where: () => ({ orderBy: async () => [] }) };
      }
      // The route's own un-projected full-row selects.
      if (table === realSchema.events) {
        return { where: () => ({ orderBy: () => ({ limit: async () => state.events }) }) };
      }
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => [state.userRow] }) };
      }
      if (table === realSchema.workout_analyses || table === realSchema.sleep_analyses) {
        return { where: async () => [] };
      }
      throw new Error(`unexpected select in fakeDb: table=${String(table)} proj=${JSON.stringify(proj)}`);
    },
  };
}

const fakeDb = { select: fakeSelect };

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const routePromise = import('./route');

function req(): Request {
  return new Request('http://local/api/logs?days=1&tz=UTC', { headers: { 'x-user-id': 'user-1' } });
}

test.beforeEach(() => {
  state.userRow = { id: 'user-1', timezone: 'UTC' };
  state.events = [];
  state.mealEvents = [];
  state.dietaryRows = [];
});

test('a HealthKit-only day surfaces dietByDay and an injected nutrition_healthkit item', async () => {
  const { GET } = await routePromise;
  const todayKey = localDayKey(new Date(), 'UTC');
  state.dietaryRows = [
    { date: todayKey, metric: 'dietary_energy_kcal', value: 1850, payload: { sources: ['MyFitnessPal'] } },
    { date: todayKey, metric: 'dietary_protein_g', value: 90, payload: null },
  ];

  const response = await GET(req());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.dietByDay[todayKey], {
    kcal: 1850, protein: 90, carbs: 0, fat: 0, source: 'healthkit', sourceName: 'MyFitnessPal',
  });

  const injected = body.items.filter((i: { type: string }) => i.type === 'nutrition_healthkit');
  assert.equal(injected.length, 1);
  assert.deepEqual(injected[0], {
    id: `hk-nutrition-${todayKey}`,
    type: 'nutrition_healthkit',
    timestamp: `${todayKey}T23:59:59.999Z`,
    title: 'MyFitnessPal',
    subtitle: 'via Apple Health',
    kcal: 1850,
    hasExactTime: false,
    dayKey: todayKey,
  });
});

test('a HealthKit day with no known source app falls back to the generic Apple Health title', async () => {
  const { GET } = await routePromise;
  const todayKey = localDayKey(new Date(), 'UTC');
  state.dietaryRows = [
    { date: todayKey, metric: 'dietary_energy_kcal', value: 900, payload: null },
  ];

  const response = await GET(req());
  const body = await response.json();

  assert.equal(body.dietByDay[todayKey].sourceName, null);
  const injected = body.items.find((i: { type: string }) => i.type === 'nutrition_healthkit');
  assert.equal(injected.title, 'Apple Health');
});

test('a day with a logged meal_logged event injects nothing and reports source: logged', async () => {
  const { GET } = await routePromise;
  const todayKey = localDayKey(new Date(), 'UTC');
  const now = new Date();
  state.events = [
    { id: 'evt-1', user_id: 'user-1', type: 'meal_logged', timestamp: now, payload: { kcal: 500, protein: 30, carbs: 40, fat: 10 } },
  ];
  state.mealEvents = [
    { timestamp: now, payload: { kcal: 500, protein: 30, carbs: 40, fat: 10 } },
  ];
  // Even with a HealthKit reading present the same day, meal_logged must
  // win — resolveDailyIntake's precedence rule, not reimplemented here.
  state.dietaryRows = [
    { date: todayKey, metric: 'dietary_energy_kcal', value: 2000, payload: null },
  ];

  const response = await GET(req());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.dietByDay[todayKey].source, 'logged');
  assert.equal(body.dietByDay[todayKey].kcal, 500);
  assert.equal(
    body.items.some((i: { type: string }) => i.type === 'nutrition_healthkit'),
    false,
  );
});

test('a day with neither a log nor a HealthKit reading reports source: none and injects nothing', async () => {
  const { GET } = await routePromise;
  const todayKey = localDayKey(new Date(), 'UTC');

  const response = await GET(req());
  const body = await response.json();

  assert.deepEqual(body.dietByDay[todayKey], {
    kcal: 0, protein: 0, carbs: 0, fat: 0, source: 'none', sourceName: null,
  });
  assert.equal(
    body.items.some((i: { type: string }) => i.type === 'nutrition_healthkit'),
    false,
  );
});
