import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * Drives the real IO orchestrator `searchCandidates` (not just the pure
 * helpers candidates.test.ts covers) against a fake `@/db` and a fake
 * `@/lib/nutritionix`, so it never touches Postgres or the network. Lives in
 * its own file — separate from candidates.test.ts's pure-function-only
 * suite — because it needs `@/db` mocked before `./candidates` is first
 * imported; node:test isolates each test file in its own subprocess, same
 * constraint documented in lib/brain/tools.logMeal.test.ts.
 *
 * USDA_FDC_API_KEY is deliberately left unset — lib/nutrition/usda.ts's
 * searchFoods short-circuits to [] without it, so this file needs no fake
 * for it and no network call happens either way.
 *
 * Focus: `SearchCandidatesOptions.skipEstimate` suppresses the CalorieNinjas
 * free-text estimate fetch, and — critically — that omitting it (the manual
 * search picker's call shape, app/api/nutrition/search) leaves the existing
 * behavior completely unchanged.
 */

let lookupNutritionCalls: string[] = [];

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        // History's chain ends orderBy().limit(); cache's ends limit()
        // directly — support both off the same fake `where()` result.
        orderBy: () => ({ limit: async () => [] }),
        limit: async () => [],
      }),
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb } });
mock.module('@/lib/nutritionix', {
  namedExports: {
    lookupNutrition: async (query: string) => {
      lookupNutritionCalls.push(query);
      return { kcal: 300, c: 40, p: 10, f: 8, foods: [{ name: query, qty: 1, unit: 'serving', kcal: 300 }] };
    },
  },
});

const candidatesPromise = import('./candidates');

test('searchCandidates fetches the CalorieNinjas estimate by default (picker behavior, unchanged)', async () => {
  lookupNutritionCalls = [];
  const { searchCandidates } = await candidatesPromise;

  // No USDA hits (no API key) -> needsEstimate is true regardless of phrasing.
  const result = await searchCandidates('user-1', 'two eggs and toast');

  assert.deepEqual(lookupNutritionCalls, ['two eggs and toast']);
  assert.ok(result.estimateFoods);
  assert.ok(result.candidates.some((c) => c.origin === 'estimate'));
});

test('searchCandidates skips the CalorieNinjas estimate when skipEstimate: true (quickLog.ts\'s auto-log path)', async () => {
  lookupNutritionCalls = [];
  const { searchCandidates } = await candidatesPromise;

  const result = await searchCandidates('user-1', 'two eggs and toast', { skipEstimate: true });

  assert.deepEqual(lookupNutritionCalls, []);
  assert.equal(result.estimateFoods, null);
  assert.equal(result.candidates.some((c) => c.origin === 'estimate'), false);
});

test('searchCandidates({ skipEstimate: false }) is identical to the default (explicit false, still unchanged)', async () => {
  lookupNutritionCalls = [];
  const { searchCandidates } = await candidatesPromise;

  const result = await searchCandidates('user-1', 'two eggs and toast', { skipEstimate: false });

  assert.deepEqual(lookupNutritionCalls, ['two eggs and toast']);
  assert.ok(result.estimateFoods);
});
