import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { and, eq } from 'drizzle-orm';
import * as realSchema from '../db/schema';

/**
 * Regression coverage for the ontology retraction bug: the coach inserted a
 * SECOND confirmed node instead of clearing a stale one, and the Coach
 * Workspace daily-recommendation gate (loadDailyRecommendationInput) read
 * every confirmed node ever written — including ones that no longer apply —
 * permanently blocking a "prescription" once any Injury/Condition/Medication/
 * Allergy node existed. The fix adds nodes.status ('active' | 'resolved') and
 * filters the constraint query to status = 'active'.
 *
 * This drives the real loadDailyRecommendationInput against a fake `@/db`
 * (no Postgres) and a faked lib/brain/baselines (no calibration query), and
 * asserts on the exact `where` condition object passed for the nodes query —
 * proving the SQL filter, not just downstream JS behavior, excludes resolved
 * nodes. `@/db` must be mocked before ./coachWorkspaceRepository is first
 * imported; node:test isolates each test file in its own subprocess, so this
 * lives on its own (same constraint documented in lib/brain/tools.getSchedule.test.ts).
 */

const state: {
  metricRows: unknown[];
  baselineRows: unknown[];
  nodeRows: Array<{ id: string; type: string; label: string }>;
} = { metricRows: [], baselineRows: [], nodeRows: [] };

let capturedNodesWhere: unknown = null;

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.daily_metrics) {
        return { where: () => Promise.resolve(state.metricRows) };
      }
      if (table === realSchema.baselines) {
        return { where: () => Promise.resolve(state.baselineRows) };
      }
      if (table === realSchema.nodes) {
        return {
          where: (cond: unknown) => {
            capturedNodesWhere = cond;
            return Promise.resolve(state.nodeRows);
          },
        };
      }
      throw new Error(`unexpected select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/baselines', {
  namedExports: { getCalibration: async () => ({ status: 'ready', metrics: {} }) },
});

const repoPromise = import('./coachWorkspaceRepository');

test('loadDailyRecommendationInput scopes the constraint query to active, confirmed nodes for the requesting user', async () => {
  capturedNodesWhere = null;
  state.nodeRows = [{ id: 'node-1', type: 'Injury', label: 'Adductor injury' }];

  const { loadDailyRecommendationInput } = await repoPromise;
  const now = new Date('2026-08-11T12:00:00.000Z');
  const result = await loadDailyRecommendationInput('user-1', '2026-08-11', now);

  // The exact SQL condition the real code built for the nodes query must
  // include status = 'active' — this is the actual fix, not incidental.
  const expectedWhere = and(
    eq(realSchema.nodes.user_id, 'user-1'),
    eq(realSchema.nodes.source, 'confirmed'),
    eq(realSchema.nodes.status, 'active'),
  );
  assert.deepEqual(capturedNodesWhere, expectedWhere);

  assert.deepEqual(result.confirmedConstraints, [{ id: 'node-1', type: 'Injury', label: 'Adductor injury' }]);
});

test('loadDailyRecommendationInput never queries status="resolved" for a different user\'s constraints', async () => {
  capturedNodesWhere = null;
  state.nodeRows = [];

  const { loadDailyRecommendationInput } = await repoPromise;
  await loadDailyRecommendationInput('user-2', '2026-08-11', new Date('2026-08-11T12:00:00.000Z'));

  const expectedWhere = and(
    eq(realSchema.nodes.user_id, 'user-2'),
    eq(realSchema.nodes.source, 'confirmed'),
    eq(realSchema.nodes.status, 'active'),
  );
  assert.deepEqual(capturedNodesWhere, expectedWhere);

  // Never accidentally scoped to another user's id.
  const wrongUserWhere = and(
    eq(realSchema.nodes.user_id, 'user-1'),
    eq(realSchema.nodes.source, 'confirmed'),
    eq(realSchema.nodes.status, 'active'),
  );
  assert.notDeepEqual(capturedNodesWhere, wrongUserWhere);
});

test('a resolved-only node set yields an empty constraint gate (the actual bug scenario)', async () => {
  capturedNodesWhere = null;
  // Simulates Postgres already having excluded the resolved "adductor injury"
  // row — i.e. what the gate sees once resolve_fact has retracted it.
  state.nodeRows = [];

  const { loadDailyRecommendationInput } = await repoPromise;
  const result = await loadDailyRecommendationInput('user-1', '2026-08-11', new Date('2026-08-11T12:00:00.000Z'));

  assert.deepEqual(result.confirmedConstraints, []);
});
