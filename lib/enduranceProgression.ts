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
 * the calendar decides a RACE PHASE — build, taper, race week (0–7 days out,
 * race day included), recovery (days after). Where the phases start depends on
 * the race distance (`raceRules`): a marathon and longer taper from 21 days out
 * and recover for 14 days; a half marathon tapers for days 8–14 only and
 * recovers for 14 days; a 10K or shorter has no taper (race week is the only
 * easing-off) and recovers for 7 days. Taper, race week and recovery do not
 * grow: they have their own weekly target (a share of the runner's peak week,
 * see `racePhaseTargetKm`) and the growth step above is not used in them.
 *
 * ONE week plan (`enduranceWeekPlan`, bottom of this module): every surface that
 * talks about a calendar week of running — the Today / Trends goal card, the
 * Monday weekly review, the coach lines and the coach opener — reads the SAME
 * plan for that week: its kind (baseline, build, hold, restart, maintain,
 * taper, race week, recovery, rebuild), its km target, the next long run and
 * the band the finished week is graded against. The plan's phase and target
 * always come from the week's MONDAY (also for the card), so a Sunday race can
 * never make the card and the review disagree about which week it is.
 */

import { withUnit } from './displayText';
import { KM_PER_MILE } from './metricFormat';

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

/**
 * Marathon-and-longer rules (also the default for a race with no distance):
 * more than this many days out is still the build phase; this many and fewer is
 * the taper. Shorter races taper later or not at all, see `raceRules`.
 */
export const TAPER_START_DAYS = 21;
/** Marathon: 14–21 days out is the early taper (x0.75), 8–13 days out the late taper (x0.6). */
export const TAPER_LATE_FROM_DAYS = 13;
/** 0–7 days out (race day included) is race week. */
export const RACE_WEEK_DAYS = 7;
/** Recovery is the first 14 days after race day (7 for a 10K or shorter); recovery week 1 is days 1–7, week 2 days 8–14. */
export const RECOVERY_DAYS = 14;

/** Marathon shares of the peak week: early taper, late taper, race week (the race itself excluded), recovery week 1 and 2. */
export const TAPER_EARLY_FRACTION = 0.75;
export const TAPER_LATE_FRACTION = 0.6;
export const RACE_WEEK_FRACTION = 0.4;
export const RECOVERY_WEEK1_FRACTION = 0.4;
export const RECOVERY_WEEK2_FRACTION = 0.6;
/** Half marathon: one taper week at x0.75, race week x0.5, recovery days 1–7 at most x0.4 and days 8–14 at most x0.7. */
export const HALF_TAPER_FRACTION = 0.75;
export const HALF_RACE_WEEK_FRACTION = 0.5;
export const HALF_RECOVERY_WEEK1_FRACTION = 0.4;
export const HALF_RECOVERY_WEEK2_FRACTION = 0.7;
/** 10K or shorter: no taper, race week x0.6, 7 days of recovery at most x0.5. */
export const SHORT_RACE_WEEK_FRACTION = 0.6;
export const SHORT_RECOVERY_FRACTION = 0.5;

/** The peak week is the biggest of this many 7-day blocks ending the day before the taper began. */
const PEAK_WEEKS = 4;

/** 10K and shorter / half marathon / longer: the race phases are not the same length for all of them. */
export type RaceClass = 'short' | 'half' | 'long';

/** A race of this many km or less is a 10K-or-shorter race (the tolerance covers 10.0 / 10.05 km GPS-ish entries). */
const SHORT_RACE_MAX_KM = 10.05;
/** A race of this many km or less (and over a 10K) is a half-marathon-class race (21.0975 km, 21.1 km). */
const HALF_RACE_MAX_KM = 21.15;

/**
 * The race class for a distance: <= 10 km short, <= 21.1 km half, longer long.
 * A race with no (usable) distance keeps the marathon rules, the longest taper.
 */
export function raceClass(distanceKm: number | null | undefined): RaceClass {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm <= 0) return 'long';
  if (distanceKm <= SHORT_RACE_MAX_KM) return 'short';
  if (distanceKm <= HALF_RACE_MAX_KM) return 'half';
  return 'long';
}

export interface RaceRules {
  raceClass: RaceClass;
  /** Days out the taper begins (this many days and fewer); 7 (= race week) when there is no taper. */
  taperStartDays: number;
  /** Days after race day that count as recovery. */
  recoveryDays: number;
  /** The peak long run is planned this many days before the race. */
  peakLongRunLeadDays: number;
}

const RACE_RULES: Record<RaceClass, RaceRules> = {
  short: { raceClass: 'short', taperStartDays: RACE_WEEK_DAYS, recoveryDays: 7, peakLongRunLeadDays: 10 },
  half: { raceClass: 'half', taperStartDays: 14, recoveryDays: RECOVERY_DAYS, peakLongRunLeadDays: 14 },
  long: { raceClass: 'long', taperStartDays: TAPER_START_DAYS, recoveryDays: RECOVERY_DAYS, peakLongRunLeadDays: 21 },
};

/** Where the phases fall for a race of this distance (see `RaceClass`). */
export function raceRules(distanceKm: number | null | undefined): RaceRules {
  return RACE_RULES[raceClass(distanceKm)];
}

export interface RacePhaseInfo {
  phase: RacePhase;
  /** Days from today to race day: 0 on race day, negative after it. */
  daysToRace: number;
  /** The race class the phase was read with; absent = marathon rules (older literals). */
  raceClass?: RaceClass;
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
 * YYYY-MM-DD), by the race distance's rules (`raceRules`; no distance = the
 * marathon rules): 'build' (before the taper), 'taper' (a half: 8–14 days out,
 * a marathon: 8–21, none for a 10K or shorter), 'race_week' (0–7, including
 * race day), 'recovery' (1–14 days after, 1–7 for a 10K or shorter). `null`
 * without a (valid) race date, and once recovery is over. Also returns the
 * signed day count so callers need not redo the arithmetic.
 */
export function racePhaseInfo(
  raceDate: string | null | undefined,
  today: string,
  raceDistanceKm?: number | null,
): RacePhaseInfo | null {
  if (!raceDate) return null;
  const daysToRace = dayIndex(raceDate) - dayIndex(today);
  if (!Number.isFinite(daysToRace)) return null;
  const rules = raceRules(raceDistanceKm);
  const cls = rules.raceClass;
  if (daysToRace > rules.taperStartDays) return { phase: 'build', daysToRace, raceClass: cls };
  if (daysToRace > RACE_WEEK_DAYS) return { phase: 'taper', daysToRace, raceClass: cls };
  if (daysToRace >= 0) return { phase: 'race_week', daysToRace, raceClass: cls };
  if (daysToRace >= -rules.recoveryDays) return { phase: 'recovery', daysToRace, raceClass: cls };
  return null;
}

/** `racePhaseInfo(...)?.phase`. */
export function racePhase(
  raceDate: string | null | undefined,
  today: string,
  raceDistanceKm?: number | null,
): RacePhase | null {
  return racePhaseInfo(raceDate, today, raceDistanceKm)?.phase ?? null;
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
 * (21 days before a marathon, 14 before a half, 7 before a 10K or shorter —
 * `raceRules(raceDistanceKm).taperStartDays`). `runs` are running workouts (day
 * + km, any order; runs outside that 28-day window are ignored). `null` when
 * nothing was run in the window or the best block is under one km — callers
 * fall back to the weekly distance goal then.
 */
export function peakWeekKmBeforeTaper(
  runs: ReadonlyArray<{ day: string; km: number }>,
  raceDate: string,
  raceDistanceKm?: number | null,
): number | null {
  const taperStart = dayIndex(raceDate) - raceRules(raceDistanceKm).taperStartDays;
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

/** Taper: running at least this share of the week's target is on plan (less running is no slip in a taper). */
export const TAPER_GOOD_MIN_FRACTION = 0.6;
/** Taper: more than this fraction over the target (and by the minimum excess below) is over the plan. */
export const TAPER_OVER_FRACTION = 0.25;
/** Taper over-the-plan also needs at least this much excess: 3 km (2 mi for a unit size below 1, i.e. miles). */
const TAPER_OVER_MIN_EXCESS_KM = 3;
const TAPER_OVER_MIN_EXCESS_MI = 2;
/** Race week / recovery: the target is a ceiling, met with this much slack (10%). */
export const PHASE_CEILING_TOLERANCE = 1.1;

/** Where a wind-down week's running sits against its target. */
export type WindDownBand = 'under' | 'within' | 'over';

/**
 * ONE rule for "is this taper / race-week / recovery week on plan?", shared by
 * the weekly review (rating) and the goal card (verdict):
 *  - taper: 'within' from 60% of the target up to 25% over it (and under 3 km /
 *    2 mi over); 'over' beyond that, 'under' below 60%;
 *  - race week and recovery: the target is a ceiling — 'within' up to 10% over
 *    it, 'over' beyond; never 'under' (running less is the plan).
 * `weekFraction` (0..1, default 1) pro-rates the taper's LOWER bound for a week
 * still under way (the goal card on a Tuesday), so an early-week 6 km is not an
 * undershoot; the upper bounds are cumulative and never pro-rated.
 * `unitsPerKm` is the display unit's size (1 for km, below 1 for miles).
 */
export function windDownBand(
  phase: 'taper' | 'race_week' | 'recovery',
  km: number,
  targetKm: number,
  opts: { unitsPerKm?: number; weekFraction?: number } = {},
): WindDownBand {
  const units = opts.unitsPerKm ?? 1;
  if (phase !== 'taper') return km > targetKm * PHASE_CEILING_TOLERANCE ? 'over' : 'within';
  const minExcess = units < 1 ? TAPER_OVER_MIN_EXCESS_MI : TAPER_OVER_MIN_EXCESS_KM;
  if (km > targetKm * (1 + TAPER_OVER_FRACTION) && (km - targetKm) * units >= minExcess) return 'over';
  const fraction = Math.min(1, Math.max(0, opts.weekFraction ?? 1));
  return km < targetKm * TAPER_GOOD_MIN_FRACTION * fraction ? 'under' : 'within';
}

/**
 * A planned weekly distance (km) rounded in the display unit: whole km, or the nearest 0.5 mi for miles (a ceiling
 * of "7.2 mi" is not a number a runner can plan with); at least 1 unit. One decimal in km.
 */
export function roundWeekTargetKm(km: number, unitsPerKm = 1): number {
  const units = Number.isFinite(unitsPerKm) && unitsPerKm > 0 ? unitsPerKm : 1;
  const step = units < 1 ? 0.5 : 1;
  const inUnits = Math.max(1, Math.round((km * units) / step) * step);
  return Math.round((inUnits / units) * 10) / 10;
}

/**
 * The weekly running target (km) for taper, race week and recovery; `null` in
 * the build phase (the growth step applies) and without a usable peak week.
 * The shares of the peak week depend on the race class (`info.raceClass`; no
 * class = the marathon column):
 *
 *  | phase                  | 10K or shorter | half marathon | marathon and longer |
 *  |------------------------|----------------|---------------|---------------------|
 *  | taper                  | none           | x0.75         | x0.75 (14–21 days), x0.6 (8–13) |
 *  | race week (race out)   | x0.6           | x0.5          | x0.4                |
 *  | recovery days 1–7      | at most x0.5   | at most x0.4  | at most x0.4        |
 *  | recovery days 8–14     | (none: 7 days) | at most x0.7  | at most x0.6        |
 *
 * Rounding happens in the display unit (`unitsPerKm`: 1 for km, ~0.6214 for
 * miles) so an imperial runner's target is a multiple of 0.5 mi, and is at
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
  const cls: RaceClass = info.raceClass ?? 'long';
  let fraction: number;
  switch (info.phase) {
    case 'taper':
      if (cls === 'short') return null; // no taper before a 10K or shorter
      fraction = cls === 'half' ? HALF_TAPER_FRACTION : info.daysToRace > TAPER_LATE_FROM_DAYS ? TAPER_EARLY_FRACTION : TAPER_LATE_FRACTION;
      break;
    case 'race_week':
      fraction = cls === 'short' ? SHORT_RACE_WEEK_FRACTION : cls === 'half' ? HALF_RACE_WEEK_FRACTION : RACE_WEEK_FRACTION;
      break;
    case 'recovery': {
      const week = recoveryWeek(-info.daysToRace);
      fraction = cls === 'short' ? SHORT_RECOVERY_FRACTION
        : cls === 'half' ? (week === 1 ? HALF_RECOVERY_WEEK1_FRACTION : HALF_RECOVERY_WEEK2_FRACTION)
        : week === 1 ? RECOVERY_WEEK1_FRACTION : RECOVERY_WEEK2_FRACTION;
      break;
    }
    default: return null;
  }
  const km = roundWeekTargetKm(peakWeekKm * fraction, units);
  const goal = opts.weeklyGoalKm;
  return goal != null && Number.isFinite(goal) && goal > 0 ? Math.min(km, goal) : km;
}

// ── Long-run targets ────────────────────────────────────────────────────────

/**
 * Peak long-run distance (km) a runner should reach before the taper, by race
 * distance: 5K 8, 10K 14, half 18, marathon 32, otherwise 85% of the race.
 * Null without a race distance.
 */
export function longRunTargetKm(raceDistanceKm: number | null | undefined): number | null {
  if (raceDistanceKm == null || !Number.isFinite(raceDistanceKm) || raceDistanceKm <= 0) return null;
  if (Math.abs(raceDistanceKm - 5) < 0.05) return 8;
  if (Math.abs(raceDistanceKm - 10) < 0.05) return 14;
  if (Math.abs(raceDistanceKm - 21.1) < 0.05) return 18;
  if (Math.abs(raceDistanceKm - 42.2) < 0.05) return 32;
  return Math.round(raceDistanceKm * 0.85);
}

/** The peak long run to build to, and the race-distance peak when the long-run cap at the weekly goal held it lower. */
export interface LongRunPeak {
  peakKm: number;
  raceTargetKm: number | null;
}

/**
 * The peak long run a runner is planned to reach: the race-distance peak (`longRunTargetKm`), but never more than
 * half of the weekly goal (`LONG_RUN_MAX_WEEK_SHARE`) — a long run that is most of the week is not a plan. When
 * the race peak does not fit under that cap at the weekly goal, the peak is what fits (rounded down to 0.5 of the
 * display unit) and `raceTargetKm` carries the race peak for the one-line explanation (`longRunCapNote`). Null
 * without a race distance.
 */
export function longRunPeakTarget(
  raceDistanceKm: number | null | undefined,
  weeklyGoalKm: number | null | undefined,
  unitsPerKm = 1,
): LongRunPeak | null {
  const race = longRunTargetKm(raceDistanceKm);
  if (race == null) return null;
  if (weeklyGoalKm == null || !Number.isFinite(weeklyGoalKm) || weeklyGoalKm <= 0 || !Number.isFinite(unitsPerKm) || unitsPerKm <= 0) {
    return { peakKm: race, raceTargetKm: null };
  }
  const fitsInUnits = Math.floor(weeklyGoalKm * unitsPerKm * LONG_RUN_MAX_WEEK_SHARE * 2 + 1e-9) / 2;
  const fitsKm = Math.round((fitsInUnits / unitsPerKm) * 100) / 100;
  if (fitsKm >= race - 1e-9 || fitsKm <= 0) return { peakKm: race, raceTargetKm: null };
  return { peakKm: fitsKm, raceTargetKm: race };
}

/** "a 15 km" / "an 18 km": the article for a number read aloud (eight, eleven, eighteen take "an"). */
function articleFor(numberText: string): 'a' | 'an' {
  return /^(8|11|18)(\D|$)/.test(numberText) ? 'an' : 'a';
}

/**
 * The one-line note for a long-run peak held below the race peak by the weekly goal: "Your 30 km weeks fit a 15 km
 * long run; for an 18 km peak, raise the goal to ~36 km". Null when the cap did not bind.
 */
export function longRunCapNote(peak: LongRunPeak | null | undefined, weeklyGoalKm: number, unitsPerKm = 1): string | null {
  if (peak == null || peak.raceTargetKm == null || !Number.isFinite(weeklyGoalKm) || weeklyGoalKm <= 0) return null;
  const unit = distanceUnit(unitsPerKm);
  const fit = formatTargetLongRun(peak.peakKm, unitsPerKm);
  const full = formatTargetLongRun(peak.raceTargetKm, unitsPerKm);
  const needed = Math.ceil((peak.raceTargetKm / LONG_RUN_MAX_WEEK_SHARE) * unitsPerKm * 2 - 1e-9) / 2;
  const goal = withUnit(round1(weeklyGoalKm * unitsPerKm), unit);
  return `Your ${goal} weeks fit ${articleFor(fit)} ${fit} long run; for ${articleFor(full)} ${full} peak, raise the goal to ~${withUnit(needed, unit)}`;
}

/** A run is only called a "long run" at 5 km (3 mi) or more; shorter ones are the "longest run". */
export const LONG_RUN_MIN_KM = 5;
export const LONG_RUN_MIN_KM_IMPERIAL = 3 * KM_PER_MILE;

/** True when `km` is long enough to be called a long run in the display unit (`unitsPerKm` < 1 = miles). */
export function isLongRun(km: number, unitsPerKm = 1): boolean {
  return km >= (unitsPerKm < 1 ? LONG_RUN_MIN_KM_IMPERIAL : LONG_RUN_MIN_KM) - 1e-9;
}

/** "long run" for a run of 5 km (3 mi) or more, else "longest run". */
export function longRunWord(km: number, unitsPerKm = 1): 'long run' | 'longest run' {
  return isLongRun(km, unitsPerKm) ? 'long run' : 'longest run';
}

// ── Display helpers (units) ─────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;

function distanceUnit(unitsPerKm: number): 'km' | 'mi' {
  return unitsPerKm < 1 ? 'mi' : 'km';
}

/** A measured distance, e.g. "24.5 km" / "15.2 mi" (U+00A0 between the number and the unit). */
export function formatKm(km: number, unitsPerKm = 1): string {
  return withUnit(round1(km * unitsPerKm), distanceUnit(unitsPerKm));
}

/** A planned long-run distance: rounded to the nearest 0.5 of the display unit ("11 mi", "15.5 km"). */
export function formatTargetLongRun(km: number, unitsPerKm = 1): string {
  return withUnit(Math.round(km * unitsPerKm * 2) / 2, distanceUnit(unitsPerKm));
}

/** A long-run distance (km) rounded to the nearest 0.5 of the display unit, back in km. */
export function roundLongRunKm(km: number, unitsPerKm = 1): number {
  return Math.round(((Math.round(km * unitsPerKm * 2) / 2) / unitsPerKm) * 100) / 100;
}

/** A long-run distance (km) rounded DOWN to 0.5 of the display unit, back in km (a capped long run never rounds up past its cap). */
export function floorLongRunKm(km: number, unitsPerKm = 1): number {
  return Math.round(((Math.floor(km * unitsPerKm * 2 + 1e-9) / 2) / unitsPerKm) * 100) / 100;
}

/** A race time from minutes: "2:01" from one hour on, else "45 min". Null when unknown. */
export function formatRaceTime(durationMin: number | null | undefined): string | null {
  if (durationMin == null || !Number.isFinite(durationMin) || durationMin <= 0) return null;
  const total = Math.round(durationMin);
  if (total < 60) return withUnit(total, 'min');
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// ── Calendar helpers ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** `day` (YYYY-MM-DD) plus `n` days. */
export function addDayKey(day: string, n: number): string {
  return new Date((dayIndex(day) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Monday (UTC calendar) of the week containing `day`. */
export function mondayOfDay(day: string): string {
  const dow = (new Date(dayIndex(day) * DAY_MS).getUTCDay() + 6) % 7; // Mon = 0
  return addDayKey(day, -dow);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Spike rule (shared by the card and the review) ──────────────────────────

/** Endurance spike: running km above the week's step by more than this fraction AND by at least the minimum excess (3 km / 2 mi). */
export const SPIKE_OVER_STEP_FRACTION = 0.3;
export const SPIKE_MIN_EXCESS_KM = 3;
export const SPIKE_MIN_EXCESS_MI = 2;

/**
 * A jump, not a good week: running km more than 30% above the week's step AND
 * at least 3 km (2 mi) over it. Only when a step below the goal applies — with
 * the goal as the bar, going past it is simply a hit target.
 */
export function isSpikeWeek(km: number, stepKm: number, goalKm: number, unitsPerKm = 1): boolean {
  if (stepKm >= goalKm) return false;
  const imperial = unitsPerKm < 1;
  const excess = (km - stepKm) * unitsPerKm;
  return km > stepKm * (1 + SPIKE_OVER_STEP_FRACTION) && excess >= (imperial ? SPIKE_MIN_EXCESS_MI : SPIKE_MIN_EXCESS_KM);
}

/** The km above which `isSpikeWeek` is true for a step (informational: the band's upper edge). */
function spikeEdgeKm(stepKm: number, unitsPerKm: number): number {
  const minExcessKm = (unitsPerKm < 1 ? SPIKE_MIN_EXCESS_MI : SPIKE_MIN_EXCESS_KM) / unitsPerKm;
  return round1(Math.max(stepKm * (1 + SPIKE_OVER_STEP_FRACTION), stepKm + minExcessKm));
}

// ── Week plan ───────────────────────────────────────────────────────────────

/** A running workout with a measured distance (km), `day` = user-local YYYY-MM-DD. */
export interface PlanRun {
  day: string;
  km: number;
  durationMin?: number | null;
}

export type EnduranceWeekKind =
  | 'baseline'
  | 'build'
  | 'hold'
  | 'restart'
  | 'maintain'
  | 'taper'
  | 'race_week'
  | 'recovery'
  | 'rebuild';

/** How a finished (or running) week stacks up against its plan; 'light' = a rest / break week. */
export type WeekLevel = 'good' | 'mixed' | 'tough';
export type WeekGapType = 'short' | 'spike' | 'over' | 'under';

export interface WeekGrade {
  level: WeekLevel | 'light';
  /** Why the week was not good: short of its target, a jump over it, or (wind-down weeks) over / under the phase target. */
  gap: WeekGapType | null;
}

/** The band a week's km is graded against. */
export interface PlanBand {
  /** At least this much running is a good week. */
  goodFromKm: number;
  /** At least this much is a mixed (short) week, less is tough. */
  mixedFromKm: number;
  /** More than this is over the plan (a spike in a build-type week, "over" in a wind-down week); null = no upper guard. */
  overKm: number | null;
}

/** The last finished week, as the plan for it graded it. */
export interface PlanLastWeek {
  weekStart: string;
  km: number;
  runDays: number;
  kind: EnduranceWeekKind;
  targetKm: number | null;
  /** Null at the edge of the history the plan looks back over. */
  grade: WeekGrade | null;
  /** Whole-percent change vs the week before it; null when that week was under 5 km (3 mi) or has no runs. */
  changePct: number | null;
}

export interface PlanLongRun {
  /** The longest run of the 14 days before the week (the race itself excluded); null when there was none. */
  lastKm: number | null;
  /** The longest run of the 28 days before the week (the race itself excluded). */
  peakKm: number | null;
  /**
   * Peak long run to build to before the taper: the race-distance peak, or what fits under the long-run cap at the
   * weekly goal (`longRunPeakTarget`); null without an upcoming race distance.
   */
  targetPeakKm: number | null;
  /** The race-distance peak when the cap at the weekly goal held `targetPeakKm` lower (then say so, once); null otherwise. */
  raceTargetKm: number | null;
  /** The week's long run: min(lastKm + 2 km, the peak target); rounded to 0.5 of the display unit. */
  nextKm: number | null;
}

export interface EnduranceWeekPlanInput {
  /** Running workouts with a distance, any order; the more history (up to ~10 weeks) the better. Runs after `today` are ignored. */
  runs: ReadonlyArray<PlanRun>;
  /** Monday of the week to plan. */
  weekStart: string;
  /** The weekly distance goal, km (> 0). */
  goalKm: number;
  race?: { date: string | null; distanceKm: number | null } | null;
  /** User-local today (for the card) or the day the plan is read from (the review passes the week's last day / the coming Monday). */
  today: string;
  /** Biggest weekly km before the taper (the loader supplies it); the weekly goal stands in when absent. */
  racePeakWeekKm?: number | null;
  /** The display unit's size in km: 1 for km, 1 / KM_PER_MILE for miles. */
  unitsPerKm?: number;
  /** User-local day the goal began; a goal set after the race ends the rebuild phase. */
  goalStartDay?: string | null;
  /**
   * An explicit long-run reading (km) that replaces the one derived from `runs`: the weekly review is handed the goal
   * card's `longRun` object as of the end of the reviewed week, which is the same reading.
   */
  longRun?: { lastKm: number; peakKm?: number | null; targetPeakKm?: number | null } | null;
}

export interface EnduranceWeekPlan {
  kind: EnduranceWeekKind;
  weekStart: string;
  goalKm: number;
  /** The week's running target, km; null in a baseline week (nothing to measure yet). */
  targetKm: number | null;
  /** The next long run (km), `longRun.nextKm`. */
  longRunKm: number | null;
  longRun: PlanLongRun;
  /** The band the week's km is graded against (see `gradeEnduranceWeek`). */
  band: PlanBand;
  /** The short "what this week is for" line (plain English, U+00A0 between numbers and units). */
  purpose: string;
  /** The last finished week against its own plan; null for a baseline week. */
  last: PlanLastWeek | null;
  /** Mean weekly km of the (up to) 4 finished TRAINING weeks before this one (taper, race and recovery weeks left out); null with none. */
  avg4wKm: number | null;
  /** Days since the last run as of today (or the week's last day for a past week); null with no runs. */
  daysSinceRun: number | null;
  /** No run for 7+ days (never in a taper / race / recovery week): the runner is on a break. */
  onBreak: boolean;
  /** The week ENDED with 5+ days off (never in a taper / race / recovery week): a short week like that is a lighter week. */
  endedOff: boolean;
  /**
   * Restart (or rebuild-from-rest) weeks: why, the median weekly km (before the break) the restart target is a share
   * of, the share the restart used (the gap length decides it) and the gap in days when it was a gap.
   */
  restart: { reason: 'break' | 'low_week' | 'no_runs'; medianKm: number; fraction: number; gapDays: number | null } | null;
  /**
   * The weeks right after a restart climb back to the pre-break median in rungs (restart, then 80%, then 100%):
   * the median, the rung this week uses (share of the median) and how many weeks after the restart it is (1-3).
   */
  comeback: { medianKm: number; fraction: number; weeksSince: number } | null;
  /** The restart target (km) the card quotes while the runner is on a break; equals `targetKm` in a restart week. */
  restartKm: number;
  /** Last week's long run ran 2 km or more over its plan: this week's long run is held there. */
  longRunJump: { actualKm: number; plannedKm: number; heldKm: number } | null;
  /** True when a training week before this one reached the weekly goal (else a maintain week is still "build to"). */
  goalReachedBefore: boolean;
  /** Days from the day the plan is read on (today; the week's last day for a past week) to race day; negative after it; null without a race. */
  raceDaysToGo: number | null;
  /** The actual step over last week in whole percent (this week's target against last week's km); null when last week was too small to compare or there is no target. */
  stepPct: number | null;
  /** Hold week: last week's jump and the step it was graded against. */
  hold: { spikeKm: number; spikeStepKm: number } | null;
  /** Taper / race week / recovery: the race phase read on this week's Monday and the peak week its target is a share of. */
  wind: { phase: 'taper' | 'race_week' | 'recovery'; info: RacePhaseInfo; peakKm: number } | null;
  /** Rebuild: whole days since race day on this week's Monday. */
  rebuild: { daysSince: number } | null;
  unitsPerKm: number;
}

/** A sick or very light week (no long gap) is "restarted" from this share of the recent median week. */
export const RESTART_FRACTION = 0.6;
/** A finished week under this share of the median of the 4 weeks before it is a restart trigger. */
export const RESTART_LOW_WEEK_FRACTION = 0.5;
/**
 * The restart cut scales with the length of the gap: up to 7 days is one skipped
 * step (the restart holds last week's target), 8–14 days restarts at ~75% of the
 * pre-break median week, more than 14 days at ~55%.
 */
export const RESTART_HOLD_GAP_DAYS = 7;
export const RESTART_MID_FRACTION = 0.75;
export const RESTART_LONG_GAP_DAYS = 14;
export const RESTART_LONG_FRACTION = 0.55;
/**
 * After a restart the comeback climbs back to the pre-break median in rungs
 * (restart -> 80% -> 100% of the median), for this many weeks. A rung is climbed
 * only when the week before graded good; otherwise it is repeated.
 */
export const COMEBACK_WEEKS = 3;
export const COMEBACK_RUNGS = [0.8, 1] as const;
/** No run for this many days is a break (more for a runner who normally runs less often, see `breakThreshold`). */
export const BREAK_DAYS = 7;
/**
 * A finished week that ENDED with this many days off (more for a runner who runs less often) and was short is a
 * lighter week (illness, travel), not a failure — a gentler bar than "On a break", which needs `BREAK_DAYS`.
 */
export const SHORT_WEEK_REST_DAYS = 5;
/** A runner's own rhythm: a break is also at least this many times their typical gap between run days. */
const BREAK_GAP_FACTOR = 1.5;
/** Rebuild covers the weeks from the end of recovery up to this many days after the race. */
export const REBUILD_DAYS = 42;
/** The change vs the week before is only quoted when that week was at least this big (km; 3 mi for miles). */
const MIN_COMPARE_BASE_KM = 5;
const MIN_COMPARE_BASE_MI = 3;
/**
 * How far back the plan walks: to see a spike (one hold week per spike week) and to climb back after a restart (the
 * week before this one must itself know the restart three weeks behind it), and the weeks the restart median looks at.
 */
const MAX_PLAN_DEPTH = 4;
const MEDIAN_WEEKS = 4;
const MAX_LOOKBACK_WEEKS = 16;
/** Good / mixed shares of a week's target. */
const GOOD_FRACTION = 0.9;
const MIXED_FRACTION = 0.6;
const RESTART_GOOD_FRACTION = 0.6;
const RESTART_MIXED_FRACTION = 0.3;
/** Rebuild weeks (after the race) and the comeback rungs after a restart are graded gentler than a normal build: 80% is good. */
const REBUILD_GOOD_FRACTION = 0.8;
const REBUILD_MIXED_FRACTION = 0.5;
/**
 * The long run never grows past this share of the week's target (it is the week's biggest run, not the whole
 * week): half of a normal week, 40% of a restart week.
 */
export const LONG_RUN_MAX_WEEK_SHARE = 0.5;
export const LONG_RUN_RESTART_WEEK_SHARE = 0.4;
/** A taper week's long run is this share of the peak long run of the last 28 days. */
const TAPER_LONG_RUN_SHARE = 0.65;
/** A run this share of the race distance, within a day of race day, is the race. */
export const RACE_RUN_MIN_FRACTION = 0.9;

interface PlanCtx {
  runs: PlanRun[];
  today: string;
  units: number;
  goalKm: number;
  raceDate: string | null;
  raceKm: number | null;
  peakKm: number | null;
  goalStartDay: string | null;
  longRunOverride: { lastKm: number; peakKm: number | null; targetPeakKm: number | null } | null;
  /** The long-run peak for the race at the weekly goal. */
  peakInfo: LongRunPeak | null;
  firstRunWeek: string | null;
  kmCache: Map<string, { km: number; days: number }>;
}

/** The race run: the longest run of at least 90% of the race distance on race day or the day before / after. Null when none. */
export function findRaceRun(
  runs: ReadonlyArray<PlanRun>,
  race: { date: string | null; distanceKm: number | null } | null | undefined,
): PlanRun | null {
  if (!race?.date || race.distanceKm == null || !Number.isFinite(race.distanceKm) || race.distanceKm <= 0) return null;
  const raceDay = dayIndex(race.date);
  if (!Number.isFinite(raceDay)) return null;
  const min = race.distanceKm * RACE_RUN_MIN_FRACTION;
  let best: PlanRun | null = null;
  for (const r of runs) {
    if (!Number.isFinite(r.km) || r.km < min) continue;
    const off = Math.abs(dayIndex(r.day) - raceDay);
    if (!(off <= 1)) continue;
    // Race day beats a neighbouring day; then the longer run.
    const better = best == null
      || (r.day === race.date && best.day !== race.date)
      || ((r.day === race.date) === (best.day === race.date) && r.km > best.km);
    if (better) best = r;
  }
  return best;
}

function buildCtx(input: EnduranceWeekPlanInput): PlanCtx {
  const units = input.unitsPerKm != null && Number.isFinite(input.unitsPerKm) && input.unitsPerKm > 0 ? input.unitsPerKm : 1;
  const runs = input.runs
    .filter(r => Number.isFinite(r.km) && r.km > 0 && DAY_RE.test(r.day) && r.day <= input.today)
    .map(r => ({ day: r.day, km: r.km, durationMin: r.durationMin ?? null }));
  let first: string | null = null;
  for (const r of runs) if (first == null || r.day < first) first = r.day;
  const raceDate = input.race?.date && DAY_RE.test(input.race.date) ? input.race.date : null;
  const rk = input.race?.distanceKm;
  return {
    runs,
    today: input.today,
    units,
    goalKm: input.goalKm,
    raceDate,
    raceKm: rk != null && Number.isFinite(rk) && rk > 0 ? rk : null,
    peakKm: input.racePeakWeekKm != null && Number.isFinite(input.racePeakWeekKm) && input.racePeakWeekKm > 0 ? input.racePeakWeekKm : null,
    goalStartDay: input.goalStartDay ?? null,
    longRunOverride: input.longRun != null && Number.isFinite(input.longRun.lastKm) && input.longRun.lastKm > 0
      ? { lastKm: input.longRun.lastKm, peakKm: input.longRun.peakKm ?? null, targetPeakKm: input.longRun.targetPeakKm ?? null }
      : null,
    peakInfo: longRunPeakTarget(rk != null && Number.isFinite(rk) && rk > 0 ? rk : null, input.goalKm, units),
    firstRunWeek: first == null ? null : mondayOfDay(first),
    kmCache: new Map(),
  };
}

/** Running km and run days of the Mon–Sun week at `w`; the race itself (any run on race day) is not training volume. */
function weekRuns(ctx: PlanCtx, w: string): { km: number; days: number } {
  const hit = ctx.kmCache.get(w);
  if (hit) return hit;
  const end = addDayKey(w, 6);
  let km = 0;
  const days = new Set<string>();
  for (const r of ctx.runs) {
    if (r.day < w || r.day > end) continue;
    if (ctx.raceDate != null && r.day === ctx.raceDate) continue;
    km += r.km;
    days.add(r.day);
  }
  const out = { km, days: days.size };
  ctx.kmCache.set(w, out);
  return out;
}

function phaseAt(ctx: PlanCtx, w: string): RacePhaseInfo | null {
  return ctx.raceDate ? racePhaseInfo(ctx.raceDate, w, ctx.raceKm) : null;
}

function isWindWeek(ctx: PlanCtx, w: string): boolean {
  return isWindDownPhase(phaseAt(ctx, w)?.phase);
}

/**
 * Weekly km (newest first) of up to `n` TRAINING weeks strictly before `before`
 * — taper, race and recovery weeks are planned easy weeks, not training weeks —
 * from the first week with a run on. A week with no runs counts as 0 km.
 */
function trainingWeeksBefore(ctx: PlanCtx, before: string, n: number): number[] {
  const out: number[] = [];
  if (ctx.firstRunWeek == null) return out;
  for (let k = 1; k <= MAX_LOOKBACK_WEEKS && out.length < n; k++) {
    const w = addDayKey(before, -7 * k);
    if (w < ctx.firstRunWeek) break;
    if (isWindWeek(ctx, w)) continue;
    out.push(weekRuns(ctx, w).km);
  }
  return out;
}

function trainingAvg(ctx: PlanCtx, w: string): number | null {
  const kms = trainingWeeksBefore(ctx, w, MEDIAN_WEEKS);
  return kms.length === 0 ? null : round1(kms.reduce((a, b) => a + b, 0) / kms.length);
}

/**
 * Restart target: `fraction` of the median weekly km (a 0-run week counts; 60% for a very light week, 75% / 55% by
 * the length of the gap, see `restartFractionFor`), never under 35% of the median of the weeks that had runs.
 * Rounded in the display unit (0.5 mi for miles).
 */
function restartTargetKm(ctx: PlanCtx, windowKm: number[], fraction: number): { km: number; medianKm: number } {
  const zeroInclusive = median(windowKm);
  const withRuns = median(windowKm.filter(v => v >= MIN_BASE_WEEK));
  const medianKm = zeroInclusive ?? ctx.goalKm * 0.5;
  const base = Math.max(fraction * medianKm, 0.35 * (withRuns ?? medianKm));
  return { km: Math.min(ctx.goalKm, roundWeekTargetKm(base, ctx.units)), medianKm };
}

/**
 * How much of the pre-break median a restart asks for, by the length of the gap in days: up to 7 days is one skipped
 * step ('hold': last week's target stands), 8-14 days ~75%, more than 14 days ~55%. No gap (a very light week that
 * was not a gap) restarts at the plain 60%.
 */
function restartFractionFor(gapDays: number | null): number | 'hold' {
  if (gapDays == null) return RESTART_FRACTION;
  if (gapDays <= RESTART_HOLD_GAP_DAYS) return 'hold';
  return gapDays <= RESTART_LONG_GAP_DAYS ? RESTART_MID_FRACTION : RESTART_LONG_FRACTION;
}

/**
 * Days without a run that count as a break: 5, or 1.5 x the runner's typical gap
 * between run days over the 4 weeks before the week when that is longer — a
 * runner who runs once a week is not "on a break" every Friday. Needs 2 run days
 * to know the rhythm; fewer fall back to 5.
 */
export function breakThreshold(runs: ReadonlyArray<PlanRun>, weekStart: string, minDays = BREAK_DAYS): number {
  const from = addDayKey(weekStart, -28);
  const days = [...new Set(runs.filter(r => r.day >= from && r.day < weekStart).map(r => r.day))].sort();
  if (days.length < 2) return minDays;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(dayIndex(days[i]) - dayIndex(days[i - 1]));
  const typical = median(gaps) ?? 1;
  return Math.max(minDays, Math.ceil(typical * BREAK_GAP_FACTOR));
}

/**
 * The length (days) of a gap of `threshold`+ days between runs (or since the last run) that reaches into the week at
 * `w` — one that started before it; null when there is none.
 */
function breakGapDays(ctx: PlanCtx, w: string, asOf: string, threshold: number): number | null {
  const lastBefore = lastRunBefore(ctx, w);
  if (lastBefore == null) return null;
  let firstIn: string | null = null;
  const end = addDayKey(w, 6);
  for (const r of ctx.runs) if (r.day >= w && r.day <= end && (firstIn == null || r.day < firstIn)) firstIn = r.day;
  // Two earlier run days in the 4 weeks are needed to know the runner's rhythm; a new runner's first gap is no "break".
  const from = addDayKey(w, -28);
  if (new Set(ctx.runs.filter(r => r.day >= from && r.day < w).map(r => r.day)).size < 2) return null;
  const e = firstIn ?? (asOf < end ? asOf : end);
  if (e < w) return null;
  const gap = dayIndex(e) - dayIndex(lastBefore);
  return gap >= threshold ? gap : null;
}

/** The last run day before `w`; null without one. */
function lastRunBefore(ctx: PlanCtx, w: string): string | null {
  let last: string | null = null;
  for (const r of ctx.runs) if (r.day < w && (last == null || r.day > last)) last = r.day;
  return last;
}

/** The longest run (km) in the Mon-Sun week at `w`, the race itself left out; null when there was none. */
function longestRunIn(ctx: PlanCtx, w: string): number | null {
  const end = addDayKey(w, 6);
  let best: number | null = null;
  for (const r of ctx.runs) {
    if (r.day < w || r.day > end) continue;
    if (ctx.raceDate != null && r.day === ctx.raceDate) continue;
    if (best == null || r.km > best) best = r.km;
  }
  return best == null ? null : round1(best);
}

/**
 * The longest run of the last 14 days (`lastKm`: what the next long run grows
 * from) and of the last 28 days (`peakKm`), as of `today`. The race itself (a
 * run on race day) is not a training long run. Null when there was none.
 */
export function longRunStats(
  runs: ReadonlyArray<PlanRun>,
  today: string,
  raceDate?: string | null,
): { lastKm: number | null; peakKm: number | null } {
  let last: number | null = null;
  let peak: number | null = null;
  for (const r of runs) {
    if (!Number.isFinite(r.km) || r.km <= 0) continue;
    if (raceDate != null && r.day === raceDate) continue;
    const age = dayIndex(today) - dayIndex(r.day);
    if (!(age >= 0)) continue;
    if (age < 28 && (peak == null || r.km > peak)) peak = r.km;
    if (age < 14 && (last == null || r.km > last)) last = r.km;
  }
  return { lastKm: last == null ? null : round1(last), peakKm: peak == null ? null : round1(peak) };
}

/** How a week's grade bars are set: a normal week, a gentle comeback / rebuild week, or a restart week. */
type BandMode = 'normal' | 'gentle' | 'restart';

function bandFor(targetKm: number | null, ctx: PlanCtx, medianKm: number | null, wind: EnduranceWeekPlan['wind'], mode: BandMode): PlanBand {
  if (targetKm == null) return { goodFromKm: 0, mixedFromKm: 0, overKm: null };
  if (wind) {
    if (wind.phase === 'taper') {
      const minExcessKm = (ctx.units < 1 ? TAPER_OVER_MIN_EXCESS_MI : TAPER_OVER_MIN_EXCESS_KM) / ctx.units;
      return {
        goodFromKm: round1(targetKm * TAPER_GOOD_MIN_FRACTION),
        mixedFromKm: 0,
        overKm: round1(Math.max(targetKm * (1 + TAPER_OVER_FRACTION), targetKm + minExcessKm)),
      };
    }
    return { goodFromKm: 0, mixedFromKm: 0, overKm: round1(targetKm * PHASE_CEILING_TOLERANCE) };
  }
  const good = mode === 'restart' ? RESTART_GOOD_FRACTION : mode === 'gentle' ? REBUILD_GOOD_FRACTION : GOOD_FRACTION;
  const mixed = mode === 'restart' ? RESTART_MIXED_FRACTION : mode === 'gentle' ? REBUILD_MIXED_FRACTION : MIXED_FRACTION;
  let over: number | null = targetKm < ctx.goalKm ? spikeEdgeKm(targetKm, ctx.units) : null;
  // Regaining volume up to the median of the weeks before the break is never a spike.
  if (over != null && medianKm != null) over = Math.max(over, round1(medianKm));
  return { goodFromKm: round1(targetKm * good), mixedFromKm: round1(targetKm * mixed), overKm: over };
}

/**
 * The next long run (km) for a plan: min(last + 2 km, the peak target), never
 * above half of the week's target (40% in a restart week; unless the last long
 * run was already above that, then it is held), rounded to 0.5 of the display
 * unit. A hold week keeps the last one; a taper week runs about two thirds of
 * the peak long run; race and recovery weeks have none. `heldKm` (last week's
 * long run jumped over its plan) holds the long run there instead of growing it.
 */
function nextLongRun(
  ctx: PlanCtx,
  kind: EnduranceWeekKind,
  targetKm: number | null,
  lr: { lastKm: number | null; peakKm: number | null; targetPeakKm: number | null },
  restarting: boolean,
  heldKm: number | null,
): number | null {
  switch (kind) {
    case 'baseline':
    case 'race_week':
    case 'recovery':
      return null;
    case 'taper':
      return lr.peakKm == null ? null : roundLongRunKm(lr.peakKm * TAPER_LONG_RUN_SHARE, ctx.units);
    case 'hold':
      return lr.lastKm == null ? null : roundLongRunKm(lr.lastKm, ctx.units);
    default: {
      if (lr.lastKm == null || targetKm == null) return null;
      if (heldKm != null && !restarting) return roundLongRunKm(heldKm, ctx.units);
      const next = longRunStepKm(lr.lastKm, lr.targetPeakKm);
      // A restart week starts the long run again from the recent longest, but never past 40% of the (gentle) restart week.
      const cap = restarting ? targetKm * LONG_RUN_RESTART_WEEK_SHARE : Math.max(targetKm * LONG_RUN_MAX_WEEK_SHARE, lr.lastKm);
      // A long run held down by the cap rounds down to the half unit, so it never ends up above its share of the week.
      return next > cap ? floorLongRunKm(cap, ctx.units) : roundLongRunKm(next, ctx.units);
    }
  }
}

/** The line a race eve reads: the day before the race is for rest, not for the week's leftover budget. */
export const RACE_EVE_LINE = 'Race tomorrow — rest or a 15-min shakeout; lay out your kit';

/** One line of "what this week is for" (units-aware, U+00A0 between a number and its unit). */
function purposeLine(plan: Omit<EnduranceWeekPlan, 'purpose'>): string {
  const u = plan.unitsPerKm;
  const t = plan.targetKm;
  const lr = plan.longRunKm;
  const lrWord = lr != null ? longRunWord(lr, u) : 'long run';
  const held = plan.longRunJump != null ? " (held after last week's jump)" : '';
  const lrPart = lr != null ? `${lrWord} ${formatTargetLongRun(lr, u)}${held}` : null;
  switch (plan.kind) {
    case 'baseline':
      return "Baseline week: run as you normally would; next week's step is built from this week";
    case 'build': {
      const back = plan.comeback != null ? `; back toward your usual ~${formatKm(plan.comeback.medianKm, u)}` : '';
      return lrPart && t != null
        ? `~${formatKm(t, u)} this week: ${lrPart}, the rest easy runs${back}`
        : `~${formatKm(t ?? plan.goalKm, u)} this week, mostly easy runs${back}`;
    }
    case 'maintain': {
      // A runner who has never run the weekly goal is still building to it, not holding it.
      const verb = plan.goalReachedBefore ? 'Hold' : 'Build to';
      return lrPart ? `${verb} ${formatKm(plan.goalKm, u)} this week: ${lrPart}, the rest easy` : `${verb} ${formatKm(plan.goalKm, u)} this week, the rest of the runs easy`;
    }
    case 'hold':
      return `Hold ~${formatKm(t ?? plan.goalKm, u)} this week, no step up after last week's jump${lrPart ? `; keep the ${lrPart}` : ''}`;
    case 'restart':
      return `Restart at ~${formatKm(t ?? plan.restartKm, u)} this week with easy runs${lrPart ? `; ${lrPart}` : ''}`;
    case 'rebuild': {
      const atGoal = t != null && t >= plan.goalKm - 1e-9;
      return `Rebuilding: ~${formatKm(t ?? plan.goalKm, u)} this week, easy runs${atGoal ? '' : ', then add about 10% a week'}`;
    }
    case 'taper': {
      const race = lrPart ? `${lrPart} easy, plus 3×${u < 1 ? '0.5' : '1'} ${distanceUnit(u)} at race pace midweek` : `3×${u < 1 ? '0.5' : '1'} ${distanceUnit(u)} at race pace midweek, the rest easy`;
      return `Taper: ~${formatKm(t ?? plan.goalKm, u)} this week, cut the volume; ${race}`;
    }
    case 'race_week': {
      // The plan's phase is read on the week's Monday; what today is for depends on TODAY's distance to the race.
      const toGo = plan.raceDaysToGo;
      if (toGo === 0) return 'Race day: warm up easy and start relaxed';
      if (toGo === 1) return RACE_EVE_LINE;
      if (toGo != null && toGo < 0) return `Recovery: easy only this week (~${formatKm(t ?? plan.goalKm, u)} max)`;
      return 'Race week: short easy runs, rest 1–2 days before the race';
    }
    case 'recovery':
      return `Recovery: easy only this week (~${formatKm(t ?? plan.goalKm, u)} max)`;
  }
}

/**
 * One step up from a week's TARGET as the card and the review showed it (rounded in the display unit: a 4.97 mi
 * target was shown as "~5 mi", so the hold after a jump is 6 mi, not 5): `weekStepTarget` in the display unit,
 * the weekly goal itself when the step reaches it.
 */
function stepFromShownTarget(targetKm: number, goalKm: number, units: number): number {
  const shown = Math.round(targetKm * units * 10) / 10;
  const next = weekStepTarget(shown, goalKm * units);
  if (next == null) return targetKm;
  return next >= goalKm * units - 1e-9 ? goalKm : Math.round((next / units) * 10) / 10;
}

/** True when a training week before `w` (up to the lookback) ran at least the weekly goal. */
function goalReachedBefore(ctx: PlanCtx, w: string): boolean {
  if (ctx.firstRunWeek == null) return false;
  for (let k = 1; k <= MAX_LOOKBACK_WEEKS; k++) {
    const wk = addDayKey(w, -7 * k);
    if (wk < ctx.firstRunWeek) break;
    if (isWindWeek(ctx, wk)) continue;
    if (weekRuns(ctx, wk).km >= ctx.goalKm - 0.05) return true;
  }
  return false;
}

/** The next comeback rung (share of the pre-break median) above the one used the week before. */
function nextRung(fraction: number): number {
  for (const rung of COMEBACK_RUNGS) if (rung > fraction + 1e-9) return rung;
  return COMEBACK_RUNGS[COMEBACK_RUNGS.length - 1];
}

/** `km` rounded UP in the display unit (whole km, 0.5 mi). */
function ceilWeekTargetKm(km: number, units: number): number {
  const step = units < 1 ? 0.5 : 1;
  return Math.round((Math.ceil((km * units) / step - 1e-9) * step / units) * 10) / 10;
}

function planWeek(ctx: PlanCtx, w: string, depth: number): EnduranceWeekPlan {
  const info = phaseAt(ctx, w);
  const prevStart = addDayKey(w, -7);
  const asOf = ctx.today < addDayKey(w, 6) ? ctx.today : addDayKey(w, 6);
  const peakInfo = info != null && info.phase === 'build' ? ctx.peakInfo : null;
  const targetPeak = peakInfo?.peakKm ?? null;
  // The long-run target is read from the 14 / 28 days BEFORE the week, so it stands all week (the
  // card on a Sunday, after the long run is done, still shows the week's target, not next week's).
  const derived = longRunStats(ctx.runs, addDayKey(w, -1), ctx.raceDate);
  // An explicit long-run reading belongs to the week asked for (depth 0), not to the weeks it is graded against.
  const lr0 = ctx.longRunOverride != null && depth === 0
    ? { lastKm: ctx.longRunOverride.lastKm, peakKm: ctx.longRunOverride.peakKm ?? ctx.longRunOverride.lastKm, targetPeakKm: ctx.longRunOverride.targetPeakKm }
    : { ...derived, targetPeakKm: targetPeak };

  // Days since the last run (as of today, or the week's last day for a past week).
  let lastRunDay: string | null = null;
  for (const r of ctx.runs) if (r.day <= asOf && (lastRunDay == null || r.day > lastRunDay)) lastRunDay = r.day;
  const daysSinceRun = lastRunDay == null ? null : dayIndex(asOf) - dayIndex(lastRunDay);
  const raceDaysToGo = ctx.raceDate != null ? dayIndex(ctx.raceDate) - dayIndex(asOf) : null;

  const prev = weekRuns(ctx, prevStart);
  const prevPrev = weekRuns(ctx, addDayKey(w, -14));
  const compareMin = ctx.units < 1 ? MIN_COMPARE_BASE_MI / ctx.units : MIN_COMPARE_BASE_KM;
  const wind = info != null && isWindDownPhase(info.phase) ? info : null;
  // Rest is the plan in a taper / race / recovery week: never a break.
  const breakAt = breakThreshold(ctx.runs, w);
  const onBreak = wind == null && daysSinceRun != null && daysSinceRun >= breakAt;
  const endedOff = wind == null && daysSinceRun != null && daysSinceRun >= breakThreshold(ctx.runs, w, SHORT_WEEK_REST_DAYS);

  // The windows the restart median is read from.
  const prevIsTraining = !isWindWeek(ctx, prevStart);
  const beforeWindow = prevIsTraining ? trainingWeeksBefore(ctx, prevStart, MEDIAN_WEEKS) : trainingWeeksBefore(ctx, w, MEDIAN_WEEKS);
  const breakWindow = trainingWeeksBefore(ctx, w, MEDIAN_WEEKS);

  // Last finished week, graded by its own plan.
  const prevPlan = depth < MAX_PLAN_DEPTH ? planWeek(ctx, prevStart, depth + 1) : null;
  const hasPrior = ctx.runs.some(r => r.day < w);
  const prevGrade = prevPlan != null && hasPrior ? gradeEnduranceWeek(prevPlan, prev.km, { runDays: prev.days, unitsPerKm: ctx.units }) : null;
  const last: PlanLastWeek | null = hasPrior && ctx.runs.some(r => r.day >= prevStart && r.day < w)
    ? {
        weekStart: prevStart,
        km: round1(prev.km),
        runDays: prev.days,
        kind: prevPlan?.kind ?? 'build',
        targetKm: prevPlan?.targetKm ?? null,
        grade: prevGrade,
        // No % against a very small week, nor for the week that restarted after a break (that +150% is not growth).
        changePct: prevPrev.km >= compareMin && prevPlan?.restart == null && prevGrade?.level !== 'light'
          ? Math.round(((prev.km - prevPrev.km) / prevPrev.km) * 100)
          : null,
      }
    : null;

  // The restart target quoted to a runner who is on a break: by the length of the gap so far.
  const holdKm = prevPlan?.targetKm ?? null;
  const restartFor = (windowKm: number[], gapDays: number | null): { km: number; medianKm: number; fraction: number } => {
    const f = restartFractionFor(gapDays);
    if (f === 'hold' && holdKm != null) {
      const medianKm = median(windowKm) ?? ctx.goalKm * 0.5;
      return { km: Math.min(ctx.goalKm, holdKm), medianKm, fraction: medianKm > 0 ? Math.min(ctx.goalKm, holdKm) / medianKm : 1 };
    }
    const fraction = f === 'hold' ? RESTART_MID_FRACTION : f;
    return { ...restartTargetKm(ctx, windowKm, fraction), fraction };
  };
  const trailingGap = daysSinceRun;
  const breakRestart = restartFor(breakWindow, onBreak ? trailingGap : null);

  let kind: EnduranceWeekKind;
  let targetKm: number | null;
  let restart: EnduranceWeekPlan['restart'] = null;
  let comeback: EnduranceWeekPlan['comeback'] = null;
  let hold: EnduranceWeekPlan['hold'] = null;
  let rebuild: EnduranceWeekPlan['rebuild'] = null;
  let medianKm: number | null = null;
  let mode: BandMode = 'normal';

  const daysAfterRace = ctx.raceDate != null ? dayIndex(w) - dayIndex(ctx.raceDate) : null;
  const goalRestarted = ctx.goalStartDay != null && ctx.raceDate != null && ctx.goalStartDay > addDayKey(ctx.raceDate, 1);
  const inRebuild = wind == null && info == null && daysAfterRace != null && daysAfterRace > 0 && daysAfterRace <= REBUILD_DAYS && !goalRestarted;

  if (wind) {
    const peak = ctx.peakKm ?? ctx.goalKm;
    kind = wind.phase;
    targetKm = racePhaseTargetKm(wind, peak, { weeklyGoalKm: ctx.goalKm, unitsPerKm: ctx.units });
  } else if (!hasPrior) {
    kind = 'baseline';
    targetKm = null;
  } else {
    if (inRebuild) rebuild = { daysSince: daysAfterRace as number };
    let triggered: { reason: 'break' | 'low_week' | 'no_runs'; target: { km: number; medianKm: number; fraction: number }; gapDays: number | null } | null = null;
    if (prev.km < MIN_BASE_WEEK) {
      // An empty week: the gap runs from the last run before it (an almost-empty week still counts as 8+ days).
      const before = lastRunBefore(ctx, w);
      const gap = before == null ? null : Math.max(RESTART_HOLD_GAP_DAYS + 1, dayIndex(w) - dayIndex(before));
      triggered = { reason: 'no_runs', target: restartFor(beforeWindow, gap), gapDays: gap };
    } else if (prevIsTraining && beforeWindow.length >= 2) {
      const m = median(beforeWindow);
      if (m != null && m >= compareMin && prev.km < RESTART_LOW_WEEK_FRACTION * m) {
        // A very light week without a long gap in it: the plain restart share of the median.
        triggered = { reason: 'low_week', target: { ...restartTargetKm(ctx, beforeWindow, RESTART_FRACTION), fraction: RESTART_FRACTION }, gapDays: null };
      }
    }
    if (!triggered && prevIsTraining) {
      const gap = breakGapDays(ctx, w, asOf, breakAt);
      if (gap != null) triggered = { reason: 'break', target: restartFor(breakWindow, gap), gapDays: gap };
    }

    if (triggered) {
      let restartKm = triggered.target.km;
      // A break noticed mid-week never shrinks the week's target below what the week has already run.
      if (triggered.reason === 'break') {
        const buildStep = weekStepOrGoalKm(prev.km, ctx.goalKm, ctx.units);
        const done = weekRuns(ctx, w).km;
        if (done > restartKm) restartKm = Math.min(buildStep, ceilWeekTargetKm(done, ctx.units));
      }
      restart = { reason: triggered.reason, medianKm: round1(triggered.target.medianKm), fraction: triggered.target.fraction, gapDays: triggered.gapDays };
      medianKm = triggered.target.medianKm;
      kind = rebuild ? 'rebuild' : 'restart';
      targetKm = restartKm;
      mode = 'restart';
    } else if (prevPlan != null && prevIsTraining && prevPlan.targetKm != null && prevGrade?.gap === 'spike') {
      hold = { spikeKm: round1(prev.km), spikeStepKm: prevPlan.targetKm };
      kind = 'hold';
      targetKm = stepFromShownTarget(prevPlan.targetKm, ctx.goalKm, ctx.units);
    } else {
      // Build: ~10% over last week — and, for up to three weeks after a restart, at least the next rung of the climb
      // back to the pre-break median (restart -> 80% -> 100%), a rung only when the week before graded good.
      const step = weekStepOrGoalKm(prev.km, ctx.goalKm, ctx.units);
      let target = step;
      const from = prevPlan != null && prevIsTraining ? (prevPlan.restart != null ? { ...prevPlan.restart, weeksSince: 0 } : prevPlan.comeback) : null;
      if (from != null && from.weeksSince + 1 <= COMEBACK_WEEKS) {
        const rung = prevGrade?.level === 'good' ? nextRung(from.fraction) : from.fraction;
        target = Math.min(ctx.goalKm, Math.max(step, roundWeekTargetKm(from.medianKm * rung, ctx.units)));
        comeback = { medianKm: from.medianKm, fraction: rung, weeksSince: from.weeksSince + 1 };
        medianKm = from.medianKm;
      }
      if (rebuild || comeback != null) mode = 'gentle';
      targetKm = target;
      kind = rebuild ? 'rebuild' : target >= ctx.goalKm ? 'maintain' : 'build';
    }
  }

  // Last week's long run ran 2 km or more over its plan AND grew by more than the +2 km rule allows over the long run
  // before it: hold the long run there rather than grow it again. (A runner creeping past a lowered peak by a km a week
  // is not jumping.)
  let longRunJump: EnduranceWeekPlan['longRunJump'] = null;
  const plannedPrevLong = prevPlan?.longRunKm ?? null;
  const beforePrevLong = prevPlan?.longRun.lastKm ?? null;
  const prevLong = longestRunIn(ctx, prevStart);
  if (
    wind == null && restart == null && hold == null && plannedPrevLong != null && prevLong != null && beforePrevLong != null
    && isLongRun(prevLong, ctx.units)
    && prevLong >= plannedPrevLong + LONG_RUN_MAX_STEP_KM - 1e-9
    && prevLong > beforePrevLong + LONG_RUN_MAX_STEP_KM + 1e-9
  ) {
    const heldKm = lr0.targetPeakKm != null ? Math.min(prevLong, lr0.targetPeakKm) : prevLong;
    longRunJump = { actualKm: prevLong, plannedKm: plannedPrevLong, heldKm };
  }

  const longRun: PlanLongRun = {
    ...lr0,
    raceTargetKm: lr0.targetPeakKm != null && peakInfo != null && lr0.targetPeakKm === peakInfo.peakKm ? peakInfo.raceTargetKm : null,
    nextKm: nextLongRun(ctx, kind, targetKm, lr0, restart != null, longRunJump?.heldKm ?? null),
  };
  const windInfo: EnduranceWeekPlan['wind'] = wind ? { phase: wind.phase as 'taper' | 'race_week' | 'recovery', info: wind, peakKm: ctx.peakKm ?? ctx.goalKm } : null;
  const band = bandFor(targetKm, ctx, medianKm, windInfo, mode);
  const stepPct = targetKm != null && hasPrior && prev.km >= compareMin && !wind
    ? Math.round(((targetKm - prev.km) / prev.km) * 100)
    : null;
  const base: Omit<EnduranceWeekPlan, 'purpose'> = {
    kind,
    weekStart: w,
    goalKm: ctx.goalKm,
    targetKm,
    longRunKm: longRun.nextKm,
    longRun,
    band,
    last,
    avg4wKm: trainingAvg(ctx, w),
    daysSinceRun,
    onBreak,
    endedOff,
    restart,
    comeback,
    restartKm: kind === 'restart' && targetKm != null ? targetKm : breakRestart.km,
    longRunJump,
    goalReachedBefore: goalReachedBefore(ctx, w),
    raceDaysToGo,
    stepPct,
    hold,
    wind: windInfo,
    rebuild,
    unitsPerKm: ctx.units,
  };
  return { ...base, purpose: purposeLine(base) };
}

/**
 * The plan for the calendar week starting `weekStart` (a Monday): ONE answer to
 * "what is this week for?" for the card, the weekly review, the coach lines and
 * the opener. Pure; `runs` may hold any history (the plan looks back ~16 weeks
 * and treats a week with no runs as 0 km once the first run was logged).
 *
 * The kind (and so the target) depends only on running BEFORE the week, on the
 * race phase read on the week's Monday and, for a restart, on a 7-day gap that
 * reaches into the week — never on how the week itself is going (a break
 * noticed mid-week never takes the target below what the week has run), so the
 * card and the review always name the same week:
 *  - baseline: no earlier run at all — nothing to take a step from;
 *  - taper / race_week / recovery: the race phase, a share of the peak week;
 *  - rebuild: after recovery, up to 42 days after the race;
 *  - restart: last week had no run or under half the median of the 4 weeks before
 *    it, or a 7+ day break reaches into the week. The cut scales with the gap:
 *    up to 7 days holds last week's target (one skipped step), 8-14 days is ~75%
 *    of the pre-break median, over 14 days ~55%; a very light week without a long
 *    gap restarts at ~60%. The restart week's long run is at most 40% of it;
 *  - comeback: for up to 3 weeks after a restart the target is at least the next
 *    rung of the climb back (restart -> 80% -> 100% of the pre-break median),
 *    a rung only after a good week, never past the goal;
 *  - hold: last week was a spike (30% and 3 km over its step): one step up from
 *    the step it should have been, never from the spike;
 *  - build: ~10% over last week (`weekStepOrGoalKm`), below the goal;
 *  - maintain: the step reaches the weekly goal.
 */
export function enduranceWeekPlan(input: EnduranceWeekPlanInput): EnduranceWeekPlan {
  return planWeek(buildCtx(input), input.weekStart, 0);
}

/**
 * Grade `km` of running in a week against its plan's band. `runDays` is the
 * week's run-day count (a baseline week is graded on consistency: 3+ runs is
 * good, never tough). A week with no running at all is 'light' (rest is fine),
 * and so is a short week that ended in days off (the plan's `endedOff`).
 * Wind-down weeks use the shared `windDownBand`.
 */
export function gradeEnduranceWeek(
  plan: Pick<EnduranceWeekPlan, 'kind' | 'targetKm' | 'band' | 'endedOff' | 'restart' | 'goalKm'>,
  km: number,
  opts: { runDays?: number; unitsPerKm?: number } = {},
): WeekGrade {
  const units = opts.unitsPerKm ?? 1;
  const phase = plan.kind;
  if (phase === 'taper' || phase === 'race_week' || phase === 'recovery') {
    if (plan.targetKm == null) return { level: 'good', gap: null };
    const band = windDownBand(phase, km, plan.targetKm, { unitsPerKm: units });
    return band === 'within' ? { level: 'good', gap: null } : { level: 'mixed', gap: band };
  }
  if (km <= 0) return { level: 'light', gap: null };
  if (plan.kind === 'baseline') {
    return (opts.runDays ?? 0) >= 3 ? { level: 'good', gap: null } : { level: 'mixed', gap: 'short' };
  }
  const target = plan.targetKm as number;
  const medianGuard = plan.restart != null ? plan.restart.medianKm : 0;
  if (plan.band.overKm != null && isSpikeWeek(km, target, plan.goalKm, units) && km > medianGuard) {
    return { level: 'mixed', gap: 'spike' };
  }
  if (km >= plan.band.goodFromKm - 1e-9) return { level: 'good', gap: null };
  // A short week that ended in days off (illness, travel) is a lighter week, not a failure.
  if (plan.endedOff) return { level: 'light', gap: null };
  return km >= plan.band.mixedFromKm - 1e-9 ? { level: 'mixed', gap: 'short' } : { level: 'tough', gap: 'short' };
}

/** True for the three race-lifecycle week kinds. */
export function isWindDownKind(kind: EnduranceWeekKind): kind is 'taper' | 'race_week' | 'recovery' {
  return kind === 'taper' || kind === 'race_week' || kind === 'recovery';
}

/** Running km of the Mon–Sun week at `weekStart` the way the plan counts it (a run on race day is the race, not training). */
export function planWeekKm(
  runs: ReadonlyArray<PlanRun>,
  weekStart: string,
  raceDate?: string | null,
): { km: number; days: number } {
  const end = addDayKey(weekStart, 6);
  let km = 0;
  const days = new Set<string>();
  for (const r of runs) {
    if (!Number.isFinite(r.km) || r.km <= 0 || r.day < weekStart || r.day > end) continue;
    if (raceDate != null && r.day === raceDate) continue;
    km += r.km;
    days.add(r.day);
  }
  return { km, days: days.size };
}
