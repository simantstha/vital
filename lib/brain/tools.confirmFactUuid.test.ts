import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * confirm_fact's `factId` flows into `eq(schema.pending_facts.id, factId)`
 * — a Postgres `uuid` column. A malformed factId (a truncated id, "last",
 * a fact's own text) must return a text error and never reach that query.
 * `@/db` is mocked to throw on any access so this fails loudly if the guard
 * doesn't run before the query — same technique as
 * lib/brain/tools.deleteMeal.test.ts.
 *
 * `@/db` must be mocked before `./tools` is first imported in this process —
 * node:test runs each test file in its own subprocess, so this lives in its
 * own file (same constraint as the other lib/brain/tools.*.test.ts files).
 */

const fakeDb = {
  update: () => {
    throw new Error('confirm_fact must not query the db for a malformed factId');
  },
  select: () => {
    throw new Error('confirm_fact must not query the db for a malformed factId');
  },
  insert: () => {
    throw new Error('confirm_fact must not query the db for a malformed factId');
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const toolsPromise = import('./tools');

test('confirm_fact rejects a malformed factId before running any query (uuid column guard)', async () => {
  const tools = await toolsPromise;

  for (const badId of ['last', 'the user is allergic to peanuts', 'fact-1', '123']) {
    const result = await tools.executeToolCall('confirm_fact', { factId: badId, action: 'confirm' }, 'user-1');
    assert.match(
      result,
      /^Error: that isn't a valid fact id\.$/,
      `expected a validation error for factId ${JSON.stringify(badId)}, got: ${result}`,
    );
  }
});

test('confirm_fact accepts a well-formed uuid factId regardless of case (reaches the store)', async () => {
  const tools = await toolsPromise;
  // A well-formed id passes the guard and proceeds to query — which throws
  // in this test's fake db, proving the guard let it through rather than
  // rejecting it.
  await assert.rejects(
    tools.executeToolCall('confirm_fact', { factId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', action: 'confirm' }, 'user-1'),
    /must not query the db/,
  );
});
