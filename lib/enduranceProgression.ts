/**
 * Vital — endurance safe-progression rule (pure, no DB or Next.js imports)
 *
 * ONE rule for "how much may a runner build next week", shared by every
 * surface that talks about it so two numbers can never describe the same week:
 *
 *  - lib/weeklyReview.ts: "Next week" advice after a short distance week;
 *  - lib/goalProgress.ts: `distance.stepTargetKm`, the target the Today hero,
 *    Trends goal card and goal sheet measure THIS week against.
 *
 * The weekly review looks at the last completed week and talks about "next
 * week"; the goal card looks at the current week. Those are the same week, so
 * both read their number from here.
 *
 * Rule: a week may grow ~10% over the previous one (at least +1 unit so a very
 * small week still moves), never past the weekly target; the long run grows by
 * at most 2 km and never past its peak target.
 */

/** Weekly distance may grow by at most this fraction week over week (the ~10% rule). */
export const WEEKLY_DISTANCE_GROWTH = 0.1;
/** The long run may grow by at most this many km in a week. */
export const LONG_RUN_MAX_STEP_KM = 2;
/** A base week under this much running (in the display unit) has nothing to take 10% of. */
export const MIN_BASE_WEEK = 1;

/**
 * Next week's safe distance in whatever unit both arguments are expressed in
 * (rounding to whole units is done in that unit): min(target,
 * max(round(lastWeek x 1.10), floor(lastWeek) + 1)). `null` when last week had
 * (almost) no running or the inputs are unusable — there is no base to grow
 * from, so callers restart gently / fall back to the target.
 */
export function weekStepTarget(lastWeek: number, weeklyTarget: number): number | null {
  if (!Number.isFinite(lastWeek) || !Number.isFinite(weeklyTarget) || weeklyTarget <= 0) return null;
  if (lastWeek < MIN_BASE_WEEK) return null;
  const grown = Math.max(Math.round(lastWeek * (1 + WEEKLY_DISTANCE_GROWTH)), Math.floor(lastWeek) + 1);
  return Math.min(weeklyTarget, grown);
}

/**
 * `weekStepTarget` for km inputs, in km. `unitsPerKm` is the display unit the
 * rounding happens in (1 for km, ~0.6214 for miles) so an imperial runner's
 * step is a whole number of miles, exactly as the review words it. The result
 * is the weekly target itself (not a rounded-trip approximation) whenever the
 * step reaches it. `null` as for `weekStepTarget`.
 */
export function weekStepTargetKm(lastWeekKm: number, weeklyTargetKm: number, unitsPerKm = 1): number | null {
  if (!Number.isFinite(unitsPerKm) || unitsPerKm <= 0) return null;
  const target = weeklyTargetKm * unitsPerKm;
  const step = weekStepTarget(lastWeekKm * unitsPerKm, target);
  if (step == null) return null;
  return step >= target ? weeklyTargetKm : step / unitsPerKm;
}

/**
 * Next week's long run (km): +2 km on the last one, never past the peak target
 * and not past it even when the last long run is already there (then the peak
 * itself, i.e. "hold"). Without a peak target it is simply last + 2 km.
 */
export function longRunStepKm(lastKm: number, targetPeakKm: number | null | undefined): number {
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  if (targetPeakKm == null) return round1(lastKm + LONG_RUN_MAX_STEP_KM);
  if (lastKm >= targetPeakKm) return targetPeakKm;
  return round1(lastKm + Math.min(LONG_RUN_MAX_STEP_KM, targetPeakKm - lastKm));
}

/** True when the last long run is already at or past its peak target (so the long run is held, not grown). */
export function longRunAtPeak(lastKm: number, targetPeakKm: number | null | undefined): boolean {
  return targetPeakKm != null && lastKm >= targetPeakKm;
}
