import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '@/db/schema';

/**
 * GET /api/pending-facts — exercises the real route against a fake `@/db`.
 * Covers the additive `reason` field (Memory contract §1): re-surfaced from
 * `pending_facts.evidence`, trimmed, capped at 140 chars, and omitted when
 * evidence is blank.
 */

interface FakePendingFactRow {
  id: string;
  user_id: string;
  proposed_node: unknown;
  proposed_edge: unknown;
  evidence: string;
  salience: number;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
}

function mkRow(overrides: Partial<FakePendingFactRow> & { id: string; user_id: string; evidence: string }): FakePendingFactRow {
  return {
    proposed_node: null,
    proposed_edge: null,
    salience: 0.5,
    status: 'pending',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    resolved_at: null,
    ...overrides,
  };
}

let rows: FakePendingFactRow[] = [];
function setRows(newRows: FakePendingFactRow[]): void {
  rows = newRows;
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      assert.equal(table, realSchema.pending_facts, 'must query the pending_facts table');
      return {
        where: (condition: unknown) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const [userId, status] = params.map(String);
          const matches = rows.filter((r) => r.user_id === userId && r.status === status);
          return { orderBy: () => matches };
        },
      };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function req(userId?: string): Request {
  const headers: Record<string, string> = {};
  if (userId) headers['x-user-id'] = userId;
  return new Request('http://local/api/pending-facts', { headers });
}

test('401 when unauthenticated', async () => {
  const { GET } = await routePromise;
  const response = await GET(req());
  assert.equal(response.status, 401);
});

test('reason mirrors trimmed evidence when present', async () => {
  setRows([mkRow({ id: 'p1', user_id: 'user-1', evidence: '  mentioned in chat  ' })]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.items[0].evidence, '  mentioned in chat  ', 'evidence field is unchanged');
  assert.equal(body.items[0].reason, 'mentioned in chat');
});

test('reason is omitted when evidence is blank', async () => {
  setRows([mkRow({ id: 'p1', user_id: 'user-1', evidence: '   ' })]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  const body = await response.json();

  assert.ok(!('reason' in body.items[0]));
});

test('reason is truncated to 140 chars', async () => {
  setRows([mkRow({ id: 'p1', user_id: 'user-1', evidence: 'x'.repeat(200) })]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  const body = await response.json();

  assert.equal(body.items[0].reason.length, 140);
});

test('another user\'s pending facts never appear', async () => {
  setRows([
    mkRow({ id: 'p1', user_id: 'user-1', evidence: 'mine' }),
    mkRow({ id: 'p2', user_id: 'user-2', evidence: 'not mine' }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  const body = await response.json();

  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, 'p1');
});
