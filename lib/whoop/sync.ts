/**
 * WHOOP sync orchestration (see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md, Task 4/5).
 *
 * `syncWhoopWindow()` is the pure-repository half: map already-fetched WHOOP
 * records and upsert them, given an injected `WhoopSyncRepository` — same
 * split as lib/healthAnalysisIngest.ts (repository interface in, no `@/db`
 * import in this file at all), so it's fully testable with a fake repo.
 *
 * `runWhoopSync()` is the end-to-end orchestration named in the plan: given a
 * connection + time window, it fetches via lib/whoop/client.ts (serializing
 * any needed token refresh through withValidToken), maps + upserts via
 * syncWhoopWindow(), then recomputes baselines for whatever metrics were
 * touched — the same recomputeBaselines() call POST /api/ingest/daily makes.
 *
 * `createWhoopSyncRepository()` is the Drizzle-backed WhoopSyncRepository for
 * production use (Task 3/5 wiring, not part of this stage) — takes
 * `database`/`schema` as plain parameters, matching
 * lib/calendarIngestStore.ts's createCalendarIngestStore.
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type * as WhoopSchema from '../../db/schema';
import { recomputeBaselines } from '../brain/baselines';
import {
  getCycles,
  getRecoveries,
  getSleeps,
  getWorkouts,
  withValidToken,
  type WhoopConnectionHandle,
} from './client';
import { mapWhoopWindow, type WhoopSyncWindowInput } from './mapping';

export interface WhoopSyncRepository {
  upsertDailyMetrics(userId: string, rows: Array<{ date: string; metric: string; value: number; payload: unknown }>): Promise<void>;
  /** Scoped to [windowStart, windowEnd] — matches events_user_type_timestamp_idx. */
  listExistingWorkoutIds(userId: string, windowStart: Date, windowEnd: Date, whoopIds: string[]): Promise<Set<string>>;
  insertWorkoutEvents(userId: string, events: Array<{ timestamp: Date; payload: unknown }>): Promise<void>;
}

export interface WhoopSyncResult {
  touchedMetrics: string[];
  dailyMetricsWritten: number;
  workoutEventsWritten: number;
}

/**
 * Maps already-fetched WHOOP records and upserts them via `repository`.
 * Workouts are inserted append-only into `events`, deduped by `whoopId`
 * against whatever already exists in [windowStart, windowEnd] for this user
 * (idempotent re-sync — the same workout arriving twice is a no-op, not a
 * duplicate event row).
 */
export async function syncWhoopWindow(
  repository: WhoopSyncRepository,
  userId: string,
  timezone: string | null | undefined,
  windowStart: Date,
  windowEnd: Date,
  data: WhoopSyncWindowInput,
): Promise<WhoopSyncResult> {
  const mapped = mapWhoopWindow(data, timezone);

  if (mapped.dailyMetrics.length > 0) {
    await repository.upsertDailyMetrics(userId, mapped.dailyMetrics);
  }

  let workoutEventsWritten = 0;
  if (mapped.workoutEvents.length > 0) {
    const existingIds = await repository.listExistingWorkoutIds(
      userId,
      windowStart,
      windowEnd,
      mapped.workoutEvents.map((e) => e.whoopId),
    );
    const fresh = mapped.workoutEvents.filter((e) => !existingIds.has(e.whoopId));
    if (fresh.length > 0) {
      await repository.insertWorkoutEvents(userId, fresh.map((e) => ({ timestamp: e.timestamp, payload: e.payload })));
      workoutEventsWritten = fresh.length;
    }
  }

  return {
    touchedMetrics: Array.from(new Set(mapped.dailyMetrics.map((m) => m.metric))),
    dailyMetricsWritten: mapped.dailyMetrics.length,
    workoutEventsWritten,
  };
}

export interface WhoopSyncTarget {
  connectionId: string;
  userId: string;
  timezone: string | null | undefined;
}

/**
 * Full sync for one connection over [windowStart, windowEnd]: fetch (with
 * serialized token refresh) → map → upsert → recompute baselines for touched
 * metrics. `tokenStore` is the same WhoopTokenStore withValidToken() needs
 * (see lib/whoop/client.ts createWhoopTokenStore).
 */
export async function runWhoopSync(
  target: WhoopSyncTarget,
  tokenStore: WhoopConnectionHandle['store'],
  repository: WhoopSyncRepository,
  windowStart: Date,
  windowEnd: Date,
): Promise<WhoopSyncResult> {
  const data = await withValidToken({ id: target.connectionId, store: tokenStore }, async (accessToken) => {
    const [cycles, recoveries, sleeps, workouts] = await Promise.all([
      getCycles(accessToken, windowStart, windowEnd),
      getRecoveries(accessToken, windowStart, windowEnd),
      getSleeps(accessToken, windowStart, windowEnd),
      getWorkouts(accessToken, windowStart, windowEnd),
    ]);
    return { cycles, recoveries, sleeps, workouts };
  });

  const result = await syncWhoopWindow(repository, target.userId, target.timezone, windowStart, windowEnd, data);

  if (result.touchedMetrics.length > 0) {
    await recomputeBaselines(target.userId, result.touchedMetrics);
  }

  return result;
}

// ─── Drizzle-backed repository (production wiring for Task 3/5) ─────────────
// Minimal chain typing, same approach as lib/calendarIngestStore.ts: narrow
// enough for what this module calls, so a fake `database` in tests doesn't
// need to satisfy drizzle-orm's full generic surface.

interface DrizzleWhoopSyncDatabase {
  insert(table: unknown): {
    values(rows: Array<Record<string, unknown>>): {
      onConflictDoUpdate(config: { target: unknown[]; set: Record<string, unknown> }): Promise<unknown>;
    } & Promise<unknown>;
  };
  select(fields: Record<string, unknown>): {
    from(table: unknown): {
      where(predicate: unknown): Promise<Array<Record<string, unknown>>>;
    };
  };
}

export function createWhoopSyncRepository(database: unknown, schema: typeof WhoopSchema): WhoopSyncRepository {
  const db = database as DrizzleWhoopSyncDatabase;
  return {
    async upsertDailyMetrics(userId, rows) {
      if (rows.length === 0) return;
      await db.insert(schema.daily_metrics).values(rows.map((r) => ({
        user_id: userId,
        date: r.date,
        metric: r.metric,
        value: r.value,
        payload: r.payload ?? null,
        source: 'whoop',
      }))).onConflictDoUpdate({
        target: [schema.daily_metrics.user_id, schema.daily_metrics.date, schema.daily_metrics.metric],
        set: {
          value: sql`excluded.value`,
          payload: sql`excluded.payload`,
          source: sql`excluded.source`,
          updated_at: sql`now()`,
        },
      });
    },
    async listExistingWorkoutIds(userId, windowStart, windowEnd, whoopIds) {
      if (whoopIds.length === 0) return new Set();
      const rows = await db.select({ payload: schema.events.payload }).from(schema.events).where(and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'workout_completed'),
        eq(schema.events.source, 'whoop'),
        gte(schema.events.timestamp, windowStart),
        lte(schema.events.timestamp, windowEnd),
      ));
      const ids = new Set<string>();
      for (const row of rows) {
        const whoopId = (row.payload as Record<string, unknown> | null)?.whoopId;
        if (typeof whoopId === 'string' && whoopIds.includes(whoopId)) ids.add(whoopId);
      }
      return ids;
    },
    async insertWorkoutEvents(userId, events) {
      if (events.length === 0) return;
      await db.insert(schema.events).values(events.map((e) => ({
        user_id: userId,
        timestamp: e.timestamp,
        type: 'workout_completed',
        payload: e.payload,
        source: 'whoop',
      })));
    },
  };
}
