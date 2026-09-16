import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';

/**
 * `workerRepository.getContext` reads ontology nodes and feeds them into the
 * proactive analysis prompt as `profile.facts`. Nodes are never deleted — a
 * retracted fact ("my injury healed", "I'm no longer allergic to X") flips
 * `status` to 'resolved' instead (see the lifecycle comment on the `nodes`
 * table in db/schema.ts). If the nodes query only filters on `user_id`, a
 * retracted fact keeps reaching the model's prompt forever.
 *
 * This drives the real `getContext` implementation against a fake `@/db`
 * and inspects the drizzle `where()` condition passed for the nodes table.
 * The fake's `where()` normally discards its argument, so this test
 * captures it and serializes the drizzle SQL AST (stripping the circular
 * `table` back-reference) to confirm the condition actually constrains
 * `nodes.status` to the literal 'active' — not just that a query happened.
 * A bare `eq(nodes.user_id, ...)` with no status clause serializes without
 * a "status"/"active" pair in proximity, so this genuinely fails if the
 * filter is removed (verified manually by reverting the fix and re-running).
 *
 * `@/db` must be mocked before `proactiveHealthWorkerRepository` is first
 * imported in this process, so this lives in its own file — node:test runs
 * each test file in its own subprocess, keeping the module registry clean.
 * (lib/proactiveHealthWorkerRepository.test.ts already owns the one other
 * `@/db` mock in this package; a second mock in that file would conflict.)
 */
test("getContext's ontology-nodes query filters to status = 'active'", async () => {
  let nodesWhereCondition: unknown;

  function thenableRows<T>(rows: T[]) {
    // db.select(...).from(...).where(...) is sometimes awaited directly
    // (baselines, metrics) and sometimes chained with .limit(1) (preferences,
    // users) in the real getContext implementation, so the stand-in for
    // where()'s return value needs to satisfy both call shapes.
    const p = Promise.resolve(rows) as Promise<T[]> & { limit: () => Promise<T[]> };
    p.limit = async () => rows;
    return p;
  }

  const fakeDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          if (table === realSchema.nodes) nodesWhereCondition = condition;
          if (table === realSchema.notification_preferences) {
            return thenableRows([{ timezone: 'UTC', workout_notifications_enabled: true, sleep_notifications_enabled: true }]);
          }
          if (table === realSchema.users) {
            return thenableRows([{ name: 'Test', goal: null, target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null, unit_system: null }]);
          }
          return thenableRows([]); // baselines, daily_metrics, nodes
        },
      }),
    }),
  };

  mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
  const { workerRepository } = await import('./proactiveHealthWorkerRepository');

  const job = {
    id: 'workout-1',
    kind: 'workout' as const,
    userId: 'user-1',
    localDate: '2026-09-16',
    input: {},
    retryCount: 0,
    notificationRetryCount: 0,
    leaseToken: 'lease-1',
  };

  await workerRepository.getContext(job);

  assert.ok(nodesWhereCondition, 'nodes query must pass a where() condition');
  const serialized = JSON.stringify(nodesWhereCondition, (key, value) => (key === 'table' ? '[table]' : value));
  assert.match(
    serialized,
    /"name":"status"[\s\S]{0,400}?"value":"active"/,
    "expected the nodes where() condition to constrain status to 'active'",
  );
});
