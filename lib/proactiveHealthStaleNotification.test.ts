import assert from 'node:assert/strict';
import test, { before, beforeEach, mock } from 'node:test';
import * as realSchema from '../db/schema';
import type { workerRepository as WorkerRepositoryExport } from './proactiveHealthWorkerRepository';

/**
 * Drives the real `workerRepository.claimNotification` against a fake `@/db`
 * to prove the freshness gate added in claimNotification (see
 * lib/proactiveHealthWorkerRepository.ts) suppresses stale events and lets
 * fresh ones through, without ever touching Postgres.
 *
 * `@/db` must be mocked before `proactiveHealthWorkerRepository` is first
 * imported in this process, so — like proactiveHealthWorkerRepository.test.ts
 * — this lives in its own file; node:test runs each test file in its own
 * subprocess, keeping the module registry clean. Unlike that file, this one
 * has several tests, so `mock.module` is installed exactly once at module
 * load (mocking the same specifier twice throws `ERR_INVALID_STATE`) and each
 * test only swaps the mutable preference row / clears the call logs.
 */

let preferenceRow: Record<string, unknown> = {};
const updateCalls: Array<{ table: unknown; assigned: Record<string, unknown> }> = [];
const insertCalls: unknown[] = [];

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [preferenceRow],
      }),
    }),
  }),
  update: (table: unknown) => ({
    set: (assigned: Record<string, unknown>) => {
      updateCalls.push({ table, assigned });
      return {
        where: () => ({
          returning: async () => [{ id: 'analysis-1' }],
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

let workerRepository: typeof WorkerRepositoryExport;

before(async () => {
  mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
  ({ workerRepository } = await import('./proactiveHealthWorkerRepository'));
});

beforeEach(() => {
  preferenceRow = { user_id: 'user-1', timezone: 'UTC', workout_notifications_enabled: true, sleep_notifications_enabled: true };
  updateCalls.length = 0;
  insertCalls.length = 0;
});

test('a stale workout is suppressed at claim time — no update ever sets "sending"', async () => {
  const job = {
    id: 'workout-1',
    kind: 'workout' as const,
    userId: 'user-1',
    localDate: '2026-07-05', // stale local date too, so both bases would suppress
    input: { startTime: '2026-07-05T00:00:00.000Z', durationMin: 30 }, // ended 8+ days before `now`
    retryCount: 0,
    notificationRetryCount: 0,
    leaseToken: 'analysis-lease',
  };
  const now = new Date('2026-07-13T10:00:00Z');

  const token = await workerRepository.claimNotification(job, now);

  assert.equal(token, null);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, realSchema.workout_analyses);
  assert.equal(updateCalls[0].assigned.notification_state, 'suppressed');
  assert.equal(updateCalls.some((call) => call.assigned.notification_state === 'sending'), false);
});

test('a fresh workout is claimed for sending', async () => {
  const now = new Date('2026-07-13T10:00:00Z');
  const job = {
    id: 'workout-2',
    kind: 'workout' as const,
    userId: 'user-1',
    localDate: '2026-07-13',
    input: { startTime: '2026-07-13T09:00:00.000Z', durationMin: 30 }, // ended 30 min before `now`
    retryCount: 0,
    notificationRetryCount: 0,
    leaseToken: 'analysis-lease',
  };

  const token = await workerRepository.claimNotification(job, now);

  assert.equal(typeof token, 'string');
  assert.ok(token);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, realSchema.workout_analyses);
  assert.equal(updateCalls[0].assigned.notification_state, 'sending');
});

test('a stale sleep job is suppressed on the retry path (past the wake date)', async () => {
  const now = new Date('2026-07-13T10:00:00Z'); // UTC local day 2026-07-13
  const job = {
    id: 'sleep-1',
    kind: 'sleep' as const,
    userId: 'user-1',
    localDate: '2026-07-11', // no longer today's local day — a retried-past-window sleep job
    input: { minutes: 410 },
    retryCount: 0,
    notificationRetryCount: 2,
    leaseToken: 'analysis-lease',
  };

  const token = await workerRepository.claimNotification(job, now);

  assert.equal(token, null);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, realSchema.sleep_analyses);
  assert.equal(updateCalls[0].assigned.notification_state, 'suppressed');
});
