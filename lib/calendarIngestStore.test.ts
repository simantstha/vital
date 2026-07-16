import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';
import { createCalendarIngestStore } from './calendarIngestStore';

/**
 * Verifies the real Drizzle adapter issues the exact overlap-delete
 * predicate the business logic relies on (start_at < windowEnd AND
 * end_at > windowStart, scoped to the user), and inserts the normalized
 * block shape — using a fake `db.transaction` so no Postgres connection is
 * needed (same pattern as lib/proactiveAnalysisRecoveryDrizzle.test.ts).
 * lib/calendarIngest.test.ts independently proves this predicate produces
 * correct replace/no-duplication behavior against an in-memory store.
 */
test('replaceWindow deletes on the exact overlap predicate, then inserts the given blocks', async () => {
  const deletes: Array<{ table: unknown; where: { getSQL(): unknown } }> = [];
  const inserts: Array<{ table: unknown; rows: Array<Record<string, unknown>> }> = [];

  const transaction = {
    delete: (table: unknown) => ({
      where: async (where: { getSQL(): unknown }) => {
        deletes.push({ table, where });
      },
    }),
    insert: (table: unknown) => ({
      values: async (rows: Array<Record<string, unknown>>) => {
        inserts.push({ table, rows });
      },
    }),
  };
  const db = { transaction: async <T>(op: (tx: typeof transaction) => Promise<T>) => op(transaction) };

  const store = createCalendarIngestStore(db, schema);
  const windowStart = new Date('2026-07-16T00:00:00.000Z');
  const windowEnd = new Date('2026-07-17T00:00:00.000Z');
  const blocks = [
    { startAt: new Date('2026-07-16T09:00:00.000Z'), endAt: new Date('2026-07-16T09:30:00.000Z'), allDay: false, title: 'Standup' },
    { startAt: new Date('2026-07-16T00:00:00.000Z'), endAt: new Date('2026-07-17T00:00:00.000Z'), allDay: true, title: null },
  ];

  const replaced = await store.replaceWindow('user-1', windowStart, windowEnd, blocks);

  assert.equal(replaced, 2);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].table, schema.calendar_blocks);

  const query = new PgDialect().sqlToQuery(deletes[0].where.getSQL() as never);
  assert.match(query.sql, /"user_id" = \$1/);
  assert.match(query.sql, /"start_at" < \$2/);
  assert.match(query.sql, /"end_at" > \$3/);
  assert.deepEqual(query.params, ['user-1', windowEnd.toISOString(), windowStart.toISOString()]);

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].table, schema.calendar_blocks);
  assert.deepEqual(inserts[0].rows, [
    { user_id: 'user-1', start_at: blocks[0].startAt, end_at: blocks[0].endAt, all_day: false, title: 'Standup' },
    { user_id: 'user-1', start_at: blocks[1].startAt, end_at: blocks[1].endAt, all_day: true, title: null },
  ]);
});

test('replaceWindow skips the insert call entirely when the window has no blocks', async () => {
  let insertCalled = false;
  const transaction = {
    delete: () => ({ where: async () => {} }),
    insert: () => { insertCalled = true; return { values: async () => {} }; },
  };
  const db = { transaction: async <T>(op: (tx: typeof transaction) => Promise<T>) => op(transaction) };

  const store = createCalendarIngestStore(db, schema);
  const replaced = await store.replaceWindow(
    'user-1',
    new Date('2026-07-16T00:00:00.000Z'),
    new Date('2026-07-17T00:00:00.000Z'),
    [],
  );

  assert.equal(replaced, 0);
  assert.equal(insertCalled, false);
});
