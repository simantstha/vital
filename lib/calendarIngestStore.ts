/**
 * Drizzle-backed CalendarIngestStore adapter for POST /api/ingest/calendar.
 *
 * Split from the route the same way lib/proactiveAnalysisRecoveryDrizzle.ts
 * is split from its caller: the adapter takes `database`/`schema` as plain
 * parameters (typed to the minimal chain shape it uses) so tests can pass a
 * fake transaction object and assert on the exact delete/insert calls —
 * including the generated SQL predicate — without touching Postgres.
 */

import { and, eq, gt, lt } from 'drizzle-orm';
import type * as CalendarSchema from '../db/schema';
import type { CalendarIngestStore } from './calendarIngest';

type Schema = typeof CalendarSchema;

interface DrizzleTransaction {
  delete(table: Schema['calendar_blocks']): {
    where(predicate: unknown): Promise<unknown>;
  };
  insert(table: Schema['calendar_blocks']): {
    values(rows: Array<Record<string, unknown>>): Promise<unknown>;
  };
}

interface DrizzleDatabase {
  transaction<T>(operation: (transaction: DrizzleTransaction) => Promise<T>): Promise<T>;
}

export function createCalendarIngestStore(database: unknown, schema: Schema): CalendarIngestStore {
  const db = database as DrizzleDatabase;
  return {
    replaceWindow: (userId, windowStart, windowEnd, blocks) => db.transaction(async (tx) => {
      // Overlap (not exact-window) delete: a block that started before the
      // window but runs into it is removed too, so a shifted re-sync never
      // leaves a stale duplicate at the seam.
      await tx.delete(schema.calendar_blocks).where(
        and(
          eq(schema.calendar_blocks.user_id, userId),
          lt(schema.calendar_blocks.start_at, windowEnd),
          gt(schema.calendar_blocks.end_at, windowStart),
        ),
      );

      if (blocks.length > 0) {
        await tx.insert(schema.calendar_blocks).values(
          blocks.map((b) => ({
            user_id:  userId,
            start_at: b.startAt,
            end_at:   b.endAt,
            all_day:  b.allDay,
            title:    b.title,
          })),
        );
      }

      return blocks.length;
    }),
  };
}
