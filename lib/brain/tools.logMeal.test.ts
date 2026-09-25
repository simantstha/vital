import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import {
  pickLoggableCandidate,
  normalizeName,
  needsEstimate,
  type Candidate,
  type SearchCandidatesResult,
} from '../nutrition/candidates';
import type { EstimateResult } from '../nutrition/estimator';

/**
 * Drives the real log_meal executeToolCall text path (searchCandidates →
 * quickLogMeal's estimator routing → meal_logged event insert) against fake
 * `@/db`, `@/lib/nutrition/candidates` and `@/lib/nutrition/estimator`
 * modules, so it never touches Postgres or the network. All three must be
 * mocked before ./tools is first imported in this process — node:test runs
 * each test file in its own subprocess, so this lives in its own file (same
 * constraint documented in lib/brain/tools.getSchedule.test.ts).
 *
 * mock.module() can only be called once per specifier per process, so the
 * fakes read their answers from mutable `state` that each test sets before
 * calling the tool, rather than re-mocking per test. The candidates mock
 * re-exports the REAL normalizeName/needsEstimate (pure, no IO) alongside
 * the fake searchCandidates — quickLogMeal imports both, so leaving them out
 * would break its own routing logic, not just its dependencies.
 */
const state: {
  searchResult: SearchCandidatesResult;
  estimateResult: EstimateResult;
} = {
  searchResult: { candidates: [], estimateFoods: null, usdaCount: 0 },
  estimateResult: { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] },
};

let searchCandidatesCalls: Array<{ userId: string; query: string; skipEstimate?: boolean }> = [];
let estimateMealCalls: Array<{ userId: string; text: string | undefined }> = [];
let insertedValues: Array<Record<string, unknown>> = [];
let nextInsertedId = 'event-1';

const fakeDb = {
  insert: (table: unknown) => {
    if (table !== realSchema.events) throw new Error(`unexpected table in insert(): ${String(table)}`);
    return {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return {
          returning: async () => [{ id: nextInsertedId }],
        };
      },
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/nutrition/candidates', {
  namedExports: {
    searchCandidates: async (userId: string, query: string, options?: { skipEstimate?: boolean }) => {
      searchCandidatesCalls.push({ userId, query, skipEstimate: options?.skipEstimate });
      return state.searchResult;
    },
    // Real, pure selector — exercised indirectly through log_meal so this
    // test file also covers the candidates.ts <-> tools.ts wiring, not just
    // pickLoggableCandidate in isolation (see candidates.test.ts for that).
    pickLoggableCandidate,
    normalizeName,
    needsEstimate,
  },
});
mock.module('@/lib/nutrition/estimator', {
  namedExports: {
    estimateMeal: async (input: { userId: string; text?: string }) => {
      estimateMealCalls.push({ userId: input.userId, text: input.text });
      return state.estimateResult;
    },
  },
});
mock.module('@/lib/openFoodFacts', {
  namedExports: {
    lookupBarcode: async (_barcode: string) => ({
      productName: 'Fake Product',
      per100g: { kcal: 200, c: 20, p: 10, f: 5 },
    }),
  },
});

const toolsPromise = import('./tools');

function historyCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    origin: 'history',
    name: 'Grilled chicken breast',
    kcal: 300,
    c: 5,
    p: 45,
    f: 10,
    lastLoggedAt: '2026-07-16T12:00:00.000Z',
    slot: 'lunch',
    ...overrides,
  };
}

// A single plain food with no quantity language ("grilled chicken breast")
// now ALSO routes through the estimator, same as every other non-exact-
// history query — see lib/nutrition/quickLog.ts's header comment and
// quickLog.test.ts's matching test for the full rationale: routing only on
// `needsEstimate` left plain, quantity-word-free phrases with a USDA hit
// (like "a plate of rice" — see the dedicated test below) auto-logging a
// fixed default USDA serving, which was the owner's actual complaint. This
// test used to assert candidates[0]'s fixed serving was logged untouched;
// it now asserts the (mocked) grounded estimator's result instead.
test('log_meal text path routes a single plain food (no quantity language) through the estimator', async () => {
  searchCandidatesCalls = [];
  estimateMealCalls = [];
  insertedValues = [];
  nextInsertedId = 'event-usda';
  state.searchResult = {
    candidates: [{ origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 }],
    estimateFoods: null,
    usdaCount: 1,
  };
  state.estimateResult = {
    name: 'grilled chicken breast',
    kcal: 380, c: 0, p: 71, f: 9,
    items: [
      { food: 'grilled chicken breast', grams: 230, kcal: 380, c: 0, p: 71, f: 9, source: 'usda', confidence: 'high', portionNote: '~230g, a large breast' },
    ],
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: 'grilled chicken breast' }, 'user-1'),
  );

  // searchCandidates is still called (needed for the exact-history check
  // and as a fallback), but with skipEstimate: true.
  assert.deepEqual(searchCandidatesCalls, [{ userId: 'user-1', query: 'grilled chicken breast', skipEstimate: true }]);
  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'grilled chicken breast' }]);

  assert.equal(insertedValues.length, 1);
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.kcal, 380); // grounded ~230g portion, not the fixed 284 kcal default serving
  assert.equal(payload.name, 'grilled chicken breast');
  assert.equal(payload.description, 'grilled chicken breast');
  assert.equal(payload.source, 'estimator');

  assert.equal(result.ok, true);
  assert.equal(result.id, 'event-usda');
  assert.equal(result.kcal, 380);
  assert.equal(result.origin, 'estimate');
  assert.deepEqual(result.foods, [{ name: 'grilled chicken breast', qty: 230, unit: 'g', kcal: 380 }]);
});

test('log_meal text path with a history candidate maps source to "history" and never calls the estimator', async () => {
  insertedValues = [];
  estimateMealCalls = [];
  state.searchResult = { candidates: [historyCandidate()], estimateFoods: null, usdaCount: 0 };

  const tools = await toolsPromise;
  await tools.executeToolCall('log_meal', { text: 'grilled chicken breast' }, 'user-1');

  assert.equal(estimateMealCalls.length, 0);
  assert.equal((insertedValues[0].payload as Record<string, unknown>).source, 'history');
});

// "a plate of rice" — no digit, no "and", no comma, and USDA has a "rice"
// hit — is the owner's exact original complaint: needsEstimate would be
// false here, so before this fix it auto-logged one generic default USDA
// serving regardless of "a plate of". Exercised through the coach's
// log_meal tool (not just quickLogMeal directly) so the full tools.ts <->
// quickLog.ts <-> estimator.ts wiring is covered for this case too.
test('log_meal text path routes "a plate of rice" through the estimator even though needsEstimate would be false', async () => {
  insertedValues = [];
  estimateMealCalls = [];
  nextInsertedId = 'event-rice';
  state.searchResult = {
    candidates: [{ origin: 'usda', name: 'Rice, white, cooked', kcal: 205, c: 45, p: 4, f: 0 }],
    estimateFoods: null,
    usdaCount: 1,
  };
  assert.equal(needsEstimate('a plate of rice', 1), false);
  state.estimateResult = {
    name: 'white rice, cooked',
    kcal: 494, c: 106, p: 10, f: 1,
    items: [{ food: 'white rice, cooked', grams: 380, kcal: 494, c: 106, p: 10, f: 1, source: 'usda', confidence: 'high', portionNote: 'full dinner plate, ~2 cups' }],
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: 'a plate of rice' }, 'user-1'),
  );

  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'a plate of rice' }]);
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.kcal, 494);
  assert.equal(payload.source, 'estimator');
  assert.equal(result.kcal, 494);
});

test('log_meal text path returns "Could not find nutrition data" when neither candidates nor the estimator match', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [], estimateFoods: null, usdaCount: 0 };
  state.estimateResult = { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] };

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('log_meal', { text: 'unobtainium soup' }, 'user-1');

  assert.match(result, /Could not find nutrition data for "unobtainium soup"/);
  assert.equal(insertedValues.length, 0);
});

// A multi-food/quantity phrase (usdaCount 0 or a digit/"and"/comma — see
// candidates.ts's needsEstimate) now routes through
// lib/nutrition/estimator.ts's grounded estimator instead of the legacy
// single CalorieNinjas-estimate candidate — see quickLog.test.ts's matching
// test for the full rationale. The mocked numbers below (grounded per-item
// breakdown) replace the old flat CalorieNinjas totals.
test('log_meal text path routes a multi-food phrase through the estimator and formats items/foods from the grounded breakdown', async () => {
  insertedValues = [];
  nextInsertedId = 'event-estimate';
  state.searchResult = { candidates: [], estimateFoods: null, usdaCount: 0 };
  state.estimateResult = {
    name: 'eggs, fried, toast, white bread',
    kcal: 350, c: 30, p: 18, f: 15,
    items: [
      { food: 'eggs, fried', grams: 100, kcal: 140, c: 1, p: 12, f: 10, source: 'usda', confidence: 'high', portionNote: '2 large eggs' },
      { food: 'toast, white bread', grams: 60, kcal: 210, c: 29, p: 6, f: 5, source: 'usda', confidence: 'med', portionNote: '2 slices' },
    ],
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: 'eggs and toast' }, 'user-1'),
  );

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.name, 'eggs, fried, toast, white bread');
  assert.equal(payload.source, 'estimator');
  assert.equal(payload.items, '100g eggs, fried, 60g toast, white bread');
  assert.equal(payload.totalGrams, 160);

  assert.equal(result.id, 'event-estimate');
  assert.deepEqual(result.foods, [
    { name: 'eggs, fried', qty: 100, unit: 'g', kcal: 140 },
    { name: 'toast, white bread', qty: 60, unit: 'g', kcal: 210 },
  ]);
  assert.equal(result.origin, 'estimate');
});

// The estimator parses N distinct items by construction (step 1's
// report_meal_items tool call), so the old bug this test used to guard
// against — picking a single USDA food's per-serving macros for a
// multi-food query — is now structurally impossible for any phrase that
// reaches it (needsEstimate routes multi-food/quantity phrases here
// instead of through pickLoggableCandidate's single-candidate pick).
test('log_meal text path grounds a multi-food quantity phrase item-by-item instead of picking one candidate', async () => {
  insertedValues = [];
  nextInsertedId = 'event-multi';
  state.searchResult = {
    candidates: [{ origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 }],
    estimateFoods: null,
    usdaCount: 1,
  };
  state.estimateResult = {
    name: 'chicken breast, grilled, white rice, cooked',
    kcal: 543, c: 44, p: 51, f: 15,
    items: [
      { food: 'chicken breast, grilled', grams: 200, kcal: 330, c: 0, p: 47, f: 15, source: 'usda', confidence: 'high', portionNote: '~200g' },
      { food: 'white rice, cooked', grams: 150, kcal: 213, c: 44, p: 4, f: 0, source: 'usda', confidence: 'med', portionNote: '~1 cup' },
    ],
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: '200g chicken and rice' }, 'user-1'),
  );

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.kcal, 543);
  assert.equal(payload.source, 'estimator');
  assert.equal(payload.name, 'chicken breast, grilled, white rice, cooked');

  assert.equal(result.origin, 'estimate');
  assert.equal(result.kcal, 543);
  assert.deepEqual(result.foods, [
    { name: 'chicken breast, grilled', qty: 200, unit: 'g', kcal: 330 },
    { name: 'white rice, cooked', qty: 150, unit: 'g', kcal: 213 },
  ]);
});

test('log_meal barcode path writes a name/description and returns the inserted event id', async () => {
  insertedValues = [];
  nextInsertedId = 'event-barcode';

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: '012345678905', grams: 50 }, 'user-1'),
  );

  assert.equal(insertedValues.length, 1);
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.name, 'Fake Product 50g');
  assert.equal(payload.description, 'Fake Product 50g');

  assert.equal(result.ok, true);
  assert.equal(result.id, 'event-barcode');
  assert.equal(result.product, 'Fake Product');
});
