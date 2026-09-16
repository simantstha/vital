import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../../db/schema';

/**
 * query_ontology (executeToolCall's nodes reader) must exclude a superseded
 * row (superseded_by IS NULL) the same way every other nodes reader listed
 * in the memory-tiers plan does — see lib/brain/memoryTiers.ts. This drives
 * the real query_ontology branch against a fake `@/db` whose `.where()`
 * inspects the actual drizzle condition via PgDialect().sqlToQuery() (same
 * technique as lib/brain/dailyBriefRepository.test.ts) and applies it to an
 * in-memory row set, so a genuine filtering bug (not just "was isNull()
 * called") would fail this test.
 *
 * `@/db` must be mocked before `./tools` is first imported in this process —
 * node:test runs each test file in its own subprocess (same constraint
 * lib/proactiveHealthWorkerRepository.test.ts documents), so this lives in
 * its own file.
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
  created_at: Date;
  resolved_at: Date | null;
}

const rows: FakeNodeRow[] = [
  {
    id: 'node-active', user_id: 'user-1', type: 'Habit', label: 'Keeps a food journal',
    properties: null, source: 'coach', weight: 0.6, status: 'active', superseded_by: null,
    created_at: new Date('2026-01-01'), resolved_at: null,
  },
  {
    id: 'node-superseded', user_id: 'user-1', type: 'Habit', label: 'Stale provisional guess',
    properties: null, source: 'coach', weight: 0.6, status: 'active', superseded_by: 'node-active',
    created_at: new Date('2026-01-01'), resolved_at: null,
  },
];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.nodes) throw new Error(`unexpected table in select().from(): ${String(table)}`);
      return {
        where: (condition: unknown) => {
          const { sql: sqlText, params } = new PgDialect().sqlToQuery(condition as never);
          const userId = params[0];
          // isNull(superseded_by) has no bound param, so detect it from the
          // rendered SQL text — the same signal a real Postgres planner
          // would act on.
          const excludesSuperseded = /superseded_by["`]?\s+is\s+null/i.test(sqlText);
          return {
            orderBy: async (..._order: unknown[]) =>
              rows.filter(
                (r) =>
                  r.user_id === userId &&
                  r.status === 'active' &&
                  (!excludesSuperseded || r.superseded_by === null),
              ),
          };
        },
      };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const toolsPromise = import('./tools');

test('query_ontology excludes a superseded row', async () => {
  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('query_ontology', {}, 'user-1')) as FakeNodeRow[];

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'node-active');
  assert.ok(!result.some((r) => r.id === 'node-superseded'));
});
