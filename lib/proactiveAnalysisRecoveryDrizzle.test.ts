import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';
import { createProactiveAnalysisRecoveryStore } from './proactiveAnalysisRecoveryDrizzle';

test('the recovery Drizzle adapter locks both tables and uses the exact bounded update shape', async () => {
  const lockedTables: unknown[] = [];
  const updates: Array<{ table: unknown; assigned: Record<string, unknown>; where: { getSQL(): unknown }; returning: Record<string, unknown> }> = [];
  const rowsByTable = new Map<unknown, Array<Record<string, unknown>>>([
    [schema.workout_analyses, [{
      id: 'workout-id',
      status: 'failed',
      retryCount: 3,
      leaseToken: null,
      result: null,
      notificationState: 'failed',
      notificationSentAt: null,
    }]],
    [schema.sleep_analyses, [{
      id: 'sleep-id',
      status: 'failed',
      retryCount: 4,
      leaseToken: null,
      result: null,
      notificationState: 'failed',
      notificationSentAt: null,
    }]],
  ]);
  const transaction = {
    select: (selection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          for: (lock: string) => {
            assert.equal(lock, 'update');
            lockedTables.push(table);
            return (rowsByTable.get(table) ?? []).map((row) => Object.fromEntries(
              Object.keys(selection).map((key) => [key, row[key]]),
            ));
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (assigned: Record<string, unknown>) => ({
        where: (where: { getSQL(): unknown }) => ({
          returning: (returning: Record<string, unknown>) => {
            updates.push({ table, assigned, where, returning });
            return rowsByTable.get(table) ?? [];
          },
        }),
      }),
    }),
  };
  const db = { transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(transaction) };
  const store = createProactiveAnalysisRecoveryStore(db, schema);
  const ids = ['requested-id'];
  const now = new Date('2026-07-13T12:00:00.000Z');

  await store.transaction(async (adapter) => {
    const locked = await adapter.lockRows(ids);
    assert.deepEqual(locked.map(({ id, kind }) => ({ id, kind })), [
      { id: 'workout-id', kind: 'workout' },
      { id: 'sleep-id', kind: 'sleep' },
    ]);
    assert.deepEqual(locked.map(({ notificationState, notificationSentAt }) => ({
      notificationState,
      notificationSentAt,
    })), [
      { notificationState: 'failed', notificationSentAt: null },
      { notificationState: 'failed', notificationSentAt: null },
    ]);
    assert.deepEqual(await adapter.recover('workout', ids, now), ['workout-id']);
    assert.deepEqual(await adapter.recover('sleep', ids, now), ['sleep-id']);
  });

  assert.deepEqual(lockedTables, [schema.workout_analyses, schema.sleep_analyses]);
  assert.deepEqual(updates.map(({ table }) => table), [schema.workout_analyses, schema.sleep_analyses]);
  for (const update of updates) {
    assert.deepEqual(Object.keys(update.assigned).sort(), [
      'lease_expires_at',
      'lease_token',
      'next_attempt_at',
      'notification_state',
      'retry_count',
      'status',
    ]);
    assert.deepEqual(update.assigned, {
      status: 'pending',
      retry_count: 0,
      next_attempt_at: now,
      lease_token: null,
      lease_expires_at: null,
      notification_state: 'pending',
    });
    assert.deepEqual(Object.keys(update.returning), ['id']);
    const query = new PgDialect().sqlToQuery(update.where.getSQL() as never);
    assert.match(query.sql, /"id" in \(\$1\)/);
    assert.match(query.sql, /"status" = \$2/);
    assert.match(query.sql, /"lease_token" is null/);
    assert.match(query.sql, /"result" is null/);
    assert.match(query.sql, /"notification_state" = \$3/);
    assert.match(query.sql, /"notification_sent_at" is null/);
    assert.deepEqual(query.params, ['requested-id', 'failed', 'failed']);
  }
});
