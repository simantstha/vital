import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import type { Candidate, SearchCandidatesResult } from '../nutrition/candidates';

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
} = { searchResult: { candidates: [], estimateFoods: null } };

let searchCandidatesCalls: Array<{ userId: string; query: string }> = [];
let insertedValues: Array<Record<string, unknown>> = [];

const fakeDb = {
  insert: (table: unknown) => {
    if (table !== realSchema.events) throw new Error(`unexpected table in insert(): ${String(table)}`);
    return {
      values: async (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
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
  state.searchResult = {
    candidates: [historyCandidate({ origin: 'usda', name: 'Chicken Breast, Grilled', kcal: 284, c: 0, p: 53, f: 6 })],
    estimateFoods: null,
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
  assert.equal(payload.description, 'grilled chicken breast');
  assert.equal(payload.source, 'usda');
  assert.equal('items' in payload, false);

  assert.equal(result.ok, true);
  assert.equal(result.kcal, 284);
  assert.equal(result.matched, 'Chicken Breast, Grilled');
  assert.equal(result.origin, 'usda');
  assert.equal('foods' in result, false);
});

test('log_meal text path with a history candidate maps source to "history"', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [historyCandidate()], estimateFoods: null };

  const tools = await toolsPromise;
  await tools.executeToolCall('log_meal', { text: 'grilled chicken breast' }, 'user-1');

  assert.equal((insertedValues[0].payload as Record<string, unknown>).source, 'history');
});

test('log_meal text path returns "Could not find nutrition data" and inserts nothing when no candidates match', async () => {
  insertedValues = [];
  state.searchResult = { candidates: [], estimateFoods: null };

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('log_meal', { text: 'unobtainium soup' }, 'user-1');

  assert.match(result, /Could not find nutrition data for "unobtainium soup"/);
  assert.equal(insertedValues.length, 0);
});

test('log_meal text path with an estimate candidate formats items and returns foods', async () => {
  insertedValues = [];
  state.searchResult = {
    candidates: [{ origin: 'estimate', name: 'eggs and toast', kcal: 350, c: 30, p: 18, f: 15 }],
    estimateFoods: [
      { name: 'eggs', qty: 2, unit: '', kcal: 140 },
      { name: 'toast', qty: 1, unit: 'slice', kcal: 210 },
    ],
  };

  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('log_meal', { text: 'eggs and toast' }, 'user-1'),
  );

  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.source, 'calorieninjas');
  assert.equal(payload.items, '2 eggs, 1slice toast');

  assert.deepEqual(result.foods, [
    { name: 'eggs', qty: 2, unit: '', kcal: 140 },
    { name: 'toast', qty: 1, unit: 'slice', kcal: 210 },
  ]);
  assert.equal(result.origin, 'estimate');
});
