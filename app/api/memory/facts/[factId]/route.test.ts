import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '@/db/schema';

/**
 * PATCH /api/memory/facts/[factId] (Memory contract §2) — exercises the real
 * route + the real supersedeFact/drizzleFactSupersessionStore and
 * loadEntityRoster (neither mocked) against a fake `@/db`, same technique as
 * app/api/memory/facts/[factId]/undo/route.test.ts and
 * app/api/memory/route.test.ts: a fake `nodes`/`users` table scoped by
 * user_id, with `db.transaction` running the real insert+update chain so a
 * dropped user_id/status filter fails this test, not just "was eq() called".
 *
 * `@/db` must be mocked before the route (and lib/brain/tools.ts,
 * lib/brain/entityDoc.ts) is first imported in this process — node:test runs
 * each test file in its own subprocess, so this lives in its own file.
 */

interface FakeNodeRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  properties: unknown;
  source: string;
  weight: number;
  status: string;
  superseded_by: string | null;
  subject_node_id: string | null;
  created_at: Date;
}

function mkRow(overrides: Partial<FakeNodeRow> & { id: string; user_id: string; type: string; label: string }): FakeNodeRow {
  return {
    properties: null,
    source: 'coach',
    weight: 0.6,
    status: 'active',
    superseded_by: null,
    subject_node_id: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

let rows: FakeNodeRow[] = [];
function setRows(newRows: FakeNodeRow[]): void {
  rows = newRows.map((r) => ({ ...r }));
}

let userTimeZone: string | undefined;
function setUserTimeZone(tz: string | undefined): void {
  userTimeZone = tz;
}

let nextInsertId = 0;

function params(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

const fakeDb = {
  select: (cols: Record<string, unknown>) => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return {
          where: () => ({
            limit: async () => (userTimeZone === undefined ? [] : [{ timezone: userTimeZone }]),
          }),
        };
      }

      assert.equal(table, realSchema.nodes, 'must query the nodes table');
      return {
        where: (condition: unknown) => {
          if ('properties' in cols) {
            // drizzleFactSupersessionStore.findActiveNode: and(eq(id), eq(user_id), eq(status,'active'), isNull(superseded_by)).
            const [id, userId, status] = params(condition).map(String);
            const matches = rows.filter((r) => r.id === id && r.user_id === userId && r.status === status);
            return { limit: async (n: number) => matches.slice(0, n) };
          }

          // loadEntityRoster: and(eq(user_id), eq(status,'active'), isNull(superseded_by)).
          const [userId, status] = params(condition).map(String);
          return rows.filter((r) => r.user_id === userId && r.status === status);
        },
      };
    },
  }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: (table: unknown) => {
        assert.equal(table, realSchema.nodes);
        return {
          values: (vals: Record<string, unknown>) => {
            const result = (async () => {
              nextInsertId += 1;
              const newRow: FakeNodeRow = {
                id: `new-${nextInsertId}`,
                user_id: vals.user_id as string,
                type: vals.type as string,
                label: vals.label as string,
                properties: vals.properties ?? null,
                source: vals.source as string,
                weight: vals.weight as number,
                status: 'active',
                superseded_by: null,
                subject_node_id: (vals.subject_node_id as string | null) ?? null,
                created_at: new Date('2026-06-01T00:00:00.000Z'),
              };
              rows.push(newRow);
              return [{ id: newRow.id, type: newRow.type, label: newRow.label, created_at: newRow.created_at }];
            })();
            return { returning: () => result };
          },
        };
      },
      update: (table: unknown) => {
        assert.equal(table, realSchema.nodes);
        return {
          set: (values: Record<string, unknown>) => ({
            where: (condition: unknown) => {
              // drizzleFactSupersessionStore.supersede's old-node update: and(eq(id), eq(user_id), eq(status,'active')).
              const [id, userId, status] = params(condition).map(String);
              const match = rows.find((r) => r.id === id && r.user_id === userId && r.status === status);
              const result = (async () => {
                if (!match) return [];
                Object.assign(match, values);
                return [{ id: match.id }];
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

function req(userId: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId) headers['x-user-id'] = userId;
  return new Request('http://local/api/memory/facts/x', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

function ctx(factId: string) {
  return { params: Promise.resolve({ factId }) };
}

const FACT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_FACT_ID = '22222222-2222-4222-8222-222222222222';
const RESOLVED_FACT_ID = '33333333-3333-4333-8333-333333333333';
const ENTITY_ID = '44444444-4444-4444-8444-444444444444';

test('401 when unauthenticated', async () => {
  const { PATCH } = await routePromise;
  const response = await PATCH(req(undefined, { label: 'New label' }), ctx(FACT_ID));
  assert.equal(response.status, 401);
});

test('200 supersedes: old node becomes superseded with superseded_by set, new node is returned', async () => {
  setUserTimeZone('UTC');
  setRows([
    mkRow({
      id: FACT_ID, user_id: 'user-1', type: 'Habit', label: 'Marathon runner',
      properties: { evidence: 'said so' }, weight: 0.6, source: 'coach',
    }),
  ]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: '  Ultramarathon runner  ' }), ctx(FACT_ID));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.fact.label, 'Ultramarathon runner');
  assert.equal(body.fact.type, 'Habit');
  assert.equal(body.fact.isConstraint, false);
  assert.equal(body.fact.origin, 'confirmed');
  assert.equal(body.fact.group, 'routines');
  assert.match(body.fact.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(body.fact.id, FACT_ID, 'the returned fact must be the NEW node, not the old one');

  const old = rows.find((r) => r.id === FACT_ID)!;
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by, body.fact.id);

  const created = rows.find((r) => r.id === body.fact.id)!;
  assert.equal(created.status, 'active');
  assert.equal(created.label, 'Ultramarathon runner');
  assert.equal(created.source, 'confirmed', 'edited facts are written with source \'confirmed\'');
  assert.equal(created.weight, 0.6, 'weight carries over from the old node');
  assert.deepEqual(created.properties, { evidence: 'said so' }, 'properties carry over from the old node');
});

test('400 for an empty label', async () => {
  setUserTimeZone('UTC');
  setRows([mkRow({ id: FACT_ID, user_id: 'user-1', type: 'Habit', label: 'x' })]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: '   ' }), ctx(FACT_ID));
  assert.equal(response.status, 400);

  const row = rows.find((r) => r.id === FACT_ID);
  assert.equal(row?.status, 'active', 'a rejected edit must never touch the node');
});

test('400 for a label over 140 chars', async () => {
  setUserTimeZone('UTC');
  setRows([mkRow({ id: FACT_ID, user_id: 'user-1', type: 'Habit', label: 'x' })]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: 'a'.repeat(141) }), ctx(FACT_ID));
  assert.equal(response.status, 400);
});

test('404 for another user\'s fact', async () => {
  setUserTimeZone('UTC');
  setRows([mkRow({ id: OTHER_USER_FACT_ID, user_id: 'user-2', type: 'Habit', label: 'x' })]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: 'New label' }), ctx(OTHER_USER_FACT_ID));
  assert.equal(response.status, 404);

  const row = rows.find((r) => r.id === OTHER_USER_FACT_ID);
  assert.equal(row?.status, 'active');
});

test('404 for a resolved (non-active) fact', async () => {
  setUserTimeZone('UTC');
  setRows([mkRow({ id: RESOLVED_FACT_ID, user_id: 'user-1', type: 'Habit', label: 'x', status: 'resolved' })]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: 'New label' }), ctx(RESOLVED_FACT_ID));
  assert.equal(response.status, 404);
});

test('404 for an entity node (a node referenced as another node\'s subject)', async () => {
  setUserTimeZone('UTC');
  setRows([
    mkRow({ id: ENTITY_ID, user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({ id: FACT_ID, user_id: 'user-1', type: 'Condition', label: 'Diabetes', subject_node_id: ENTITY_ID }),
  ]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: 'New label' }), ctx(ENTITY_ID));
  assert.equal(response.status, 404);

  const row = rows.find((r) => r.id === ENTITY_ID);
  assert.equal(row?.status, 'active', 'an entity node must never be superseded via this route');
});

test('404 for a malformed (non-uuid) fact id without touching the db', async () => {
  setUserTimeZone('UTC');
  setRows([mkRow({ id: FACT_ID, user_id: 'user-1', type: 'Habit', label: 'x' })]);

  const { PATCH } = await routePromise;
  const response = await PATCH(req('user-1', { label: 'New label' }), ctx('not-a-uuid'));
  assert.equal(response.status, 404);
});
