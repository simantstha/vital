import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';

/**
 * Drives the real `recordDelivery` against a fake `@/db` so it never touches
 * Postgres. Both scenarios share one mock.module()/import() — a second test
 * in this file re-importing './notificationInbox' would just get the cached
 * module bound to the FIRST mock (see the same caveat documented in
 * proactiveHealthWorkerRepository.test.ts), so idempotency and failure-
 * swallowing are exercised together against one stateful fake.
 */
test('recordDelivery is idempotent across duplicate deliveries and swallows a DB failure', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let shouldThrow = false;

  const fakeDb = {
    insert: (table: unknown) => {
      if (shouldThrow) throw new Error('db unavailable');
      assert.equal(table, realSchema.notification_inbox);
      return {
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            // Mirrors the real unique index on (user_id, type, target_id):
            // a duplicate key is a no-op, not a second row.
            const key = `${values.user_id}:${values.type}:${values.target_id}`;
            if (!seen.has(key)) {
              seen.add(key);
              rows.push(values);
            }
            return [];
          },
        }),
      };
    },
  };
  mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
  const { recordDelivery } = await import('./notificationInbox');

  const alert = { title: 'Workout logged', body: 'Your run has been logged.' };
  await recordDelivery('user-1', 'workout_analysis', 'analysis-1', alert, 'vital://workout-analysis/analysis-1');
  await recordDelivery('user-1', 'workout_analysis', 'analysis-1', alert, 'vital://workout-analysis/analysis-1');
  assert.equal(rows.length, 1, 'second insert for the same (userId, type, targetId) must be a no-op');
  assert.equal(rows[0].title, 'Workout logged');

  shouldThrow = true;
  const originalError = console.error;
  let loggedCount = 0;
  console.error = () => { loggedCount += 1; };
  try {
    await assert.doesNotReject(
      recordDelivery('user-1', 'sleep_analysis', 'analysis-2', alert, 'vital://sleep-analysis/analysis-2'),
      'a failed inbox write must never throw into the caller',
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(loggedCount, 1, 'the swallowed failure is still logged');

  // Test that markRead with empty ids returns 0 without touching the database
  const { markRead } = await import('./notificationInbox');
  const updated = await markRead('user-1', { ids: [] });
  assert.equal(updated, 0, 'markRead with empty ids must return 0 without querying the database');
});
