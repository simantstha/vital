/**
 * WHOOP context line for the coach prompt (see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md, Task 7).
 *
 * Pure (no DB, no `@/db` import) so it's directly unit-testable without a
 * DATABASE_URL — lib/brain/context.ts's assembleContext fetches the
 * daily_metrics rows and calls buildWhoopContextLine() to format whichever
 * day (today or yesterday) has WHOOP data into one compact, clearly-labeled
 * line, so the model never conflates WHOOP's HRV (RMSSD) with the HealthKit
 * baseline (SDNN) or WHOOP's recovery/strain (which have no HealthKit
 * counterpart at all).
 */

export interface WhoopContextRow {
  date: string;   // YYYY-MM-DD, user-local day (matches lib/whoop/mapping.ts's day-keying)
  metric: string; // e.g. 'whoop_recovery', 'whoop_hrv_rmssd', 'whoop_day_strain', 'whoop_sleep_min'
  value: number;
  payload: unknown;
}

/** Safe JSONB → object cast (same shape as lib/brain/context.ts's pl()). */
function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function minutesToHm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return `${h}h${m < 10 ? '0' : ''}${m}m`;
}

/**
 * Builds the one-line WHOOP summary for the coach prompt from already-fetched
 * daily_metrics rows. Only looks at `todayDate`/`yesterdayDate` (both
 * user-local YYYY-MM-DD day keys — see lib/localDay.ts) — anything older is
 * multi-day history and belongs behind the get_metric_trend tool, not the
 * durable prompt. Prefers today's bucket if it has ANY whoop_* data, else
 * falls back to yesterday's; only fields actually present in the chosen
 * day's bucket are included. Returns undefined when neither day has any
 * whoop_* row at all (line omitted entirely, per the plan).
 */
export function buildWhoopContextLine(rows: WhoopContextRow[], todayDate: string, yesterdayDate: string): string | undefined {
  const todayBucket = new Map(rows.filter((r) => r.date === todayDate).map((r) => [r.metric, r]));
  const yesterdayBucket = new Map(rows.filter((r) => r.date === yesterdayDate).map((r) => [r.metric, r]));

  const useToday = todayBucket.size > 0;
  const bucket = useToday ? todayBucket : yesterdayBucket;
  if (bucket.size === 0) return undefined;
  const label = useToday ? 'today' : 'yesterday';

  const parts: string[] = [];

  const recovery = bucket.get('whoop_recovery');
  if (recovery) parts.push(`recovery ${Math.round(recovery.value)}%`);

  const hrv = bucket.get('whoop_hrv_rmssd');
  if (hrv) parts.push(`HRV ${Math.round(hrv.value)}ms RMSSD (not comparable to HealthKit SDNN)`);

  const strain = bucket.get('whoop_day_strain');
  if (strain) parts.push(`day strain ${strain.value.toFixed(1)}`);

  const sleep = bucket.get('whoop_sleep_min');
  if (sleep) {
    const performance = pl(sleep.payload).performance;
    const perfStr = typeof performance === 'number' ? ` (performance ${Math.round(performance)}%)` : '';
    parts.push(`sleep ${minutesToHm(sleep.value)}${perfStr}`);
  }

  if (parts.length === 0) return undefined;
  return `WHOOP (${label}): ${parts.join(', ')}`;
}
