import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../../db/schema';

/**
 * `delete_meal`'s scoping rule (see its tool description + executor comment
 * in lib/brain/tools.ts): a meal is only eligible when it (1) belongs to
 * this user, (2) has source = 'coach' (only log_meal ever writes that), and
 * (3) was logged within the last DELETE_MEAL_WINDOW_MINUTES. This drives the
 * real executeToolCall('delete_meal', ...) branch against a fake `@/db`
 * whose `.where()` inspects the actual drizzle condition via
 * `PgDialect().sqlToQuery()` (same technique as
 * lib/brain/tools.queryOntology.test.ts) and applies it to an in-memory row
 * set — so a genuine scoping bug, not just "was eq() called", fails this
 * test.
 *
 * `@/db` must be mocked before `./tools` is first imported in this process —
 * node:test runs each test file in its own subprocess, so this lives in its
 * own file (same constraint as the other lib/brain/tools.*.test.ts files).
 */

interface FakeEventRow {
  id: string;
  user_id: string;
  type: string;
  source: string;
  timestamp: Date;
  payload: unknown;
}

function paramFor(sqlText: string, params: readonly unknown[], column: string, op: '=' | '>='): unknown {
  const escapedOp = op === '>=' ? '>=' : '=';
  const re = new RegExp(`"events"\\."${column}"\\s*${escapedOp}\\s*\\$(\\d+)`);
  const m = sqlText.match(re);
  return m ? params[Number(m[1]) - 1] : undefined;
}

let rows: FakeEventRow[] = [];
let deleteCalls: Array<{ id: unknown; user_id: unknown; type: unknown }> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.events) throw new Error(`unexpected table in select().from(): ${String(table)}`);
      return {
        where: (condition: unknown) => {
          const { sql: sqlText, params } = new PgDialect().sqlToQuery(condition as never);
          const id       = paramFor(sqlText, params, 'id', '=');
          const userId   = paramFor(sqlText, params, 'user_id', '=');
          const type     = paramFor(sqlText, params, 'type', '=');
          const source   = paramFor(sqlText, params, 'source', '=');
          const sinceRaw = paramFor(sqlText, params, 'timestamp', '>=');
          const since    = sinceRaw != null ? new Date(sinceRaw as string | number | Date) : undefined;

          const filtered = rows.filter((r) =>
            (id === undefined || r.id === id) &&
            r.user_id === userId &&
            r.type === type &&
            r.source === source &&
            (since === undefined || r.timestamp.getTime() >= since.getTime()),
          );

          return {
            limit: async (n: number) => filtered.slice(0, n),
            orderBy: (..._order: unknown[]) => ({
              limit: async (n: number) =>
                [...filtered].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, n),
            }),
          };
        },
      };
    },
  }),
  delete: (table: unknown) => {
    if (table !== realSchema.events) throw new Error(`unexpected table in delete(): ${String(table)}`);
    return {
      where: (condition: unknown) => {
        const { sql: sqlText, params } = new PgDialect().sqlToQuery(condition as never);
        const id     = paramFor(sqlText, params, 'id', '=');
        const userId = paramFor(sqlText, params, 'user_id', '=');
        const type   = paramFor(sqlText, params, 'type', '=');
        deleteCalls.push({ id, user_id: userId, type });
        return {
          returning: async (_proj: unknown) => {
            const idx = rows.findIndex((r) => r.id === id && r.user_id === userId && r.type === type);
            if (idx === -1) return [];
            const [deleted] = rows.splice(idx, 1);
            return [{ id: deleted.id }];
          },
        };
      },
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const toolsPromise = import('./tools');

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

test('delete_meal deletes the user\'s most recent coach-logged meal when no id is given', async () => {
  rows = [
    { id: 'evt-old', user_id: 'user-1', type: 'meal_logged', source: 'coach', timestamp: minutesAgo(5), payload: { name: 'Oatmeal' } },
    { id: 'evt-new', user_id: 'user-1', type: 'meal_logged', source: 'coach', timestamp: minutesAgo(1), payload: { name: 'Chicken bowl' } },
  ];
  deleteCalls = [];

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('delete_meal', {}, 'user-1'));

  assert.equal(result.ok, true);
  assert.equal(result.id, 'evt-new');
  assert.equal(result.name, 'Chicken bowl');
  assert.equal(deleteCalls.length, 1);
  assert.equal(rows.some((r) => r.id === 'evt-new'), false);
  assert.equal(rows.some((r) => r.id === 'evt-old'), true);
});

test('delete_meal with an explicit id deletes only that meal when it belongs to this user', async () => {
  rows = [
    { id: 'evt-1', user_id: 'user-1', type: 'meal_logged', source: 'coach', timestamp: minutesAgo(2), payload: { name: 'Toast' } },
  ];
  deleteCalls = [];

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('delete_meal', { id: 'evt-1' }, 'user-1'));

  assert.equal(result.ok, true);
  assert.equal(result.id, 'evt-1');
  assert.equal(rows.length, 0);
});

test('delete_meal refuses an id that belongs to a different user', async () => {
  rows = [
    { id: 'evt-1', user_id: 'someone-else', type: 'meal_logged', source: 'coach', timestamp: minutesAgo(2), payload: {} },
  ];
  deleteCalls = [];

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('delete_meal', { id: 'evt-1' }, 'user-1');

  assert.match(result, /^Error:/);
  assert.equal(deleteCalls.length, 0);
  assert.equal(rows.length, 1); // untouched
});

test('delete_meal refuses a meal that was not logged by the coach (app-side log)', async () => {
  rows = [
    { id: 'evt-1', user_id: 'user-1', type: 'meal_logged', source: 'search', timestamp: minutesAgo(1), payload: {} },
  ];
  deleteCalls = [];

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('delete_meal', { id: 'evt-1' }, 'user-1');

  assert.match(result, /^Error:/);
  assert.equal(deleteCalls.length, 0);
  assert.equal(rows.length, 1);
});

test('delete_meal refuses a meal older than the eligibility window', async () => {
  const tools = await toolsPromise;
  rows = [
    {
      id: 'evt-1', user_id: 'user-1', type: 'meal_logged', source: 'coach',
      timestamp: minutesAgo(tools.DELETE_MEAL_WINDOW_MINUTES + 5), payload: {},
    },
  ];
  deleteCalls = [];

  const result = await tools.executeToolCall('delete_meal', { id: 'evt-1' }, 'user-1');

  assert.match(result, /^Error:/);
  assert.equal(deleteCalls.length, 0);
  assert.equal(rows.length, 1);
});

test('delete_meal returns a clear text error, and deletes nothing, when no meal is eligible', async () => {
  rows = [];
  deleteCalls = [];

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('delete_meal', {}, 'user-1');

  assert.match(result, /^Error:/);
  assert.match(result, new RegExp(`${tools.DELETE_MEAL_WINDOW_MINUTES} minutes`));
  assert.equal(deleteCalls.length, 0);
});

test('delete_meal never matches by free-text description — id is the only optional selector', async () => {
  rows = [
    { id: 'evt-1', user_id: 'user-1', type: 'meal_logged', source: 'coach', timestamp: minutesAgo(1), payload: { name: 'Oats' } },
  ];
  deleteCalls = [];

  const tools = await toolsPromise;
  // The tool's input_schema only accepts `id` — a stray `text`/`description`
  // field (were a model to hallucinate one) is simply ignored, never used to
  // match by name.
  const result = JSON.parse(await tools.executeToolCall('delete_meal', { text: 'oats' } as never, 'user-1'));

  assert.equal(result.ok, true);
  assert.equal(result.id, 'evt-1');
});
