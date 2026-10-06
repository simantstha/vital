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
 *   recent   = best e1RM across the anchor week and the week before it
 *   baseline = best e1RM across the two weeks that end 4 weeks before the
 *              anchor week (anchor-35d and anchor-28d)
 *   change   = recent - baseline, rounded to 0.1 kg
 * Both windows need at least one week with an e1RM, otherwise there is no
 * change to report (never invented). Display wording: "+5.8 kg vs 4 weeks ago".
 *
 * Keep in lockstep with TrendsStrengthLogic.change(...) — parity tests pin
 * identical fixtures to identical numbers in both languages.
 */

export const LIFT_RECENT_OFFSETS_DAYS = [0, 7] as const;
export const LIFT_BASELINE_OFFSETS_DAYS = [28, 35] as const;

export interface LiftWeekPoint {
  weekStart: string;
  bestEstimatedOneRepMaxKg: number | null;
}

export interface LiftChange4w {
  baselineKg: number;
  recentKg: number;
  /** recent - baseline, rounded to 0.1 kg. */
  changeKg: number;
}

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function bestIn(weeks: LiftWeekPoint[], anchorWeekStart: string, offsetsDays: readonly number[]): number | null {
  const keys = new Set(offsetsDays.map(o => shiftDay(anchorWeekStart, -o)));
  let best: number | null = null;
  for (const w of weeks) {
    if (!keys.has(w.weekStart) || w.bestEstimatedOneRepMaxKg == null) continue;
    if (best == null || w.bestEstimatedOneRepMaxKg > best) best = w.bestEstimatedOneRepMaxKg;
  }
  return best;
}

export function liftChange4w(weeks: LiftWeekPoint[], anchorWeekStart: string): LiftChange4w | null {
  const recentKg = bestIn(weeks, anchorWeekStart, LIFT_RECENT_OFFSETS_DAYS);
  const baselineKg = bestIn(weeks, anchorWeekStart, LIFT_BASELINE_OFFSETS_DAYS);
  if (recentKg == null || baselineKg == null) return null;
  return { baselineKg, recentKg, changeKg: Math.round((recentKg - baselineKg) * 10) / 10 };
}
