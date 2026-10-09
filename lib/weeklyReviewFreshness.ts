/** Pure freshness helpers for the stored weekly review (kept free of DB imports so they unit-test). */

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The instant 23:59 local on the Sunday of the week starting `weekStart` (a
 * local Monday key). The review's verdict is evaluated as of this moment so it
 * describes the same window as the stats instead of drifting with `now`.
 */
export function endOfLocalWeek(weekStart: string, tz: string): Date {
  const [y, m, d] = addDays(weekStart, 6).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 23, 59, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const offsetAt = (ms: number): number => {
    const parts = fmt.formatToParts(new Date(ms));
    const g = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess); // second pass settles DST-boundary cases
  return new Date(guess);
}

/** Reviews stay live (recomputed on read) while unseen and this young, so late Sunday syncs land. */
export const REVIEW_FRESH_WINDOW_MS = 24 * 60 * 60_000;
/** Minimum gap between recomputes of the same review by app reads (the worker bypasses it). */
export const REVIEW_RECOMPUTE_MIN_GAP_MS = 5 * 60_000;

export function shouldRecomputeReview(
  row: { seenAt: Date | null; createdAt: Date },
  now: Date,
  lastRecomputeAtMs: number | null,
  opts: { force?: boolean } = {},
): boolean {
  if (row.seenAt) return false;
  if (now.getTime() - row.createdAt.getTime() >= REVIEW_FRESH_WINDOW_MS) return false;
  if (!opts.force && lastRecomputeAtMs != null && now.getTime() - lastRecomputeAtMs < REVIEW_RECOMPUTE_MIN_GAP_MS) return false;
  return true;
}

