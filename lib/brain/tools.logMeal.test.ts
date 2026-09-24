import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import { pickLoggableCandidate, type Candidate, type SearchCandidatesResult } from '../nutrition/candidates';

/**
 * Drives the real log_meal executeToolCall text path (searchCandidates →
 * meal_logged event insert) against fake `@/db` and `@/lib/nutrition/candidates`
 * modules, so it never touches Postgres or the network. Both must be mocked
 * before ./tools is first imported in this process — node:test runs each
 * test file in its own subprocess, so this lives in its own file (same
 * constraint documented in lib/brain/tools.getSchedule.test.ts).
 *
 * mock.module() can only be called once per specifier per process, so the
 * fakes read their answers from mutable `state` that each test sets before
 * calling the tool, rather than re-mocking per test.
 */
const state: {
  searchResult: SearchCandidatesResult;
} = { searchResult: { candidates: [], estimateFoods: null, usdaCount: 0 } };

let searchCandidatesCalls: Array<{ userId: string; query: string }> = [];
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
    searchCandidates: async (userId: string, query: string) => {
      searchCandidatesCalls.push({ userId, query });
      return state.searchResult;
    },
    // Real, pure selector — exercised indirectly through log_meal so this
    // test file also covers the candidates.ts <-> tools.ts wiring, not just
    // pickLoggableCandidate in isolation (see candidates.test.ts for that).
    pickLoggableCandidate,
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

test('log_meal text path inserts the top candidate\'s macros with source mapped from origin', async () => {
  searchCandidatesCalls = [];
  insertedValues = [];
  nextInsertedId = 'event-usda';
  state.searchResult = {
    candidates: [historyCandidate({ origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 })],
    estimateFoods: null,
    usdaCount: 1,
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: 'grilled chicken breast' }, 'user-1'),
  );

  assert.deepEqual(searchCandidatesCalls, [{ userId: 'user-1', query: 'grilled chicken breast' }]);
  assert.equal(insertedValues.length, 1);
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.kcal, 284);
  assert.equal(payload.c, 0);
  assert.equal(payload.p, 53);
  assert.equal(payload.f, 6);
  assert.equal(payload.name, 'Chicken Breast, Grilled');
  assert.equal(payload.description, 'grilled chicken breast');
  assert.equal(payload.source, 'usda');
  assert.equal('items' in payload, false);

  assert.equal(result.ok, true);
  assert.equal(result.id, 'event-usda');
  assert.equal(result.kcal, 284);
  assert.equal(result.matched, 'Chicken Breast, Grilled');
  assert.equal(result.origin, 'usda');
  assert.equal('foods' in result, false);
});

test('log_meal text path with a history candidate maps source to "history"', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [historyCandidate()], estimateFoods: null, usdaCount: 0 };

  const tools = await toolsPromise;
  await tools.executeToolCall('log_meal', { text: 'grilled chicken breast' }, 'user-1');

  assert.equal((insertedValues[0].payload as Record<string, unknown>).source, 'history');
});

test('log_meal text path returns "Could not find nutrition data" and inserts nothing when no candidates match', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [], estimateFoods: null, usdaCount: 0 };

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('log_meal', { text: 'unobtainium soup' }, 'user-1');

  assert.match(result, /Could not find nutrition data for "unobtainium soup"/);
  assert.equal(insertedValues.length, 0);
});

test('log_meal text path with an estimate candidate formats items and returns foods', async () => {
  insertedValues = [];
  nextInsertedId = 'event-estimate';
  state.searchResult = {
    candidates: [{ origin: 'estimate', name: 'eggs and toast', kcal: 350, c: 30, p: 18, f: 15 }],
    estimateFoods: [
      { name: 'eggs', qty: 2, unit: '', kcal: 140 },
      { name: 'toast', qty: 1, unit: 'slice', kcal: 210 },
    ],
    usdaCount: 0,
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: 'eggs and toast' }, 'user-1'),
  );

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.name, 'eggs and toast');
  assert.equal(payload.source, 'calorieninjas');
  assert.equal(payload.items, '2 eggs, 1slice toast');

  assert.equal(result.id, 'event-estimate');
  assert.deepEqual(result.foods, [
    { name: 'eggs', qty: 2, unit: '', kcal: 140 },
    { name: 'toast', qty: 1, unit: 'slice', kcal: 210 },
  ]);
  assert.equal(result.origin, 'estimate');
});

test('log_meal text path prefers the estimate candidate over a single-food USDA match for a multi-food phrase (bug fix)', async () => {
  insertedValues = [];
  nextInsertedId = 'event-multi';
  state.searchResult = {
    candidates: [
      // The old code picked candidates[0] here (a single USDA food's
      // per-serving macros) even though the query described two foods.
      { origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 },
      { origin: 'estimate', name: '200g chicken and rice', kcal: 520, c: 60, p: 45, f: 12 },
    ],
    estimateFoods: [
      { name: 'chicken', qty: 200, unit: 'g', kcal: 330 },
      { name: 'rice', qty: 1, unit: 'cup', kcal: 190 },
    ],
    usdaCount: 1,
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: '200g chicken and rice' }, 'user-1'),
  );

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.kcal, 520);
  assert.equal(payload.source, 'calorieninjas');
  assert.equal(payload.name, '200g chicken and rice');

  assert.equal(result.origin, 'estimate');
  assert.equal(result.kcal, 520);
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
