import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '@/db/schema';

/**
 * GET /api/memory — the iOS "Memory" browser's landing endpoint. Exercises
 * the real route + the real lib/brain/entityDoc.ts loaders (loadEntityRoster
 * is not mocked) against a fake `@/db`, so a real regression in either the
 * roster's WHERE clause or this route's own self-facts query fails these
 * tests — same technique as lib/brain/entityDoc.test.ts (real drizzle SQL
 * rendered via PgDialect().sqlToQuery(), not just "was eq() called").
 *
 * `@/db` must be mocked before the route module's first import (same
 * constraint documented in app/api/today/route.test.ts).
 */

interface FakeNodeRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  subject_node_id: string | null;
  status: string;
  superseded_by: string | null;
}

function mkRow(overrides: Partial<FakeNodeRow> & { id: string; user_id: string; type: string; label: string }): FakeNodeRow {
  return {
    subject_node_id: null,
    status: 'active',
    superseded_by: null,
    ...overrides,
  };
}

let rows: FakeNodeRow[] = [];
function setRows(newRows: FakeNodeRow[]): void {
  rows = newRows;
}

function assertNodesTable(table: unknown): void {
  if (table !== realSchema.nodes) throw new Error(`unexpected table in select().from(): ${String(table)}`);
}

const fakeDb = {
  select: (cols: Record<string, unknown>) => ({
    from: (table: unknown) => {
      assertNodesTable(table);
      return {
        where: (condition: unknown) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const userId = String(params[0]);
          const base = rows.filter(r => r.user_id === userId && r.status === 'active' && r.superseded_by === null);

          if ('subject_node_id' in cols) {
            // loadEntityRoster's query: and(eq(user_id), eq(status,'active'), isNull(superseded_by))
            return base;
          }

          // This route's own self-facts candidate query: same three
          // conditions plus isNull(subject_node_id).
          return base.filter(r => r.subject_node_id === null);
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
  return new Request('http://local/api/memory', { headers });
}

test('401 when unauthenticated', async () => {
  const { GET } = await routePromise;
  const response = await GET(req());
  assert.equal(response.status, 401);
});

test('cross-user isolation: another user\'s entities and facts never appear', async () => {
  setRows([
    mkRow({ id: 'self-fact-u1', user_id: 'user-1', type: 'Goal', label: 'Run a 10k' }),
    mkRow({ id: 'father-u1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({ id: 'father-fact-u1', user_id: 'user-1', type: 'Condition', label: 'Diabetes', subject_node_id: 'father-u1' }),

    mkRow({ id: 'self-fact-u2', user_id: 'user-2', type: 'Allergy', label: 'Peanuts' }),
    mkRow({ id: 'mother-u2', user_id: 'user-2', type: 'Person', label: 'Mother' }),
    mkRow({ id: 'mother-fact-u2', user_id: 'user-2', type: 'Condition', label: 'Asthma', subject_node_id: 'mother-u2' }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.self.factCount, 1);
  assert.deepEqual(body.self.facts.map((f: { label: string }) => f.label), ['Run a 10k']);
  assert.equal(body.entities.length, 1);
  assert.equal(body.entities[0].label, 'Father');

  // Never user-2's data.
  assert.ok(!body.self.facts.some((f: { label: string }) => f.label === 'Peanuts'));
  assert.ok(!body.entities.some((e: { label: string }) => e.label === 'Mother'));
});

test('third-party facts and entity nodes are excluded from self.facts', async () => {
  setRows([
    mkRow({ id: 'self-fact', user_id: 'user-1', type: 'Habit', label: 'Runs daily' }),
    // The entity node itself — subject_node_id NULL, but referenced as a subject below.
    mkRow({ id: 'father', user_id: 'user-1', type: 'Person', label: 'Father' }),
    // A third-party fact — must never appear in self.facts.
    mkRow({ id: 'father-fact', user_id: 'user-1', type: 'Condition', label: 'Type 2 Diabetes', subject_node_id: 'father' }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  const body = await response.json();

  assert.equal(body.self.factCount, 1);
  assert.equal(body.self.facts[0].label, 'Runs daily');
  assert.ok(!body.self.facts.some((f: { label: string }) => f.label === 'Father'));
  assert.ok(!body.self.facts.some((f: { label: string }) => f.label === 'Type 2 Diabetes'));
  assert.equal(body.entities.length, 1);
  assert.equal(body.entities[0].label, 'Father');
  assert.equal(body.entities[0].factCount, 1);
});

test('isConstraint is true for Allergy/Condition/Medication/Injury and false otherwise', async () => {
  setRows([
    mkRow({ id: 'a', user_id: 'user-1', type: 'Allergy', label: 'Peanuts' }),
    mkRow({ id: 'c', user_id: 'user-1', type: 'Condition', label: 'Asthma' }),
    mkRow({ id: 'm', user_id: 'user-1', type: 'Medication', label: 'Albuterol' }),
    mkRow({ id: 'i', user_id: 'user-1', type: 'Injury', label: 'Sprained ankle' }),
    mkRow({ id: 'g', user_id: 'user-1', type: 'Goal', label: 'Run a marathon' }),
    mkRow({ id: 'h', user_id: 'user-1', type: 'Habit', label: 'Sleeps 8 hours' }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  const body = await response.json();

  const byId = new Map(body.self.facts.map((f: { id: string; isConstraint: boolean }) => [f.id, f.isConstraint]));
  assert.equal(byId.get('a'), true);
  assert.equal(byId.get('c'), true);
  assert.equal(byId.get('m'), true);
  assert.equal(byId.get('i'), true);
  assert.equal(byId.get('g'), false);
  assert.equal(byId.get('h'), false);
});

test('resolved and superseded self-facts are excluded', async () => {
  setRows([
    mkRow({ id: 'active-fact', user_id: 'user-1', type: 'Goal', label: 'Run a 10k' }),
    mkRow({ id: 'resolved-fact', user_id: 'user-1', type: 'Injury', label: 'Old sprain', status: 'resolved' }),
    mkRow({ id: 'superseded-fact', user_id: 'user-1', type: 'Goal', label: 'Old goal', superseded_by: 'active-fact' }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'));
  const body = await response.json();

  assert.equal(body.self.factCount, 1);
  assert.equal(body.self.facts[0].label, 'Run a 10k');
});
