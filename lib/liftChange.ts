/**
 * Vital — the ONE definition of "lift progress" (pure, no DB or Next.js imports).
 *
 * Every surface that quotes a multi-week change in a lift's estimated 1RM —
 * the Trends goal card reason/verdict (lib/goalProgress.ts), the weekly review
 * (lib/weeklyReview.ts) and the iOS Trends Strength card
 * (TrendsStrengthLogic.swift) — uses this definition so the same lift never
 * shows two different numbers.
 *
 * Definition ("vs 4 weeks ago"), on the UTC Monday-start weekly best e1RM
 * buckets from /api/workouts/summary, anchored on a Monday `anchorWeekStart`
 * (the current week for Trends, the reviewed week for the weekly review):
 *   end      = the most recent week with an e1RM among the anchor week and the
 *              two before it (so an empty / just-started current week, e.g. a
 *              Monday before training, is skipped instead of reading as a drop)
 *   recent   = best e1RM across `end` and the week before it
 *   baseline = best e1RM across the two weeks that end 4 weeks before `end`
 *              (end-35d and end-28d)
 *   change   = recent - baseline, rounded to 0.1 kg
 * "Progressing" = change >= +1% of baseline (LIFT_PROGRESS_MIN_FRACTION); a
 * smaller change is a stall. Deload weeks (volume < 60% of the 4-week average)
 * are never a stall or a slip (isDeload).
 * Both windows need at least one week with an e1RM, otherwise there is no
 * change to report (never invented). Display wording: "+5.8 kg vs 4 weeks ago".
 *
 * Keep in lockstep with TrendsStrengthLogic.change(...) — parity tests pin
 * identical fixtures to identical numbers in both languages.
 */

/** Weeks (back from the anchor) searched for the end of the recent window. */
export const LIFT_END_LOOKBACK_DAYS = [0, 7, 14] as const;
export const LIFT_RECENT_OFFSETS_DAYS = [0, 7] as const;
export const LIFT_BASELINE_OFFSETS_DAYS = [28, 35] as const;
/** A change of at least this fraction of the baseline counts as progress. */
export const LIFT_PROGRESS_MIN_FRACTION = 0.01;
/** Recent weekly volume under this fraction of the 4-week average is a deload. */
export const DELOAD_VOLUME_FRACTION = 0.6;

export interface LiftWeekPoint {
  weekStart: string;
  bestEstimatedOneRepMaxKg: number | null;
  volumeKg?: number;
  totalSets?: number;
}

export interface LiftChange4w {
  baselineKg: number;
  recentKg: number;
  /** recent - baseline, rounded to 0.1 kg. */
  changeKg: number;
}

export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function bestIn(weeks: LiftWeekPoint[], endWeekStart: string, offsetsDays: readonly number[]): number | null {
  const keys = new Set(offsetsDays.map(o => shiftDay(endWeekStart, -o)));
  let best: number | null = null;
  for (const w of weeks) {
    if (!keys.has(w.weekStart) || w.bestEstimatedOneRepMaxKg == null) continue;
    if (best == null || w.bestEstimatedOneRepMaxKg > best) best = w.bestEstimatedOneRepMaxKg;
  }
  return best;
}

/** Monday ending the recent window: the newest week with an e1RM among the anchor and the 2 weeks before it. */
export function liftRecentEndWeek(weeks: LiftWeekPoint[], anchorWeekStart: string): string | null {
  for (const o of LIFT_END_LOOKBACK_DAYS) {
    const key = shiftDay(anchorWeekStart, -o);
    if (weeks.some(w => w.weekStart === key && w.bestEstimatedOneRepMaxKg != null)) return key;
  }
  return null;
}

export function liftChange4w(weeks: LiftWeekPoint[], anchorWeekStart: string): LiftChange4w | null {
  const end = liftRecentEndWeek(weeks, anchorWeekStart);
  if (end == null) return null;
  const recentKg = bestIn(weeks, end, LIFT_RECENT_OFFSETS_DAYS);
  const baselineKg = bestIn(weeks, end, LIFT_BASELINE_OFFSETS_DAYS);
  if (recentKg == null || baselineKg == null) return null;
  return { baselineKg, recentKg, changeKg: Math.round((recentKg - baselineKg) * 10) / 10 };
}

/** True when the change is a real gain: >= +1% of the baseline. */
export function isLiftProgressing(c: LiftChange4w): boolean {
  return c.changeKg >= c.baselineKg * LIFT_PROGRESS_MIN_FRACTION - 1e-9 && c.changeKg > 0;
}

/**
 * Deload check on a weekly volume series (weekStart -> volume): the mean of
 * the `recentWeeks` weeks ending at `endWeekStart` is under 60% of the mean of
 * the 4 weeks before them. Needs a positive 4-week average (else false).
 */
export function isDeload(volumeByWeek: Record<string, number>, endWeekStart: string, recentWeeks: number): boolean {
  let recent = 0;
  for (let i = 0; i < recentWeeks; i += 1) recent += volumeByWeek[shiftDay(endWeekStart, -7 * i)] ?? 0;
  recent /= recentWeeks;
  let prior = 0;
  for (let i = recentWeeks; i < recentWeeks + 4; i += 1) prior += volumeByWeek[shiftDay(endWeekStart, -7 * i)] ?? 0;
  prior /= 4;
  return prior > 0 && recent < prior * DELOAD_VOLUME_FRACTION;
}

/** Weekly volume series for one lift (volumeKg, or set count for bodyweight-only lifts). */
export function liftVolumeByWeek(weeks: LiftWeekPoint[]): Record<string, number> {
  const useKg = weeks.some(w => (w.volumeKg ?? 0) > 0);
  const out: Record<string, number> = {};
  for (const w of weeks) out[w.weekStart] = useKg ? (w.volumeKg ?? 0) : (w.totalSets ?? 0);
  return out;
}

/**
 * Stall = this lift's change vs 4 weeks ago is below +1% — the ONE stall
 * definition shared by the goal card and the stalled-lift nudge. Not a stall
 * when there is nothing to compare, when the lift was absent for the 2+ weeks
 * before the recent window (a break / return), or when the recent window is a
 * deload.
 */
export function isLiftStalled(weeks: LiftWeekPoint[], anchorWeekStart: string): boolean {
  const c = liftChange4w(weeks, anchorWeekStart);
  const end = liftRecentEndWeek(weeks, anchorWeekStart);
  if (!c || end == null) return false;
  if (isLiftProgressing(c)) return false;
  const hadSets = (key: string): boolean => weeks.some(w => w.weekStart === key && ((w.totalSets ?? 0) > 0 || w.bestEstimatedOneRepMaxKg != null));
  if (!hadSets(shiftDay(end, -14)) && !hadSets(shiftDay(end, -21))) return false;
  return !isDeload(liftVolumeByWeek(weeks), end, 2);
}

/** "bench press" -> "Bench Press"; prefers an explicit display name when known. */
export function liftDisplayName(key: string, display?: Record<string, string> | null): string {
  const given = display?.[key];
  if (given) return given;
  return key.replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}
