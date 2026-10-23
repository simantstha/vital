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
 * Wave 21e additions to the same plan (so the card, the review and the coach never disagree): every 4th calendar week
 * of plain building is a CUTBACK (~80% of the week it replaces, long run held but never past half of the lowered week, graded as its own target and never
 * "short"); the last 2 build weeks before a taper add a few strides; a week read DURING the week with 4+ days off (or,
 * from Friday, well behind its own pace) is a LIGHT week (don't make it up, capped long run); a careful comeback's
 * target is a ceiling ("up to", capped at 1.25x the week just run) graded against the week before it; a restart "hold"
 * never exceeds 0.75x the pre-break median and, on the week's last day, is next week's number; recovery ceilings round
 * UP so km and mi agree; the long-run cap note is due in the goal's first week and then every 4th; a long run that was
 * over 55% of its week gets one watch note and is never praised as a good peak.
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
 * least 1 unit; a recovery ceiling rounds UP (so km and mi ceilings agree). A
 * `weeklyGoalKm` caps the result: a wind-down week never asks for more than the
 * stated weekly goal.
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
  // A recovery ceiling rounds UP in the display unit (whole km, 0.5 mi): the metric and imperial ceilings then agree
  // (11.3 km is "12 km" and "7.5 mi"), and a runner who sits at the raw share is never over a rounded-down ceiling.
  const km = info.phase === 'recovery'
    ? Math.max(ceilWeekTargetKm(peakWeekKm * fraction, units), roundWeekTargetKm(0, units))
    : roundWeekTargetKm(peakWeekKm * fraction, units);
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

/** How a comeback week's km sat against its "up to" ceiling (C): inside the 10% slack, "a touch over" (fine), or "well over" (a spike). */
export type CapRead = 'within' | 'touch' | 'well';

/**
 * A careful comeback's "up to ~18 km" target is a ceiling (C), and the km run (A) are read against it (wave 22e):
 *  - A <= 1.10 x C is within it (on plan);
 *  - over that, and still at most 1.25 x C (or under 3 km / 2 mi over it) and not past the pre-break median (B): "a touch over" -
 *    said once, neutral, "fine";
 *  - A > 1.25 x C (and 3 km / 2 mi over it), or past B: "well over" - a spike, even below the pre-break median.
 * Takes the plan of the week that was run and its km. A plan without a ceiling (`upTo`), or one whose ceiling is the weekly goal
 * itself (going past the goal is just a hit target), is always `within`.
 */
export function comebackCapRead(
  plan: Pick<EnduranceWeekPlan, 'upTo' | 'targetKm' | 'goalKm'> & { comeback?: { medianKm: number } | null },
  km: number,
  unitsPerKm = 1,
): CapRead {
  if (!plan.upTo || plan.targetKm == null || plan.targetKm >= plan.goalKm - 1e-9) return 'within';
  const ceiling = plan.targetKm;
  if (km <= ceiling * PHASE_CEILING_TOLERANCE + 1e-9) return 'within';
  const minExcessKm = (unitsPerKm < 1 ? SPIKE_MIN_EXCESS_MI : SPIKE_MIN_EXCESS_KM) / unitsPerKm;
  const big = km > ceiling * COMEBACK_MAX_GROWTH + 1e-9 && km - ceiling >= minExcessKm - 1e-9;
  const median = plan.comeback?.medianKm ?? null;
  return big || (median != null && km > median + 1e-9) ? 'well' : 'touch';
}

/** True when a comeback week went more than 10% over its "up to" ceiling (`comebackCapRead` is not `within`). */
export function overUpToCap(plan: Pick<EnduranceWeekPlan, 'upTo' | 'targetKm' | 'goalKm'> & { comeback?: { medianKm: number } | null }, km: number, unitsPerKm = 1): boolean {
  return comebackCapRead(plan, km, unitsPerKm) !== 'within';
}

/** The wording of an over-the-ceiling week, ONE phrase for the goal card, the weekly review and the coach: "a touch over, fine" or "well over the ceiling". */
export function overCapPhrase(read: Exclude<CapRead, 'within'>): 'a touch over, fine' | 'well over the ceiling' {
  return read === 'well' ? 'well over the ceiling' : 'a touch over, fine';
}

/** A hold week is kept while it stays within this multiple of its number (and its long run within `HOLD_LONG_RUN_SLACK_KM` of the held one). */
export const HOLD_KEPT_FRACTION = 1.05;
export const HOLD_LONG_RUN_SLACK_KM = 0.5;

/**
 * Wave 23e: a hold week is "on plan" only if it was held - at most 105% of its number and a long run at most 0.5 km over the held one. A hold the
 * runner built through ("28 of ~25 km, long run 12 against 11") is neither on plan nor praised as held. `longestRunKm` is the week's longest run
 * (null = unknown: only the km are judged). The long run the hold asked for is the plan's own, before any trim of the week's last days.
 */
export function holdOverrun(
  plan: Pick<EnduranceWeekPlan, 'kind' | 'targetKm' | 'longRunKm'> & Partial<Pick<EnduranceWeekPlan, 'longRunTrim'>>,
  km: number,
  longestRunKm: number | null,
): boolean {
  if (plan.kind !== 'hold' || plan.targetKm == null) return false;
  if (km > plan.targetKm * HOLD_KEPT_FRACTION + 1e-9) return true;
  const heldLong = plan.longRunTrim?.fullKm ?? plan.longRunKm;
  return longestRunKm != null && heldLong != null && longestRunKm > heldLong + HOLD_LONG_RUN_SLACK_KM + 1e-9;
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
  /** That week was a cutback week (its `targetKm` is the lowered number). */
  cutback: boolean;
  /** That week's target was an "up to" comeback ceiling and the week ran more than 10% over it (`overUpToCap`). */
  overCap: boolean;
  /** ... how far over: 'touch' (fine, said once) or 'well' (a spike; this week holds at that ceiling). Null when within it or it had none. */
  capRead: 'touch' | 'well' | null;
  /** Null at the edge of the history the plan looks back over. */
  grade: WeekGrade | null;
  /** Whole-percent change vs the week before it; null when that week was under 5 km (3 mi) or has no runs. */
  changePct: number | null;
  /** Wave 23e: that week was a hold week and he did not keep it (`holdOverrun`): the card and the review say "above the hold", not "on plan". */
  holdOver: boolean;
  /**
   * Wave 23e: the km `changePct` is measured against - the week before it, or, when THAT week was a cutback, the last full week before the cutback (the
   * base that week's own step was taken from), so the % is ONE number on the card, the coach and the review. Null when `changePct` is.
   */
  changeBaseKm: number | null;
  /** ... and the base is the last full week before a cutback (name it: "+9% on your last full week (23 km)"), not simply the week before. */
  changeAfterCutback: boolean;
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
  /**
   * The cap note ("Your 30 km weeks fit a 15 km long run; for an 18 km peak, raise the goal...") is due this week:
   * only in a build-phase week, the first one of the goal and then every 4th (`CAP_NOTE_EVERY_WEEKS`); never in a
   * taper, race, recovery or rebuild week. Every surface that words the cap note asks this, so none of them nags.
   */
  capNoteDue: boolean;
  /** The long run is held (last week's long run jumped, or the plan asks for no more than the last one), not grown. */
  held: boolean;
  /** The most recent week whose long run was over 55% of its week (build weeks only): one watch note, not one per day. */
  share: LongRunShare | null;
  /** The watch note for `share` is said today: on the Monday after the oversized week only (wave 22e), never on the other days. */
  shareDue: boolean;
  /** The 28-day peak long run was over 55% of its own week: never praised as a good peak. */
  peakOversized: boolean;
  /**
   * The 28-day peak run against the plan (wave 22e): `plannedKm` is the long run its week planned, `sharePct` the share of its week, and
   * `within` is true only when it was at most the plan + 0.5 km (and the peak target + 0.5 km) and at most half of its week - the only
   * peak that is praised ("peak reached"). Null without a run in the last 28 days.
   */
  peakPlan: { plannedKm: number | null; sharePct: number; within: boolean; brokenKm: number | null } | null;
}

/** A week whose long run was most of it. */
export interface LongRunShare {
  weekStart: string;
  /** The long run, km. */
  longKm: number;
  /** The week's running km (a week still under way: the larger of what is run and the week's target). */
  weekKm: number;
  /** Whole percent of the week the long run was. */
  sharePct: number;
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
  /** The day the long-run cap note's cadence counts from (the goal's first week); defaults to `goalStartDay`, then the first run. */
  capNoteAnchorDay?: string | null;
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
  /**
   * Wave 23e: the km this week's ~10% step was taken from: last week, or after a cutback week the bigger of the two weeks before it (the cutback
   * was a pause, not a new base). `stepPct` is measured against it; every surface that quotes the weekly % uses it.
   */
  stepBaseKm: number;
  /** The restart target (km) the card quotes while the runner is on a break; equals `targetKm` in a restart week. */
  restartKm: number;
  /** The restart number is the lower band for a gap of more than two weeks (55% of the pre-break median): the copy says why it is lower. */
  restartLong: boolean;
  /** Last week's long run ran 2 km or more over its plan: this week's long run is held there. */
  longRunJump: { actualKm: number; plannedKm: number; heldKm: number } | null;
  /** True when a training week before this one reached the weekly goal (else a maintain week is still "build to"). */
  goalReachedBefore: boolean;
  /**
   * Wave 23e P3-c: last week itself ran the weekly goal (>= goal - 0.5 km). A maintain week is "Hold 30 km" only when the goal was reached before AND last
   * week was at it; a week after a shorter one (a cutback, a 28 km week) is "Build to 30 km" - never "hold" a number he has not just run.
   */
  lastAtGoal: boolean;
  /**
   * Wave 23e P3-m: a TAPER week whose number is last week's km (within `TAPER_HOLD_SLACK_KM`, either side): it holds the volume, it does not "cut" it. The card,
   * the coach and the review say "hold ~22 km (75% of your ~29 km peak)" instead of "cut the volume" right after a 22 km week.
   */
  taperHold: boolean;
  /** Days from the day the plan is read on (today; the week's last day for a past week) to race day; negative after it; null without a race. */
  raceDaysToGo: number | null;
  /** The actual step over last week in whole percent (this week's target against last week's km); null when last week was too small to compare or there is no target. */
  stepPct: number | null;
  /**
   * Hold week: last week's jump and the target it was graded against (the target its cards showed: a cutback week's is the cutback number).
   * `ceiling` (wave 22e): the jump was a comeback week well over its "up to" ceiling - this week stays AT that ceiling, and `ladder` keeps
   * the climb back to the pre-break median alive for the week after. `skippedCutback` (wave 22e): the jump was a cutback week that ran
   * more than 10% over its lowered number - this week holds at the week the cutback replaced instead of building 10% on the skip.
   */
  hold: { spikeKm: number; spikeStepKm: number; ceiling?: boolean; skippedCutback?: boolean; ladder?: { medianKm: number; fraction: number; weeksSince: number } } | null;
  /** Taper / race week / recovery: the race phase read on this week's Monday and the peak week its target is a share of. */
  wind: { phase: 'taper' | 'race_week' | 'recovery'; info: RacePhaseInfo; peakKm: number } | null;
  /** Rebuild: whole days since race day on this week's Monday. */
  rebuild: { daysSince: number } | null;
  /**
   * Cutback week: every 4th (calendar) week, once 3 plain build / maintain weeks precede it, is a cutback at ~80% of the
   * week it replaces, long run held.
   * `normalKm` is the target the week would have had. `targetKm` is the cutback number and the week is graded against
   * it (never "short"). Null otherwise.
   */
  cutback: { normalKm: number } | null;
  /**
   * Consecutive build weeks up to and including this one: plain build / maintain weeks and (wave 23e) hold weeks - a hold is a pause in the
   * step, not a down week. A cutback, restart, rebuild, comeback rung or wind-down week resets it to 0.
   */
  buildWeeks: number;
  /**
   * Wave 23e: a cutback is OWED - the last cutback week was run as a normal week (a skipped cutback) and no down week has come since. The next
   * cutback fires at the first eligible week after 2 build weeks (the skip-hold counts as one), not at the end of the 4-week cycle.
   */
  cutbackOwed: boolean;
  /** One of the last 2 build weeks before a taper: the plan copy adds `STRIDES_COPY` so race-pace work is not new in the taper. */
  strides: boolean;
  /**
   * A week read DURING the week with 4+ days without a run (or, from Thursday, well behind the runner's own pace with the
   * rest of the target out of reach of the runs still to come): don't make it up. `longRunCapKm` is the most the week's long
   * run should be (~40% of a realistic week, or the last long run). Never in the week before a taper (`preTaper`).
   */
  lightWeek: { reason: 'days_off' | 'late_week'; daysOff: number; longRunCapKm: number | null } | null;
  /**
   * The week BEFORE a taper (or race week): the next Monday's phase is taper / race week. Easing off is fine there, so the
   * light-week rule does not apply; `nextPhase` says what starts tomorrow-ish.
   */
  preTaper: {
    nextPhase: 'taper' | 'race_week';
    /** Wave 23e P3-j: the taper's long run as Monday's plan will show it (65% of the 28-day peak as of this Sunday, including this week's long run); null before race week. */
    taperLongRunKm?: number | null;
  } | null;
  /**
   * A pre-taper week whose target no longer fits in the runs the runner usually has left (or with 4+ days off): "Easing off
   * before your taper - fine". `longRunKm` is the week's planned long run, `taperLongRunKm` the taper's (what a long run
   * eased to would be); the card keeps the planned one as the upper end. `lastDay` (wave 22e): read on the week's last day, when the week is
   * done and short - the plan line is then "Taper starts tomorrow - no need to make up this week's km", the same as the headline and the coach.
   */
  easingOff: { reason: 'days_off' | 'late_week'; daysOff: number; longRunKm: number | null; taperLongRunKm: number | null; lastDay?: boolean } | null;
  /** A comeback target lifted above the plain 10% step is a ceiling: say "up to ~18 km". */
  upTo: boolean;
  /**
   * Wave 23e: this week's long run is still to come (the longest run so far is under 60% of it) - read on a day of the week, never on the weeks
   * graded behind it. The card, the coach and the headline wait for it before they judge the week (a Sunday morning is not "Behind").
   */
  longRunAhead: boolean;
  /**
   * Wave 23e: what the week has already run plus the planned long run is over the week's number (1.10 x the target, the target itself in a
   * taper), so the long run is cut to what is left - or skipped when under 3 km (2 mi) is. `longRunKm`, `longRun.nextKm`, the plan line, the
   * coach and the card's remaining-km line all say that ONE number. `fullKm` is the long run the week would otherwise plan.
   */
  longRunTrim: { fullKm: number; doneKm: number; remainingKm: number; weekDone: boolean; today: boolean } | null;
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
/** Wave 23e P3-h: a long run quoted next to a restart number is at most this share of it (floored to the half km / mile): 12 km restart -> 4.5 km, never 6.5 (54%). */
export const RESTART_LONG_RUN_MAX_SHARE = 0.4;
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
 * How far back the plan walks: to see a spike (one hold week per spike week), to climb back after a restart (the
 * week before this one must itself know the restart three weeks behind it) and to see that the 3 weeks before a
 * cutback were plain build weeks (a comeback can be 4 weeks deep, so 8 covers it). Past weeks are computed once per call
 * (`PlanCtx.planCache`). The loader's run history is a sliding 77-day window: the walk stays well inside it, so the
 * partial week at the window's edge can never change today's plan.
 */
const MAX_PLAN_DEPTH = 8;
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
/** Every 4th plain build / maintain week is a cutback at ~80% of the week it replaces (long run held). */
export const CUTBACK_EVERY_WEEKS = 4;
export const CUTBACK_FRACTION = 0.8;
/** Wave 23e: an owed cutback (the last one was skipped) comes after this many build weeks, the skip-hold counting as one. */
export const OWED_CUTBACK_AFTER_BUILD_WEEKS = 2;
/** A cutback week that ran more than this multiple of its lowered number skipped the cutback (the shared 10% ceiling slack). */
export const CUTBACK_SKIPPED_FRACTION = PHASE_CEILING_TOLERANCE;
/** The last 2 build weeks before a taper carry a few strides, so race-pace work is not brand new in the taper. */
export const STRIDES_COPY = 'plus 4–6 strides after one easy run';
export const STRIDES_WEEKS_BEFORE_TAPER = 2;
/** A comeback rung never asks for more than this multiple of the week just run (and still at least the normal 10% step). */
export const COMEBACK_MAX_GROWTH = 1.25;
/** Light week: this many days without a run in the current week, or Thursday and later with under half the target and no way to fit the rest. */
export const LIGHT_WEEK_DAYS_OFF = 4;
export const LIGHT_WEEK_LATE_SHARE = 0.5;
/** ... the late-week read starts on Thursday (0 = Monday). */
export const LIGHT_WEEK_LATE_FROM_DOW = 3;
/** ... and needs the week to be under this share of what the runner's last weeks had run by the same weekday. */
export const LIGHT_WEEK_PACE_FRACTION = 0.75;
/** ... and the rest of the target not to fit in the runs the runner usually still has left (with this much room for a slightly bigger run). */
export const LIGHT_WEEK_FIT_SLACK = 1.2;
/** A week that lost that many days is realistically ~70% of its target at best; its long run is ~40% of that. */
export const LIGHT_WEEK_REALISTIC_FRACTION = 0.7;
export const LIGHT_WEEK_LONG_RUN_SHARE = 0.4;
/** A peak long run is within the plan when it is at most this many km over what its week planned (and over the peak target). */
export const PEAK_PLAN_SLACK_KM = 0.5;
/** A long run over this share of its week gets one watch note (a long run is the week's biggest run, not most of it). */
export const OVERSIZED_LONG_RUN_SHARE = 0.55;
/** ... in a week with at least this many run days (with two runs a week the long one is most of it by nature). */
export const LONG_RUN_SHARE_MIN_RUN_DAYS = 3;
/** The long-run cap note is shown in the goal's first week and then at most every this many weeks. */
export const CAP_NOTE_EVERY_WEEKS = 4;
/** Wave 23e: under this many km (2 mi) left in the week, the long run is not trimmed to a stub - the week's km are done. */
export const LONG_RUN_TRIM_MIN_KM = 3;
export const LONG_RUN_TRIM_MIN_MI = 2;
/** The week's long run is run once a run of this share of it (or more) is in; a shorter run earlier in the week is not it. */
export const LONG_RUN_DONE_FRACTION = 0.9;
/** Race eve after a week at least this many times the plan: add the "start conservatively" note. */
export const RACE_EVE_HEAVY_WEEK = 1.5;
export const RACE_EVE_CONSERVATIVE_LINE = 'Start conservatively — the first few km easy';
/** `RACE_EVE_CONSERVATIVE_LINE` in the runner's unit ("the first few miles easy" for miles). */
export function raceEveConservativeLine(unitsPerKm = 1): string {
  return unitsPerKm < 1 ? RACE_EVE_CONSERVATIVE_LINE.replace(/km easy$/, 'miles easy') : RACE_EVE_CONSERVATIVE_LINE;
}
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
  /** Monday of the week the cap-note cadence counts from (the goal's first week; else the first week with a run). */
  capNoteAnchor: string | null;
  kmCache: Map<string, { km: number; days: number }>;
  /** Plans of the weeks BEFORE the requested one (they never depend on today or on the explicit long-run reading). */
  planCache: Map<string, EnduranceWeekPlan>;
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
  const anchorDay = input.capNoteAnchorDay ?? input.goalStartDay ?? null;
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
    capNoteAnchor: anchorDay != null && DAY_RE.test(anchorDay) ? mondayOfDay(anchorDay) : first == null ? null : mondayOfDay(first),
    kmCache: new Map(),
    planCache: new Map(),
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

function bandFor(
  targetKm: number | null,
  ctx: PlanCtx,
  medianKm: number | null,
  wind: EnduranceWeekPlan['wind'],
  mode: BandMode,
  opts: { comebackFromKm?: number | null; cutbackNormalKm?: number | null } = {},
): PlanBand {
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
  // A cutback is graded as its own target and never "short": any running is a good cutback week. Its target is the week's one
  // target, so the jump guard is measured against it too (the 30% margin keeps the normal week it replaced, 25% above it, from
  // being a spike) - the card, the distance line and the review never quote two "safe steps" for the same week.
  if (opts.cutbackNormalKm != null) {
    return { goodFromKm: 0, mixedFromKm: 0, overKm: targetKm < ctx.goalKm ? spikeEdgeKm(targetKm, ctx.units) : null };
  }
  const good = mode === 'restart' ? RESTART_GOOD_FRACTION : mode === 'gentle' ? REBUILD_GOOD_FRACTION : GOOD_FRACTION;
  const mixed = mode === 'restart' ? RESTART_MIXED_FRACTION : mode === 'gentle' ? REBUILD_MIXED_FRACTION : MIXED_FRACTION;
  let over: number | null = targetKm < ctx.goalKm ? spikeEdgeKm(targetKm, ctx.units) : null;
  // Regaining volume up to the median of the weeks before the break is never a spike - in a RESTART week. A comeback week is judged
  // against its own ceiling (`comebackCapRead`): running far past it is a spike even below the pre-break median (wave 22e).
  if (over != null && medianKm != null && opts.comebackFromKm == null) over = Math.max(over, round1(medianKm));
  // A careful comeback's target is a ceiling (the ladder), not a bar: the week is good when it grew on the last one and
  // was not a spike; it is mixed only when it shrank. Never tough. (A rebuild after the race keeps its 80% bar.)
  if (opts.comebackFromKm != null && opts.comebackFromKm > 0) {
    return { goodFromKm: round1(opts.comebackFromKm), mixedFromKm: 0, overKm: over };
  }
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
  cutback = false,
  keepLastLong = true,
): number | null {
  switch (kind) {
    case 'baseline':
    case 'race_week':
    case 'recovery':
      return null;
    case 'taper':
      return lr.peakKm == null ? null : roundLongRunKm(lr.peakKm * TAPER_LONG_RUN_SHARE, ctx.units);
    case 'hold': {
      if (lr.lastKm == null) return null;
      // Held where it was - except a hold AT a comeback ceiling (`keepLastLong` false), which cannot carry a 12 km long run in an 18 km week.
      const held = roundLongRunKm(lr.lastKm, ctx.units);
      const halfWeek = !keepLastLong && targetKm != null ? targetKm * LONG_RUN_MAX_WEEK_SHARE : null;
      return halfWeek != null && held > halfWeek + 1e-9 ? floorLongRunKm(halfWeek, ctx.units) : held;
    }
    default: {
      if (lr.lastKm == null || targetKm == null) return null;
      // A cutback week keeps the long run where it is (it is the week's volume that comes down), never past the peak
      // target and never past half of the LOWERED week: a long run held at 14 km in a 24 km cutback would be 58% of it.
      if (cutback) {
        const held = roundLongRunKm(lr.targetPeakKm != null ? Math.min(lr.lastKm, lr.targetPeakKm) : lr.lastKm, ctx.units);
        const cutCap = targetKm * LONG_RUN_MAX_WEEK_SHARE;
        return held > cutCap + 1e-9 ? floorLongRunKm(cutCap, ctx.units) : held;
      }
      if (heldKm != null && !restarting) return roundLongRunKm(heldKm, ctx.units);
      const next = longRunStepKm(lr.lastKm, lr.targetPeakKm);
      // A restart week starts the long run again from the recent longest, but never past 40% of the (gentle) restart week.
      // (The hold AT a comeback ceiling, and the week after it, keep no such exception: the week is lowered below the spike's long run.)
      const cap = restarting ? targetKm * LONG_RUN_RESTART_WEEK_SHARE : keepLastLong ? Math.max(targetKm * LONG_RUN_MAX_WEEK_SHARE, lr.lastKm) : targetKm * LONG_RUN_MAX_WEEK_SHARE;
      // A long run held down by the cap rounds down to the half unit, so it never ends up above its share of the week.
      return next > cap ? floorLongRunKm(cap, ctx.units) : roundLongRunKm(next, ctx.units);
    }
  }
}

/** The line a race eve reads: the day before the race is for rest, not for the week's leftover budget. */
export const RACE_EVE_LINE = 'Race tomorrow — rest or a 15-min shakeout; lay out your kit';

/**
 * The taper's race-pace reps, "3×1 km" ("3×0.5 mi" for miles), with U+00A0 between the number and the unit like every
 * other distance in display copy.
 */
export function racePaceReps(unitsPerKm = 1): string {
  return withUnit(unitsPerKm < 1 ? '3×0.5' : '3×1', distanceUnit(unitsPerKm));
}

/** "Light week — don't make it up; long run ≤ ~8 km easy, or skip it if you were ill" (units-aware, U+00A0 before the unit). */
export function lightWeekLine(lightWeek: NonNullable<EnduranceWeekPlan['lightWeek']>, unitsPerKm = 1): string {
  const cap = lightWeek.longRunCapKm;
  return cap != null
    ? `Light week — don't make it up; ${longRunWord(cap, unitsPerKm)} ≤ ~${formatTargetLongRun(cap, unitsPerKm)} easy, or skip it if you were ill`
    : "Light week — don't make it up; keep the runs short and easy, or skip them if you were ill";
}

/** "11.5" / "15": a long-run distance as a bare number in the display unit (the unit goes once, after a range). */
function longRunNumber(km: number, unitsPerKm: number): number {
  return Math.round(km * unitsPerKm * 2) / 2;
}

/**
 * The pre-taper week's line when the target is out of reach: "Easing off before your taper — fine; keep Sunday's long run
 * ~11.5–15 km easy" (the taper's own long run to this week's planned one; one number when they meet). A runner with days off
 * is also told they may skip it if they were ill.
 */
export function easingOffLine(
  easing: NonNullable<EnduranceWeekPlan['easingOff']>,
  nextPhase: 'taper' | 'race_week' = 'taper',
  unitsPerKm = 1,
): string {
  const lead = `Easing off before ${nextPhase === 'taper' ? 'your taper' : 'race week'} — fine`;
  const hi = easing.longRunKm;
  if (hi == null) return `${lead}; keep the runs short and easy`;
  const lo = easing.taperLongRunKm;
  const unit = distanceUnit(unitsPerKm);
  const range = lo != null && longRunNumber(lo, unitsPerKm) < longRunNumber(hi, unitsPerKm)
    ? withUnit(`${longRunNumber(lo, unitsPerKm)}–${longRunNumber(hi, unitsPerKm)}`, unit)
    : formatTargetLongRun(hi, unitsPerKm);
  const ill = easing.reason === 'days_off' ? ', or skip it if you were ill' : '';
  return `${lead}; keep Sunday's ${longRunWord(hi, unitsPerKm)} ~${range} easy${ill}`;
}

/** The last day of a pre-taper week that ended short: the week is done and nothing is to be made up. */
export function easedOffLine(nextPhase: 'taper' | 'race_week' = 'taper', unitsPerKm = 1): string {
  return `${nextPhase === 'taper' ? 'Taper' : 'Race week'} starts tomorrow — no need to make up this week's ${distanceUnit(unitsPerKm) === 'km' ? 'km' : 'miles'}`;
}

/** One line of "what this week is for" (units-aware, U+00A0 between a number and its unit). */
function purposeLine(plan: Omit<EnduranceWeekPlan, 'purpose'>): string {
  const u = plan.unitsPerKm;
  const t = plan.targetKm;
  const lr = plan.longRunKm;
  const lrWord = lr != null ? longRunWord(lr, u) : 'long run';
  const held = plan.longRunJump != null ? " (held after last week's jump)" : '';
  const lrPart = lr != null ? `${lrWord} ${formatTargetLongRun(lr, u)}${held}` : null;
  const strides = plan.strides ? `; ${STRIDES_COPY}` : '';
  if (plan.lightWeek != null) return lightWeekLine(plan.lightWeek, u);
  // Wave 23e: the week's km are run before its long run: no long run is planned, the plan line says so (the card's remaining-km line has the rest).
  if (plan.longRunTrim?.weekDone) {
    const head = plan.cutback != null ? 'Cutback week: ' : plan.kind === 'taper' ? 'Taper: ' : plan.kind === 'hold' ? 'Hold week: ' : '';
    return `${head}~${formatKm(t ?? plan.goalKm, u)} this week, done — no long run (rest or a 20-min jog)`;
  }
  if (plan.easingOff != null) return plan.easingOff.lastDay ? easedOffLine(plan.preTaper?.nextPhase ?? 'taper', u) : easingOffLine(plan.easingOff, plan.preTaper?.nextPhase ?? 'taper', u);
  switch (plan.kind) {
    case 'baseline':
      return "Baseline week: run as you normally would; next week's step is built from this week";
    case 'build': {
      if (plan.cutback != null) {
        return `Cutback week: ~${formatKm(t ?? plan.goalKm, u)}, ${lrPart ?? 'easy runs'} — absorb the last three weeks${strides}`;
      }
      // Still climbing back toward the pre-break level (not once the target has reached it).
      const back = plan.comeback != null && t != null && t < plan.comeback.medianKm - 0.5
        ? `; back toward your usual ~${formatKm(plan.comeback.medianKm, u)}`
        : '';
      // A comeback target lifted above the plain 10% step is a ceiling, not a bar: "up to ~18 km".
      const lead = plan.upTo ? 'Up to ' : '';
      return lrPart && t != null
        ? `${lead}~${formatKm(t, u)} this week: ${lrPart}, the rest easy runs${back}${strides}`
        : `${lead}~${formatKm(t ?? plan.goalKm, u)} this week, mostly easy runs${back}${strides}`;
    }
    case 'maintain': {
      if (plan.cutback != null) {
        return `Cutback week: ~${formatKm(t ?? plan.goalKm, u)}, ${lrPart ?? 'easy runs'} — absorb the last three weeks${strides}`;
      }
      // A runner who has never run the weekly goal is still building to it, not holding it - and (wave 23e P3-c) neither is one whose last week fell short of it.
      const verb = plan.goalReachedBefore && plan.lastAtGoal ? 'Hold' : 'Build to';
      return lrPart
        ? `${verb} ${formatKm(plan.goalKm, u)} this week: ${lrPart}, the rest easy${strides}`
        : `${verb} ${formatKm(plan.goalKm, u)} this week, the rest of the runs easy${strides}`;
    }
    case 'hold':
      // Wave 23e: no guilt - the cutback became a normal week, which is fine; this week is the easier one.
      if (plan.hold?.skippedCutback) return `Your cutback became a normal week — fine. Hold ~${formatKm(t ?? plan.goalKm, u)} this week${lrPart ? `, ${lrPart}` : ''} — an easier week before building again${strides}`;
      return `Hold ~${formatKm(t ?? plan.goalKm, u)} this week, no step up after last week's jump${lrPart ? `; keep the ${lrPart}` : ''}${strides}`;
    case 'restart':
      if (plan.restartLong) return `Two weeks off — restart a bit lower, ~${formatKm(t ?? plan.restartKm, u)} this week with easy runs${lrPart ? `; ${lrPart}` : ''}`;
      return `Restart at ~${formatKm(t ?? plan.restartKm, u)} this week with easy runs${lrPart ? `; ${lrPart}` : ''}`;
    case 'rebuild': {
      const atGoal = t != null && t >= plan.goalKm - 1e-9;
      return `Rebuilding: ~${formatKm(t ?? plan.goalKm, u)} this week, easy runs${lrPart ? `, ${lrPart}` : ''}${atGoal ? '' : ', then add about 10% a week'}`;
    }
    case 'taper': {
      const reps = racePaceReps(u);
      const race = lrPart ? `${lrPart} easy, plus ${reps} at race pace midweek` : `${reps} at race pace midweek, the rest easy`;
      // Wave 23e P3-m: right after a week at the taper's own number it is no cut - say what it is, as a share of the peak.
      if (plan.taperHold && t != null && plan.wind != null) {
        return `Taper: hold ~${formatKm(t, u)} this week (${Math.round((t / plan.wind.peakKm) * 100)}% of your ~${formatKm(Math.round(plan.wind.peakKm * u) / u, u)} peak); ${race}`;
      }
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

/** Wave 23e P3-c: last week "ran the goal" when it came within this many km of it (30 km goal: 29.5 km and up). */
export const LAST_AT_GOAL_SLACK_KM = 0.5;
/** Wave 23e P3-m: a taper week within this many km of last week's volume (either side) is a hold, not a cut. */
export const TAPER_HOLD_SLACK_KM = 0.5;

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
  if (depth > 0) {
    const hit = ctx.planCache.get(w);
    if (hit) return hit;
  }
  const plan = computeWeekPlan(ctx, w, depth);
  if (depth > 0) ctx.planCache.set(w, plan);
  return plan;
}

/** Whole weeks since Monday 1970-01-05: the calendar the cutback cycle follows. */
function absoluteWeek(monday: string): number {
  return Math.round((dayIndex(monday) - dayIndex('1970-01-05')) / 7);
}

/** `km` rounded DOWN in the display unit (whole km, 0.5 mi), back in km (one decimal). */
function floorWeekTargetKm(km: number, units: number): number {
  const step = units < 1 ? 0.5 : 1;
  return Math.round((Math.floor((km * units) / step + 1e-9) * step / units) * 10) / 10;
}

/** The week's longest run when it was most of the week (over 55%, in a week of 3+ run days); null otherwise. */
function weekLongRunShare(ctx: PlanCtx, w: string, weekKmFloor: number): LongRunShare | null {
  const wr = weekRuns(ctx, w);
  const longKm = longestRunIn(ctx, w);
  if (longKm == null || wr.days < LONG_RUN_SHARE_MIN_RUN_DAYS || !isLongRun(longKm, ctx.units)) return null;
  const weekKm = Math.max(wr.km, weekKmFloor);
  if (!(weekKm > 0)) return null;
  const share = longKm / weekKm;
  if (share <= OVERSIZED_LONG_RUN_SHARE + 1e-9) return null;
  return { weekStart: w, longKm, weekKm: round1(weekKm), sharePct: Math.round(share * 100) };
}

/** The longest stretch of days without a run inside each of the 4 weeks before `w` (weeks with a run), as a median; 0 with none. */
function typicalOffStreak(ctx: PlanCtx, w: string): number {
  const streaks: number[] = [];
  for (let k = 1; k <= MEDIAN_WEEKS; k++) {
    const wk = addDayKey(w, -7 * k);
    if (ctx.firstRunWeek == null || wk < ctx.firstRunWeek) break;
    const ran = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const d = addDayKey(wk, i);
      if (ctx.runs.some(r => r.day === d)) ran.add(d);
    }
    if (ran.size === 0) continue;
    let best = 0;
    let cur = 0;
    for (let i = 0; i < 7; i++) {
      cur = ran.has(addDayKey(wk, i)) ? 0 : cur + 1;
      if (cur > best) best = cur;
    }
    streaks.push(best);
  }
  return median(streaks) ?? 0;
}

/**
 * Running km per weekday (Monday = index 0) of up to 4 TRAINING weeks before `w` (wind-down weeks left out), from the first
 * week with a run on, newest first; the race itself is not training. The runner's own week shape: what they usually have run
 * by a weekday and what they usually still have left after it.
 */
function priorWeekProfiles(ctx: PlanCtx, w: string): number[][] {
  const out: number[][] = [];
  for (let k = 1; k <= MEDIAN_WEEKS; k++) {
    const wk = addDayKey(w, -7 * k);
    if (ctx.firstRunWeek == null || wk < ctx.firstRunWeek) break;
    if (isWindWeek(ctx, wk)) continue;
    const profile = [0, 0, 0, 0, 0, 0, 0];
    for (const r of ctx.runs) {
      const i = dayIndex(r.day) - dayIndex(wk);
      if (i < 0 || i > 6 || (ctx.raceDate != null && r.day === ctx.raceDate)) continue;
      profile[i] += r.km;
    }
    out.push(profile);
  }
  return out;
}

function computeWeekPlan(ctx: PlanCtx, w: string, depth: number): EnduranceWeekPlan {
  const info = phaseAt(ctx, w);
  const prevStart = addDayKey(w, -7);
  const weekEnd = addDayKey(w, 6);
  const asOf = ctx.today < weekEnd ? ctx.today : weekEnd;
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
  const hasPrior = ctx.runs.some(r => r.day < w);
  const prevPlan = depth < MAX_PLAN_DEPTH && hasPrior ? planWeek(ctx, prevStart, depth + 1) : null;
  const prevGrade = prevPlan != null && hasPrior ? gradeEnduranceWeek(prevPlan, prev.km, { runDays: prev.days, unitsPerKm: ctx.units }) : null;
  // Wave 23e: last week's change is measured against the base ITS step was taken from: after a cutback that is the last full week before it.
  const lastChangeBase = prevPlan != null ? prevPlan.stepBaseKm : prevPrev.km;
  const last: PlanLastWeek | null = hasPrior && ctx.runs.some(r => r.day >= prevStart && r.day < w)
    ? {
        weekStart: prevStart,
        km: round1(prev.km),
        runDays: prev.days,
        kind: prevPlan?.kind ?? 'build',
        targetKm: prevPlan?.targetKm ?? null,
        cutback: prevPlan?.cutback != null,
        overCap: prevPlan != null && overUpToCap(prevPlan, prev.km, ctx.units),
        capRead: prevPlan != null && prevPlan.upTo ? (comebackCapRead(prevPlan, prev.km, ctx.units) === 'within' ? null : (comebackCapRead(prevPlan, prev.km, ctx.units) as 'touch' | 'well')) : null,
        grade: prevGrade,
        // No % against a very small week, nor for the week that restarted after a break (that +150% is not growth).
        holdOver: prevPlan != null && prevGrade?.gap !== 'spike' && holdOverrun(prevPlan, prev.km, longestRunIn(ctx, prevStart)),
        changePct: lastChangeBase != null && lastChangeBase >= compareMin && prevPlan?.restart == null && prevGrade?.level !== 'light' && prevPlan?.last?.grade?.gap !== 'spike'
          ? Math.round(((prev.km - lastChangeBase) / lastChangeBase) * 100)
          : null,
        changeBaseKm: lastChangeBase != null && lastChangeBase >= compareMin && prevPlan?.restart == null && prevGrade?.level !== 'light' && prevPlan?.last?.grade?.gap !== 'spike' ? round1(lastChangeBase) : null,
        changeAfterCutback: prevPlan != null && prevPlan.stepBaseKm > prevPrev.km + 1e-9,
      }
    : null;

  // The restart target quoted to a runner who is on a break: by the length of the gap so far.
  const holdKm = prevPlan?.targetKm ?? null;
  // The restart number a break quotes is "if you restart tomorrow": a gap still open today (no run in the week yet) is tomorrow's gap + 1,
  // every day of the break (wave 22e: it used to be only a 7-day gap on the last day). Sunday's "~17 km" is then never Monday's "~12 km" -
  // the band drops on the day the gap becomes 15 days, and the card says why (`restartLong`).
  const gapOnDay = (gap: number | null, open: boolean): number | null => (gap != null && open ? gap + 1 : gap);
  const restartFor = (windowKm: number[], gapDays: number | null): { km: number; medianKm: number; fraction: number } => {
    const f = restartFractionFor(gapDays);
    if (f === 'hold' && holdKm != null) {
      const medianKm = median(windowKm) ?? ctx.goalKm * 0.5;
      // A hold (one skipped step) never asks for more than the mid restart share of the pre-break median.
      const mid = restartTargetKm(ctx, windowKm, RESTART_MID_FRACTION);
      const km = Math.min(ctx.goalKm, holdKm, mid.km);
      return { km, medianKm, fraction: medianKm > 0 ? km / medianKm : 1 };
    }
    const fraction = f === 'hold' ? RESTART_MID_FRACTION : f;
    return { ...restartTargetKm(ctx, windowKm, fraction), fraction };
  };
  const trailingGap = daysSinceRun;
  const breakGapShown = onBreak ? gapOnDay(trailingGap, true) : null;
  const breakRestart = restartFor(breakWindow, breakGapShown);

  let kind: EnduranceWeekKind;
  let targetKm: number | null;
  let restart: EnduranceWeekPlan['restart'] = null;
  let comeback: EnduranceWeekPlan['comeback'] = null;
  let hold: EnduranceWeekPlan['hold'] = null;
  let rebuild: EnduranceWeekPlan['rebuild'] = null;
  let cutback: EnduranceWeekPlan['cutback'] = null;
  let upTo = false;
  // The window the restart number is read from (an empty week: the weeks before it; a break noticed mid-week: the weeks before this one).
  let restartWindow: number[] = breakWindow;
  let medianKm: number | null = null;
  let mode: BandMode = 'normal';
  // The base the week's ~10% step is taken from: last week, or after a cutback the larger of the two weeks before it.
  let stepBaseKm = prev.km;
  // Plain build / maintain weeks in a row ending last week; the walk back is cut off after `MAX_PLAN_DEPTH` weeks (0 there).
  const prevBuildWeeks = prevPlan != null ? prevPlan.buildWeeks : 0;
  // Cutback weeks fall on every 4th CALENDAR week - the same weeks for the card and the review, whatever window of
  // history either was handed - once 3 plain build / maintain weeks precede one.
  const cutbackWeek = ((absoluteWeek(w) % CUTBACK_EVERY_WEEKS) + CUTBACK_EVERY_WEEKS) % CUTBACK_EVERY_WEEKS === CUTBACK_EVERY_WEEKS - 1;

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
    restartWindow = prev.km < MIN_BASE_WEEK ? beforeWindow : breakWindow;
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
      if (gap != null) {
        const open = !ctx.runs.some(r => r.day >= w && r.day <= asOf);
        const shown = gapOnDay(gap, open);
        triggered = { reason: 'break', target: restartFor(breakWindow, shown), gapDays: shown };
      }
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
      // `spikeStepKm` is the target last week was graded against (a cutback week's is the cutback number, what its cards and its
      // review quoted). The hold itself steps up from the step the progression had planned: after a cutback that is the week it
      // replaced (the cutback was a pause, not a new base), otherwise the same target.
      const spikeStepKm = prevPlan.targetKm;
      // A comeback week well over its "up to" ceiling: stay AT that ceiling (no step up, none from the jump), and keep the climb back alive.
      const ceilingBroken = prevPlan.upTo && comebackCapRead(prevPlan, prev.km, ctx.units) === 'well';
      hold = {
        spikeKm: round1(prev.km),
        spikeStepKm,
        ...(ceilingBroken ? { ceiling: true, ...(prevPlan.comeback != null ? { ladder: { ...prevPlan.comeback } } : {}) } : {}),
      };
      kind = 'hold';
      targetKm = ceilingBroken ? spikeStepKm : stepFromShownTarget(prevPlan.cutback?.normalKm ?? spikeStepKm, ctx.goalKm, ctx.units);
    } else if (prevPlan != null && prevIsTraining && prevPlan.cutback != null && prevPlan.targetKm != null && prevGrade?.gap === 'over') {
      // A cutback week that ran more than 10% over its lowered number skipped the cutback: no +10% build on the skip - this week holds at the
      // week the cutback replaced ("You skipped the cutback - hold ~25 km"), and the week after builds on from there.
      hold = { spikeKm: round1(prev.km), spikeStepKm: prevPlan.targetKm, skippedCutback: true };
      kind = 'hold';
      targetKm = Math.min(ctx.goalKm, prevPlan.cutback.normalKm);
    } else {
      // Build: ~10% over last week — and, for up to three weeks after a restart, at least the next rung of the climb
      // back to the pre-break median (restart -> 80% -> 100%), a rung only when the week before graded good.
      // After a cutback week the step is taken from the bigger of the two weeks before it, so the cutback costs no progress.
      if (prevPlan?.cutback != null) stepBaseKm = Math.max(prev.km, prevPrev.km);
      const step = weekStepOrGoalKm(stepBaseKm, ctx.goalKm, ctx.units);
      let target = step;
      const from = prevPlan != null && prevIsTraining
        ? (prevPlan.restart != null ? { ...prevPlan.restart, weeksSince: 0 } : prevPlan.comeback ?? prevPlan.hold?.ladder ?? null)
        : null;
      // A comeback week read against its "up to" ceiling C (km run A): within it, "a touch over" (rule 2), or "well over" (rule 3 -
      // that one is a spike and became the hold branch above).
      const capRead = prevPlan != null && prevIsTraining ? comebackCapRead(prevPlan, prev.km, ctx.units) : 'within';
      if (from != null && from.weeksSince + 1 <= COMEBACK_WEEKS) {
        // A rung is climbed only when the week before graded good (a touch over its ceiling still does); otherwise it is repeated.
        const rung = prevGrade?.level === 'good' ? nextRung(from.fraction) : from.fraction;
        const rungKm = roundWeekTargetKm(from.medianKm * rung, ctx.units);
        // Rule 1 (A within 1.10 x C): a rung never asks for more than 1.25x the week just run, and still climbs by the normal 10% step.
        // Rule 2 (A a touch over): the ceiling climbs from the CEILING, never from the overshoot - at most 1.25x C - and never below what was run.
        const ceilingKm = prevPlan?.targetKm ?? null;
        target = capRead === 'touch' && ceilingKm != null
          ? Math.max(ceilWeekTargetKm(prev.km, ctx.units), Math.min(rungKm, floorWeekTargetKm(ceilingKm * COMEBACK_MAX_GROWTH, ctx.units)))
          : Math.max(step, Math.min(rungKm, floorWeekTargetKm(prev.km * COMEBACK_MAX_GROWTH, ctx.units)));
        // Never past the weekly goal, nor past the pre-break median the climb is back to (unless more than that was already run).
        target = Math.min(ctx.goalKm, target, Math.max(ceilWeekTargetKm(from.medianKm, ctx.units), ceilWeekTargetKm(prev.km, ctx.units)));
        // A target lifted above the plain step is a ceiling for a careful comeback, not a bar to clear; so is the one after a touch over.
        upTo = target > step + 1e-9 || capRead === 'touch';
        comeback = { medianKm: from.medianKm, fraction: rung, weeksSince: from.weeksSince + 1 };
        medianKm = from.medianKm;
      }
      if (rebuild || comeback != null) mode = 'gentle';
      targetKm = target;
      kind = rebuild ? 'rebuild' : target >= ctx.goalKm ? 'maintain' : 'build';
      // Every 4th plain build / maintain week is a cutback: ~80% of the week it replaces, the long run held.
      // Not in the last build week before a taper / race week: the taper is the easing off, and the peak long run belongs there.
      const beforeWindDown = isWindDownPhase(phaseAt(ctx, addDayKey(w, 7))?.phase);
      // Wave 23e: the calendar's 4th week still carries the cutback, after 3 build weeks - or after 2 when one is OWED (the last was skipped; the
      // skip-hold counts as a build week). Only on the calendar's own weeks, so the plan of a past week read from a later Monday (the chain is
      // cut off after `MAX_PLAN_DEPTH` weeks) is the plan that week showed.
      const owed = prevPlan?.cutbackOwed === true && prevIsTraining;
      const cutbackDue = cutbackWeek && prevBuildWeeks >= (owed ? OWED_CUTBACK_AFTER_BUILD_WEEKS : CUTBACK_EVERY_WEEKS - 1);
      if ((kind === 'build' || kind === 'maintain') && comeback == null && cutbackDue && target >= compareMin && !beforeWindDown) {
        const cut = roundWeekTargetKm(target * CUTBACK_FRACTION, ctx.units);
        if (cut < target - 1e-9) {
          cutback = { normalKm: target };
          targetKm = cut;
        }
      }
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

  const buildLike = kind === 'build' || kind === 'maintain' || kind === 'hold';
  const plain = (kind === 'build' || kind === 'maintain') && comeback == null && rebuild == null && cutback == null;
  // Wave 23e: a hold week (a skipped cutback's, or a spike's) is a build week for the count - it paused the step, it did not rest the legs. Except a spike
  // hold that lands ON the calendar's cutback week after 3 build weeks: it is the cut after the jump (a 40 km week, then ~22), and it takes the cutback's place.
  const slotHold = kind === 'hold' && hold?.skippedCutback !== true && cutbackWeek && prevBuildWeeks >= CUTBACK_EVERY_WEEKS - 1;
  const buildWeeks = plain || (kind === 'hold' && !slotHold) ? prevBuildWeeks + 1 : 0;
  // A skipped cutback is owed until a cutback is taken (or a restart, wind-down or rebuild week rests the runner anyway).
  const cutbackOwed = cutback == null && (hold?.skippedCutback === true || (prevPlan?.cutbackOwed === true && (kind === 'build' || kind === 'maintain' || kind === 'hold') && comeback == null));

  // The last 2 build weeks before a taper carry a few strides: race-pace work must not be brand new in the taper.
  const strides = buildLike && comeback == null && info != null && info.phase === 'build' && raceClass(ctx.raceKm) !== 'short'
    && [7, 14].some(d => isWindDownPhase(phaseAt(ctx, addDayKey(w, d))?.phase));

  // The long run the week would plan without a light-week cap (the light-week read and the easing-off read both quote it).
  const heldLongRun = longRunJump?.heldKm ?? null;
  const plannedNextKm = nextLongRun(ctx, kind, targetKm, lr0, restart != null, heldLongRun, cutback != null, hold?.ceiling !== true && prevPlan?.hold?.ceiling !== true);

  // The week before a taper (or race week): the next Monday's phase is wind-down. Easing off is the plan's own next step.
  const nextWindPhase = buildLike && info != null && info.phase === 'build' ? phaseAt(ctx, addDayKey(w, 7))?.phase : undefined;
  // (Wave 23e P3-j: the taper's long run is read the way Monday's plan will read it - stats as of this week's Sunday, this week's long run included.)
  const taperPeakKm = nextWindPhase === 'taper' ? longRunStats(ctx.runs, addDayKey(w, 6), ctx.raceDate).peakKm : null;
  const preTaper: EnduranceWeekPlan['preTaper'] = nextWindPhase === 'taper' || nextWindPhase === 'race_week'
    ? nextWindPhase === 'taper'
      ? { nextPhase: nextWindPhase, taperLongRunKm: taperPeakKm == null ? null : roundLongRunKm(taperPeakKm * TAPER_LONG_RUN_SHARE, ctx.units) }
      : { nextPhase: nextWindPhase }
    : null;

  // Light week: read DURING the week, with days off (or, from Thursday, behind the runner's own pace with the rest of the
  // target out of reach): don't make it up. In a pre-taper week the same reads are "easing off" instead - fine, not light.
  // (The card is read at any hour: a runner whose Thursday run is still to come is judged on the Thursday run they have not
  // logged yet, like the Friday read before it.)
  let lightWeek: EnduranceWeekPlan['lightWeek'] = null;
  let easingOff: EnduranceWeekPlan['easingOff'] = null;
  if (depth === 0 && ctx.today >= w && ctx.today <= weekEnd && wind == null && buildLike && targetKm != null && daysSinceRun != null) {
    const dow = dayIndex(ctx.today) - dayIndex(w); // 0 = Monday
    const daysOff = Math.min(daysSinceRun, dow + 1);
    const offThreshold = Math.max(LIGHT_WEEK_DAYS_OFF, typicalOffStreak(ctx, w) + 2);
    const doneKm = weekRuns(ctx, w).km;
    // Does the rest of the target fit in the runs the runner usually still has left after today (their own weekday shape, with
    // room for a slightly bigger run)? The long run still to come is the Sunday run they usually have: a runner whose long run is
    // Sunday sits under half of the week on a Friday, on pace.
    const profiles = priorWeekProfiles(ctx, w);
    const longestSoFar = Math.max(0, ...ctx.runs.filter(r => r.day >= w && r.day <= ctx.today && r.day !== ctx.raceDate).map(r => r.km));
    const longRunAhead = plannedNextKm != null && longestSoFar < plannedNextKm * 0.6;
    let reason: 'days_off' | 'late_week' | null = null;
    if (daysOff >= offThreshold) reason = 'days_off';
    else if (dow >= LIGHT_WEEK_LATE_FROM_DOW && doneKm < targetKm * LIGHT_WEEK_LATE_SHARE && profiles.length > 0) {
      // Behind the runner's own weeks by the same weekday, behind the target without the long run still to come, AND the rest of
      // the target out of reach of the runs they usually have left.
      // Wave 23e (G2): a run that is still to come TODAY is still ahead, not missed: until it is logged the week so far is read through
      // YESTERDAY and today's usual run is part of what is left (a runner who did exactly what the plan said on Tuesday is not "behind" on
      // Thursday morning). Once today's run is in, today counts as done.
      const ranToday = ctx.runs.some(r => r.day === ctx.today && r.day !== ctx.raceDate);
      const through = ranToday ? dow : dow - 1;
      const usualKm = median(profiles.map(p => p.slice(0, through + 1).reduce((a, b) => a + b, 0))) as number;
      const usualLeft = profiles.reduce((a, p) => a + p.slice(through + 1).reduce((x, y) => x + y, 0), 0) / profiles.length;
      const behindUsual = doneKm < usualKm * LIGHT_WEEK_PACE_FRACTION;
      const behindTarget = doneKm < LIGHT_WEEK_LATE_SHARE * (targetKm - (longRunAhead && plannedNextKm != null ? plannedNextKm : 0));
      const fits = targetKm - doneKm <= usualLeft * LIGHT_WEEK_FIT_SLACK + 1e-9;
      if (behindUsual && behindTarget && !fits) reason = 'late_week';
    }
    if (reason != null && preTaper != null) {
      const taperLong = plannedNextKm != null || lr0.peakKm != null
        ? roundLongRunKm(Math.max(lr0.peakKm ?? 0, plannedNextKm ?? 0) * TAPER_LONG_RUN_SHARE, ctx.units)
        : null;
      easingOff = { reason, daysOff, longRunKm: plannedNextKm, taperLongRunKm: taperLong };
    } else if (reason != null) {
      const realistic = targetKm * LIGHT_WEEK_REALISTIC_FRACTION;
      let cap = floorLongRunKm(realistic * LIGHT_WEEK_LONG_RUN_SHARE, ctx.units);
      if (lr0.lastKm != null) cap = Math.min(cap, roundLongRunKm(lr0.lastKm, ctx.units));
      lightWeek = { reason, daysOff, longRunCapKm: cap > 0 ? cap : null };
    }
  }

  // Wave 23e: the week's long run against what is left of the week. A long run that would carry the week past 110% of its number (the
  // number itself in a taper) is cut to what is left, or skipped when under 3 km (2 mi) is: ONE number for the plan line, the coach, the
  // card's remaining-km line and the headline (they used to say "long run 10 km" next to "keep the rest to one short easy run").
  let longRunAhead = false;
  let longRunTrim: EnduranceWeekPlan['longRunTrim'] = null;
  if (depth === 0 && ctx.today >= w && ctx.today <= weekEnd && kind !== 'baseline' && kind !== 'race_week' && kind !== 'recovery' && plannedNextKm != null) {
    const longestToday = Math.max(0, ...ctx.runs.filter(r => r.day >= w && r.day <= ctx.today && r.day !== ctx.raceDate).map(r => r.km));
    // The week's long run is run when a run of (nearly) its planned length is in: a 7 km Tuesday run is not the 9 km Sunday long run. On the last
    // day any run logged TODAY is the long run (a 12 km Sunday run against a planned 14 is the long run run short, not one still to come).
    const ranOnLastDay = ctx.today === weekEnd && ctx.runs.some(r => r.day === ctx.today && r.day !== ctx.raceDate);
    longRunAhead = longestToday < plannedNextKm * LONG_RUN_DONE_FRACTION && !ranOnLastDay;
    const doneNow = weekRuns(ctx, w).km;
    if (lightWeek == null && easingOff == null && !onBreak && targetKm != null) {
      const left = Math.max(0, targetKm - doneNow);
      const stub = (ctx.units < 1 ? LONG_RUN_TRIM_MIN_MI : LONG_RUN_TRIM_MIN_KM) / ctx.units;
      const limit = kind === 'taper' ? targetKm : targetKm * PHASE_CEILING_TOLERANCE;
      // (a) the long run still to come would carry the week past its number; (b) before the last day, the week's km are all but run, wherever the long run was.
      const tooMuch = longRunAhead && doneNow + plannedNextKm > limit + 1e-9;
      const allButRun = ctx.today < weekEnd && left < stub - 1e-9;
      if (tooMuch || allButRun) {
        longRunTrim = {
          fullKm: plannedNextKm,
          doneKm: round1(doneNow),
          remainingKm: round1(left),
          weekDone: left < stub - 1e-9 || floorLongRunKm(left, ctx.units) <= 0,
          today: dayIndex(ctx.today) - dayIndex(w) === 6,
        };
      }
    }
  }
  const trimmedKm = longRunTrim == null ? null : longRunTrim.weekDone ? null : floorLongRunKm(longRunTrim.remainingKm, ctx.units);
  const untrimmedNextKm = lightWeek != null && lightWeek.longRunCapKm != null ? lightWeek.longRunCapKm : plannedNextKm;
  const nextKm = longRunTrim != null ? trimmedKm : untrimmedNextKm;
  const raceTargetKm = lr0.targetPeakKm != null && peakInfo != null && lr0.targetPeakKm === peakInfo.peakKm ? peakInfo.raceTargetKm : null;
  // The cap note: the goal's first week, then at most every 4th, in build weeks only.
  let capNoteDue = false;
  if (raceTargetKm != null && info != null && info.phase === 'build' && rebuild == null) {
    const anchor = ctx.capNoteAnchor;
    const idx = anchor == null ? 0 : Math.round((dayIndex(w) - dayIndex(anchor)) / 7);
    capNoteDue = idx <= 0 || idx % CAP_NOTE_EVERY_WEEKS === 0;
    // Wave 22e: never in a light, restart or comeback week (the runner is coming back, not raising a goal) ...
    if (lightWeek != null || easingOff != null || restart != null || comeback != null) capNoteDue = false;
    // ... and only when the raised goal (twice the race peak long run) can be reached at +10% a week before the taper starts.
    if (capNoteDue && hasPrior && ctx.raceDate != null) {
      const taperStart = dayIndex(ctx.raceDate) - raceRules(ctx.raceKm).taperStartDays;
      const stepsLeft = Math.max(0, Math.ceil((taperStart - dayIndex(w)) / 7));
      const raisedGoalKm = raceTargetKm / LONG_RUN_MAX_WEEK_SHARE;
      if (prev.km * (1 + WEEKLY_DISTANCE_GROWTH) ** stepsLeft < raisedGoalKm - 0.5) capNoteDue = false;
    }
  }

  // A long run that was most of its week: one watch note (the most recent such week) and no praise for the peak.
  let share: LongRunShare | null = null;
  let peakOversized = false;
  let peakPlan: PlanLongRun['peakPlan'] = null;
  if (depth === 0) {
    const inProgress = asOf < weekEnd;
    const floorFor = (wk: string): number => (wk === w && inProgress && wind == null && targetKm != null ? targetKm : 0);
    if (wind == null && rebuild == null) {
      share = weekLongRunShare(ctx, w, floorFor(w)) ?? (isWindWeek(ctx, prevStart) ? null : weekLongRunShare(ctx, prevStart, 0));
    }
    let peakRun: PlanRun | null = null;
    for (const r of ctx.runs) {
      if (ctx.raceDate != null && r.day === ctx.raceDate) continue;
      const age = dayIndex(asOf) - dayIndex(r.day);
      if (!(age >= 0 && age < 28)) continue;
      if (peakRun == null || r.km > peakRun.km || (r.km === peakRun.km && r.day > peakRun.day)) peakRun = r;
    }
    if (peakRun != null) {
      const pw = mondayOfDay(peakRun.day);
      const s = weekLongRunShare(ctx, pw, floorFor(pw));
      peakOversized = s != null && Math.abs(s.longKm - round1(peakRun.km)) < 1e-6;
      // Wave 22e: was the peak the long run the plan asked for? At most that week's planned long run (and the peak target) + 0.5 km, and at
      // most half of its week. "Peak reached" is praise only for a run that kept to the plan.
      const peakWeekPlan = pw === w || depth >= MAX_PLAN_DEPTH ? null : planWeek(ctx, pw, depth + 1);
      const plannedKm = peakWeekPlan?.longRunKm ?? (pw === w ? plannedNextKm : null);
      const weekKm = Math.max(weekRuns(ctx, pw).km, floorFor(pw));
      const sharePct = weekKm > 0 ? Math.round((peakRun.km / weekKm) * 100) : 0;
      // (A week with under 3 run days has no rhythm to hold a plan or a share against: the long run is most of it by nature, as for the watch note.)
      const rhythm = weekRuns(ctx, pw).days >= LONG_RUN_SHARE_MIN_RUN_DAYS;
      const longerThanWeek = rhythm && plannedKm != null && peakRun.km > plannedKm + PEAK_PLAN_SLACK_KM + 1e-9;
      const longerThanTarget = lr0.targetPeakKm != null && peakRun.km > lr0.targetPeakKm + PEAK_PLAN_SLACK_KM + 1e-9;
      const tooBig = rhythm && weekKm > 0 && peakRun.km > weekKm * LONG_RUN_MAX_WEEK_SHARE + 1e-9;
      // The plan number it broke: the long run its week planned, else the peak target; null when only the share is to blame.
      const brokenKm = longerThanWeek ? plannedKm : longerThanTarget ? lr0.targetPeakKm : null;
      peakPlan = { plannedKm, sharePct, within: !longerThanWeek && !longerThanTarget && !tooBig, brokenKm };
    }
  }

  const longRun: PlanLongRun = {
    ...lr0,
    raceTargetKm,
    nextKm,
    capNoteDue,
    held: buildLike && (cutback != null || longRunJump != null || (untrimmedNextKm != null && lr0.lastKm != null && untrimmedNextKm <= lr0.lastKm + 1e-9)),
    share,
    shareDue: share != null && share.weekStart === prevStart && ctx.today === w,
    peakOversized,
    peakPlan,
  };
  const windInfo: EnduranceWeekPlan['wind'] = wind ? { phase: wind.phase as 'taper' | 'race_week' | 'recovery', info: wind, peakKm: ctx.peakKm ?? ctx.goalKm } : null;
  const band = bandFor(targetKm, ctx, medianKm, windInfo, mode, { comebackFromKm: comeback != null ? prev.km : null, cutbackNormalKm: cutback?.normalKm ?? null });
  // The last day of a pre-taper week that is done and short: it is "easing off" too (not a target still to hit), so the headline, the plan line
  // and the coach all say the same thing ("Taper starts tomorrow - no need to make up this week's km").
  if (depth === 0 && preTaper != null && wind == null && lightWeek == null && targetKm != null && ctx.today === weekEnd) {
    const done = weekRuns(ctx, w).km;
    // (Wave 23e: not while the week's long run is still to come and would make the week - the last day is not over before it.)
    const longRunWouldMakeIt = longRunAhead && plannedNextKm != null && done + plannedNextKm >= band.goodFromKm - 1e-9;
    if (easingOff != null) easingOff = { ...easingOff, lastDay: true };
    else if (done > 0 && !longRunWouldMakeIt && gradeEnduranceWeek({ kind, targetKm, band, endedOff, restart, goalKm: ctx.goalKm, cutback, comeback, upTo }, done, { unitsPerKm: ctx.units }).gap === 'short') {
      easingOff = { reason: 'late_week', daysOff: 0, longRunKm: null, taperLongRunKm: null, lastDay: true };
    }
  }
  const stepPct = targetKm != null && hasPrior && stepBaseKm >= compareMin && !wind && cutback == null && hold?.ceiling !== true
    ? Math.round(((targetKm - stepBaseKm) / stepBaseKm) * 100)
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
    // On a break a gap-based restart week quotes "if you restart tomorrow" (the same window, the gap + 1); the week's own number once back.
    restartKm: kind === 'restart' && targetKm != null
      ? (onBreak && breakGapShown != null && restart != null && restart.reason !== 'low_week' ? restartFor(restartWindow, breakGapShown).km : targetKm)
      : breakRestart.km,
    restartLong: (() => {
      const gap = onBreak ? breakGapShown : kind === 'restart' ? restart?.gapDays ?? null : null;
      return gap != null && restartFractionFor(gap) === RESTART_LONG_FRACTION;
    })(),
    longRunJump,
    goalReachedBefore: goalReachedBefore(ctx, w),
    lastAtGoal: hasPrior && prev.km >= ctx.goalKm - LAST_AT_GOAL_SLACK_KM,
    taperHold: wind?.phase === 'taper' && hasPrior && targetKm != null && Math.abs(targetKm - prev.km) <= TAPER_HOLD_SLACK_KM + 1e-9,
    raceDaysToGo,
    stepPct,
    stepBaseKm,
    hold,
    wind: windInfo,
    rebuild,
    cutback,
    buildWeeks,
    cutbackOwed,
    strides,
    lightWeek,
    preTaper,
    easingOff,
    upTo,
    longRunAhead,
    longRunTrim,
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
  plan: Pick<EnduranceWeekPlan, 'kind' | 'targetKm' | 'band' | 'endedOff' | 'restart' | 'goalKm'> & Partial<Pick<EnduranceWeekPlan, 'cutback' | 'comeback' | 'upTo'>>,
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
  // Regaining the pre-break level in a RESTART week is never a spike. A comeback week has no such exemption (wave 22e): it is read
  // against its own "up to" ceiling - well over it is a spike even below the pre-break median - and otherwise like any build week.
  const medianGuard = plan.restart?.medianKm ?? 0;
  if (plan.upTo === true && plan.comeback != null && comebackCapRead({ upTo: true, targetKm: target, goalKm: plan.goalKm, comeback: plan.comeback }, km, units) === 'well') {
    return { level: 'mixed', gap: 'spike' };
  }
  // A cutback week's target is the cutback number: it is the step a jump is measured against, like any other week's.
  if (plan.band.overKm != null && isSpikeWeek(km, target, plan.goalKm, units) && km > medianGuard) {
    return { level: 'mixed', gap: 'spike' };
  }
  // A cutback week that ran more than 10% over its lowered number became a normal week (wave 22e: the cutback was "skipped"). Wave 23e: that is no failure - a
  // good week, not a spike - but the gap 'over' stays so the next week holds at the week the cutback replaced and the cutback is still owed.
  if (plan.cutback != null && km > target * CUTBACK_SKIPPED_FRACTION + 1e-9) return { level: 'good', gap: 'over' };
  // A cutback week that ended in days off before it reached even its (lowered) number is a rest week, not a good cutback.
  if (plan.cutback != null && plan.endedOff && km < target) return { level: 'light', gap: null };
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
