/**
 * Vital — endurance safe-progression rule (pure, no DB or Next.js imports)
 *
 * ONE rule for "how much may a runner build next week", shared by every
 * surface that talks about it so two numbers can never describe the same week:
 *
 *  - lib/weeklyReview.ts: "Next week" advice after a short distance week, and
 *    the bar the finished week itself is graded against;
 *  - lib/goalProgress.ts: `distance.stepTargetKm`, the target the Today hero,
 *    Trends goal card and goal sheet measure THIS week against.
 *
 * The weekly review looks at the last completed week and talks about "next
 * week"; the goal card looks at the current week. Those are the same week, so
 * both read their number from here. Likewise the review grades the finished
 * week against the step the goal card showed WHILE that week was under way
 * (`weekStepOrGoalKm` of the week before it), never against the full goal.
 *
 * Rule: a week may grow ~10% over the previous one (at least +1 unit so a very
 * small week still moves), never past the weekly target; the long run grows by
 * at most 2 km and never past its peak target.
 *
 * Race lifecycle (same module, same rule for every surface): with a race date
 * the calendar decides a RACE PHASE — build (> 21 days out), taper (8–21), race
 * week (0–7, race day included), recovery (1–14 days after). Taper, race week
 * and recovery do not grow: they have their own weekly target (a share of the
 * runner's peak week, see `racePhaseTargetKm`) and the growth step above is not
 * used in them.
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
 * The target a week is measured against, in km: that week's safe step from the
 * running km of the week BEFORE it (`weekStepTargetKm`, rounded to 0.1 km), or
 * the weekly target itself when there is no measured base week, the base week
 * had (almost) no running, or the step reaches the target. Always <= the
 * target. goalProgress shows it as `distance.stepTargetKm` while the week is
 * under way; the weekly review grades the finished week against the same
 * number. `lastWeekKm` is the base week's running km (null = nothing measured).
 */
export function weekStepOrGoalKm(lastWeekKm: number | null, weeklyTargetKm: number, unitsPerKm = 1): number {
  if (lastWeekKm == null) return weeklyTargetKm;
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const step = weekStepTargetKm(round1(lastWeekKm), weeklyTargetKm, unitsPerKm);
  return step == null ? weeklyTargetKm : Math.min(weeklyTargetKm, round1(step));
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

// ── Race lifecycle ──────────────────────────────────────────────────────────

/** Where a race date sits relative to today: far out, tapering, race week, or just done. */
export type RacePhase = 'build' | 'taper' | 'race_week' | 'recovery';

/** More than this many days out is still the build phase; this many and fewer is the taper. */
export const TAPER_START_DAYS = 21;
/** 14–21 days out is the early taper (x0.75), 8–13 days out the late taper (x0.6). */
export const TAPER_LATE_FROM_DAYS = 13;
/** 0–7 days out (race day included) is race week. */
export const RACE_WEEK_DAYS = 7;
/** Recovery is the first 14 days after race day; recovery week 1 is days 1–7, week 2 days 8–14. */
export const RECOVERY_DAYS = 14;

/** Shares of the peak week: early taper, late taper, race week (the race itself excluded), recovery week 1 and 2. */
export const TAPER_EARLY_FRACTION = 0.75;
export const TAPER_LATE_FRACTION = 0.6;
export const RACE_WEEK_FRACTION = 0.4;
export const RECOVERY_WEEK1_FRACTION = 0.4;
export const RECOVERY_WEEK2_FRACTION = 0.6;

/** The peak week is the biggest of this many 7-day blocks ending the day before the taper began. */
const PEAK_WEEKS = 4;

export interface RacePhaseInfo {
  phase: RacePhase;
  /** Days from today to race day: 0 on race day, negative after it. */
  daysToRace: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days since 1970-01-01 for a YYYY-MM-DD key; NaN when malformed. */
function dayIndex(day: string): number {
  if (!DAY_RE.test(day)) return Number.NaN;
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * The race phase for `raceDate` as seen from `today` (both user-local
 * YYYY-MM-DD): 'build' (> 21 days out), 'taper' (8–21), 'race_week' (0–7,
 * including race day), 'recovery' (1–14 days after). `null` without a (valid)
 * race date, and from 15 days after the race on. Also returns the signed day
 * count so callers need not redo the arithmetic.
 */
export function racePhaseInfo(raceDate: string | null | undefined, today: string): RacePhaseInfo | null {
  if (!raceDate) return null;
  const daysToRace = dayIndex(raceDate) - dayIndex(today);
  if (!Number.isFinite(daysToRace)) return null;
  if (daysToRace > TAPER_START_DAYS) return { phase: 'build', daysToRace };
  if (daysToRace > RACE_WEEK_DAYS) return { phase: 'taper', daysToRace };
  if (daysToRace >= 0) return { phase: 'race_week', daysToRace };
  if (daysToRace >= -RECOVERY_DAYS) return { phase: 'recovery', daysToRace };
  return null;
}

/** `racePhaseInfo(...)?.phase`. */
export function racePhase(raceDate: string | null | undefined, today: string): RacePhase | null {
  return racePhaseInfo(raceDate, today)?.phase ?? null;
}

/** True for the phases that carry their own weekly target instead of the growth step. */
export function isWindDownPhase(phase: RacePhase | null | undefined): phase is 'taper' | 'race_week' | 'recovery' {
  return phase === 'taper' || phase === 'race_week' || phase === 'recovery';
}

/** Recovery week (1 or 2) for the days since race day (1–14): days 1–7 are week 1. */
export function recoveryWeek(daysSince: number): 1 | 2 {
  return daysSince <= 7 ? 1 : 2;
}

/**
 * The peak week (km) the taper and recovery targets are shares of: the biggest
 * of the four 7-day blocks of running that end the day before the taper began
 * (21 days before the race). `runs` are running workouts (day + km, any order;
 * runs outside that 28-day window are ignored). `null` when nothing was run in
 * the window or the best block is under one km — callers fall back to the
 * weekly distance goal then.
 */
export function peakWeekKmBeforeTaper(runs: ReadonlyArray<{ day: string; km: number }>, raceDate: string): number | null {
  const taperStart = dayIndex(raceDate) - TAPER_START_DAYS;
  if (!Number.isFinite(taperStart)) return null;
  const blocks = new Array<number>(PEAK_WEEKS).fill(0);
  for (const r of runs) {
    if (!Number.isFinite(r.km) || r.km <= 0) continue;
    const before = taperStart - dayIndex(r.day); // 1 = the day before the taper began
    if (!Number.isFinite(before) || before < 1 || before > PEAK_WEEKS * 7) continue;
    blocks[Math.floor((before - 1) / 7)] += r.km;
  }
  const peak = Math.max(...blocks);
  return peak >= MIN_BASE_WEEK ? peak : null;
}

/**
 * The weekly running target (km) for taper, race week and recovery; `null` in
 * the build phase (the growth step applies) and without a usable peak week.
 *
 *  - taper 14–21 days out: round(peak x 0.75); 8–13 days out: round(peak x 0.6);
 *  - race week: round(peak x 0.4), NOT counting the race itself;
 *  - recovery week 1 (days 1–7 after): at most round(peak x 0.4), week 2: at
 *    most round(peak x 0.6), easy running only.
 *
 * Rounding happens in the display unit (`unitsPerKm`: 1 for km, ~0.6214 for
 * miles) so an imperial runner's target is a whole number of miles, and is at
 * least 1 unit. A `weeklyGoalKm` caps the result: a wind-down week never asks
 * for more than the stated weekly goal.
 */
export function racePhaseTargetKm(
  info: RacePhaseInfo,
  peakWeekKm: number,
  opts: { weeklyGoalKm?: number | null; unitsPerKm?: number } = {},
): number | null {
  const units = opts.unitsPerKm ?? 1;
  if (!Number.isFinite(peakWeekKm) || peakWeekKm <= 0 || !Number.isFinite(units) || units <= 0) return null;
  let fraction: number;
  switch (info.phase) {
    case 'taper': fraction = info.daysToRace > TAPER_LATE_FROM_DAYS ? TAPER_EARLY_FRACTION : TAPER_LATE_FRACTION; break;
    case 'race_week': fraction = RACE_WEEK_FRACTION; break;
    case 'recovery': fraction = recoveryWeek(-info.daysToRace) === 1 ? RECOVERY_WEEK1_FRACTION : RECOVERY_WEEK2_FRACTION; break;
    default: return null;
  }
  const inUnits = Math.max(1, Math.round(peakWeekKm * units * fraction));
  const km = Math.round((inUnits / units) * 10) / 10;
  const goal = opts.weeklyGoalKm;
  return goal != null && Number.isFinite(goal) && goal > 0 ? Math.min(km, goal) : km;
}
