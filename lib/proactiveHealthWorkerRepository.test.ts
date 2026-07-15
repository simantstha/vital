import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';

/**
 * Sleep notifications used to be suppressed once local time passed the
 * user's configured morning-brief time (a `morning_notification_slots`
 * claim gated the update). That suppression is gone: sleep now claims a
 * notification exactly like workout — preference check, then the
 * notification_state 'pending' -> 'sending' update. This test drives the
 * real `workerRepository.claimNotification` implementation against a fake
 * `@/db` so it never touches Postgres, and proves a sleep job whose local
 * time is past `morning_brief_time_minutes` is still claimed and that no
 * `morning_notification_slots` insert is attempted.
 *
 * `@/db` must be mocked before `proactiveHealthWorkerRepository` is first
 * imported in this process, so this lives in its own file — node:test runs
 * each test file in its own subprocess, keeping the module registry clean.
 */
test('a sleep job past the morning-brief local time is still claimed for sending', async () => {
  const updateCalls: Array<{ table: unknown; assigned: Record<string, unknown> }> = [];
  const insertCalls: unknown[] = [];

  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{
            user_id: 'user-1',
            timezone: 'UTC',
            morning_brief_time_minutes: 300, // 5:00am — job below claims at 6:00am, well past this
            sleep_notifications_enabled: true,
            workout_notifications_enabled: true,
          }],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (assigned: Record<string, unknown>) => {
        updateCalls.push({ table, assigned });
        return {
          where: () => ({
            returning: async () => [{ id: 'sleep-analysis-1' }],
          }),
        };
      },
    }),
    insert: (table: unknown) => {
      insertCalls.push(table);
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [],
          }),
        }),
      };
    },
  };

  mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
  const { workerRepository } = await import('./proactiveHealthWorkerRepository');

  const job = {
    id: 'sleep-analysis-1',
    kind: 'sleep' as const,
    userId: 'user-1',
    localDate: '2026-07-15',
    input: {},
    retryCount: 0,
    notificationRetryCount: 0,
    leaseToken: 'analysis-lease',
  };
  const now = new Date('2026-07-15T06:00:00Z'); // past the 5:00am morning-brief time

  const token = await workerRepository.claimNotification(job, now);

  assert.equal(typeof token, 'string');
  assert.ok(token);
  assert.deepEqual(insertCalls, []); // no morning_notification_slots claim attempted
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, realSchema.sleep_analyses);
  assert.equal(updateCalls[0].assigned.notification_state, 'sending');
  assert.equal(updateCalls[0].assigned.notification_lease_token, token);
});
