import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import {
  pickLoggableCandidate,
  normalizeName,
  needsEstimate,
  type Candidate,
  type SearchCandidatesResult,
} from './candidates';
import type { EstimateResult } from './estimator';

/**
 * Drives the real quickLogMeal against fake `@/db`, `@/lib/nutrition/candidates`
 * and `@/lib/nutrition/estimator` modules, so it never touches Postgres or the
 * network. mock.module() can only be called once per specifier per process —
 * same constraint documented in lib/brain/tools.logMeal.test.ts — so this
 * lives in its own file and reads its answers from mutable `state`.
 *
 * The candidates mock re-exports the REAL normalizeName/needsEstimate (pure,
 * no IO) alongside the fake searchCandidates — quickLogMeal imports
 * normalizeName (needsEstimate is exported too so this file itself can build
 * cases the same way the real manual-search picker route would), so leaving
 * either out would make quickLogMeal's own routing logic (not just its
 * dependencies) silently break.
 */
const state: {
  searchResult: SearchCandidatesResult;
  /** What the estimator returns for the query under test. Empty items ==
   *  "the estimator found nothing loggable". */
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
        return { returning: async () => [{ id: nextInsertedId }] };
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

const quickLogPromise = import('./quickLog');

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

function reset() {
  searchCandidatesCalls = [];
  estimateMealCalls = [];
  insertedValues = [];
  state.searchResult = { candidates: [], estimateFoods: null, usdaCount: 0 };
  state.estimateResult = { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] };
}

// ─── A single plain food (no quantity language) now ALSO routes through the
// estimator — this is the fix for the owner's actual complaint. Before this
// change, quickLogMeal only routed to the estimator when
// candidates.ts's `needsEstimate` was true (a digit, "and", a comma, or no
// USDA hit); a plain single-food query like "grilled chicken breast" has
// none of those and USDA has a hit, so it used to auto-log candidates[0]'s
// fixed default-portion serving untouched. That's the same bug class as "a
// plate of rice" (see the two tests below) — a plain, quantity-word-free
// phrase with a USDA hit slipping past `needsEstimate`. This test (and the
// "coach caller" test below it) are the two "byte-identical single plain
// food" cases a prior version of this file asserted went straight to
// candidates[0]; they now go through the (mocked) grounded estimator
// instead, same as every other non-exact-history query. ─────────────────────
test('quickLogMeal routes a single plain food (no quantity language, USDA hit present) through the estimator', async () => {
  reset();
  nextInsertedId = 'event-quick';
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

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'grilled chicken breast', { source: 'quick', slot: 'lunch' });

  // searchCandidates is still called (needed for the exact-history check
  // and as a fallback), but with skipEstimate: true — the legacy
  // CalorieNinjas candidate is never used on this auto-log path any more.
  assert.deepEqual(searchCandidatesCalls, [{ userId: 'user-1', query: 'grilled chicken breast', skipEstimate: true }]);
  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'grilled chicken breast' }]);

  assert.equal(insertedValues.length, 1);
  assert.equal(insertedValues[0].source, 'quick');
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.slot, 'lunch');
  assert.equal(payload.source, 'estimator');
  assert.equal(payload.name, 'grilled chicken breast');
  assert.equal(payload.description, 'grilled chicken breast');
  assert.equal(payload.kcal, 380); // grounded ~230g portion, not a fixed default serving

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.id, 'event-quick');
  assert.equal(result.kcal, 380);
  assert.equal(result.isEstimate, true);
  assert.equal(result.origin, 'estimate');
});

test('quickLogMeal short-circuits an exact user-history hit and never calls the estimator', async () => {
  reset();
  state.searchResult = { candidates: [historyCandidate()], estimateFoods: null, usdaCount: 0 };

  const { quickLogMeal } = await quickLogPromise;
  await quickLogMeal('user-1', 'grilled chicken breast', { source: 'coach' });

  assert.equal(estimateMealCalls.length, 0);
  assert.equal(insertedValues[0].source, 'coach');
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal('slot' in payload, false);
  assert.equal(payload.source, 'history');
});

// ─── "a plate of rice": no digit, no "and", no comma — needsEstimate would
// return false here (usdaCount > 0), so before this fix it auto-logged one
// generic default USDA "rice" serving regardless of "a plate of". This is
// the owner's exact complaint. ───────────────────────────────────────────────
test('quickLogMeal routes "a plate of rice" through the estimator even though needsEstimate would be false', async () => {
  reset();
  state.searchResult = {
    candidates: [{ origin: 'usda', name: 'Rice, white, cooked', kcal: 205, c: 45, p: 4, f: 0 }],
    estimateFoods: null,
    usdaCount: 1,
  };
  // Sanity-check the premise: the OLD routing signal is false for this query.
  assert.equal(needsEstimate('a plate of rice', 1), false);

  state.estimateResult = {
    name: 'white rice, cooked',
    kcal: 494, c: 106, p: 10, f: 1,
    items: [{ food: 'white rice, cooked', grams: 380, kcal: 494, c: 106, p: 10, f: 1, source: 'usda', confidence: 'high', portionNote: 'full dinner plate, ~2 cups' }],
  };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'a plate of rice', { source: 'quick' });

  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'a plate of rice' }]);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.kcal, 494); // grounded ~380g plate, not a fixed default serving
});

// ─── "a bowl of oatmeal with banana": "with", not "and" — needsEstimate's
// regex only matches the word "and", so this also used to slip past it. ─────
test('quickLogMeal routes "a bowl of oatmeal with banana" through the estimator even though needsEstimate would be false', async () => {
  reset();
  state.searchResult = {
    candidates: [{ origin: 'usda', name: 'Oatmeal, cooked', kcal: 71, c: 12, p: 3, f: 1 }],
    estimateFoods: null,
    usdaCount: 1,
  };
  assert.equal(needsEstimate('a bowl of oatmeal with banana', 1), false);

  state.estimateResult = {
    name: 'oatmeal, cooked, banana',
    kcal: 383, c: 78, p: 10, f: 4,
    items: [
      { food: 'oatmeal, cooked', grams: 350, kcal: 249, c: 44, p: 9, f: 4, source: 'usda', confidence: 'high', portionNote: 'full cereal bowl, ~1.5 cups' },
      { food: 'banana', grams: 120, kcal: 107, c: 27, p: 1, f: 0, source: 'usda', confidence: 'high', portionNote: '1 medium banana' },
    ],
  };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'a bowl of oatmeal with banana', { source: 'quick' });

  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'a bowl of oatmeal with banana' }]);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.kcal, 383);
  if (!result.foods) throw new Error('expected a foods breakdown');
  assert.equal(result.foods.length, 2);
});

test('quickLogMeal routes a quantity/multi-food phrase through the estimator and logs the grounded breakdown', async () => {
  reset();
  nextInsertedId = 'event-estimate';
  state.searchResult = {
    candidates: [{ origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 }],
    estimateFoods: null,
    usdaCount: 1,
  };
  state.estimateResult = {
    name: 'grilled chicken breast, white rice, cooked',
    kcal: 543, c: 44, p: 51, f: 15,
    items: [
      { food: 'grilled chicken breast', grams: 200, kcal: 330, c: 0, p: 47, f: 15, source: 'usda', confidence: 'high', portionNote: '~200g breast' },
      { food: 'white rice, cooked', grams: 150, kcal: 213, c: 44, p: 4, f: 0, source: 'usda', confidence: 'med', portionNote: '~1 cup' },
    ],
  };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', '200g chicken and rice', { source: 'quick' });

  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: '200g chicken and rice' }]);

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.source, 'estimator');
  assert.equal(payload.items, '200g grilled chicken breast, 150g white rice, cooked');
  assert.deepEqual(payload.estimatorItems, state.estimateResult.items);
  assert.equal(payload.totalGrams, 350);

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.isEstimate, true);
  assert.equal(result.kcal, 543);
  assert.deepEqual(result.foods, [
    { name: 'grilled chicken breast', qty: 200, unit: 'g', kcal: 330 },
    { name: 'white rice, cooked', qty: 150, unit: 'g', kcal: 213 },
  ]);
});

test('quickLogMeal returns { ok: false } and inserts nothing when neither candidates nor the estimator find anything', async () => {
  reset();

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'unobtainium soup', { source: 'quick' });

  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'unobtainium soup' }]);
  assert.equal(result.ok, false);
  assert.equal(insertedValues.length, 0);
});
