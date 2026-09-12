/**
 * WHOOP reconciliation pass (see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md, Task 5).
 *
 * Runs once per proactive-health-worker tick: for every `active` WHOOP
 * connection whose `last_synced_at` is null or more than an hour old, sync a
 * trailing 48h window. WHOOP publishes no *cycle* webhook event type, but
 * because the webhook handler re-syncs the whole trailing 48h window on any
 * recovery/sleep/workout event, cycles/strain come along with it — so this
 * pass is not what makes cycle/strain land. Its real job is the safety net:
 * it covers stretches where no webhook event fires at all (so intraday strain
 * doesn't go stale on a quiet day) and any delivery WHOOP drops.
 * `last_synced_at` itself is stamped by runWhoopSync() on success
 * (lib/whoop/sync.ts), the one shared success path both this pass and the
 * webhook handler funnel through — not by this pass directly. Intentional
 * consequence: webhook syncs advance `last_synced_at` too, so while webhooks
 * are healthy this pass finds nothing due and is a no-op; if webhooks go
 * quiet for over an hour, the next tick picks the connection back up.
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
 * limit hit while fetching for one user must not race ahead into more 429s
 * for other users). Failures are triaged by BLAST RADIUS, which is the whole
 * reason there are two distinct outcomes below — the question is never "how
 * bad is this error" but "is this about WHOOP, or about this one connection?"
 *
 *   - Global backpressure — a 429 or a 5xx from WHOOP (on WhoopApiError or
 *     WhoopTokenError) is a signal about OUR api quota or WHOOP's own health,
 *     not about the connection that happened to be next in line. Retrying the
 *     remaining connections would just spend the same exhausted quota and
 *     deepen the rate limit, so the pass stops iterating and leaves them for
 *     the next tick. Reported as `backpressure: true`.
 *
 *   - Per-connection failure — a dead grant, an unexpected DB error, anything
 *     else. Scoped to that one connection, so it is logged, recorded in
 *     `failed`, and the loop continues. This isolation is load-bearing: a
 *     single connection whose refresh token was revoked (and which therefore
 *     failed every tick forever) previously aborted the whole pass and
 *     starved WHOOP sync for EVERY user, retrying every 15s indefinitely.
 *     One bad connection must never block the others.
 *
 *   - WhoopConnectionInactiveError (connection revoked/errored under us,
 *     mid-pass) → not a failure at all; skip just that user and continue.
 *     Recorded in `skipped`, never in `failed`.
 *
 * In every case the next tick (in ~15s, see scripts/proactive-health-worker.ts)
 * re-picks up whatever is still due, since `last_synced_at` only advances for
 * connections that actually completed.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type * as WhoopSchema from '../../db/schema';
import { WhoopApiError, WhoopConnectionInactiveError, WhoopTokenError } from './client';

const SYNC_INTERVAL_MS = 60 * 60_000; // 1 hour
const SYNC_WINDOW_MS = 48 * 3_600_000; // 48 hours

/**
 * Is this error a signal about WHOOP as a whole (our rate-limit quota, or
 * their availability) rather than about one connection? Those are the only
 * errors that justify stopping the pass — see the blast-radius triage in the
 * module comment. Deliberately keyed on the HTTP status, not the error class:
 * a 429 is equally a global signal whether it surfaced from a data call
 * (WhoopApiError) or a token refresh (WhoopTokenError).
 */
function isBackpressureSignal(err: unknown): boolean {
  if (!(err instanceof WhoopApiError) && !(err instanceof WhoopTokenError)) return false;
  return err.status === 429 || err.status >= 500;
}

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
}

export interface WhoopWorkerPassResult {
  synced: string[];      // connection ids that completed successfully this tick
  skipped: string[];     // connection ids skipped (WhoopConnectionInactiveError)
  failed: string[];      // connection ids that errored for their own reasons; the loop continued past each
  backpressure: boolean; // true if a 429/5xx from WHOOP stopped the pass early, leaving the rest of `due` untried
}

export async function runWhoopWorkerPass(now: Date, deps: WhoopWorkerPassDeps): Promise<WhoopWorkerPassResult> {
  const connections = await deps.listActiveConnections();
  const due = selectDueWhoopConnections(connections, now);

  const windowEnd = now;
  const windowStart = new Date(now.getTime() - SYNC_WINDOW_MS);

  const synced: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let backpressure = false;

  for (const connection of due) {
    try {
      await deps.runSync({ connectionId: connection.id, userId: connection.userId, timezone: connection.timezone }, windowStart, windowEnd);
      synced.push(connection.id);
    } catch (err) {
      if (err instanceof WhoopConnectionInactiveError) {
        console.error(`[whoop-worker] connection ${connection.id} is inactive, skipping: ${String(err)}`);
        skipped.push(connection.id);
        continue;
      }
      if (isBackpressureSignal(err)) {
        // Global signal — stop the pass rather than spending the same
        // exhausted quota on everyone still queued behind this connection.
        console.error(`[whoop-worker] backing off the rest of the reconciliation pass at connection ${connection.id}: ${String(err)}`);
        backpressure = true;
        break;
      }
      // Scoped to this connection — isolate it and keep going, so one dead
      // grant can't starve every other user's sync.
      console.error(`[whoop-worker] connection ${connection.id} failed, continuing to the next: ${String(err)}`);
      failed.push(connection.id);
    }
  }

  return { synced, skipped, failed, backpressure };
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
}

export interface WhoopWorkerRepository {
  listActiveConnections(): Promise<WhoopConnectionForSync[]>;
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
  };
}
