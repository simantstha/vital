import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../db/schema';
import { notificationClaimable } from './proactiveHealthTransitions';

/**
 * scripts/requeue-fallback-analyses.ts re-queues rows that were already
 * notified with notification_state = 'suppressed' so the regenerated analysis
 * never triggers a second push. That only holds if every worker transition a
 * requeued row passes through leaves 'suppressed' alone and every push path
 * only acts on 'pending' (or an expired 'sending'). This drives the real
 * workerRepository against a fake `@/db` and renders the SQL it would send, so
 * a later edit that breaks the invariant fails here instead of in a user's
 * notification tray.
 *
 * `@/db` must be mocked before the repository is first imported in this
 * process, hence the separate file (node:test runs each file in its own
 * subprocess).
 */

interface UpdateCall { table: unknown; assigned: Record<string, unknown>; where: unknown }
const updateCalls: UpdateCall[] = [];

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ user_id: 'user-1', timezone: 'UTC', sleep_notifications_enabled: true, workout_notifications_enabled: true }],
      }),
    }),
  }),
  update: (table: unknown) => ({
    set: (assigned: Record<string, unknown>) => ({
      where: (where: unknown) => {
        updateCalls.push({ table, assigned, where });
        return { returning: async () => [{ id: 'analysis-1' }] };
      },
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const dialect = new PgDialect();
const render = (fragment: unknown): string => dialect.sqlToQuery(fragment as never).sql;

const job = {
  id: 'analysis-1',
  kind: 'sleep' as const,
  userId: 'user-1',
  localDate: '2026-10-14',
  input: {},
  retryCount: 0,
  notificationRetryCount: 0,
  leaseToken: 'analysis-lease',
};
const now = new Date('2026-10-14T12:00:00Z'); // same local day as job.localDate in UTC, so the freshness gate passes

test('storeReady writes the result without touching notification state', async () => {
  updateCalls.length = 0;
  const { workerRepository } = await import('./proactiveHealthWorkerRepository');
  const result = { headline: 'h', shortInsight: 's', narrative: 'n', observations: [], nextSteps: [] };
  assert.equal(await workerRepository.storeReady(job, result), true);
  assert.equal(updateCalls.length, 1);
  const keys = Object.keys(updateCalls[0].assigned);
  assert.deepEqual(keys.filter((key) => key.startsWith('notification_')), []);
  assert.equal(updateCalls[0].assigned.status, 'ready');
  assert.equal(updateCalls[0].assigned.result, result);
});

test('markRetry keeps a suppressed row suppressed and resets every other state to pending', async () => {
  updateCalls.length = 0;
  const { workerRepository } = await import('./proactiveHealthWorkerRepository');
  await workerRepository.markRetry(job, now);
  assert.equal(updateCalls.length, 1);
  const rendered = render(updateCalls[0].assigned.notification_state);
  assert.match(rendered, /case when "sleep_analyses"\."notification_state" = 'suppressed' then 'suppressed' else 'pending' end/);
});

test('claimNotification only claims pending (or expired sending) rows, so a suppressed row never pushes', async () => {
  updateCalls.length = 0;
  const { workerRepository } = await import('./proactiveHealthWorkerRepository');
  const token = await workerRepository.claimNotification(job, now);
  assert.equal(typeof token, 'string'); // the fake db claims whatever the predicate lets through; the predicate is the point
  assert.equal(updateCalls.length, 1);
  const predicate = render(updateCalls[0].where);
  assert.match(predicate, /"notification_state" = 'pending'/);
  assert.match(predicate, /"notification_state" = 'sending' and "sleep_analyses"\."notification_lease_expires_at" <=/);
  assert.doesNotMatch(predicate, /suppressed/);
  assert.equal(updateCalls[0].assigned.notification_state, 'sending');
});

test('the ready-notification candidate query never lists suppressed rows', async () => {
  const { buildReadyNotificationCandidatesQuery } = await import('./proactiveHealthWorkerRepository');
  const query = render(buildReadyNotificationCandidatesQuery(now, 40));
  assert.match(query, /notification_state='pending'/);
  assert.match(query, /notification_state='sending'/);
  assert.doesNotMatch(query, /suppressed/);
});

test('notificationClaimable treats suppressed (and sent/failed) as terminal', () => {
  const past = new Date(now.getTime() - 60_000);
  assert.equal(notificationClaimable('suppressed', null, past, now), false);
  assert.equal(notificationClaimable('suppressed', past, past, now), false);
  assert.equal(notificationClaimable('sent', null, past, now), false);
  assert.equal(notificationClaimable('failed', null, past, now), false);
  assert.equal(notificationClaimable('pending', null, past, now), true);
});
