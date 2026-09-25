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
 * no IO) alongside the fake searchCandidates — quickLogMeal imports both from
 * '@/lib/nutrition/candidates', so leaving them out would make quickLogMeal's
 * own routing logic (not just its dependencies) silently break.
 */
const state: {
  searchResult: SearchCandidatesResult;
  /** What the estimator returns for a phrase with quantity/multi-food
   *  language — see quickLog.ts's `needsEstimate` routing. Empty items ==
   *  "the estimator found nothing loggable either". */
  estimateResult: EstimateResult;
} = {
  searchResult: { candidates: [], estimateFoods: null, usdaCount: 0 },
  estimateResult: { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] },
};

let searchCandidatesCalls: Array<{ userId: string; query: string }> = [];
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
    searchCandidates: async (userId: string, query: string) => {
      searchCandidatesCalls.push({ userId, query });
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

test('quickLogMeal inserts the top candidate and passes source/slot through to the row', async () => {
  searchCandidatesCalls = [];
  insertedValues = [];
  nextInsertedId = 'event-quick';
  state.searchResult = {
    candidates: [historyCandidate({ origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 })],
    estimateFoods: null,
    usdaCount: 1,
  };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'grilled chicken breast', { source: 'quick', slot: 'lunch' });

  assert.deepEqual(searchCandidatesCalls, [{ userId: 'user-1', query: 'grilled chicken breast' }]);
  assert.equal(insertedValues.length, 1);
  assert.equal(insertedValues[0].source, 'quick');
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.slot, 'lunch');
  assert.equal(payload.source, 'usda');
  assert.equal(payload.name, 'Chicken Breast, Grilled');
  assert.equal(payload.description, 'grilled chicken breast');

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.id, 'event-quick');
  assert.equal(result.name, 'Chicken Breast, Grilled');
  assert.equal(result.kcal, 284);
  assert.equal(result.c, 0);
  assert.equal(result.p, 53);
  assert.equal(result.f, 6);
  assert.equal(result.isEstimate, false);
  assert.equal(result.origin, 'usda');
  assert.equal('foods' in result, false);
});

test('quickLogMeal source is passed through as "coach" for the coach caller and omits slot when absent', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [historyCandidate()], estimateFoods: null, usdaCount: 0 };

  const { quickLogMeal } = await quickLogPromise;
  await quickLogMeal('user-1', 'grilled chicken breast', { source: 'coach' });

  assert.equal(insertedValues[0].source, 'coach');
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal('slot' in payload, false);
});

// A quantity/multi-food phrase ("200g chicken and rice") now routes through
// lib/nutrition/estimator.ts's grounded estimator instead of the legacy
// single CalorieNinjas-estimate candidate — this is the actual fix for the
// "meal logging is way off" complaint: portions are grounded per item
// (grams × real per-100g data) instead of one free-text re-parse. The old
// mocked numbers (520 kcal total) are replaced with a grounded two-item
// breakdown (grilled chicken 200g + cooked rice 150g) to demonstrate that
// shape; searchCandidates is still called first (it still gates the
// exact-history short-circuit and is the fallback if the estimator finds
// nothing — see quickLog.ts).
test('quickLogMeal routes a quantity/multi-food phrase through the estimator and logs the grounded breakdown', async () => {
  insertedValues = [];
  estimateMealCalls = [];
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
  insertedValues = [];
  estimateMealCalls = [];
  state.searchResult = { candidates: [], estimateFoods: null, usdaCount: 0 };
  state.estimateResult = { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'unobtainium soup', { source: 'quick' });

  assert.deepEqual(estimateMealCalls, [{ userId: 'user-1', text: 'unobtainium soup' }]);
  assert.equal(result.ok, false);
  assert.equal(insertedValues.length, 0);
});
