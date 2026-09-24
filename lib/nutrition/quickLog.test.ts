import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import { pickLoggableCandidate, type Candidate, type SearchCandidatesResult } from './candidates';

/**
 * Drives the real quickLogMeal against fake `@/db` and `@/lib/nutrition/candidates`
 * modules, so it never touches Postgres or the network. mock.module() can only
 * be called once per specifier per process — same constraint documented in
 * lib/brain/tools.logMeal.test.ts — so this lives in its own file and reads
 * its answers from mutable `state`.
 */
const state: { searchResult: SearchCandidatesResult } = {
  searchResult: { candidates: [], estimateFoods: null, usdaCount: 0 },
};

let searchCandidatesCalls: Array<{ userId: string; query: string }> = [];
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

test('quickLogMeal picks the estimate candidate for a multi-food phrase and returns isEstimate + foods', async () => {
  insertedValues = [];
  nextInsertedId = 'event-estimate';
  state.searchResult = {
    candidates: [
      { origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 },
      { origin: 'estimate', name: '200g chicken and rice', kcal: 520, c: 60, p: 45, f: 12 },
    ],
    estimateFoods: [
      { name: 'chicken', qty: 200, unit: 'g', kcal: 330 },
      { name: 'rice', qty: 1, unit: 'cup', kcal: 190 },
    ],
    usdaCount: 1,
  };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', '200g chicken and rice', { source: 'quick' });

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.items, '200g chicken, 1cup rice');

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.isEstimate, true);
  assert.equal(result.kcal, 520);
  assert.deepEqual(result.foods, [
    { name: 'chicken', qty: 200, unit: 'g', kcal: 330 },
    { name: 'rice', qty: 1, unit: 'cup', kcal: 190 },
  ]);
});

test('quickLogMeal returns { ok: false } and inserts nothing when no candidates match', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [], estimateFoods: null, usdaCount: 0 };

  const { quickLogMeal } = await quickLogPromise;
  const result = await quickLogMeal('user-1', 'unobtainium soup', { source: 'quick' });

  assert.equal(result.ok, false);
  assert.equal(insertedValues.length, 0);
});
