import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '@/db/schema';

/**
 * GET /api/memory/entities/[id] — exercises the real route + the real
 * lib/brain/entityDoc.ts's loadEntityDoc (not mocked) against a fake `@/db`.
 * Fake dispatch technique mirrors lib/brain/entityDoc.test.ts's DB-backed
 * tests: real drizzle WHERE clauses are rendered via PgDialect().sqlToQuery()
 * so a dropped user_id or status filter fails these tests, not just "was
 * eq() called".
 */

interface FakeNodeRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  subject_node_id: string | null;
  properties: unknown;
  source: string;
  weight: number;
  status: string;
  superseded_by: string | null;
  created_at: Date;
}

function mkRow(overrides: Partial<FakeNodeRow> & { id: string; user_id: string; type: string; label: string }): FakeNodeRow {
  return {
    subject_node_id: null,
    properties: null,
    source: 'coach',
    weight: 0.6,
    status: 'active',
    superseded_by: null,
    created_at: new Date('2026-01-01'),
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

function selectDistinctImpl(_cols: Record<string, unknown>) {
  return {
    from: (table: unknown) => {
      assertNodesTable(table);
      return {
        where: (condition: unknown) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const userId = String(params[0]);
          return [...new Set(
            rows
              .filter(r => r.user_id === userId && r.status === 'active' && r.superseded_by === null && r.subject_node_id !== null)
              .map(r => r.subject_node_id as string),
          )];
        },
      };
    },
  };
}

function selectImpl(cols: Record<string, unknown>) {
  return {
    from: (table: unknown) => {
      assertNodesTable(table);
      return {
        where: (condition: unknown) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const userId = String(params[0]);
          const keys = Object.keys(cols);

          if (keys.includes('source')) {
            // loadEntityDoc's fact query
            const entityId = String(params[1]);
            const matches = rows.filter(r =>
              r.user_id === userId && r.subject_node_id === entityId && r.status === 'active' && r.superseded_by === null);
            return { orderBy: async (..._order: unknown[]) => matches };
          }

          // fetchEntityCandidates's outer select
          const ids = params.slice(2).map(String);
          return rows.filter(r =>
            r.user_id === userId && r.status === 'active' && r.superseded_by === null && ids.includes(r.id));
        },
      };
    },
  };
}

const mockDb = {
  select: (cols: Record<string, unknown>) => selectImpl(cols),
  selectDistinct: (cols: Record<string, unknown>) => selectDistinctImpl(cols),
};
mock.module('@/db', { namedExports: { db: mockDb, schema: realSchema } });

const routePromise = import('./route');

function req(userId?: string): Request {
  const headers: Record<string, string> = {};
  if (userId) headers['x-user-id'] = userId;
  return new Request('http://local/api/memory/entities/x', { headers });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test('401 when unauthenticated', async () => {
  const { GET } = await routePromise;
  const response = await GET(req(), ctx('father-1'));
  assert.equal(response.status, 401);
});

test('404 with a JSON error for an unknown entity id', async () => {
  setRows([]);
  const { GET } = await routePromise;
  const response = await GET(req('user-1'), ctx('does-not-exist'));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('cross-user isolation: another user\'s entity id 404s and their facts never appear', async () => {
  setRows([
    mkRow({ id: 'father-u1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-u1', user_id: 'user-1', type: 'Condition', label: 'Hypertension',
      subject_node_id: 'father-u1', source: 'confirmed', properties: { evidence: 'controlled with diet' },
    }),
    mkRow({ id: 'mother-u2', user_id: 'user-2', type: 'Person', label: 'Mother' }),
    mkRow({
      id: 'fact-u2', user_id: 'user-2', type: 'Condition', label: 'Should never appear',
      subject_node_id: 'mother-u2', source: 'confirmed', properties: { evidence: 'x' },
    }),
  ]);

  const { GET } = await routePromise;

  // user-2's entity id is not resolvable for user-1.
  const miss = await GET(req('user-1'), ctx('mother-u2'));
  assert.equal(miss.status, 404);

  // user-1's own entity resolves, with only their own facts.
  const hit = await GET(req('user-1'), ctx('father-u1'));
  assert.equal(hit.status, 200);
  const body = await hit.json();
  assert.equal(body.id, 'father-u1');
  assert.equal(body.label, 'Father');
  assert.equal(body.kind, 'Person');
  assert.equal(body.isSelf, false);
  assert.equal(body.facts.length, 1);
  assert.equal(body.facts[0].label, 'Hypertension');
  assert.ok(!body.facts.some((f: { label: string }) => f.label === 'Should never appear'));
});

test('facts serialise createdAt as an ISO 8601 string with exact camelCase keys', async () => {
  setRows([
    mkRow({ id: 'father-1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-1', user_id: 'user-1', type: 'Condition', label: 'Diabetes',
      subject_node_id: 'father-1', source: 'confirmed',
      properties: { evidence: 'diagnosed at 50' },
      created_at: new Date('2026-08-15T12:00:00Z'),
    }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'), ctx('father-1'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), ['facts', 'id', 'isSelf', 'kind', 'label']);
  const fact = body.facts[0];
  assert.deepEqual(Object.keys(fact).sort(), ['createdAt', 'evidence', 'label', 'source', 'type']);
  assert.equal(fact.createdAt, '2026-08-15T12:00:00.000Z');
  assert.equal(fact.evidence, 'diagnosed at 50');
  assert.equal(fact.source, 'confirmed');
});

test('resolved and superseded facts are excluded from the entity document', async () => {
  setRows([
    mkRow({ id: 'father-1', user_id: 'user-1', type: 'Person', label: 'Father' }),
    mkRow({
      id: 'fact-active', user_id: 'user-1', type: 'Condition', label: 'Hypertension',
      subject_node_id: 'father-1', source: 'confirmed',
    }),
    mkRow({
      id: 'fact-resolved', user_id: 'user-1', type: 'Condition', label: 'Old back injury',
      subject_node_id: 'father-1', source: 'coach', status: 'resolved',
    }),
    mkRow({
      id: 'fact-superseded', user_id: 'user-1', type: 'Condition', label: 'Provisional guess',
      subject_node_id: 'father-1', source: 'coach', superseded_by: 'fact-active',
    }),
  ]);

  const { GET } = await routePromise;
  const response = await GET(req('user-1'), ctx('father-1'));
  const body = await response.json();
  assert.deepEqual(body.facts.map((f: { label: string }) => f.label), ['Hypertension']);
});
