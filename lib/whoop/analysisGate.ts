/**
 * Pure gate for creating a WHOOP workout/sleep analysis (see the
 * multi-device-analyses contract, "Creating WHOOP analyses"):
 *
 *   - Only sessions that ended within the last 24h — an old session
 *     surfacing via backfill/reconciliation shouldn't spawn a stale
 *     notification.
 *   - Never on a connection's first sync (`last_synced_at` null) — that sync
 *     is a historical backfill (30 days on connect, see
 *     app/api/whoop/callback/route.ts) and must not trigger a notification
 *     storm for every workout/sleep in that window.
 */
export interface WhoopAnalysisGateInput {
  /** When the session (workout or sleep) ended. */
  endedAt: Date;
  /** The time this sync is running at. */
  now: Date;
  /** True when this is the WHOOP connection's first-ever sync. */
  isFirstSync: boolean;
}

export const WHOOP_ANALYSIS_MAX_AGE_MS = 24 * 60 * 60_000;

export function shouldCreateWhoopAnalysis(input: WhoopAnalysisGateInput): boolean {
  if (input.isFirstSync) return false;
  const ageMs = input.now.getTime() - input.endedAt.getTime();
  return ageMs >= 0 && ageMs <= WHOOP_ANALYSIS_MAX_AGE_MS;
}
