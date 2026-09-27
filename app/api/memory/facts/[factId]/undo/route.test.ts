import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '@/db/schema';

/**
 * POST /api/memory/facts/[factId]/undo (chat-activity contract §2) —
 * exercises the real route + the real resolveFact/drizzleNodeResolutionStore
 * (not mocked) against a fake `@/db`, mirroring
 * lib/brain/tools.resolveFactCascade.test.ts's technique: a fake `nodes`
 * table scoped by user_id, with `db.transaction` running the real update
 * chain so a dropped user_id/status filter would fail this test, not just
 * "was eq() called".
 *
 * `@/db` must be mocked before the route (and lib/brain/tools.ts) is first
 * imported in this process — node:test runs each test file in its own
 * subprocess, so this lives in its own file.
 */

interface FakeNodeRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  status: string;
}

let rows: FakeNodeRow[] = [];
function setRows(newRows: FakeNodeRow[]): void {
  rows = newRows.map((r) => ({ ...r }));
}

function params(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      assert.equal(table, realSchema.nodes, 'must query the nodes table');
      return {
        where: (condition: unknown) => {
          // findActiveNode's id branch: and(eq(user_id), eq(status,'active'), isNull(superseded_by), eq(id)).
          const [userId, status, id] = params(condition).map(String);
          const matches = rows.filter((r) => r.user_id === userId && r.status === status && r.id === id);
          return { limit: async (n: number) => matches.slice(0, n) };
        },
      };
    },
  }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: (table: unknown) => {
        assert.equal(table, realSchema.nodes);
        return {
          set: (values: Record<string, unknown>) => ({
            where: (condition: unknown) => {
              // resolveNode's target update: and(eq(id), eq(user_id), eq(status,'active')).
              const [id, userId, status] = params(condition).map(String);
              const match = rows.find((r) => r.id === id && r.user_id === userId && r.status === status);
              const result = (async () => {
                if (!match) return [];
                match.status = values.status as string;
                return [{ id: match.id, label: match.label, type: match.type }];
              })();
              return Object.assign(result, { returning: () => result });
            },
          }),
        };
      },
    };
    return fn(tx);
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function req(userId?: string): Request {
  const headers: Record<string, string> = {};
  if (userId) headers['x-user-id'] = userId;
  return new Request('http://local/api/memory/facts/x/undo', { method: 'POST', headers });
}

function ctx(factId: string) {
  return { params: Promise.resolve({ factId }) };
}

const FACT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_FACT_ID = '22222222-2222-4222-8222-222222222222';

test('401 when unauthenticated', async () => {
  const { POST } = await routePromise;
  const response = await POST(req(), ctx(FACT_ID));
  assert.equal(response.status, 401);
});

test('200 and resolves the node for the owning user', async () => {
  setRows([{ id: FACT_ID, user_id: 'user-1', type: 'Habit', label: 'Marathon runner', status: 'active' }]);

  const { POST } = await routePromise;
  const response = await POST(req('user-1'), ctx(FACT_ID));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true });

  const row = rows.find((r) => r.id === FACT_ID);
  assert.equal(row?.status, 'resolved', 'the node must actually be flipped to resolved, not just report ok');
});

test('404 for another user\'s fact (never resolved)', async () => {
  setRows([{ id: OTHER_USER_FACT_ID, user_id: 'user-2', type: 'Habit', label: 'Someone else\'s fact', status: 'active' }]);

  const { POST } = await routePromise;
  const response = await POST(req('user-1'), ctx(OTHER_USER_FACT_ID));
  assert.equal(response.status, 404);

  const row = rows.find((r) => r.id === OTHER_USER_FACT_ID);
  assert.equal(row?.status, 'active', 'a fact scoped to another user must never be resolved');
});

test('404 for an unknown fact id', async () => {
  setRows([]);
  const { POST } = await routePromise;
  const response = await POST(req('user-1'), ctx(FACT_ID));
  assert.equal(response.status, 404);
});

test('404 for a malformed (non-uuid) fact id without touching the db', async () => {
  setRows([{ id: FACT_ID, user_id: 'user-1', type: 'Habit', label: 'x', status: 'active' }]);
  const { POST } = await routePromise;
  const response = await POST(req('user-1'), ctx('not-a-uuid'));
  assert.equal(response.status, 404);

  const row = rows.find((r) => r.id === FACT_ID);
  assert.equal(row?.status, 'active');
});
