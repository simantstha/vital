/**
 * WHOOP reconciliation pass (see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md, Task 5).
 *
 * Runs once per proactive-health-worker tick: for every `active` WHOOP
 * connection whose `last_synced_at` is null or more than an hour old, sync a
 * trailing 48h window (this is also how cycle/strain data — which has no
 * webhook — gets picked up at all) and stamp `last_synced_at = now()`.
 *
 * Split the same way as lib/calendarIngestStore.ts / lib/whoop/sync.ts:
 * `selectDueWhoopConnections` is pure (no DB, no fetch) so scheduling logic
 * is unit-testable with plain objects; `runWhoopWorkerPass` takes its DB +
 * sync behavior as injected `WhoopWorkerPassDeps` (mirrors how
 * lib/proactiveHealthWorker.ts's runClaimedAnalysis takes `analyze`/`push` as
 * parameters) so the orchestration loop itself is also testable without a
 * live Postgres connection or WHOOP credentials; `createWhoopWorkerRepository`
 * is the Drizzle-backed production implementation of the DB half.
 *
 * One user at a time, sequentially (never Promise.all — see the plan: a rate
 * limit hit while fetching for one user must stop the whole pass, not race
 * ahead into more 429s for other users):
 *   - WhoopConnectionInactiveError (connection revoked/errored under us,
 *     mid-pass) → skip just that user, continue to the next.
 *   - Anything else (WhoopApiError — including 429 — WhoopTokenError, or an
 *     unexpected DB error) → log and abort the ENTIRE pass for this tick;
 *     the next tick (in ~15s, see scripts/proactive-health-worker.ts) picks
 *     up exactly where this one left off, since `last_synced_at` was only
 *     updated for connections that finished before the abort.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type * as WhoopSchema from '../../db/schema';
import { WhoopConnectionInactiveError } from './client';

const SYNC_INTERVAL_MS = 60 * 60_000; // 1 hour
const SYNC_WINDOW_MS = 48 * 3_600_000; // 48 hours

export interface WhoopConnectionForSync {
  id: string;
  userId: string;
  timezone: string | null;
  status: string;
  lastSyncedAt: Date | null;
}

/**
 * Pure filter: which of `connections` are due for a reconciliation sync right
 * now. Callers are expected to have already queried `status = 'active'` rows
 * only (see createWhoopWorkerRepository below); the status check here is
 * defense-in-depth so this function's contract doesn't silently depend on the
 * caller having filtered correctly.
 */
export function selectDueWhoopConnections(connections: WhoopConnectionForSync[], now: Date): WhoopConnectionForSync[] {
  return connections.filter((c) => {
    if (c.status !== 'active') return false;
    if (c.lastSyncedAt == null) return true;
    return now.getTime() - c.lastSyncedAt.getTime() >= SYNC_INTERVAL_MS;
  });
}

export interface WhoopWorkerPassDeps {
  listActiveConnections(): Promise<WhoopConnectionForSync[]>;
  runSync(target: { connectionId: string; userId: string; timezone: string | null }, windowStart: Date, windowEnd: Date): Promise<unknown>;
  markSynced(connectionId: string, syncedAt: Date): Promise<void>;
}

export interface WhoopWorkerPassResult {
  synced: string[];   // connection ids that completed successfully this tick
  skipped: string[];  // connection ids skipped (WhoopConnectionInactiveError)
  aborted: boolean;    // true if the pass stopped early on a non-inactive error
}

export async function runWhoopWorkerPass(now: Date, deps: WhoopWorkerPassDeps): Promise<WhoopWorkerPassResult> {
  const connections = await deps.listActiveConnections();
  const due = selectDueWhoopConnections(connections, now);

  const windowEnd = now;
  const windowStart = new Date(now.getTime() - SYNC_WINDOW_MS);

  const synced: string[] = [];
  const skipped: string[] = [];

  for (const connection of due) {
    try {
      await deps.runSync({ connectionId: connection.id, userId: connection.userId, timezone: connection.timezone }, windowStart, windowEnd);
      await deps.markSynced(connection.id, now);
      synced.push(connection.id);
    } catch (err) {
      if (err instanceof WhoopConnectionInactiveError) {
        console.error(`[whoop-worker] connection ${connection.id} is inactive, skipping: ${String(err)}`);
        skipped.push(connection.id);
        continue;
      }
      console.error(`[whoop-worker] aborting reconciliation pass at connection ${connection.id}: ${String(err)}`);
      return { synced, skipped, aborted: true };
    }
  }

  return { synced, skipped, aborted: false };
}

// ─── Drizzle-backed repository (production wiring) ───────────────────────────
// Same narrow-interface approach as lib/whoop/sync.ts's
// createWhoopSyncRepository: `database`/`schema` passed as plain parameters,
// not imported here, so tests can pass a fake without touching Postgres.

interface DrizzleWhoopWorkerDatabase {
  select(fields: Record<string, unknown>): {
    from(table: unknown): {
      innerJoin(table: unknown, predicate: unknown): {
        where(predicate: unknown): Promise<Array<{ id: string; user_id: string; timezone: string | null; status: string; last_synced_at: Date | null }>>;
      };
    };
  };
  update(table: unknown): {
    set(values: Record<string, unknown>): {
      where(predicate: unknown): Promise<unknown>;
    };
  };
}

export interface WhoopWorkerRepository {
  listActiveConnections(): Promise<WhoopConnectionForSync[]>;
  markSynced(connectionId: string, syncedAt: Date): Promise<void>;
}

export function createWhoopWorkerRepository(database: unknown, schema: typeof WhoopSchema): WhoopWorkerRepository {
  const db = database as DrizzleWhoopWorkerDatabase;
  return {
    async listActiveConnections() {
      const cutoff = new Date(Date.now() - SYNC_INTERVAL_MS);
      const rows = await db
        .select({
          id: schema.whoop_connections.id,
          user_id: schema.whoop_connections.user_id,
          timezone: schema.users.timezone,
          status: schema.whoop_connections.status,
          last_synced_at: schema.whoop_connections.last_synced_at,
        })
        .from(schema.whoop_connections)
        .innerJoin(schema.users, eq(schema.users.id, schema.whoop_connections.user_id))
        .where(and(
          eq(schema.whoop_connections.status, 'active'),
          or(isNull(schema.whoop_connections.last_synced_at), lt(schema.whoop_connections.last_synced_at, cutoff)),
        ));
      return rows.map((r) => ({ id: r.id, userId: r.user_id, timezone: r.timezone, status: r.status, lastSyncedAt: r.last_synced_at }));
    },
    async markSynced(connectionId, syncedAt) {
      await db.update(schema.whoop_connections).set({ last_synced_at: syncedAt, updated_at: new Date() }).where(eq(schema.whoop_connections.id, connectionId));
    },
  };
}
