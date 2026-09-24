import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * resolve_fact's `id` flows into `eq(schema.nodes.id, id)` inside
 * findActiveNode — a Postgres `uuid` column. A malformed id (a truncated
 * id, "last", a fact's own text) must return a text error and never reach
 * that query, and must not silently fall back to a label match. `@/db` is
 * mocked to throw on any access so this fails loudly if the guard doesn't
 * run before the query — same technique as lib/brain/tools.deleteMeal.test.ts.
 *
 * `@/db` must be mocked before `./tools` is first imported in this process —
 * node:test runs each test file in its own subprocess, so this lives in its
 * own file (same constraint as the other lib/brain/tools.*.test.ts files).
 */

const fakeDb = {
  select: () => {
    throw new Error('resolve_fact must not query the db for a malformed id');
  },
  update: () => {
    throw new Error('resolve_fact must not query the db for a malformed id');
  },
  transaction: () => {
    throw new Error('resolve_fact must not query the db for a malformed id');
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const toolsPromise = import('./tools');

test('resolve_fact rejects a malformed id before running any query (uuid column guard)', async () => {
  const tools = await toolsPromise;

  for (const badId of ['last', 'the user is allergic to peanuts', 'node-1', '123']) {
    const result = await tools.executeToolCall(
      'resolve_fact',
      { id: badId, evidence: 'no longer true' },
      'user-1',
    );
    assert.match(
      result,
      /^Error: that isn't a valid fact id\.$/,
      `expected a validation error for id ${JSON.stringify(badId)}, got: ${result}`,
    );
  }
});

test('resolve_fact does not fall back to a label match when an explicit id is malformed', async () => {
  const tools = await toolsPromise;
  // Even though `label` is also a valid selector for resolve_fact, an
  // explicit (if malformed) id means a *specific* fact was meant — the tool
  // must not silently retry by label.
  const result = await tools.executeToolCall(
    'resolve_fact',
    { id: 'not-a-uuid', label: 'Peanut allergy', evidence: 'outgrew it' },
    'user-1',
  );
  assert.match(result, /^Error: that isn't a valid fact id\.$/);
});

test('resolve_fact accepts a well-formed uuid id regardless of case (reaches the store)', async () => {
  const tools = await toolsPromise;
  await assert.rejects(
    tools.executeToolCall(
      'resolve_fact',
      { id: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', evidence: 'outgrew it' },
      'user-1',
    ),
    /must not query the db/,
  );
});
