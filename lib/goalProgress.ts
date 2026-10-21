/**
 * Vital — goal progress (pure, no DB or Next.js imports)
 *
 * Answers "am I actually getting where I want to go?" for one user, in plain
 * English, grounded only in numbers that exist. `computeGoalProgress` takes
 * already-loaded data (weigh-ins, intake, lifts, sessions, vitals) and returns
 * the JSON shape served by GET /api/goal/progress. The thin DB loader lives in
 * lib/goalProgressLoader.ts so this module stays unit-testable with no
 * DATABASE_URL.
 *
 * Reuses, rather than re-derives:
 *  - lib/weightTrend.ts — the EWMA-smoothed trend + rate-of-change helpers.
 *  - lib/brain/weightSignals.ts — plateau / too_fast_loss / under_eating /
 *    weekend_overeating assessment and its named thresholds.
 *  - lib/workoutRepository.ts's ProgressionSummary (weekly best e1RM per lift).
 *
 * Honesty rule: never invent a number. Anything unknown is null; verdicts that
 * cannot be supported by the data fall back to 'insufficient_data' or
 * 'needs_target'. A weigh-in older than 14 days supports no weight verdict, a
 * reached target says so ('reached') instead of reading as "ahead", and "last
 * 4 weeks" stats shrink to the age of a newer goal.
 *
 * Per goal:
 *  - weight_loss — the PACE is a least-squares line through the raw weigh-ins of
 *    the last 21 days (lib/weightPace.ts: 6 weigh-ins over 14 days), judged against
 *    the 0.25–1.0 %bw/wk safe band. The smoothed trend only draws the chart. A goal
 *    under 3 weeks old (or too few weigh-ins) gets an early read — no ETA, no
 *    ahead/behind. "N weeks ahead/behind" is stated only when the pace as of today
 *    and as of 7 days ago agree; paces on opposite sides of the target date say
 *    "on track for" the target date itself, and the call changes only after two
 *    consecutive weigh-ins make it. A gap of 7+ days without a weigh-in, a 3-week raw
 *    plateau and a reached target (7-day mean or trend, sticky) have their own reads.
 *    A pace survives a gap (28-day window for up to 7 days after the last valid one);
 *    "too fast" is entered at >1%/wk on both paces and left below 0.9%, and within a
 *    kilo of the target it becomes "Nearly there — start easing calories toward
 *    maintenance". Progress (changeKg, progressPct, "to go", the early read, the coach
 *    and the opener) is measured from ONE weight: the 7-day raw mean, else the scale —
 *    and that is `current.weightKg` too (the chart's smoothed trend is `current.trendKg`).
 *    THE WEEK'S PLAN (lib/weightWeekPlan.ts `weightWeekPlan`, like the endurance one) decides
 *    the call — early / pace / plateau / moving again / returning / reached / maintenance,
 *    ahead / on pace / behind / too fast, the date and the ONE action — once a week, from the
 *    weigh-ins through the Sunday before it (the card, the opener, the coach lines and the
 *    weekly review all read it). Only daily FACTS move daily: the weekly average, the kilos
 *    to go, the weigh-in count, today's scale. A projection more than 8 weeks past the target
 *    date quotes no date ("the date won't hold"); the 14 days after a plateau are "moving
 *    again" (no date, no "behind", no trim); a plateau's cause is judged over its own weeks
 *    and kept; "Set a new target or switch to maintenance" is asked in the first week after
 *    the target is reached, then a held weight on real intake becomes the maintenance target.
 *  - muscle — lift e1RM progression (top 3 lifts), weight gain band
 *    0.1–0.5 %bw/wk, sessions/week vs target, protein-target days.
 *  - endurance — with a weekly distance target and measured running, ONE week plan
 *    (lib/enduranceProgression.ts `enduranceWeekPlan`, the same plan the weekly
 *    review, the coach lines and the coach opener read) decides everything: the
 *    week's kind (baseline, build, hold, restart, maintain, taper, race week,
 *    recovery, rebuild), its km target (`distance.stepTargetKm`), the long run,
 *    the verdict and the headline. The race phase and every target are read on the
 *    MONDAY of the calendar week, whatever day it is. The verdict rests on the last
 *    FINISHED week against its own plan, never on a rolling 14-day comparison or on
 *    how much of the current week has been run: 'building' on a build / baseline /
 *    restart / rebuild week, 'on_track' at the weekly goal and in a taper / race
 *    week / recovery week within its band, 'holding' on a jump over the safe step
 *    (this week so far, or last week's: the hold week), 'behind' only when last
 *    week was far short of its own step (never on a break, restart or rebuild).
 *    Growth is ONE number — the finished week against the one before, "21 km last
 *    week (+11%), on plan" — the same one the review quotes. Race day says "start
 *    relaxed", a race-length run on race day says "done". Goals without a weekly
 *    distance target (or without any measured run) keep the training-volume trend
 *    (ENDURANCE_VOLUME_WINDOW_LABEL), sessions/week, resting HR / HRV direction.
 *    With a race, the long-run build (the longest run of the last 14 days vs a
 *    distance-based peak target) is a reason right behind the race countdown, and
 *    in taper / race week it says the peak long run is done. No new verdict values.
 *    Wave 21e, still the one plan: a LIGHT week (4+ days without a run in the week,
 *    or from Friday well behind the runner's own pace) is 'holding' - "don't make it
 *    up", long run capped - never 'on track for the half'; every 4th calendar week of
 *    building is a CUTBACK (~80% of the week it replaces, graded as its own target);
 *    a careful comeback's target is a ceiling ("up to ~18 km") graded against the
 *    week before; the race eve carries no km of the week at all (`thisWeekKm` null,
 *    `distance.text` "Race tomorrow"); the last day of a taper week says the week is
 *    done; the long-run cap note is said in the goal's first build week and then every
 *    4th (`longRun.capNoteDue`); a long run over 55% of its week is one watch note and
 *    never a [good] peak (`longRun.oversized`); sessions are counted in whole calendar
 *    weeks ("3 or 4 runs a week so far"). All additive: no new verdict values.
 *  - general — consistency: active days, sleep-goal nights, logging days.
 */

import type { WeightReading } from './weightTrend';
import { arrowPair, withUnit } from './displayText';
import { computeWeightTrend, trendDeltaKgPerWeek, trendDeltaSpanDays, trendSpanDays } from './weightTrend';
import {
  ON_PACE_MARGIN_DAYS,
  PACE_MIN_SPAN_DAYS,
  PACE_MIN_WEIGH_INS,
  PACE_SETTLE_DAYS,
  PACE_WINDOW_DAYS,
  RETURN_WEIGH_INS_NEEDED,
  meanOver,
  weighInReturn,
  weightReachedRead,
  type WeighInReturn,
  type WeightPace,
} from './weightPace';
import {
  FAT_LOSS_MIN_PCT,
  PLATEAU_SPAN_DAYS,
  WEEK_MEAN_MIN_WEIGH_INS,
  fmtWeekday,
  weightWeekPlan,
  type WeightPlanPace,
  type WeightWeekPlan,
} from './weightWeekPlan';
import {
  assessWeightSignals,
  PARTIAL_LOG_KCAL_THRESHOLD,
  PLATEAU_MAX_PCT_PER_WEEK,
  TOO_FAST_LOSS_PCT_PER_WEEK,
  type WeightSignal,
} from './brain/weightSignals';
import type { ProgressionSummary } from './workoutRepository';
import {
  isDeloadWeek,
  isLiftProgressing,
  furthestBehindReturn,
  isLiftStalled,
  liftChange4w,
  liftDisplayChange,
  liftDisplayName,
  liftLapseMinDays,
  liftLastBest,
  liftRecentEndWeek,
  liftReturnDisplay,
  liftReturnStates,
  liftShortName,
  pickHeadlineLift,
  pickWeekOverWeek,
  rankLifts,
  weekOverWeekWording,
  type LiftReturnDisplay,
  type LiftReturnState,
} from './liftChange';
import { weekStartKeyForDay } from './localDay';
import { KM_PER_MILE } from './metricFormat';
import {
  PHASE_CEILING_TOLERANCE,
  RACE_EVE_LINE,
  enduranceWeekPlan,
  RACE_EVE_CONSERVATIVE_LINE,
  RACE_EVE_HEAVY_WEEK,
  TAPER_GOOD_MIN_FRACTION,
  LONG_RUN_MAX_WEEK_SHARE,
  racePaceReps,
  findRaceRun,
  formatRaceTime,
  formatTargetLongRun,
  gradeEnduranceWeek,
  isWindDownPhase,
  longRunCapNote,
  longRunPeakTarget,
  longRunStats,
  longRunTargetKm as longRunTargetKmFor,
  longRunWord,
  mondayOfDay,
  overCapPhrase,
  CUTBACK_SKIPPED_FRACTION,
  planWeekKm,
  racePhaseInfo,
  racePhaseTargetKm,
  raceRules,
  recoveryWeek,
  roundLongRunKm,
  weekStepOrGoalKm,
  type EnduranceWeekKind,
  type EnduranceWeekPlan,
  type LongRunShare,
  type PlanRun,
  type RacePhase,
  type RacePhaseInfo,
} from './enduranceProgression';

// ── Constants ───────────────────────────────────────────────────────────────

/** Weigh-ins needed (over >= RATE_MIN_SPAN_DAYS) before a rate or ETA is quoted. */
export const WEIGH_INS_NEEDED = 3;
export const RATE_MIN_SPAN_DAYS = 7;
/** Trend window (days) the weekly rate is measured over. */
export const RATE_WINDOW_DAYS = 28;

/** Safe weekly body-weight change bands, % of bodyweight per week. */
export const FAT_LOSS_BAND = { minPct: FAT_LOSS_MIN_PCT, maxPct: TOO_FAST_LOSS_PCT_PER_WEEK } as const;
export const MUSCLE_GAIN_BAND = { minPct: 0.1, maxPct: 0.5 } as const;

/** ETA beyond this many days is not quoted (a near-flat trend projects absurd dates). */
const MAX_ETA_DAYS = 3650;
/**
 * ONE margin for "ahead" / "on pace" / "behind": an ETA within this many days of the
 * target date (either side) is on pace. The same figure iOS GoalProgressLogic and the
 * coach opener use, so the card, the opener and the app never disagree about a week.
 */
export const ON_PACE_GRACE_DAYS = ON_PACE_MARGIN_DAYS;
/** A logged day counts as calorie-adherent when kcal <= target x this. */
const CALORIE_ADHERENCE_TOLERANCE = 1.05;
/** A day counts as hitting the protein target at >= this fraction of it. */
const PROTEIN_HIT_FRACTION = 0.9;
/** Minimum logged days in the last 7 before an adherence/protein reason is shown. */
const MIN_LOGGED_DAYS_FOR_ADHERENCE = 3;
/** Learned-vs-formula TDEE gap (kcal/day) worth surfacing. */
const TDEE_GAP_MIN_KCAL = 100;
/** Volume change (%) at/above which endurance training reads as 'building'. */
const ENDURANCE_BUILDING_PCT = 5;
/** Sessions in the last 28 days needed before endurance/general verdicts are called. */
const MIN_SESSIONS_FOR_ENDURANCE = 3;
/** Resting HR move (bpm) / HRV move (%) between the two 14-day halves that counts as a direction. */
const RHR_DIRECTION_BPM = 1;
const HRV_DIRECTION_PCT = 5;
/** Sleep night counts as meeting the goal at >= this fraction of it. */
const SLEEP_GOAL_FRACTION = 0.9;
/** Consistency-composite gain (0–1) that reads as 'building' for the general goal. */
const GENERAL_BUILDING_DELTA = 0.05;
/** Planned-session adherence (%) below which the reason is a watch; below LOW the verdict gets an amber lead reason. */
const ADHERENCE_WATCH_PCT = 75;
const ADHERENCE_LOW_PCT = 60;
/** Muscle verdict: below this 4-week session adherence (%) a lift gain reads "Lifts up, sessions behind", not "Progressing". */
const ADHERENCE_BEHIND_PCT = 70;
export const HEADLINE_MAX_CHARS = 70;
/**
 * Weigh-in staleness. Older than STALE the trend is an out-of-date picture: the
 * weight verdict becomes insufficient_data ("Last weigh-in N days ago…"). From
 * AGING (up to STALE) the verdict is kept but no projected date is quoted and a
 * "Based on a weigh-in N days ago" reason is added.
 */
export const WEIGH_IN_AGING_DAYS = 7;
export const WEIGH_IN_STALE_DAYS = 14;
/** Reached-goal copy: within this many kg of the target reads as "Holding at ... inside your target range"; a reached target stays reached until the trend leaves it. */
const HOLDING_NEAR_TARGET_KG = 1;
/** The scale counts as "down" on the start weight from this many kg. */
const EARLY_DOWN_MIN_KG = 0.1;
/** Longest window (days) the "last 4 weeks" stats look back; a younger goal shrinks it to its age. */
const STAT_WINDOW_DAYS = 28;
/** Planned-session adherence is never judged over less than one week. */
const MIN_SESSION_WINDOW_DAYS = 7;

// ── Types ───────────────────────────────────────────────────────────────────

export type GoalKind = 'weight_loss' | 'muscle' | 'endurance' | 'general';

export type GoalVerdict =
  | 'reached'
  | 'on_track'
  | 'ahead'
  | 'too_fast'
  | 'behind'
  | 'stalled'
  | 'progressing'
  | 'building'
  | 'holding'
  | 'needs_target'
  | 'insufficient_data';

export type ReasonTone = 'good' | 'watch' | 'neutral';

export interface GoalDistanceProgress {
  targetKm: number;
  /** Running distance this local calendar week (Mon–today); null when no run in the last 28 days carries a distance. */
  thisWeekKm: number | null;
  /** Mean weekly distance over the trailing 28 days; null without distance data. */
  avg4wKm: number | null;
  /** Local Monday of the week thisWeekKm covers. */
  weekStart: string;
  /**
   * This week's safe step toward `targetKm`, from LAST week's running km (the
   * shared rule in lib/enduranceProgression.ts — the same ~27 km the weekly
   * review's "Next week" says for this week). Equals `targetKm` when last week
   * was already within 10% of it or there is no last-week data. The progress
   * bar runs to this number. During taper, race week and recovery it is that
   * phase's weekly target instead (a share of the peak week — see
   * `racePhaseTargetKm`), never the growth step.
   */
  stepTargetKm: number;
  /**
   * e.g. "22.7 of ~27 km running this week · goal 30 km" when the step is below
   * the goal, "24.5 of 30 km running this week" when it is the goal (mi for
   * imperial users); "15 km so far · baseline week" in the first week of running.
   */
  text: string;
  /**
   * The week plan behind `stepTargetKm` and the headline (lib/enduranceProgression.ts
   * `enduranceWeekPlan`), additive: absent on payloads from before it and
   * without any measured running.
   */
  plan?: GoalWeekPlan;
}

/** What this calendar week is for: the plan the card, the weekly review and the coach all read. */
export interface GoalWeekPlan {
  /** baseline | build | hold | restart | maintain | taper | race_week | recovery | rebuild. */
  kind: EnduranceWeekKind;
  /** The week's running target, km; null in a baseline week (no earlier week to take a step from). */
  targetKm: number | null;
  /** The next long run, km; null when there is none to plan (baseline, race week, recovery, nothing run lately). */
  longRunKm: number | null;
  /** One line: what the week is for ("~27 km this week: long run 15 km, the rest easy runs"). */
  purpose: string;
  /**
   * Additive: the actual step this week's target is over last week's running, in whole percent (+13 for a
   * 17 -> 19 km step); null / absent when last week was too small to compare or the week has no step (baseline,
   * taper, race week, recovery).
   */
  stepPct?: number | null;
  /** Additive: the pre-break weekly km the weeks after a restart climb back to (restart -> 80% -> 100%); null / absent otherwise. */
  comebackKm?: number | null;
  /** Additive: false while the runner has never run the weekly goal in a training week (then a "maintain" week is still building to it). */
  goalReachedBefore?: boolean;
  /** Additive: a cutback week (every 4th plain build / maintain week): `targetKm` is ~80% of the week it replaces, the long run is held. */
  cutback?: boolean;
  /** Additive: a light week - 4+ days without a run, or well behind the week's pace from Thursday with the rest of the target out of reach: don't make it up (`longRunKm` is the cap). */
  lightWeek?: boolean;
  /**
   * Additive (wave 22e): the week BEFORE a taper (or race week) whose target is out of reach or that has days off: easing off is fine,
   * never "light". `longRunKm` is the week's planned long run, `taperLongRunKm` the taper's own (the lower end of "~11.5-15 km").
   */
  easingOff?: boolean;
  taperLongRunKm?: number | null;
  /** Additive (wave 22e): the next Monday starts a taper / race week (this is the last build week); absent otherwise. */
  preTaper?: 'taper' | 'race_week';
  /** Additive: one of the last 2 build weeks before the taper: the plan copy asks for a few strides after one easy run. */
  strides?: boolean;
  /** Additive: the week's long run is held (not grown) - a cutback week, or after last week's long-run jump. */
  longRunHeld?: boolean;
  /** Additive: the target is a careful comeback's ceiling, worded "up to ~18 km". */
  upTo?: boolean;
  /**
   * Additive: last week ran more than 10% over its "up to" comeback ceiling. `overCapRead` says how far: 'touch' (fine, said once; the
   * ceiling climbs from the ceiling, never from the overshoot) or 'well' (a spike: this week is a hold AT that ceiling).
   */
  overCap?: boolean;
  overCapRead?: 'touch' | 'well';
  /** Additive (wave 22e): last week was a cutback that ran more than 10% over its lowered number, so this week holds at the week the cutback replaced. */
  skippedCutback?: boolean;
  /** Additive (wave 22e): on a break, the restart number "if you restart tomorrow" when it differs from the week's own `targetKm` (a lower band past two weeks off). */
  restartKm?: number;
}

export interface GoalRaceProgress {
  /** Race day, YYYY-MM-DD (user-local). */
  date: string;
  distanceKm: number | null;
  /** "Half marathon" | "Marathon" | "10K" | "5K" | "<n> km race" | "Race" (no distance). */
  label: string;
  /** Whole weeks to go; 0 during race week (fewer than 7 days out) and once the race is done. */
  weeksToGo: number;
  /** Days to race day; 0 on race day and once the race is done (then see `daysSince`). */
  daysToGo: number;
  /**
   * Where the race sits in build -> taper -> race week -> recovery (the shared
   * calendar rule in lib/enduranceProgression.ts `racePhase`). Additive:
   * absent on payloads from before the race lifecycle.
   */
  phase?: RacePhase;
  /** Recovery only: whole days since race day (1–14). Absent before and on race day. */
  daysSince?: number;
  /**
   * The race itself, once a run of at least 90% of the race distance is logged on
   * race day (or the day before / after): its km and, when known, its minutes.
   * Additive: absent before the race is run.
   */
  completed?: { km: number; durationMin: number | null } | null;
}

export interface GoalLongRunProgress {
  /** The longest run of the last 14 days (the race itself excluded), km. */
  lastKm: number;
  /** Longest single run in the last 28 days, km. */
  peakKm: number;
  /** Peak long-run distance to build to before the taper (by race distance); null without a race distance. */
  targetPeakKm: number | null;
  /** The next long run from the week plan: min(lastKm + 2 km, the peak target); additive, absent when there is none to plan. */
  nextKm?: number | null;
  /**
   * Additive: the race-distance peak (e.g. 18 km for a half) when the weekly goal cannot carry it — a long run is at
   * most half of a week, so `targetPeakKm` is then what fits (15 km at a 30 km goal). Absent / null when the peak fits.
   */
  raceTargetKm?: number | null;
  /** Additive: the long-run cap note ("Your 30 km weeks fit a 15 km long run...") is due this week (first build week, then every 4th). */
  capNoteDue?: boolean;
  /** Additive: the 28-day peak long run was over 55% of its own week - never praised as a good peak. */
  oversized?: boolean;
}

export interface GoalProgressReason {
  /** e.g. 'rate', 'lift', 'adherence', 'reached', 'position', 'next_step' (reached goals: "Set a new target or switch to maintenance"). */
  kind: string;
  text: string;
  tone: ReasonTone;
}

/**
 * How the card read the scale, additive to the payload (older clients ignore it).
 * Every surface that words the weight story — the coach lines, the opener, the
 * weekly review — reads these instead of re-deriving them.
 */
export interface GoalWeightRead {
  /**
   * What kind of read the verdict is:
   *  - 'early'     goal under 3 weeks old (or too few weigh-ins for a pace): the scale vs the start, no pace, no ETA
   *  - 'returning' 7+ days without a weigh-in, fewer than 3 weigh-ins back: no too fast / behind
   *  - 'plateau'   three flat weeks of raw weekly means
   *  - 'moving_again' (additive) the 14 days after a plateau ends, the weekly average falling again: no date, no "behind"
   *  - 'pace'      a least-squares pace over the last 3 weeks of raw weigh-ins
   *  - 'reached'   the target is reached
   * Null for a goal without a weight read (or no usable weigh-in).
   */
  state: 'early' | 'returning' | 'plateau' | 'moving_again' | 'pace' | 'reached' | null;
  /** The newest raw weigh-in (kg) and its day; null with none. */
  scaleKg: number | null;
  scaleDay: string | null;
  /** Mean of the raw weigh-ins in the 7 days up to the newest one (kg); null with fewer than 3. */
  weekMeanKg: number | null;
  /**
   * Weeks the stated ETA is ahead (positive) or behind (negative) the target date,
   * rounded to whole weeks; 0 = on pace (the stated ETA is then the target date itself,
   * also when the two paces disagree about which side of it they land). Null whenever
   * no ahead/behind claim is made (early read, unconfirmed pace, no ETA, no target date).
   */
  weeksVsTarget: number | null;
  /** After 7+ days without a weigh-in, until 3 weigh-ins are back; null otherwise. */
  returned: { gapDays: number; sinceDay: string; sinceKg: number; weighInsSince: number } | null;
  /** Days from `reachedAt` to the newest day (0 = reached today); null when not reached or the crossing is unknown. */
  reachedDaysAgo: number | null;
  /**
   * Additive. Calendar days the goal has run (start day and today counted); null when its start is unknown.
   * Lets a reader tell "the pace settles after 3 weeks" (young goal) from "a few more weigh-ins" (older one).
   */
  goalAgeDays?: number | null;
  /** Additive. Days the quoted pace was fitted over (21; 28 while a gap in weigh-ins is bridged); null without a pace. */
  paceWindowDays?: number | null;
  /**
   * Additive, weight_loss only. The logged-day calorie picture: in a plateau, the logs of the plateau's own weeks
   * that named its cause (`low` = the logged days ran over the budget; kept for the whole plateau); otherwise the
   * last 7 days. The average of the logged days against the budget. Null without a calorie target or 3+ logged days.
   */
  intake?: { avgKcal: number; targetKcal: number; loggedDays: number; daysWithinTarget: number; low: boolean } | null;
  /**
   * Additive, weight_loss only. This week's plan (lib/weightWeekPlan.ts): decided once a week from the weigh-ins through
   * the Sunday before it, and read by the card, the opener, the coach lines and the weekly review, so none of them can
   * disagree inside a week. `state` here may be `moving_again` (an unknown state to a client that predates it).
   */
  plan?: WeightWeekPlan | null;
}

export interface GoalProgress {
  goal: GoalKind;
  target: { weightKg: number | null; date: string | null; weeklySessions: number | null; weeklyDistanceKm: number | null };
  /** Endurance with a weekly distance target only; null otherwise. Distances in km, `text` is unit-aware. */
  distance: GoalDistanceProgress | null;
  /**
   * Endurance with a race date that has not passed, or passed within the last
   * 14 days (phase 'recovery'); null otherwise.
   */
  race?: GoalRaceProgress | null;
  /** Endurance with running distances in the last 28 days; null otherwise. Running only, km. */
  longRun?: GoalLongRunProgress | null;
  current: {
    /**
     * weight_loss: the ONE weight the card measures from — the 7-day raw mean (3+ weigh-ins), else the latest scale
     * reading — the same one `changeKg`, `progressPct` and the headline's "to go" use; the smoothed trend is `trendKg`.
     * Other goals: the smoothed trend.
     */
    weightKg: number | null;
    startWeightKg: number | null;
    changeKg: number | null;
    progressPct: number | null;
    /** Additive, weight_loss only: the smoothed trend (what the chart draws; it lags the scale by about ten days). */
    trendKg?: number | null;
  };
  ratePerWeek: { kg: number | null; pctBodyweight: number | null };
  safeBand: { minPct: number; maxPct: number } | null;
  eta: string | null;
  onPaceForTargetDate: boolean | null;
  verdict: GoalVerdict;
  headline: string;
  reasons: GoalProgressReason[];
  /** Days since the newest weigh-in (0 = today); null with none. The ETA is anchored to that day, not to today. */
  lastWeighInDaysAgo?: number | null;
  /**
   * Days since the newest session in the trailing 28 days (strength sessions
   * for a muscle goal); null when there was none in that window.
   */
  lastSessionDaysAgo?: number | null;
  /**
   * Additive: the local day (YYYY-MM-DD) of that newest session — the date behind
   * `lastSessionDaysAgo` (same 28-day window, null when there was none), so the
   * coach can say "Last strength session 8 days ago (Apr 25)" without a clock.
   */
  lastSessionOn?: string | null;
  /**
   * Weight goals (weight_loss / muscle) whose weight target is currently
   * reached: the local day (YYYY-MM-DD) of the first trend point that crossed
   * the target since the goal started. Null when the target is not reached,
   * the weigh-in is stale, or the crossing is unknown (e.g. the goal started
   * already past the target, or no weigh-in before the crossing).
   */
  reachedAt?: string | null;
  /** How the weight verdict was read (see GoalWeightRead); null for goals without one. Additive: absent on older payloads. */
  weightRead?: GoalWeightRead | null;
  /**
   * Muscle goal with a weekly sessions target only; null/absent otherwise.
   * The structured numbers behind the `adherence` reason and the muscle
   * `behind` verdict (pct < ADHERENCE_BEHIND_PCT; the verdict's call is made as of the last Monday or session,
   * `sessionsBehindPct`, so on a day with nothing new this live count can sit under the line a day before the verdict follows), so a client can say WHY the
   * goal is behind and what to aim for ("9 of 16 sessions in 4 wk · aim for 4
   * this week") without parsing reason copy. `planned` = weeklyTarget x the
   * window in weeks (4 for an established goal, fewer while the goal is new).
   */
  adherence?: GoalSessionAdherence | null;
  /**
   * Muscle goal only, additive: set when the user took a break of 10+ days in a
   * row without a strength session and came back within the last 35 days. While
   * the headline lift is still under its pre-break best (`regained: false`) the
   * verdict is 'building' ("Building back") and no stall or drop is called;
   * once it is back above it (`regained: true`) the card says so until the 35
   * days are over. Null / absent otherwise.
   */
  liftReturn?: GoalLiftReturn | null;
  /**
   * Muscle goal only, additive: the return from that same break lift by lift —
   * the headline lift first (identical to `liftReturn`), then the other main
   * lifts (squat, bench press, deadlift, overhead press) that were trained
   * before the break and since. "Back above your pre-break best" is claimed only
   * when every entry is `regained`; with some back and some not the headline
   * names both ("Squat back above pre-break; deadlift at 98% …"). Null when
   * `liftReturn` is; absent for every other goal.
   */
  liftReturns?: GoalLiftReturn[] | null;
  dataSufficiency: { weighIns: number; needed: number; sessionsLast28d: number };
}

export interface GoalLiftReturn {
  /** Canonical key of the lift this is about ("squat"). */
  exercise: string;
  /** Display name ("Squat"). */
  name: string;
  /** Days in a row without a strength session. */
  breakDays: number;
  /** Last day of the break, YYYY-MM-DD (user-local). */
  endedOn: string;
  /** Best estimated 1RM in the 4 weeks before the break, kg. */
  preBreakKg: number;
  /** Best estimated 1RM since the return, kg. */
  recentKg: number;
  /** Whole percent of the pre-break best (under 100 while rebuilding). */
  pct: number;
  /** True once the lift is back at or above its pre-break best. */
  regained: boolean;
}

export interface GoalSessionAdherence {
  /** Sessions done in the window (the trailing 28 days, or since a younger goal began; never under 7 days). */
  done: number;
  /** Planned sessions over the same window (weeklyTarget x windowDays / 7, rounded). */
  planned: number;
  weeklyTarget: number;
  /** done / planned, whole percent. */
  pct: number;
  /** Days the window covers: 28 for an established goal, fewer (min 7) for a new one. */
  windowDays: number;
}

export interface GoalProgressIntakeDay {
  day: string;
  kcal: number | null;
  proteinG: number | null;
  source: 'logged' | 'healthkit' | 'none';
}

export interface GoalProgressBudget {
  targetKcal: number | null;
  proteinG: number | null;
  /** Sex-aware low-energy floor (dietBudget.lowEnergyThresholdKcal). */
  floorKcal: number;
  formulaTdee: number | null;
  learnedTdee: number | null;
  /** 'none' | 'low' | 'medium' | 'high' — learnedExpenditure confidence. */
  tdeeConfidence: string | null;
}

export interface DayValue {
  day: string;
  value: number;
}

export interface GoalProgressInput {
  goal: GoalKind;
  /** User-local today, YYYY-MM-DD. */
  todayKey: string;
  target: { weightKg: number | null; date: string | null; weeklySessions: number | null; weeklyDistanceKm?: number | null };
  /** Endurance only: optional race (see GoalProgress.race). Does not affect the verdict. */
  race?: { date: string | null; distanceKm: number | null } | null;
  /**
   * Endurance: running workouts with a distance over a longer history than
   * `workouts` (~10 weeks, the loader supplies it) — the week plan needs the
   * weeks before last week (restart median, spike → hold, baseline). Absent
   * (tests, old callers): the running `workouts` stand in.
   */
  runHistory?: Array<{ day: string; km: number; durationMin?: number | null }>;
  /**
   * Endurance with a race: the biggest weekly running km (km) in the 4 weeks
   * before the taper began (`peakWeekKmBeforeTaper`, from a longer history than
   * `workouts` — the loader supplies it). The taper / race-week / recovery
   * targets are shares of it. Null / absent: the weekly distance goal stands in.
   */
  racePeakWeekKm?: number | null;
  /**
   * `weightKg` null with `startedAt` set means no weigh-in existed when the goal
   * began; the start weight is then derived from the first weigh-in on/after
   * the start day (`startedDay`, user-local; defaults to startedAt's date).
   */
  start: { weightKg: number | null; startedAt: string | null; startedDay?: string | null };
  /** Raw weigh-ins; ~90 days gives the EWMA run-in room. */
  weightReadings: WeightReading[];
  /** Resolved intake for the trailing 28 local days (any order). */
  intakeDays: GoalProgressIntakeDay[];
  /**
   * weight_loss, additive: resolved intake over a longer history (the loader supplies ~70 days). A plateau's cause is
   * judged over its own weeks and kept while it lasts, which needs the logs from when it began; absent (tests, old
   * callers): `intakeDays` stands in.
   */
  intakeHistoryDays?: GoalProgressIntakeDay[];
  budget: GoalProgressBudget | null;
  progression: ProgressionSummary;
  /** Distinct local days with a completed session (logged strength set or real HealthKit workout), trailing 28 days. */
  trainingDays: string[];
  /**
   * Muscle goal only: distinct local days with a STRENGTH session (logged sets
   * or a HealthKit strength workout — see isStrengthWorkoutType). When present
   * the muscle goal counts these instead of every HealthKit workout.
   */
  strengthDays?: string[];
  /**
   * Muscle goal only, additive: strength-session days over a longer history
   * (the loader passes the last ~84 days of logged sets plus the 28 days of
   * HealthKit strength workouts). Used to find a break of 10+ days and the
   * return from it; absent -> only `strengthDays` / `trainingDays` are used.
   */
  strengthHistoryDays?: string[];
  /** HealthKit workouts, trailing 28 days (durationMin null when unknown; `type` is the HealthKit name, e.g. "Running"). */
  workouts: Array<{ day: string; durationMin: number | null; distanceKm?: number | null; type?: string | null }>;
  /** exercise key -> display name (e.g. "bench press" -> "Bench Press"); falls back to Title Case. */
  exerciseDisplay?: Record<string, string>;
  restingHr: DayValue[];
  hrv: DayValue[];
  sleepMinutes: DayValue[];
  sleepGoalMinutes: number;
  /**
   * Display unit for weight numbers in `headline` / `reasons` text only
   * ('imperial' → lb, otherwise kg). Structured numeric fields stay in kg.
   */
  unitSystem?: 'metric' | 'imperial' | null;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** HealthKit workout type names (see HealthKitBackfill.workoutTypeName) that are strength sessions. */
export function isStrengthWorkoutType(type: string | null | undefined): boolean {
  return type != null && /strength/i.test(type);
}

/** Endurance distance counts running only (type names are HealthKit's, e.g. "Running"). */
export function isRunningWorkoutType(type: string | null | undefined): boolean {
  return type != null && /^running$/i.test(type.trim());
}

/** Days that count as a session for the goal: strength sessions only for muscle. */
function sessionDays(input: GoalProgressInput): string[] {
  return input.goal === 'muscle' && input.strengthDays ? input.strengthDays : input.trainingDays;
}

export const KG_TO_LB = 2.20462;

/** A kg value converted to the input's display unit and rounded, no unit suffix. */
function weightNum(input: GoalProgressInput, kg: number, digits: 1 | 2 = 1): number {
  const v = input.unitSystem === 'imperial' ? kg * KG_TO_LB : kg;
  return digits === 2 ? round2(v) : round1(v);
}

/** Formats a kg value in the input's display unit, e.g. "72.5 kg" / "159.8 lb". */
function fmtWeight(input: GoalProgressInput, kg: number, digits: 1 | 2 = 1): string {
  return withUnit(weightNum(input, kg, digits), input.unitSystem === 'imperial' ? 'lb' : 'kg');
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function addDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 10", or "Dec 10, 2027" when the year differs from `todayKey`'s. */
function fmtDate(day: string, todayKey: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const base = `${MONTHS[m - 1]} ${d}`;
  return y === Number(todayKey.slice(0, 4)) ? base : `${base}, ${y}`;
}

function clip(text: string): string {
  if (text.length <= HEADLINE_MAX_CHARS) return text;
  return `${text.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function fmtKcal(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function inLastDays(day: string, todayKey: string, n: number): boolean {
  const age = dayNumber(todayKey) - dayNumber(day);
  return age >= 0 && age < n;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function capReasons(candidates: Array<GoalProgressReason | null>): GoalProgressReason[] {
  return candidates.filter((r): r is GoalProgressReason => r != null).slice(0, 3);
}

// ── Goal-age windows ────────────────────────────────────────────────────────
// "Last 4 weeks" stats must not pretend a goal that began 9 days ago has 28
// days behind it: they shrink to the goal's age (a sessions window never under
// one week), and their copy names the real span.

/** User-local day the goal began (YYYY-MM-DD), null when unknown. */
function goalStartDay(input: GoalProgressInput): string | null {
  const day = input.start.startedDay ?? (input.start.startedAt ? input.start.startedAt.slice(0, 10) : null);
  return day != null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Calendar days the goal has been running, counting the start day and today (>= 1); null when the start is unknown. */
function goalAgeDays(input: GoalProgressInput): number | null {
  const start = goalStartDay(input);
  if (start == null) return null;
  return Math.max(1, dayNumber(input.todayKey) - dayNumber(start) + 1);
}

/** Days a "last 4 weeks" stat looks back: 28, or the goal's age while it is younger than that. */
function statWindowDays(input: GoalProgressInput): number {
  const age = goalAgeDays(input);
  return age == null ? STAT_WINDOW_DAYS : Math.min(STAT_WINDOW_DAYS, age);
}

/** Window for session counts and planned-session adherence: statWindowDays, but never under one week. */
function sessionWindowDays(input: GoalProgressInput): number {
  return Math.max(MIN_SESSION_WINDOW_DAYS, statWindowDays(input));
}

/** "4 weeks" for a full window, else "N days". */
function windowSpanText(days: number): string {
  return days >= STAT_WINDOW_DAYS ? '4 weeks' : `${days} ${plural(days, 'day')}`;
}

// ── Weight block (shared by every goal) ─────────────────────────────────────

interface WeightBlock {
  weighIns: number;
  spanDays: number;
  rateReliable: boolean;
  trend: ReturnType<typeof computeWeightTrend>;
  currentKg: number | null;
  /** weight_loss: the pace (kg/wk) from raw weigh-ins, null without one; other goals: the 28-day trend rate. */
  rateKg: number | null;
  /** Signed: negative = losing. */
  pctBw: number | null;
  /** Calendar days the quoted rate really spans (< RATE_WINDOW_DAYS for a short history); null without a rate. */
  rateSpanDays: number | null;
  /** Target reached for this goal's direction (null when no target weight / no current weight). */
  reached: boolean | null;
  /** targetWeight - current weight (signed), null when unknown. weight_loss measures from the 7-day mean, not the lagging trend. */
  neededKg: number | null;
  /**
   * Projected date, anchored to the newest weigh-in (never moved forward to
   * today). Used for the verdict; the payload hides it once the weigh-in is
   * `aging` or `stale`. weight_loss: only a STATED date (both paces agree; or the
   * target date itself while on pace).
   */
  eta: string | null;
  onPace: boolean | null;
  /** Newest weigh-in day (YYYY-MM-DD), null with none. */
  lastWeighInDay: string | null;
  /** Days from the newest weigh-in to today; null with none. */
  ageDays: number | null;
  /** Newest weigh-in is older than WEIGH_IN_STALE_DAYS: the weight picture is out of date. */
  stale: boolean;
  /** Newest weigh-in is WEIGH_IN_AGING_DAYS..WEIGH_IN_STALE_DAYS old: verdict kept, no ETA. */
  aging: boolean;
  /** First day of the current reached stretch (lib/weightPace.ts weightReachedRead); null when not reached / unknown. */
  reachedAt: string | null;
  /** Newest raw weigh-in, kg. */
  scaleKg: number | null;
  /** Mean of the raw weigh-ins in the 7 days up to the newest one; null with fewer than 3. */
  weekMeanKg: number | null;
  /**
   * The ONE weight progress is measured from: the 7-day raw mean, else the latest scale reading. Behind weight_loss
   * `current.changeKg` / `progressPct`, "to go", the early-read "down X", the coach's "since start" and the opener.
   */
  progressKg: number | null;
  /**
   * weight_loss only: this week's plan (lib/weightWeekPlan.ts), null for other goals or without enough weigh-ins. The
   * call (state, ahead / behind / too fast), the date and the action are decided once a week and read from here by
   * the card, the opener, the coach lines and the weekly review; the daily facts (the weekly average, the kilos to
   * go, the scale) stay on this block and update every day.
   */
  plan: WeightWeekPlan | null;
  /** weight_loss only: the newest gap of 7+ days without a weigh-in and the weigh-ins since (a daily fact). */
  ret: WeighInReturn | null;
}

/** True when `kg` has reached `targetKg` for the goal's direction (within 0.1 kg counts). Only goals without a weight verdict use this. */
function weightReachedTarget(goal: GoalKind, targetKg: number, kg: number): boolean {
  const needed = targetKg - kg;
  if (Math.abs(needed) < 0.1) return true;
  if (goal === 'weight_loss') return needed > 0;
  if (goal === 'muscle') return needed < 0;
  return false;
}

function buildWeightBlock(input: GoalProgressInput): WeightBlock {
  const trend = computeWeightTrend(input.weightReadings);
  const days = trend.days;
  const weighIns = days.length;
  const spanDays = trendSpanDays(days);
  const rateReliable = weighIns >= WEIGH_INS_NEEDED && spanDays >= RATE_MIN_SPAN_DAYS;
  const currentKg = days.length > 0 ? days[days.length - 1].trendKg : null;
  const lastWeighInDay = days.length > 0 ? days[days.length - 1].day : null;
  const ageDays = lastWeighInDay != null ? Math.max(0, dayNumber(input.todayKey) - dayNumber(lastWeighInDay)) : null;
  const stale = ageDays != null && ageDays > WEIGH_IN_STALE_DAYS;
  const aging = ageDays != null && ageDays >= WEIGH_IN_AGING_DAYS && !stale;

  let rateKg = rateReliable ? trendDeltaKgPerWeek(days, RATE_WINDOW_DAYS) : null;
  let rateSpanDays = rateKg != null ? trendDeltaSpanDays(days, RATE_WINDOW_DAYS) : null;
  let pctBw = rateKg != null && currentKg != null && currentKg > 0 ? (rateKg / currentKg) * 100 : null;

  const targetKg = input.target.weightKg;
  let neededKg = currentKg != null && targetKg != null ? targetKg - currentKg : null;

  const weightGoal = input.goal === 'weight_loss' || input.goal === 'muscle';
  let reached: boolean | null = null;
  let reachedAt: string | null = null;
  if (currentKg != null && targetKg != null) {
    if (weightGoal) {
      // Reached = the 7-day raw mean OR the trend is within a hair of the target (lib/weightPace.ts); it stays reached
      // until the trend later leaves the holding range, so one high reading cannot flip it back.
      const r = weightReachedRead(days, {
        targetKg, gain: input.goal === 'muscle', lapseKg: HOLDING_NEAR_TARGET_KG, startDay: goalStartDay(input),
      });
      reached = r.reached;
      reachedAt = r.reached && !stale ? r.reachedAt : null;
    } else {
      reached = weightReachedTarget(input.goal, targetKg, currentKg);
    }
  }

  // The progress weight is rounded ONCE, here, to the 0.1 kg every surface prints it at: `changeKg`, `progressPct`, "to go", the
  // headline's "down X", the coach lines, the opener (which reads `weightRead.weekMeanKg`, the same number) and the review all
  // derive from it. Rounding only at display time put "down 1 kg" (off 91.05) next to "0.9 of 8 kg" (off the printed 91.1).
  const scaleKg = days.length > 0 ? round1(days[days.length - 1].rawKg) : null;
  const week = lastWeighInDay != null ? meanOver(days, lastWeighInDay, 7) : null;
  const weekMeanKg = week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? round1(week.meanKg) : null;
  const progressKg = weekMeanKg ?? scaleKg;

  // ETA only with a reliable rate pointing toward the target, a meaningful
  // (non-plateau) pace, and a sane horizon.
  let eta: string | null = null;
  if (
    reached === false && neededKg != null && rateKg != null && pctBw != null &&
    Math.sign(rateKg) === Math.sign(neededKg) && Math.abs(pctBw) > PLATEAU_MAX_PCT_PER_WEEK
  ) {
    const daysToGo = Math.ceil((Math.abs(neededKg) / Math.abs(rateKg)) * 7);
    // Anchored to the newest weigh-in, not today: a skipped weigh-in day must
    // not push the ETA later without any new data. And never pushed FORWARD to
    // today either: a projection that already lies in the past would otherwise
    // "beat" any target date. A stale weigh-in simply hides the date (see
    // `aging` / `stale`).
    if (daysToGo <= MAX_ETA_DAYS) eta = addDays(lastWeighInDay ?? input.todayKey, daysToGo);
  }

  let onPace: boolean | null = null;
  if (input.target.date != null) {
    if (reached === true) onPace = true;
    else if (eta != null) onPace = eta <= addDays(input.target.date, ON_PACE_GRACE_DAYS);
    else if (reached === false && rateReliable) onPace = false; // moving the wrong way / flat
  }

  // weight_loss reads the raw scale instead (the trend above only draws the chart), through the week's plan.
  let plan: WeightWeekPlan | null = null;
  const ret = input.goal === 'weight_loss' ? weighInReturn(days, goalStartDay(input)) : null;
  if (input.goal === 'weight_loss' && lastWeighInDay != null && rateReliable) {
    plan = weightWeekPlan({
      todayKey: input.todayKey,
      days,
      startDay: goalStartDay(input),
      startKg: input.start.weightKg ?? deriveStartWeightKg(days, input.start),
      targetKg,
      targetDate: input.target.date,
      reached: reached === true,
      reachedAt,
      unitSystem: input.unitSystem,
      intakeDays: input.intakeHistoryDays ?? input.intakeDays,
      targetKcal: input.budget?.targetKcal ?? null,
      floorKcal: input.budget?.floorKcal ?? null,
      formulaTdee: input.budget?.formulaTdee ?? null,
      weeklySessions: input.target.weeklySessions,
    });
    if (plan != null) {
      rateKg = plan.pace != null ? plan.pace.kgPerWeek : null;
      pctBw = plan.pace != null ? plan.pace.pctPerWeek : null;
      rateSpanDays = null;
      neededKg = progressKg != null && targetKg != null ? targetKg - progressKg : null;
      eta = reached === true ? null : plan.etaDate;
      onPace = input.target.date == null ? null : reached === true ? true : plan.onPace;
    }
  }

  return {
    weighIns, spanDays, rateReliable, trend, currentKg, rateKg, pctBw, rateSpanDays, reached, neededKg,
    eta, onPace, lastWeighInDay, ageDays, stale, aging, reachedAt, scaleKg, weekMeanKg, progressKg, plan, ret,
  };
}

// ── Intake helpers ──────────────────────────────────────────────────────────

function lastSevenIntake(input: GoalProgressInput): GoalProgressIntakeDay[] {
  return input.intakeDays.filter(d => inLastDays(d.day, input.todayKey, 7));
}

function toSignalPoints(days: GoalProgressIntakeDay[]) {
  return days.map(d => ({ day: d.day, kcal: d.kcal, source: d.source }));
}

// ── Reason builders ─────────────────────────────────────────────────────────

/** A weekly weight trend under this share of bodyweight (as printed, 2 decimals) is "flat", not a direction. */
const RATE_FLAT_PCT = 0.05;

function rateReason(input: GoalProgressInput, w: WeightBlock, band: { minPct: number; maxPct: number } | null): GoalProgressReason | null {
  if (w.rateKg == null || w.pctBw == null) return null;
  // Thresholds are compared against the number that is printed (2 decimals),
  // so "0.1% a week" can never sit next to "under the 0.1% a week floor".
  const abs = round2(Math.abs(w.pctBw));
  const flat = abs < RATE_FLAT_PCT;
  const dir = flat ? 'flat' : w.rateKg < 0 ? 'down' : 'up';
  // The rate is measured over the history that exists: under 4 weeks of
  // weigh-ins says the real span ("over 9 days").
  const span = windowSpanText(w.rateSpanDays ?? RATE_WINDOW_DAYS);
  let text = `Trend weight ${dir} ${fmtWeight(input, Math.abs(w.rateKg), 2)}/wk (${abs}% of bodyweight) over ${span}`;
  let tone: ReasonTone = 'neutral';
  if (band) {
    const wantedDir = input.goal === 'weight_loss' ? w.rateKg < 0 : w.rateKg > 0;
    if (!flat && wantedDir && abs >= band.minPct && abs < band.maxPct) {
      tone = 'good';
      text += `, inside the ${band.minPct}–${band.maxPct}% safe band`;
    } else if (!flat && wantedDir && abs >= band.maxPct) {
      // At (not just above) the top of the band is already worth a flag.
      tone = 'watch';
      text += `, at or above the ${band.maxPct}% a week ceiling`;
    } else if (flat || wantedDir) {
      tone = 'neutral';
      text += `, under the ${band.minPct}% a week floor`;
    } else {
      tone = 'watch';
      text += ', the opposite way from your goal';
    }
  }
  return { kind: 'rate', text, tone };
}

/** The logged days of the last 7 against the calorie target; null without a target or 3+ logged days. */
function calorieAdherenceStats(input: GoalProgressInput): { target: number; hit: number; logged: number; avgKcal: number; frac: number } | null {
  const target = input.budget?.targetKcal;
  if (target == null) return null;
  const logged = lastSevenIntake(input).filter(
    d => d.source !== 'none' && d.kcal != null && d.kcal >= PARTIAL_LOG_KCAL_THRESHOLD,
  );
  if (logged.length < MIN_LOGGED_DAYS_FOR_ADHERENCE) return null;
  const hit = logged.filter(d => (d.kcal as number) <= target * CALORIE_ADHERENCE_TOLERANCE).length;
  const avgKcal = (mean(logged.map(d => d.kcal as number)) as number);
  return { target, hit, logged: logged.length, avgKcal, frac: hit / logged.length };
}

function calorieAdherenceReason(input: GoalProgressInput): GoalProgressReason | null {
  const stats = calorieAdherenceStats(input);
  if (stats == null) return null;
  const { target, hit, logged, frac } = stats;
  return {
    kind: 'calorie_adherence',
    text: `Stayed within your ${withUnit(fmtKcal(target), 'kcal')} target on ${hit} of ${logged} logged ${plural(logged, 'day')} this week`,
    tone: frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral',
  };
}

/** Under this share of the logged days within the target, with the average over it, calorie adherence is "low". */
const CALORIE_ADHERENCE_LOW_FRACTION = 0.5;

/** The additive `weightRead.intake`: the logged-day calorie picture behind the plateau advice (null when there is none). */
function intakeRead(input: GoalProgressInput): GoalWeightRead['intake'] {
  const stats = calorieAdherenceStats(input);
  if (stats == null) return null;
  return {
    avgKcal: Math.round(stats.avgKcal),
    targetKcal: stats.target,
    loggedDays: stats.logged,
    daysWithinTarget: stats.hit,
    low: stats.frac < CALORIE_ADHERENCE_LOW_FRACTION && stats.avgKcal > stats.target,
  };
}

function signalReasons(signals: WeightSignal[]): { weekend: GoalProgressReason | null; underEating: GoalProgressReason | null } {
  const wk = signals.find(s => s.kind === 'weekend_overeating');
  const ue = signals.find(s => s.kind === 'under_eating');
  return {
    weekend: wk
      ? {
          kind: 'weekend_overeating',
          text: `Weekends average ${withUnit(fmtKcal(Number(wk.facts.weekendAvgKcal)), 'kcal')} vs ${fmtKcal(Number(wk.facts.weekdayAvgKcal))} on weekdays`,
          tone: 'watch',
        }
      : null,
    underEating: ue
      ? {
          kind: 'under_eating',
          text: `Average intake of ${withUnit(fmtKcal(Number(ue.facts.avgKcal)), 'kcal')} is under the ${withUnit(fmtKcal(Number(ue.facts.floorKcal)), 'kcal')} safe floor`,
          tone: 'watch',
        }
      : null,
  };
}

function tdeeReason(input: GoalProgressInput): GoalProgressReason | null {
  const b = input.budget;
  if (!b || b.formulaTdee == null || b.learnedTdee == null) return null;
  if (b.tdeeConfidence !== 'medium' && b.tdeeConfidence !== 'high') return null;
  const gap = b.learnedTdee - b.formulaTdee;
  if (Math.abs(gap) < TDEE_GAP_MIN_KCAL) return null;
  return {
    kind: 'tdee',
    text: `Your logs suggest you burn about ${withUnit(fmtKcal(b.learnedTdee), 'kcal')} a day, ${withUnit(fmtKcal(Math.abs(gap)), 'kcal')} ${gap < 0 ? 'less' : 'more'} than the ${withUnit(fmtKcal(b.formulaTdee), 'kcal')} formula estimate`,
    tone: 'neutral',
  };
}

/** Distinct session days in the trailing `windowDays` local days (today included). */
function sessionCount(input: GoalProgressInput, windowDays: number): number {
  return new Set(sessionDays(input).filter(d => inLastDays(d, input.todayKey, windowDays))).size;
}

/**
 * `count` is always the trailing 28 days (dataSufficiency, the endurance
 * gate); `perWeek` averages over the goal-aware window (sessionWindowDays), so
 * a goal that began 10 days ago is not divided by four weeks.
 */
function sessionsPerWeek(input: GoalProgressInput): { count: number; perWeek: number } {
  const windowDays = sessionWindowDays(input);
  return {
    count: sessionCount(input, STAT_WINDOW_DAYS),
    perWeek: round1(sessionCount(input, windowDays) / (windowDays / 7)),
  };
}

function sessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  const { perWeek } = sessionsPerWeek(input);
  const windowDays = sessionWindowDays(input);
  const span = windowSpanText(windowDays);
  const target = input.target.weeklySessions;
  if (sessionCount(input, windowDays) === 0) {
    return { kind: 'sessions', text: `No training sessions logged in the last ${span}`, tone: 'watch' };
  }
  if (target == null) {
    return { kind: 'sessions', text: `Averaging ${perWeek} ${plural(perWeek, 'session')} a week over the last ${span}`, tone: 'neutral' };
  }
  return {
    kind: 'sessions',
    text: `Averaging ${perWeek} ${plural(perWeek, 'session')} a week vs your target of ${target}`,
    tone: perWeek >= target ? 'good' : perWeek >= target * 0.75 ? 'neutral' : 'watch',
  };
}

/**
 * Planned-session adherence: done / (weekly target x window in weeks). The
 * window is the trailing 28 days for an established goal; a goal that began
 * fewer than 28 days ago is judged over the days it has existed (never under
 * one week), so a new user is not measured against four weeks of plan.
 */
function sessionAdherence(input: GoalProgressInput): GoalSessionAdherence | null {
  const target = input.target.weeklySessions;
  if (target == null || target <= 0) return null;
  const windowDays = sessionWindowDays(input);
  const done = sessionCount(input, windowDays);
  const planned = Math.max(1, Math.round((target * windowDays) / 7));
  return { done, planned, weeklyTarget: target, pct: Math.round((done / planned) * 100), windowDays };
}

/**
 * The 28-day count slides: a session ages out of it every day the lifter does not train, so "11 of 16 (69%)" can undercut the
 * 70% line on a Tuesday that brought no news at all - and the verdict, which was "Progressing" on Monday, turned over a day before
 * the lapse turned it again. The "sessions behind" CALL is therefore made as of the last day the window learned something: this
 * week's Monday (a calendar week began) or the last session logged, whichever is later. The same window, the same 70% line - it
 * just does not move on days with nothing new in them. (The adherence line and `adherence` payload keep the live count; a call
 * of "behind" always has that count under 70% too, since between those days the live count can only fall.)
 */
function sessionsBehindPct(input: GoalProgressInput): number | null {
  const target = input.target.weeklySessions;
  if (target == null || target <= 0) return null;
  const monday = weekStart(input.todayKey);
  const last = lastSessionDay(input);
  const asOf = last != null && last > monday ? last : monday;
  const windowDays = sessionWindowDays(input);
  // The sessions of the ~84 days of history the loader already holds (the trailing 28 days alone cannot see a window that ended days ago).
  const days = new Set([...(input.strengthHistoryDays ?? []), ...sessionDays(input)]);
  const done = [...days].filter(d => inLastDays(d, asOf, windowDays)).length;
  const planned = Math.max(1, Math.round((target * windowDays) / 7));
  return Math.round((done / planned) * 100);
}

/** The goal is in its first 28 days: its sessions are counted in calendar weeks (see adherenceReason). False when its start is unknown. */
function isYoungGoal(input: GoalProgressInput): boolean {
  const age = goalAgeDays(input);
  return age != null && age < STAT_WINDOW_DAYS;
}

/** The goal's first full week (7 days) has not been completed yet: nothing is judged against the plan, so no watch tone and no "behind". */
function firstWeekOpen(input: GoalProgressInput): boolean {
  const age = goalAgeDays(input);
  return age != null && age < MIN_SESSION_WINDOW_DAYS;
}

/**
 * The sessions line, for every goal that has a weekly sessions target.
 *
 *  - Established goal (28+ days): "9 of 16 planned sessions in 4 weeks (56%)"
 *    — watch under 75%. Past the plan it reads "17 sessions in 4 weeks, past
 *    your 16 planned (106%)": a count is never shown against a smaller plan.
 *  - First 28 days: calendar weeks, not a plan prorated to a part-week
 *    ("6 of 5 planned in 9 days" jumped around daily): "This week 2 of 4 (6
 *    since Mar 2)" — the count since the goal began shows only once there are
 *    sessions before this week, and the card's headline carries no count of its
 *    own. It is judged (the usual 75% / 90% tones, on the same numbers as the
 *    verdict) only once the first full week is done; before that it is never
 *    amber.
 */
function adherenceReason(input: GoalProgressInput): GoalProgressReason | null {
  const a = sessionAdherence(input);
  if (!a) return null;
  if (isYoungGoal(input)) {
    const start = weekStart(input.todayKey);
    const thisWeek = new Set(sessionDays(input).filter(d => d >= start && d <= input.todayKey)).size;
    const shown = Math.min(thisWeek, a.weeklyTarget);
    const open = firstWeekOpen(input);
    // A young goal always has a known start (isYoungGoal): the sessions since it, when any came before this week.
    const began = goalStartDay(input) as string;
    const sinceStart = new Set(sessionDays(input).filter(d => d >= began && d <= input.todayKey)).size;
    const since = sinceStart > thisWeek ? ` (${sinceStart} since ${fmtDate(began, input.todayKey)})` : '';
    return {
      kind: 'adherence',
      text: `This week ${shown} of ${a.weeklyTarget}${since}`,
      tone: open ? (thisWeek >= a.weeklyTarget ? 'good' : 'neutral') : a.pct >= 90 ? 'good' : a.pct >= ADHERENCE_WATCH_PCT ? 'neutral' : 'watch',
    };
  }
  const span = windowSpanText(a.windowDays);
  return {
    kind: 'adherence',
    text: a.done > a.planned
      ? `${a.done} ${plural(a.done, 'session')} in ${span}, past your ${a.planned} planned (${a.pct}%)`
      : `${a.done} of ${a.planned} planned ${plural(a.planned, 'session')} in ${span} (${a.pct}%)`,
    tone: a.pct >= 90 ? 'good' : a.pct >= ADHERENCE_WATCH_PCT ? 'neutral' : 'watch',
  };
}

/** Monday (UTC calendar) of the week containing `day`. */
function weekStart(day: string): string {
  const dow = (new Date(dayNumber(day) * 86_400_000).getUTCDay() + 6) % 7; // Mon = 0
  return addDays(day, -dow);
}

/** "2 of 4 sessions this week" (Mon–today) vs the weekly target. Null without a target. */
function weekSessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  const target = input.target.weeklySessions;
  if (target == null) return null;
  const start = weekStart(input.todayKey);
  const done = new Set(sessionDays(input).filter(d => d >= start && d <= input.todayKey)).size;
  return {
    kind: 'week_sessions',
    // Never "5 of 4": a session past the plan is still a hit of the plan.
    text: `${Math.min(done, target)} of ${target} ${plural(target, 'session')} this week`,
    tone: done >= target ? 'good' : 'neutral',
  };
}

/**
 * The muscle goal's "2 of 4 sessions this week": the shared line, amber once the
 * week can no longer reach the target — sessions so far plus the days left in
 * the week (today included) are under it ("0 of 4 sessions this week (last: Apr
 * 25)"). The 28-day line stays neutral through a missed week ("13 of 16 planned
 * sessions", 81%), so without this a Friday with no session read "Progressing".
 */
function muscleWeekSessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  const reason = weekSessionsReason(input);
  const target = input.target.weeklySessions;
  if (!reason || target == null) return reason;
  const start = weekStart(input.todayKey);
  const done = new Set(sessionDays(input).filter(d => d >= start && d <= input.todayKey)).size;
  const daysLeft = 7 - (dayNumber(input.todayKey) - dayNumber(start));
  if (done >= target || done + daysLeft >= target) return reason;
  const last = lastSessionDay(input);
  return { ...reason, text: `${reason.text}${last ? ` (last: ${fmtDate(last, input.todayKey)})` : ''}`, tone: 'watch' };
}

function proteinReason(input: GoalProgressInput): GoalProgressReason | null {
  const target = input.budget?.proteinG;
  if (target == null || target <= 0) return null;
  const logged = lastSevenIntake(input).filter(d => d.source !== 'none' && d.proteinG != null && (d.kcal ?? 0) >= PARTIAL_LOG_KCAL_THRESHOLD);
  if (logged.length < MIN_LOGGED_DAYS_FOR_ADHERENCE) return null;
  const hit = logged.filter(d => (d.proteinG as number) >= target * PROTEIN_HIT_FRACTION).length;
  const frac = hit / logged.length;
  return {
    kind: 'protein',
    text: `Hit your ${withUnit(Math.round(target), 'g')} protein target on ${hit} of ${logged.length} logged ${plural(logged.length, 'day')} this week`,
    tone: frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral',
  };
}

// ── Lift progression (muscle) ───────────────────────────────────────────────

interface LiftChange {
  exercise: string;
  /** Display name (Title Case / the user's own). */
  name: string;
  totalSets: number;
  /** Best e1RM 4 weeks ago (baseline window) vs the last 2 weeks; see lib/liftChange.ts. Null when either window is empty. */
  startKg: number | null;
  endKg: number | null;
  change4wKg: number | null;
  /** Up at least 1% on 4 weeks ago (lib/liftChange.ts isLiftProgressing). */
  up: boolean;
  /** The shared stall rule (lib/liftChange.ts isLiftStalled) for this lift: below +1%, not a break / return, not a deload. */
  stalled: boolean;
}

/**
 * The lifts the card talks about: the 3 most-trained lifts in rotation
 * (lib/liftChange.ts rankLifts), the shared headline lift (the most-trained one
 * that has a comparison) first. A lift without a 4-week comparison is listed
 * with null numbers, never silently dropped, so a claim about "every lift" can
 * be checked against it.
 */
function liftChanges(progression: ProgressionSummary, todayKey: string, display?: Record<string, string>): LiftChange[] {
  const anchor = weekStartKeyForDay(todayKey);
  const headlineKey = pickHeadlineLift(progression, anchor)?.exercise ?? null;
  const out: LiftChange[] = rankLifts(progression, anchor).map(exercise => {
    const weeks = progression[exercise];
    const c = liftChange4w(weeks, anchor);
    return {
      exercise,
      name: liftDisplayName(exercise, display),
      totalSets: weeks.reduce((sum, w) => sum + w.totalSets, 0),
      startKg: c?.baselineKg ?? null,
      endKg: c?.recentKg ?? null,
      change4wKg: c?.changeKg ?? null,
      up: c != null && isLiftProgressing(c),
      stalled: isLiftStalled(weeks, anchor),
    };
  });
  const head = out.find(l => l.exercise === headlineKey);
  const rest = out.filter(l => l !== head);
  return (head ? [head, ...rest] : rest).slice(0, 3);
}

function liftReason(l: LiftChange, input: GoalProgressInput): GoalProgressReason | null {
  const d = displayLift(l, input);
  if (d == null) return null;
  return {
    kind: 'lift',
    text: `${l.name} est. 1RM ${d.change === 0 ? 'unchanged' : liftDeltaText(d)} vs 4 weeks ago (${arrowPair(String(d.baseline), withUnit(d.recent, d.unit))})`,
    // Good = up 1%+ (the verdict's bar); a drop is only amber when it is a real stall, not a deload or a return from a break.
    tone: l.up ? 'good' : d.change < 0 && l.stalled ? 'watch' : 'neutral',
  };
}

interface LiftDisplay { baseline: number; recent: number; change: number; unit: string }

/** Whole-unit display numbers for a lift's 4-week change; the change is computed from the rounded endpoints. */
function displayLift(l: LiftChange, input: GoalProgressInput): LiftDisplay | null {
  if (l.change4wKg == null || l.startKg == null || l.endKg == null) return null;
  const imperial = input.unitSystem === 'imperial';
  const d = liftDisplayChange({ baselineKg: l.startKg, recentKg: l.endKg, changeKg: l.change4wKg }, imperial);
  return { ...d, unit: imperial ? 'lb' : 'kg' };
}

/** "+9 kg" / "−3 lb" (always signed). */
function liftDeltaText(d: LiftDisplay): string {
  return `${d.change < 0 ? '−' : '+'}${withUnit(Math.abs(d.change), d.unit)}`;
}

// ── Vitals direction (endurance) ────────────────────────────────────────────

function halves(series: DayValue[], todayKey: string): { recent: number[]; prior: number[] } {
  const recent: number[] = [];
  const prior: number[] = [];
  for (const p of series) {
    if (inLastDays(p.day, todayKey, 14)) recent.push(p.value);
    else if (inLastDays(p.day, todayKey, 28)) prior.push(p.value);
  }
  return { recent, prior };
}

function restingHrReason(input: GoalProgressInput): GoalProgressReason | null {
  const { recent, prior } = halves(input.restingHr, input.todayKey);
  if (recent.length < 3 || prior.length < 3) return null;
  const r = mean(recent) as number;
  const p = mean(prior) as number;
  const diff = r - p;
  const dir = diff <= -RHR_DIRECTION_BPM ? 'trending down' : diff >= RHR_DIRECTION_BPM ? 'trending up' : 'steady';
  return {
    kind: 'resting_hr',
    text: `Resting heart rate ${dir}: ${arrowPair(String(round1(p)), withUnit(round1(r), 'bpm'))} (last 2 weeks vs the 2 before)`,
    tone: diff <= -RHR_DIRECTION_BPM ? 'good' : diff >= RHR_DIRECTION_BPM ? 'watch' : 'neutral',
  };
}

function hrvReason(input: GoalProgressInput): GoalProgressReason | null {
  const { recent, prior } = halves(input.hrv, input.todayKey);
  if (recent.length < 3 || prior.length < 3) return null;
  const r = mean(recent) as number;
  const p = mean(prior) as number;
  if (p <= 0) return null;
  const pct = ((r - p) / p) * 100;
  const dir = pct >= HRV_DIRECTION_PCT ? 'trending up' : pct <= -HRV_DIRECTION_PCT ? 'trending down' : 'steady';
  return {
    kind: 'hrv',
    text: `HRV ${dir}: ${arrowPair(String(Math.round(p)), withUnit(Math.round(r), 'ms'))} (last 2 weeks vs the 2 before)`,
    tone: pct >= HRV_DIRECTION_PCT ? 'good' : pct <= -HRV_DIRECTION_PCT ? 'watch' : 'neutral',
  };
}

// ── Per-goal verdicts ───────────────────────────────────────────────────────

interface Outcome {
  verdict: GoalVerdict;
  headline: string;
  reasons: GoalProgressReason[];
  /** Endurance week-plan outcomes already carry the race lifecycle (race line, phase line, race-done copy). */
  raceHandled?: boolean;
}

function insufficientWeightOutcome(w: WeightBlock): Outcome {
  const missing = Math.max(0, WEIGH_INS_NEEDED - w.weighIns);
  const headline = missing > 0
    ? `Log ${missing} more ${plural(missing, 'weigh-in')} to see your trend`
    : 'Keep weighing in for a week to read your trend';
  return {
    verdict: 'insufficient_data',
    headline: clip(headline),
    reasons: [{
      kind: 'data',
      text: `${w.weighIns} ${plural(w.weighIns, 'weigh-in')} so far; a trend needs ${WEIGH_INS_NEEDED} over at least ${RATE_MIN_SPAN_DAYS} days`,
      tone: 'neutral',
    }],
  };
}

/** Newest weigh-in older than WEIGH_IN_STALE_DAYS: no verdict from weight, just an honest nudge to weigh in. */
function staleWeighInOutcome(w: WeightBlock): Outcome {
  const n = w.ageDays ?? WEIGH_IN_STALE_DAYS + 1;
  return {
    verdict: 'insufficient_data',
    headline: clip(`Last weigh-in ${n} days ago — weigh in to update your progress`),
    reasons: [{ kind: 'weigh_in_age', text: `Your last weigh-in was ${n} days ago, so your trend may be out of date`, tone: 'neutral' }],
  };
}

/** "Based on a weigh-in N days ago" while the newest weigh-in is aging (WEIGH_IN_AGING_DAYS..WEIGH_IN_STALE_DAYS). */
function agingReason(w: WeightBlock): GoalProgressReason | null {
  if (!w.aging || w.ageDays == null) return null;
  return { kind: 'weigh_in_age', text: `Based on a weigh-in ${w.ageDays} days ago`, tone: 'neutral' };
}

// Reached-goal reasons ────────────────────────────────────────────────────

/** A weight with one fixed decimal in the display unit ("84.0 kg") — for averages, so a 84.0 never reads as "84". */
function fmtWeightFixed(input: GoalProgressInput, kg: number): string {
  return withUnit(weightNum(input, kg).toFixed(1), input.unitSystem === 'imperial' ? 'lb' : 'kg');
}

/** The reach itself, first in the reasons: the weekly average (the scale's honest average), never "trend ... is at or past". */
function reachedLeadReason(input: GoalProgressInput, w: WeightBlock, targetKg: number): GoalProgressReason {
  const since = w.reachedAt ? `, first reached ${fmtDate(w.reachedAt, input.todayKey)}` : '';
  const avg = w.weekMeanKg != null
    ? `weekly average ${fmtWeightFixed(input, w.weekMeanKg)}`
    : w.scaleKg != null
      ? `latest weigh-in ${fmtWeightFixed(input, w.scaleKg)}`
      : `trend ${fmtWeightFixed(input, w.currentKg as number)}`;
  return {
    kind: 'reached',
    text: `You hit ${fmtWeight(input, targetKg)} — ${avg}${since}`,
    tone: 'good',
  };
}

/** Where the weekly average sits relative to a reached target. Never green: continued movement past the target is not progress. */
function targetPositionReason(input: GoalProgressInput, w: WeightBlock, targetKg: number): GoalProgressReason {
  const holdKg = w.progressKg ?? (w.currentKg as number);
  const diff = holdKg - targetKg;
  if (Math.abs(diff) <= HOLDING_NEAR_TARGET_KG) {
    return {
      kind: 'position',
      text: `Holding at ${fmtWeightFixed(input, holdKg)}, within ${fmtWeight(input, HOLDING_NEAR_TARGET_KG)} of ${fmtWeight(input, targetKg)}`,
      tone: 'neutral',
    };
  }
  return { kind: 'position', text: `${diff < 0 ? 'Below' : 'Above'} target by ${fmtWeight(input, Math.abs(diff))}`, tone: 'neutral' };
}

function nextStepReason(): GoalProgressReason {
  return { kind: 'next_step', text: 'Set a new target or switch to maintenance', tone: 'neutral' };
}

/** The reached card's third reason: what the plan asks of a reached goal (a new target / maintenance first, then maintenance from real intake). */
function reachedActionReason(plan: WeightWeekPlan): GoalProgressReason | null {
  const a = plan.action;
  if (a.kind === 'next_target' || a.kind === 'maintenance_target' || (a.kind === 'hold' && a.kcalTarget != null)) {
    return { kind: 'next_step', text: a.text, tone: 'neutral' };
  }
  return null;
}

/** ", around Dec 10" — or "" while the weigh-in is aging (no date quoted) and "any day now" for a date already reached. */
function aroundText(input: GoalProgressInput, w: WeightBlock, eta: string): string {
  if (w.aging) return '';
  return eta <= input.todayKey ? ', any day now' : `, around ${fmtDate(eta, input.todayKey)}`;
}

// weight_loss reasons and outcomes (the pace is lib/weightPace.ts; the call and the action are the week's plan) ─────

/**
 * The pace against the safe band — the same rate the headline quotes, so the card never calls one rate both too fast and inside the band.
 * `tooFast`: the week's "too fast" call is on. The watch tone and "above the ceiling" wording belong to that call alone, so
 * a pace wobbling around 1% never flips the tone from one day to the next; with the call on, a pace between 0.9% and the ceiling
 * keeps the watch ("close to the ceiling", hysteresis) and is not called "safe".
 * `easeToMaintenance`: the target is reached and the loss is still past the ceiling, so the warning says what to do.
 */
function paceReason(
  input: GoalProgressInput,
  pace: Pick<WeightPace, 'kgPerWeek' | 'pctPerWeek' | 'windowDays'>,
  opts: { tooFast?: boolean; easeToMaintenance?: boolean } = {},
): GoalProgressReason {
  const dir = pace.kgPerWeek < 0 ? 'Down' : 'Up';
  // The shown figure decides the band: a rate printed as "1%" is never called "above the 1% ceiling".
  const abs = round2(Math.abs(pace.pctPerWeek));
  const band = FAT_LOSS_BAND;
  const weeks = Math.round(pace.windowDays / 7);
  let text = `${dir} ${fmtWeight(input, Math.abs(pace.kgPerWeek), 2)}/wk (${abs}% of bodyweight) over the last ${weeks} weeks`;
  let tone: ReasonTone = 'neutral';
  if (pace.kgPerWeek < 0) {
    if (opts.tooFast && abs > band.maxPct) {
      tone = 'watch';
      text += `, above the ${band.maxPct}% a week ceiling${opts.easeToMaintenance ? ' — ease calories toward maintenance' : ''}`;
    } else if (opts.tooFast && abs >= band.minPct) {
      tone = 'watch';
      text += `, close to the ${band.maxPct}% a week ceiling`;
    } else if (abs >= band.minPct && abs <= band.maxPct) {
      tone = 'good';
      text += `, inside the ${band.minPct}–${band.maxPct}% safe band`;
    } else if (abs > band.maxPct) {
      // Over the line by a hair, but the week is not calling it too fast: the top of the band, not a warning.
      text += `, at the top of the ${band.minPct}–${band.maxPct}% safe band`;
    } else {
      text += `, under the ${band.minPct}% a week floor`;
    }
  } else {
    tone = 'watch';
    text += ', the opposite way from your goal';
  }
  return { kind: 'rate', text, tone };
}

/** The week's one action as a card reason. */
function planActionReason(plan: WeightWeekPlan): GoalProgressReason {
  return { kind: 'action', text: plan.action.text, tone: 'neutral' };
}

/**
 * The smoothed trend, explained once: the first week a pace is read, where the chart's trend line (which lags the
 * scale by about ten days) starts to differ from the weekly average this card measures from. No trend number is
 * printed — the card has one weight, the weekly average.
 */
function trendExplainReason(plan: WeightWeekPlan): GoalProgressReason | null {
  if (!plan.firstPaceWeek) return null;
  return {
    kind: 'trend',
    text: "The chart's trend line smooths daily water swings, so it trails your weekly average a little",
    tone: 'neutral',
  };
}

/** "±1 kg" / "±2 lb": the everyday swing of the scale, in the display unit. */
function swingText(input: GoalProgressInput): string {
  const imperial = input.unitSystem === 'imperial';
  return `±${withUnit(Math.round(imperial ? 1 * KG_TO_LB : 1), imperial ? 'lb' : 'kg')}`;
}

/** How far the progress weight (the 7-day mean, else the scale) is below the goal's start weight (kg, positive = down); null without a start or a weigh-in. */
function scaleDownKg(input: GoalProgressInput, w: WeightBlock): number | null {
  const startKg = input.start.weightKg ?? deriveStartWeightKg(w.trend.days, input.start);
  return startKg != null && w.progressKg != null ? startKg - w.progressKg : null;
}

/** Days from the goal's first day (or the first weigh-in) to the newest weigh-in, at least 1. */
function earlyReadDays(input: GoalProgressInput, w: WeightBlock): number {
  const from = goalStartDay(input) ?? w.trend.days[0]?.day ?? input.todayKey;
  const to = w.lastWeighInDay ?? input.todayKey;
  return Math.max(1, dayNumber(to) - dayNumber(from));
}

/** Weigh-in days in the 21-day pace window ending at the newest weigh-in, and the calendar days they span. */
function paceWindowFacts(w: WeightBlock): { weighIns: number; spanDays: number } {
  const last = w.lastWeighInDay;
  if (last == null) return { weighIns: 0, spanDays: 0 };
  const inWindow = w.trend.days.filter(d => dayNumber(last) - dayNumber(d.day) < PACE_WINDOW_DAYS);
  const oldest = inWindow.reduce((min, d) => (d.day < min ? d.day : min), last);
  return { weighIns: inWindow.length, spanDays: dayNumber(last) - dayNumber(oldest) };
}

type ReasonBuilder = (...lead: Array<GoalProgressReason | null>) => GoalProgressReason[];

/**
 * Early read: a goal under 3 weeks old (or too few weigh-ins for a pace). The
 * progress weight against the start, no pace, no ETA, no ahead/behind: a week of
 * daily noise is not a pace, and "24 weeks behind" off day 7 is an alarm about
 * nothing. The progress weight is the 7-day average once there are 3 weigh-ins in
 * it — the headline says "weekly average", not "on the scale" — and the single
 * latest reading only before that.
 */
function earlyReadOutcome(input: GoalProgressInput, w: WeightBlock, plan: WeightWeekPlan, build: ReasonBuilder): Outcome {
  const down = scaleDownKg(input, w);
  const isDown = down != null && down >= EARLY_DOWN_MIN_KG;
  const swing = swingText(input);
  if (plan.young) {
    // The three weeks are up but the week's plan was made before they were: the pace is read on the coming Monday.
    const age = goalAgeDays(input);
    const readsOn = age != null && age >= PACE_SETTLE_DAYS ? fmtWeekday(addDays(plan.weekStart, 7), input.todayKey) : null;
    if (isDown) {
      const days = earlyReadDays(input, w);
      const what = w.weekMeanKg != null ? `weekly average down ${fmtWeight(input, down as number)}` : `down ${fmtWeight(input, down as number)} on the scale`;
      return {
        verdict: 'progressing',
        headline: clip(`Early read — ${what} in ${days} ${plural(days, 'day')}`),
        reasons: build({
          kind: 'pace_note',
          text: readsOn != null
            ? `Your pace is read on ${readsOn} — daily swings of ${swing} are normal`
            : `Your pace estimate settles after 3 weeks of weigh-ins — daily swings of ${swing} are normal`,
          tone: 'neutral',
        }),
      };
    }
    return {
      verdict: 'holding',
      headline: clip(`Early days — daily swings of ${swing} are normal`),
      reasons: build({ kind: 'pace_note', text: readsOn != null ? `Your pace is read on ${readsOn}` : 'Your pace settles after 3 weeks of weigh-ins', tone: 'neutral' }),
    };
  }
  // An older goal without a pace: say which of the two things it is short of. Too few weigh-ins in the last 3 weeks
  // ("pace needs 6 weigh-ins over 2 weeks"), or enough of them bunched into too few days ("pace needs 2 weeks of weigh-ins").
  const { weighIns: n, spanDays } = paceWindowFacts(w);
  const countShort = n < PACE_MIN_WEIGH_INS;
  const need = countShort ? 'pace needs 6 weigh-ins over 2 weeks' : `pace needs ${PACE_MIN_SPAN_DAYS / 7} weeks of weigh-ins`;
  const note: GoalProgressReason = {
    kind: 'pace_note',
    text: countShort
      ? `${n} ${plural(n, 'weigh-in')} in the last 3 weeks; a pace needs 6 spanning at least 2 weeks`
      : `${n} weigh-ins in the last 3 weeks, but they span only ${spanDays} ${plural(spanDays, 'day')}; a pace needs 6 spanning at least 2 weeks`,
    tone: 'neutral',
  };
  if (isDown) {
    return { verdict: 'progressing', headline: clip(`Down ${fmtWeight(input, down as number)} since the start — ${need}`), reasons: build(note) };
  }
  return { verdict: 'holding', headline: clip(`Scale is flat since the start — ${need}`), reasons: build(note) };
}

/** Back after 7+ days without a weigh-in: what the scale says, no verdict on pace until the next plan reads one. */
function returningOutcome(input: GoalProgressInput, w: WeightBlock, plan: WeightWeekPlan, build: ReasonBuilder): Outcome {
  const ret = w.ret as WeighInReturn;
  const since = fmtDate(ret.lastBeforeDay, input.todayKey);
  const delta = ret.lastBeforeKg - (w.scaleKg ?? ret.firstBackKg);
  const change = Math.abs(delta) < EARLY_DOWN_MIN_KG
    ? `the scale is about the same as ${since}`
    : `the scale is ${delta > 0 ? 'down' : 'up'} ${fmtWeight(input, Math.abs(delta))} since ${since}`;
  const down = scaleDownKg(input, w);
  const left = RETURN_WEIGH_INS_NEEDED - ret.weighInsSince;
  // The count of weigh-ins still missing is a daily fact; once they are back the pace is read on the next plan's Monday.
  const text = left > 0
    ? `Keep weighing in so your trend catches up — ${left} more ${plural(left, 'weigh-in')} before your pace is read again`
    : `Keep weighing in — your pace is read again on ${fmtWeekday(addDays(plan.weekStart, 7), input.todayKey)}`;
  return {
    verdict: down != null && down >= EARLY_DOWN_MIN_KG ? 'progressing' : 'holding',
    headline: clip(`Welcome back — ${change}`),
    reasons: build({ kind: 'pace_note', text, tone: 'neutral' }),
  };
}

/** Three flat weeks of raw weekly means: named as a plateau, with the week's one action and the cause it named. */
function plateauOutcome(input: GoalProgressInput, plan: WeightWeekPlan, build: ReasonBuilder): Outcome {
  return {
    verdict: 'holding',
    headline: clip(`Plateau — weekly average ~${fmtWeightFixed(input, plan.plateauMeanKg as number)} for 3 weeks`),
    reasons: build({ kind: 'plateau', text: plan.action.text, tone: 'neutral' }),
  };
}

/**
 * The scale is moving again after a plateau (the 14 days after it ends): the 21-day line still covers the flat weeks, so
 * it is not read — no date, no "behind", no trim. The weekly average against where the plateau held says the news.
 */
function movingAgainOutcome(input: GoalProgressInput, w: WeightBlock, plan: WeightWeekPlan, build: ReasonBuilder): Outcome {
  const from = plan.plateauMeanKg;
  const now = w.progressKg;
  const delta = from != null && now != null ? from - now : null;
  const what = w.weekMeanKg != null ? 'weekly average' : 'scale';
  const down = delta != null && delta >= EARLY_DOWN_MIN_KG;
  return {
    verdict: 'progressing',
    headline: down
      ? clip(`Moving again — ${what} down ${fmtWeight(input, delta as number)} from the plateau`)
      : clip('Moving again — your weekly average is coming off the plateau'),
    // The news is also the first reason: a client that shows reasons but not this headline (the shipped app) still says it.
    reasons: build(
      {
        kind: 'moving_again',
        text: down
          ? `${what === 'scale' ? 'Scale' : 'Weekly average'} down ${fmtWeight(input, delta as number)} from the plateau — the scale is moving again`
          : 'The scale is moving again — your weekly average is coming off the plateau',
        tone: 'good',
      },
      planActionReason(plan),
    ),
  };
}

function fatLossOutcome(input: GoalProgressInput, w: WeightBlock): Outcome {
  if (input.target.weightKg == null) {
    return { verdict: 'needs_target', headline: 'Set a target weight to track your fat-loss progress', reasons: [] };
  }
  if (w.stale) return staleWeighInOutcome(w);
  const plan = w.plan;
  if (!w.rateReliable || w.currentKg == null || plan == null) {
    return insufficientWeightOutcome(w);
  }

  const targetKg = input.target.weightKg;
  const signals = assessWeightSignals({
    trend: w.trend,
    dailyIntakeKcal: toSignalPoints(lastSevenIntake(input)),
    floorKcal: input.budget?.floorKcal ?? 0,
    goal: input.goal,
    weekendPatternIntakeKcal: toSignalPoints(input.intakeDays),
    todayKey: input.todayKey,
    goalStartDay: goalStartDay(input),
  });
  const { weekend, underEating } = signalReasons(signals);
  const adherence = calorieAdherenceReason(input);
  const tdee = tdeeReason(input);
  const toGo = Math.abs(w.neededKg ?? 0);
  const pace = plan.pace;

  // Priority: the lead reason(s), the "based on an older weigh-in" caveat, the
  // trend explained once, anything worth a "watch", then the rest.
  const aging = agingReason(w);
  const trendNote = trendExplainReason(plan);
  const others = [underEating, adherence, weekend, tdee];
  const build: ReasonBuilder = (...lead) =>
    capReasons([...lead, aging, trendNote, ...others.filter(r => r?.tone === 'watch'), ...others.filter(r => r?.tone !== 'watch')]);

  if (w.reached) {
    // The goal is done: lead with the reach, never show continued loss as a
    // green "inside the safe band", and say what to do next. A safety watch
    // (under-eating, still losing past the ceiling) still gets the second slot.
    const stillFast = pace != null && plan.tooFast && pace.kgPerWeek < 0
      ? paceReason(input, pace, { tooFast: true, easeToMaintenance: true })
      : null;
    const watch = underEating ?? stillFast;
    const when = w.reachedAt ? ` (${fmtDate(w.reachedAt, input.todayKey)})` : '';
    return {
      verdict: 'reached',
      headline: clip(`Goal reached — ${fmtWeight(input, targetKg)}${when}`),
      reasons: capReasons([
        reachedLeadReason(input, w, targetKg),
        watch ?? targetPositionReason(input, w, targetKg),
        reachedActionReason(plan),
      ]),
    };
  }

  switch (plan.state) {
    case 'returning': return returningOutcome(input, w, plan, build);
    case 'plateau': return plateauOutcome(input, plan, build);
    case 'moving_again': return movingAgainOutcome(input, w, plan, build);
    case 'early': return earlyReadOutcome(input, w, plan, build);
    default: break;
  }

  // The 'pace' state always carries a pace.
  const p = pace as WeightPlanPace;
  const absPct = Math.abs(p.pctPerWeek);
  // Too fast is the week's call (lib/weightPace.ts tooFastLoss, hysteresis) — the very rate the headline quotes, never a
  // different window's — and a pace still between 0.9% and the ceiling keeps it, without calling that "safe".
  const held = plan.tooFast && round2(absPct) <= FAT_LOSS_BAND.maxPct;
  const rate = paceReason(input, p, { tooFast: plan.tooFast });
  const action = planActionReason(plan);

  if (plan.tooFast && !plan.nearlyThere) {
    return {
      verdict: 'too_fast',
      headline: clip(`${held ? 'Still losing fast' : 'Losing too fast'} — ${round2(absPct)}% of bodyweight a week`),
      reasons: build(rate, action),
    };
  }
  if (plan.nearlyThere) {
    // Within a kilo of the target the loss is about to stop on its own: say so, ease off, and keep the verdict the
    // dates give (the card does not turn "too fast" for the last few days and "reached" right after).
    return { verdict: plan.verdict, headline: clip('Nearly there — start easing calories toward maintenance'), reasons: build(rate, action) };
  }

  // Wrong direction or flat.
  if (p.kgPerWeek >= 0 || absPct <= PLATEAU_MAX_PCT_PER_WEEK) {
    if (plan.verdict === 'behind') {
      return {
        verdict: 'behind',
        headline: clip(`Weight is up ${fmtWeight(input, p.kgPerWeek, 2)} a week, away from your target`),
        reasons: build(rate),
      };
    }
    return { verdict: 'stalled', headline: clip(`Stalled — weight flat around ${fmtWeight(input, w.progressKg ?? 0)}`), reasons: build(rate) };
  }

  // Losing at a safe pace. A pace nothing has confirmed yet makes no ahead/behind call.
  if (!plan.confirmed) {
    return {
      verdict: 'progressing',
      headline: clip(`Progressing — losing about ${fmtWeight(input, Math.abs(p.kgPerWeek), 2)} a week`),
      reasons: build(rate, action),
    };
  }

  const around = plan.etaDate != null ? aroundText(input, w, plan.etaDate) : '';
  const targetDate = input.target.date;
  if (targetDate != null) {
    if (plan.call === 'ahead') {
      return { verdict: 'ahead', headline: clip(`Ahead of pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons: build(rate) };
    }
    if (plan.call === 'behind') {
      // Far behind: the projection is more than 8 weeks past the date, so no date is quoted — the date will not hold.
      if (plan.farBehind) {
        return { verdict: 'behind', headline: clip(`Behind pace — at this rate the ${fmtDate(targetDate, input.todayKey)} date won't hold`), reasons: build(rate, action) };
      }
      return { verdict: 'behind', headline: clip(`Behind pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons: build(rate, action) };
    }
    // On pace: the target date itself holds, however the two paces wobble around it.
    // (A weigh-in that is 7+ days old quotes no date; a target date already past reads "any day now".)
    const forDate = !w.aging && targetDate >= input.todayKey ? ` for ${fmtDate(targetDate, input.todayKey)}` : '';
    const anyDayNow = !w.aging && targetDate < input.todayKey ? ', any day now' : '';
    return { verdict: 'on_track', headline: clip(`On track${forDate} — about ${fmtWeight(input, toGo)} to go${anyDayNow}`), reasons: build(rate) };
  }
  if (plan.etaDate == null) {
    return { verdict: 'behind', headline: clip(`Behind — ${fmtWeight(input, toGo)} to go, too slow to project a date`), reasons: build(rate) };
  }
  if (!plan.slow) {
    return { verdict: 'on_track', headline: clip(`On track — about ${fmtWeight(input, toGo)} to go${around}`), reasons: build(rate) };
  }
  return { verdict: 'behind', headline: clip(`Slow pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons: build(rate) };
}

/**
 * Day the first lift comparison becomes possible: the first logged set + 28
 * days (a comparison needs a baseline 4 weeks before the recent window). The
 * first set's week comes from the weekly e1RM buckets; its day is refined from
 * the session days we have when one falls in that week, else the week's Monday.
 * Null without any lift or when that date has already passed (the baseline is
 * then missing for another reason, e.g. a gap in training: see
 * `nextLiftComparisonDay`).
 */
function firstLiftComparisonDay(input: GoalProgressInput): string | null {
  let firstWeek: string | null = null;
  for (const weeks of Object.values(input.progression)) {
    for (const wk of weeks) {
      if (wk.bestEstimatedOneRepMaxKg != null && (firstWeek == null || wk.weekStart < firstWeek)) firstWeek = wk.weekStart;
    }
  }
  if (firstWeek == null) return null;
  const weekEnd = addDays(firstWeek, 6);
  const inFirstWeek = sessionDays(input).filter(d => d >= (firstWeek as string) && d <= weekEnd).sort();
  const day = addDays(inFirstWeek[0] ?? firstWeek, 28);
  return day > input.todayKey ? day : null;
}

/**
 * After a gap in training (the 4-weeks-ago weeks are empty) the next day a
 * comparison exists: the earliest Monday, after today, that has a week with an
 * e1RM 4 or 5 weeks behind it, for a lift that is in rotation now. Null when
 * no lift was trained in the last 3 weeks (nothing recent to compare).
 */
function nextLiftComparisonDay(input: GoalProgressInput): string | null {
  const anchor = weekStartKeyForDay(input.todayKey);
  let best: string | null = null;
  for (const exercise of rankLifts(input.progression, anchor)) {
    const weeks = input.progression[exercise];
    if (liftRecentEndWeek(weeks, anchor) == null) continue;
    for (const wk of weeks) {
      if (wk.bestEstimatedOneRepMaxKg == null) continue;
      for (const offset of [28, 35]) {
        const day = addDays(wk.weekStart, offset);
        if (day > input.todayKey && (best == null || day < best)) best = day;
      }
    }
  }
  return best;
}

/** Lifts exist but none can be compared yet: when that changes, and whether it is the first comparison or the next one. */
function liftComparisonOutlook(input: GoalProgressInput): { kind: 'first' | 'next'; day: string } | null {
  const first = firstLiftComparisonDay(input);
  if (first) return { kind: 'first', day: first };
  const next = nextLiftComparisonDay(input);
  return next ? { kind: 'next', day: next } : null;
}

/**
 * This week (Mon–today) and last week both reached the weekly sessions target.
 * The 28-day adherence window can still hold an older gap then, so it must not
 * lead in amber next to a week that hit the target (the weekly review says
 * "You hit your 4-session target").
 */
function recentWeeksOnTarget(input: GoalProgressInput): boolean {
  const target = input.target.weeklySessions;
  if (target == null || target <= 0) return false;
  const start = weekStart(input.todayKey);
  const prevStart = addDays(start, -7);
  let thisWeek = 0;
  let lastWeek = 0;
  for (const d of new Set(sessionDays(input))) {
    if (d >= start && d <= input.todayKey) thisWeek += 1;
    else if (d >= prevStart && d < start) lastWeek += 1;
  }
  return thisWeek >= target && lastWeek >= target;
}

/** One lift's return state as the payload carries it. */
function goalLiftReturnOf(s: LiftReturnState, input: GoalProgressInput): GoalLiftReturn {
  return {
    exercise: s.exercise,
    name: liftDisplayName(s.exercise, input.exerciseDisplay),
    breakDays: s.breakDays,
    endedOn: s.breakEnd,
    preBreakKg: round1(s.preBreakKg),
    recentKg: round1(s.recentKg),
    pct: s.pct,
    regained: s.regained,
  };
}

/**
 * The "building back" state per lift for the payload (lib/liftChange.ts
 * liftReturnStates); muscle goal only. The first entry is the headline lift
 * (`liftReturn`), the rest the other main lifts trained before the break and
 * since. Empty without a recent break.
 */
function liftReturnsOf(input: GoalProgressInput): GoalLiftReturn[] {
  if (input.goal !== 'muscle') return [];
  const days = [...new Set([...(input.strengthHistoryDays ?? []), ...sessionDays(input)])];
  return liftReturnStates(input.progression, days, input.todayKey).map(s => goalLiftReturnOf(s, input));
}

/** Whole-unit pre-break / recent e1RM in the display unit, and the percentage of those SHOWN numbers (lib/liftChange.ts liftReturnDisplay). */
function returnNumbers(r: GoalLiftReturn, input: GoalProgressInput): { pre: number; recent: number; pct: number; unit: string } {
  return liftReturnDisplay(r, input.unitSystem === 'imperial');
}

/** "Squat", "Squat and bench", "Squat, bench and deadlift": the first lift by its display name, the rest by the short spoken one. */
function returnLiftNames(rets: GoalLiftReturn[], exerciseDisplay: Record<string, string> | undefined): string {
  const names = rets.map((r, i) => (i === 0 ? r.name : liftShortName(r.exercise, exerciseDisplay)));
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The comeback sentence when SOME main lifts are back at their pre-break best
 * and one is not: "Squat back above pre-break; deadlift at 98%" — the lifts that
 * are back first ("at or above" unless every one is strictly above), then the
 * lift furthest behind with its percentage of the SHOWN numbers
 * (lib/liftChange.ts liftReturnDisplay). Shared by the goal card and the weekly
 * review. `maxAhead` limits how many of the lifts that are back are named (the
 * card's headline drops to one to fit the numbers). Null unless the returns are
 * mixed (some back, some not).
 */
export function mixedReturnLead(
  rets: readonly GoalLiftReturn[],
  exerciseDisplay: Record<string, string> | undefined,
  imperial: boolean,
  maxAhead = Infinity,
): { text: string; behind: GoalLiftReturn; shown: LiftReturnDisplay } | null {
  const behind = furthestBehindReturn(rets);
  const ahead = rets.filter(r => r.regained).slice(0, maxAhead);
  if (behind == null || ahead.length === 0) return null;
  const shown = liftReturnDisplay(behind, imperial);
  const rel = ahead.every(r => { const n = liftReturnDisplay(r, imperial); return n.recent > n.pre; }) ? 'above' : 'at';
  return {
    text: `${returnLiftNames(ahead, exerciseDisplay)} back ${rel} pre-break; ${liftShortName(behind.exercise, exerciseDisplay)} at ${shown.pct}%`,
    behind,
    shown,
  };
}

/**
 * Verdict + headline for a return from a break, across every lift that has a
 * return (the headline lift first):
 *  - one lift, or none back yet: the headline lift's own line — "Building back —
 *    Squat est. 1RM 136 of 142 kg pre-break";
 *  - every lift back: "Back above your pre-break best — Squat est. 1RM 145 kg
 *    (was 142 kg)" ("Back at …" unless every one is above) — claimed ONLY when
 *    every lift is, because it reads as all of them;
 *  - some back, some not (still 'building'): both, the lift furthest behind with
 *    its numbers — "Squat back above pre-break; deadlift at 98% (157 of 160 kg
 *    est. 1RM)", shortened to fit.
 */
function liftReturnOutcome(rets: GoalLiftReturn[], input: GoalProgressInput): { verdict: GoalVerdict; headline: string } {
  const r = rets[0];
  const { pre, recent, unit } = returnNumbers(r, input);
  const imperial = input.unitSystem === 'imperial';
  const mixed = mixedReturnLead(rets, input.exerciseDisplay, imperial);
  if (mixed) {
    // Every lift that is back + the numbers of the lift that is not; else just the first lift that is back with the
    // numbers; else every lift that is back without them (the lift reasons carry the numbers).
    const b = mixed.shown;
    const numbers = ` (${b.recent} of ${withUnit(b.pre, b.unit)} est. 1RM)`;
    const first = mixedReturnLead(rets, input.exerciseDisplay, imperial, 1) as NonNullable<typeof mixed>;
    for (const text of [`${mixed.text}${numbers}`, `${first.text}${numbers}`, mixed.text]) {
      if (text.length <= HEADLINE_MAX_CHARS) return { verdict: 'building', headline: text };
    }
    return { verdict: 'building', headline: clip(`Building back — ${mixed.behind.name} est. 1RM ${b.recent} of ${withUnit(b.pre, b.unit)} pre-break`) };
  }
  if (furthestBehindReturn(rets) != null) {
    // The 142 is an estimated 1RM, not a bodyweight or a load: say so ("Squat est. 1RM 136 of 142 kg pre-break").
    return { verdict: 'building', headline: clip(`Building back — ${r.name} est. 1RM ${recent} of ${withUnit(pre, unit)} pre-break`) };
  }
  const above = rets.every(x => { const n = returnNumbers(x, input); return n.recent > n.pre; });
  if (!above) {
    return { verdict: 'progressing', headline: clip(`Back at your pre-break best — ${r.name} est. 1RM ${withUnit(recent, unit)}`) };
  }
  const full = `Back above your pre-break best — ${r.name} est. 1RM ${withUnit(recent, unit)} (was ${withUnit(pre, unit)})`;
  const short = `Back above your pre-break best — ${r.name} est. 1RM ${withUnit(recent, unit)}`;
  return { verdict: 'progressing', headline: clip(full.length <= HEADLINE_MAX_CHARS ? full : short) };
}

/**
 * The lift reasons of a return, at most two:
 *  - some lifts back and one not: the lift furthest behind first, then one that is back;
 *  - none back yet: the headline lift's own line, plus the lift furthest behind
 *    when it is 3+ points under it (so a lagging lift is not hidden behind a
 *    better one) — otherwise just the headline lift, leaving room for the break line;
 *  - every lift back: the first two.
 */
function liftReturnReasons(rets: GoalLiftReturn[], input: GoalProgressInput): GoalProgressReason[] {
  const behind = furthestBehindReturn(rets);
  const back = rets.find(r => r.regained);
  let picked: GoalLiftReturn[];
  if (behind != null && back != null) picked = [behind, back];
  else if (behind != null) {
    const lead = returnNumbers(rets[0], input);
    picked = behind !== rets[0] && returnNumbers(behind, input).pct <= lead.pct - 3 ? [rets[0], behind] : [rets[0]];
  } else picked = rets.slice(0, 2);
  return picked.map(r => liftReturnReason(r, input));
}

function liftReturnReason(r: GoalLiftReturn, input: GoalProgressInput): GoalProgressReason {
  const { pre, recent, pct, unit } = returnNumbers(r, input);
  if (!r.regained) {
    return { kind: 'lift', text: `${r.name} est. 1RM ${withUnit(recent, unit)}, ${pct}% of your ${withUnit(pre, unit)} pre-break best`, tone: 'neutral' };
  }
  return {
    kind: 'lift',
    text: recent > pre
      ? `${r.name} est. 1RM ${withUnit(recent, unit)}, back above your pre-break ${withUnit(pre, unit)}`
      : `${r.name} est. 1RM ${withUnit(recent, unit)}, back at your pre-break best`,
    tone: 'good',
  };
}

function liftReturnBreakReason(r: GoalLiftReturn, input: GoalProgressInput): GoalProgressReason {
  return { kind: 'return', text: `Back after a ${r.breakDays}-day break (ended ${fmtDate(r.endedOn, input.todayKey)})`, tone: 'neutral' };
}

/** A lift's e1RM as the copy prints it: whole kg (lb), unit glued on. */
function fmtLiftKg(input: GoalProgressInput, kg: number): string {
  const imperial = input.unitSystem === 'imperial';
  return withUnit(Math.round(kg * (imperial ? KG_TO_LB : 1)), imperial ? 'lb' : 'kg');
}

/** The lift a lapse talks about: what it was before the sessions stopped, and the week it was set. */
interface LapseLift { name: string; kg: number; weekStart: string }

function lapseLiftOf(input: GoalProgressInput, key: string | null): LapseLift | null {
  const weeks = key != null ? input.progression[key] : undefined;
  const best = key != null && weeks ? liftLastBest(weeks, weekStartKeyForDay(input.todayKey)) : null;
  return key != null && best ? { name: liftDisplayName(key, input.exerciseDisplay), kg: best.kg, weekStart: best.weekStart } : null;
}

/**
 * "No sessions for 8 days — Squat was est. 1RM 142 kg, week of Apr 20". The
 * date is the Monday of the week the best was set: the data is weekly, so a
 * day would claim more than is known. Shortens ("wk of", then no date) to fit.
 */
function lapseHeadline(input: GoalProgressInput, days: number, lift: LapseLift): string {
  const lead = `No sessions for ${days} days`;
  const was = `${lift.name} was est. 1RM ${fmtLiftKg(input, lift.kg)}`;
  const date = fmtDate(lift.weekStart, input.todayKey);
  for (const text of [`${lead} — ${was}, week of ${date}`, `${lead} — ${was}, wk of ${date}`, `${lead} — ${was}`]) {
    if (text.length <= HEADLINE_MAX_CHARS) return text;
  }
  return clip(`${lead} — ${was}`);
}

/** The lift line during a lapse: dated, no "+9 kg vs 4 weeks ago". */
function lapseReason(input: GoalProgressInput, lift: LapseLift): GoalProgressReason {
  return {
    kind: 'lift',
    text: `${lift.name} was est. 1RM ${fmtLiftKg(input, lift.kg)} in the week of ${fmtDate(lift.weekStart, input.todayKey)}`,
    tone: 'neutral',
  };
}

/**
 * Weeks 2-4, before any lift has a 4-week comparison: the weekly review's own
 * line, the same pair of weeks (lib/liftChange.ts pickWeekOverWeek: the last
 * completed week, which is the week the review reads on its Monday) and the
 * same whole-kg rounding, labelled with its window ("Last week: Squat est. 1RM
 * +4 kg vs the week before"; lib/liftChange.ts weekOverWeekWording) — on a
 * Sunday it is the week BEFORE the one just trained, so a bare "vs last trained
 * week" read as this week and disagreed with Monday's review. Only the week in
 * progress never turns it amber: half a week's best is not a drop.
 */
function weekOverWeekReason(input: GoalProgressInput): GoalProgressReason | null {
  const anchor = weekStartKeyForDay(input.todayKey);
  const pick = pickWeekOverWeek(input.progression, anchor, [addDays(anchor, -7), anchor]);
  if (!pick) return null;
  const imperial = input.unitSystem === 'imperial';
  const d = liftDisplayChange({ baselineKg: pick.change.previousKg, recentKg: pick.change.currentKg, changeKg: pick.change.changeKg }, imperial);
  const delta = d.change === 0 ? 'unchanged' : liftDeltaText({ ...d, unit: imperial ? 'lb' : 'kg' });
  const wording = weekOverWeekWording(pick.change, pick.end, anchor);
  return {
    kind: 'lift',
    text: `${wording.window ? `${wording.window}: ` : ''}${liftDisplayName(pick.exercise, input.exerciseDisplay)} est. 1RM ${delta} ${wording.vs}`,
    tone: d.change > 0 ? 'good' : d.change < 0 && pick.end < anchor && !isDeloadWeek(input.progression, pick.end) ? 'watch' : 'neutral',
  };
}

/**
 * The weight-rate line during a lapse: neutral, and about the lapse ("Trend
 * weight up 0.2 kg/wk with no training"), not the usual "inside the 0.1–0.5%
 * safe band" in green next to "No sessions for 14 days". A rate that is already
 * a warning (gaining too fast, the wrong way) keeps its watch line.
 */
function lapseRateReason(input: GoalProgressInput, w: WeightBlock, rate: GoalProgressReason | null): GoalProgressReason | null {
  if (rate == null || rate.tone === 'watch' || w.rateKg == null || w.pctBw == null) return rate;
  const flat = round2(Math.abs(w.pctBw)) < RATE_FLAT_PCT;
  const text = flat
    ? 'Trend weight flat with no training'
    : `Trend weight ${w.rateKg < 0 ? 'down' : 'up'} ${fmtWeight(input, Math.abs(w.rateKg), 2)}/wk with no training`;
  return { kind: 'rate', text, tone: 'neutral' };
}

function muscleOutcome(input: GoalProgressInput, w: WeightBlock, ret: GoalLiftReturn | null, rets: GoalLiftReturn[]): Outcome {
  if (input.target.weightKg == null && input.target.weeklySessions == null) {
    return { verdict: 'needs_target', headline: 'Set a weekly session goal to track your progress', reasons: [] };
  }

  const targetKg = input.target.weightKg;
  // A weigh-in older than WEIGH_IN_STALE_DAYS says nothing about now: no rate,
  // no "reached" off weeks-old weight.
  const weightReached = !w.stale && w.reached === true && targetKg != null && w.currentKg != null;
  const pct = w.stale ? null : w.pctBw;
  // Thresholds are compared against the percentage as printed (2 decimals).
  const shownPct = pct != null ? round2(pct) : null;

  const lifts = liftChanges(input.progression, input.todayKey, input.exerciseDisplay);
  const rate = w.stale || weightReached ? null : rateReason(input, w, MUSCLE_GAIN_BAND);
  const adherence = adherenceReason(input);
  const adh = sessionAdherence(input);
  // The 28-day window cannot judge a lifter whose last 4 weeks hold a break
  // (building back) or who has just hit the weekly target two weeks running:
  // there it never leads in amber and never makes the verdict "sessions behind".
  // The plan is not judged before the goal's first full week is done either.
  const windowStale = ret != null || recentWeeksOnTarget(input) || firstWeekOpen(input);
  const adherenceLow = !windowStale && (adh?.pct ?? 100) < ADHERENCE_LOW_PCT;
  const sessionsBehind = !windowStale && (sessionsBehindPct(input) ?? 100) < ADHERENCE_BEHIND_PCT;
  const sessions = adherence ?? sessionsReason(input);
  // The first 28 days' sessions line already says "This week 2 of 4": no second week count beside it.
  const young = isYoungGoal(input);
  const weekSessions = young ? null : muscleWeekSessionsReason(input);
  // The week can no longer reach its target: a watch line, and no "Progressing" headline over it.
  const weekShort = weekSessions?.tone === 'watch';
  const adherenceDemoted = adherence && adherence.tone === 'watch' ? { ...adherence, tone: 'neutral' as const } : adherence;
  const protein = proteinReason(input);
  // A week or more without a session: the lifts are dated, never praised ("+9 kg vs 4 weeks ago" is about a window
  // that ended before the lapse began).
  const daysOff = lastSessionDaysAgo(input);
  // The threshold scales to the weekly target (4 days for 4 a week, 7 for 2 or none): lib/liftChange.ts liftLapseMinDays.
  const lapseLift = daysOff != null && daysOff >= liftLapseMinDays(input.target.weeklySessions) ? lapseLiftOf(input, ret?.exercise ?? lifts[0]?.exercise ?? null) : null;
  const lapse = lapseLift != null && daysOff != null ? { days: daysOff, lift: lapseLift } : null;
  const liftReasons = lapse ? [] : lifts.map(l => liftReason(l, input)).filter((r): r is GoalProgressReason => r != null);
  // The lift lines: a lapse dates the lift; a return states every lift's return (the one furthest behind, then one that is back).
  const leadLifts: Array<GoalProgressReason | null> = lapse
    ? [lapseReason(input, lapse.lift)]
    : ret ? liftReturnReasons(rets.length > 0 ? rets : [ret], input) : [liftReasons[0] ?? weekOverWeekReason(input)];
  // "Back after a 15-day break" explains a rebuild; once every pre-break best is regained it is no longer news.
  const returnBreak = ret && furthestBehindReturn(rets.length > 0 ? rets : [ret]) != null ? liftReturnBreakReason(ret, input) : null;
  // A lapse is not a time to praise the scale either: the weight line is neutral and says so.
  const rateShown = lapse ? lapseRateReason(input, w, rate) : rate;
  // Rate at/above the top of the healthy band is a flag worth surfacing early.
  const rateTop = rate?.tone === 'watch' && w.rateKg != null && w.rateKg > 0;
  const reachLead = weightReached ? reachedLeadReason(input, w, targetKg as number) : null;
  // Low adherence leads (amber) without overriding the lift-based verdict.
  // The second lift outranks the in-band weight rate (a rate inside the band is the quietest line on the card).
  const reasons = windowStale
    ? capReasons([
        ...leadLifts,
        weekSessions ?? sessions,
        ret ? returnBreak : young ? null : adherenceDemoted,
        reachLead,
        rateTop ? rateShown : null,
        protein,
        ret ? null : liftReasons[1] ?? null,
        rateTop ? null : rateShown,
        rate ? agingReason(w) : null,
      ])
    : capReasons([
        adherenceLow ? adherence : null,
        weekShort ? weekSessions : null,
        ...leadLifts,
        adherenceLow ? null : sessions,
        reachLead,
        rateTop ? rateShown : null,
        protein,
        liftReasons[1] ?? null,
        rateTop ? null : rateShown,
        rate ? agingReason(w) : null,
      ]);

  // The headline lift is the shared pick (the most-trained lift that has a
  // comparison, lib/liftChange.ts); `lifts` lists it first, so the verdict, the
  // headline and the lead lift reason all name the same lift.
  const head = lifts[0]?.change4wKg != null ? lifts[0] : null;
  const headDisplay = head ? displayLift(head, input) : null;
  const liftsUp = head && headDisplay && !lapse ? head.up : null;
  const otherUp = lifts.find(l => l !== head && l.up) ?? null;
  const otherUpDisplay = otherUp ? displayLift(otherUp, input) : null;
  const sessionsBehindHeadline = adh ? clip(`Sessions behind — ${adh.done} of ${adh.planned} planned`) : 'Sessions behind';

  // What the lifts say. One stall rule (lib/liftChange.ts isLiftStalled, the
  // same the stalled-lift nudge uses): a deload, a break or a return from one
  // is never "stalled". "No lift is up" is only said when EVERY lift in the
  // list has a comparison; otherwise the lift that does is named.
  let liftState: { verdict: GoalVerdict; headline: string } | null = null;
  if (lapse) {
    liftState = { verdict: 'holding', headline: lapseHeadline(input, lapse.days, lapse.lift) };
  } else if (ret) {
    liftState = liftReturnOutcome(rets.length > 0 ? rets : [ret], input);
  } else if (head && headDisplay) {
    // Not up 1%: never print a "+1 kg" next to "stalled" (a gain under 1% reads "up under 1%").
    const headDelta = headDisplay.change < 0 ? liftDeltaText(headDisplay) : headDisplay.change === 0 ? 'unchanged' : 'up under 1%';
    if (liftsUp) {
      // A week that can no longer reach its target is never "Progressing" (the 28-day line alone stays neutral through it).
      liftState = sessionsBehind
        ? { verdict: 'behind', headline: clip(`Lifts up, sessions behind — ${head.name} ${liftDeltaText(headDisplay)}`) }
        : weekShort
          ? { verdict: 'holding', headline: clip(`Lifts up, week short — ${head.name} ${liftDeltaText(headDisplay)}`) }
          : { verdict: 'progressing', headline: clip(`Progressing — ${head.name} est. 1RM ${liftDeltaText(headDisplay)} vs 4 weeks ago`) };
    } else if (otherUp && otherUpDisplay) {
      liftState = {
        verdict: 'holding',
        headline: clip(`Holding — ${otherUp.name} ${liftDeltaText(otherUpDisplay)}, ${head.name} ${headDisplay.change < 0 ? 'down' : 'flat'}`),
      };
    } else if (head.stalled) {
      const everyLiftCompared = lifts.length >= 2 && lifts.every(l => l.change4wKg != null);
      liftState = {
        verdict: 'stalled',
        headline: everyLiftCompared
          ? 'Stalled — no lift is up 1% on 4 weeks ago'
          : clip(`Stalled — ${head.name} est. 1RM ${headDelta} vs 4 weeks ago`),
      };
    } else {
      liftState = { verdict: 'holding', headline: clip(`Holding — ${head.name} est. 1RM ${headDelta} vs 4 weeks ago`) };
    }
  }

  // Reaching the weight target never hides training feedback: sessions behind
  // → behind, stalled lifts → stalled, and only then reached.
  if (weightReached) {
    if (sessionsBehind) {
      return {
        verdict: 'behind',
        headline: liftsUp && head && headDisplay
          ? clip(`Lifts up, sessions behind — ${head.name} ${liftDeltaText(headDisplay)}`)
          : sessionsBehindHeadline,
        reasons,
      };
    }
    if (liftState?.verdict === 'stalled') {
      return { ...liftState, reasons };
    }
    const training = reasons.filter(r => r !== reachLead).slice(0, 1);
    return {
      verdict: 'reached',
      headline: clip(`Goal reached — ${fmtWeight(input, targetKg as number)}${w.reachedAt ? ` (${fmtDate(w.reachedAt, input.todayKey)})` : ''}`),
      reasons: capReasons([reachLead, ...training, nextStepReason()]),
    };
  }

  if (pct != null && pct > MUSCLE_GAIN_BAND.maxPct) {
    return {
      verdict: 'too_fast',
      headline: clip(`Gaining too fast — ${round1(pct)}% of bodyweight a week`),
      reasons,
    };
  }

  if (liftState) return { ...liftState, reasons };

  // Lifts are logged but none can be compared yet (the first 4 weeks, or the
  // 4-weeks-ago weeks are empty after a gap): say when the comparison lands and
  // keep the lift framing. A short weight trend must not call this "stalled" or
  // "the opposite way" meanwhile; only a user who set a target weight and is
  // gaining inside the band reads the weight verdict.
  const hasLiftData = Object.values(input.progression).some(weeks => weeks.some(wk => wk.bestEstimatedOneRepMaxKg != null));
  const weightLed = targetKg != null && shownPct != null && shownPct >= MUSCLE_GAIN_BAND.minPct;
  if (hasLiftData && !weightLed) {
    const outlook = liftComparisonOutlook(input);
    if (outlook) {
      // The card already shows week over week meanwhile ("Last week: Squat est. 1RM +3 kg …"), so the first 4-week
      // comparison is a "trend from" date, not a "First lift comparison" above a lift comparison. The session count
      // lives in the sessions line ("This week 1 of 4 (9 since Mar 2)"), not here.
      const day = fmtDate(outlook.day, input.todayKey);
      return {
        verdict: 'insufficient_data',
        headline: clip(outlook.kind === 'first' ? `4-week lift trend from ${day}` : `Next lift comparison on ${day}`),
        reasons,
      };
    }
  }

  if (shownPct != null) {
    if (shownPct >= MUSCLE_GAIN_BAND.minPct) {
      // Weight is moving the right way but the planned sessions are not
      // happening: a lifter who stopped training never reads "Progressing".
      if (sessionsBehind) return { verdict: 'behind', headline: sessionsBehindHeadline, reasons };
      // A week that can no longer reach its target never reads "Progressing" off the scale either.
      if (weekShort) return { verdict: 'holding', headline: clip(`Week short — weight up ${shownPct}% a week`), reasons };
      return {
        verdict: 'progressing',
        headline: clip(`Progressing — weight up ${shownPct}% a week, inside the gain band`),
        reasons,
      };
    }
    return { verdict: 'stalled', headline: clip(`Stalled — weight is not trending up (${shownPct}% a week)`), reasons };
  }

  if (w.stale) {
    const stale = staleWeighInOutcome(w);
    return { ...stale, reasons: capReasons([...stale.reasons, ...reasons]) };
  }

  return {
    verdict: 'insufficient_data',
    headline: 'Log a few more lifts or weigh-ins to see your progress',
    reasons,
  };
}

/**
 * The endurance volume-change definition for goals WITHOUT a weekly distance
 * target (time or session counts): mean weekly volume over the last 2 weeks vs
 * the 2 weeks before. With a weekly distance target the card speaks in finished
 * calendar weeks instead ("21 km last week (+11%), on plan" — the same
 * "vs last week" number the weekly review quotes), see `planOutcome`.
 */
export const ENDURANCE_VOLUME_WINDOW_LABEL = 'last 2 weeks vs the 2 before';

function distanceNum(input: GoalProgressInput, km: number): number {
  return input.unitSystem === 'imperial' ? round1(km / KM_PER_MILE) : round1(km);
}

/** "24.5 km" / "15.2 mi". */
function fmtDistance(input: GoalProgressInput, km: number): string {
  return withUnit(distanceNum(input, km), input.unitSystem === 'imperial' ? 'mi' : 'km');
}

/** Workouts that count toward the endurance distance target: running only. */
function runWorkouts(input: GoalProgressInput): GoalProgressInput['workouts'] {
  return input.workouts.filter(w => isRunningWorkoutType(w.type));
}

/** Weekly distance volume (km) for the week `offset` weeks back (0 = trailing 7 days). */
function distanceInWeek(input: GoalProgressInput, offset: number): { km: number; readings: number } {
  let km = 0;
  let readings = 0;
  for (const w of runWorkouts(input)) {
    if (w.distanceKm == null || !Number.isFinite(w.distanceKm)) continue;
    const age = dayNumber(input.todayKey) - dayNumber(w.day);
    if (age >= offset * 7 && age < offset * 7 + 7) {
      km += w.distanceKm;
      readings += 1;
    }
  }
  return { km, readings };
}

/** The display unit's size in km for the shared progression rule (1 for km, 1 / KM_PER_MILE for miles). */
function unitsPerKm(input: GoalProgressInput): number {
  return input.unitSystem === 'imperial' ? 1 / KM_PER_MILE : 1;
}

// ── Endurance week plan (ONE plan per calendar week, lib/enduranceProgression.ts) ──

interface EnduranceCtx {
  /** Running workouts with a distance: the loader's longer history when supplied, else the 28-day workouts. */
  runs: PlanRun[];
  /** Monday of this calendar week — the race phase and every target are read on it, whatever day it is. */
  weekStart: string;
  /** This week's running (Mon–today) as the plan counts it: a run on race day is the race, not training. */
  thisWeek: { km: number; days: number };
  /** The week plan; null without a weekly distance goal or any measured run. */
  plan: EnduranceWeekPlan | null;
  /** The race run (>= 90% of the race distance, on race day or a day either side), once logged. */
  raceRun: PlanRun | null;
}

function planRunsOf(input: GoalProgressInput): PlanRun[] {
  const out: PlanRun[] = [];
  if (input.runHistory) {
    for (const r of input.runHistory) {
      if (Number.isFinite(r.km) && r.km > 0) out.push({ day: r.day, km: r.km, durationMin: r.durationMin ?? null });
    }
    return out;
  }
  for (const w of runWorkouts(input)) {
    if (w.distanceKm == null || !Number.isFinite(w.distanceKm) || w.distanceKm <= 0) continue;
    out.push({ day: w.day, km: w.distanceKm, durationMin: w.durationMin });
  }
  return out;
}

const enduranceCtxCache = new WeakMap<GoalProgressInput, EnduranceCtx>();

function enduranceCtx(input: GoalProgressInput): EnduranceCtx {
  const hit = enduranceCtxCache.get(input);
  if (hit) return hit;
  const weekStartDay = mondayOfDay(input.todayKey);
  const runs = planRunsOf(input).filter(r => r.day <= input.todayKey);
  const goalKm = input.target.weeklyDistanceKm;
  const plan = input.goal === 'endurance' && goalKm != null && goalKm > 0 && runs.length > 0
    ? enduranceWeekPlan({
        runs,
        weekStart: weekStartDay,
        goalKm,
        race: input.race ?? null,
        today: input.todayKey,
        racePeakWeekKm: input.racePeakWeekKm ?? null,
        unitsPerKm: unitsPerKm(input),
        goalStartDay: goalStartDay(input),
      })
    : null;
  const ctx: EnduranceCtx = {
    runs,
    weekStart: weekStartDay,
    thisWeek: planWeekKm(runs, weekStartDay, input.race?.date ?? null),
    plan,
    raceRun: findRaceRun(runs, input.race ?? null),
  };
  enduranceCtxCache.set(input, ctx);
  return ctx;
}

/**
 * The race phase for THIS WEEK (read on its Monday, like the week plan) with the
 * signed day count to race day from today (endurance + a race date only).
 */
function raceInfo(input: GoalProgressInput): RacePhaseInfo | null {
  if (input.goal !== 'endurance' || !input.race?.date) return null;
  return racePhaseInfo(input.race.date, mondayOfDay(input.todayKey), input.race.distanceKm);
}

/**
 * The weekly running target (km) of this week's taper / race-week / recovery
 * phase for a goal WITHOUT a weekly distance target or any measured run (the
 * shared rule in lib/enduranceProgression.ts: shares of the peak week). Null in
 * the build phase, without a race and without any peak.
 */
function windDownTargetKm(input: GoalProgressInput): number | null {
  const info = raceInfo(input);
  if (info == null || !isWindDownPhase(info.phase)) return null;
  const goalKm = input.target.weeklyDistanceKm ?? null;
  const peakKm = input.racePeakWeekKm ?? goalKm;
  if (peakKm == null) return null;
  return racePhaseTargetKm(info, peakKm, { weeklyGoalKm: goalKm, unitsPerKm: unitsPerKm(input) });
}

/**
 * This calendar week's distance (Mon–today, user-local) against ITS target: the
 * plan's (the safe step, a hold or restart number, the phase target...), or the
 * goal when there is no plan (nothing measured yet, or the first week of
 * running). `thisWeekKm` is null only when nothing was ever run with a distance.
 */
function distanceProgress(input: GoalProgressInput): GoalDistanceProgress | null {
  const targetKm = input.target.weeklyDistanceKm;
  if (targetKm == null) return null;
  const ec = enduranceCtx(input);
  const plan = ec.plan;
  const hasData = ec.runs.length > 0;
  const stepKm = plan?.targetKm ?? targetKm;
  const doneKm = ec.thisWeek.km;
  const done = hasData ? distanceNum(input, doneKm) : 0;
  // The day before the race is for rest: the week's km are not on the card at all.
  const raceNow = raceProgress(input);
  const eve = raceNow != null && raceNow.phase !== 'recovery' && raceNow.daysToGo === 1;
  // Race day is for the race, not the week's km (wave 22e): "Race done - 21.1 km" once it is logged, "Race day" before; no figure of the week.
  const raceDay = raceNow != null && raceNow.phase !== 'recovery' && raceNow.daysToGo === 0;
  // One target for the week: when the plan caps it below the goal, say both
  // ("22.7 of ~27 km ... · goal 30 km"); otherwise the goal alone. Recovery's
  // number is a ceiling ("up to"); the first week of running has no target yet.
  let text: string;
  if (eve) text = 'Race tomorrow';
  else if (raceDay) text = raceNow?.completed ? `Race done — ${fmtDistance(input, raceNow.completed.km)}` : 'Race day';
  else if (plan?.kind === 'baseline') text = `${fmtDistance(input, doneKm)} so far · baseline week`;
  else if (plan?.kind === 'recovery') {
    // Just over the ceiling but inside its 10% slack is "right at" it, never "7.5 of up to 7".
    const slack = withinCeilingSlack(input, doneKm, stepKm);
    text = slack != null
      ? `${fmtDistance(input, doneKm)} so far · right at your ~${fmtDistance(input, slack)} ceiling (recovery)`
      : `${done} of up to ${fmtDistance(input, stepKm)} running this week (recovery)`;
  }
  else if (stepKm < targetKm) text = `${done} of ${plan?.upTo ? 'up to ' : ''}~${fmtDistance(input, stepKm)} running this week · goal ${fmtDistance(input, targetKm)}`;
  else text = `${done} of ${fmtDistance(input, targetKm)} running this week`;
  return {
    targetKm,
    thisWeekKm: hasData && !eve && !raceDay ? round1(doneKm) : null,
    avg4wKm: plan?.avg4wKm ?? null,
    weekStart: ec.weekStart,
    stepTargetKm: stepKm,
    text,
    ...(plan
      ? {
          plan: {
            kind: plan.kind,
            targetKm: plan.targetKm,
            longRunKm: plan.longRunKm,
            purpose: plan.purpose,
            stepPct: plan.stepPct,
            comebackKm: plan.comeback != null ? plan.comeback.medianKm : plan.restart != null ? plan.restart.medianKm : null,
            goalReachedBefore: plan.goalReachedBefore,
            ...(plan.cutback != null ? { cutback: true } : {}),
            ...(plan.onBreak && plan.kind === 'restart' && plan.targetKm != null && Math.abs(plan.restartKm - plan.targetKm) > 1e-9 ? { restartKm: plan.restartKm } : {}),
            ...(plan.lightWeek != null ? { lightWeek: true } : {}),
            ...(plan.easingOff != null ? { easingOff: true, taperLongRunKm: plan.easingOff.taperLongRunKm } : {}),
            ...(plan.preTaper != null ? { preTaper: plan.preTaper.nextPhase } : {}),
            ...(plan.strides ? { strides: true } : {}),
            ...(plan.longRun.held ? { longRunHeld: true } : {}),
            ...(plan.upTo ? { upTo: true } : {}),
            ...(plan.hold?.skippedCutback ? { skippedCutback: true } : {}),
            ...(plan.last?.overCap ? { overCap: true, ...(plan.last.capRead != null ? { overCapRead: plan.last.capRead } : {}) } : {}),
          },
        }
      : {}),
  };
}

/**
 * The ceiling (km) a recovery / race week that sits a little over its target may be called "right at": the stated
 * target itself, within the shared 10% slack. Null when the week is not over the target as the reader sees it, or is
 * over by more than the slack.
 */
function withinCeilingSlack(input: GoalProgressInput, doneKm: number, ceilingKm: number): number | null {
  if (distanceNum(input, doneKm) <= distanceNum(input, ceilingKm)) return null;
  if (doneKm > ceilingKm * PHASE_CEILING_TOLERANCE) return null;
  // The stated ceiling stays the stated ceiling all week: "~7 mi max" on Monday is "right at your ~7 mi ceiling" on Saturday.
  return ceilingKm;
}

const RACE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Race name. Standard distances keep their names (5K, 10K, Half marathon,
 * Marathon); any other distance reads "<n> km race", or "<n> mi race" for an
 * imperial user (a 16.1 km race is "10 mi race").
 */
export function raceLabel(distanceKm: number | null, unitSystem?: 'metric' | 'imperial' | null): string {
  if (distanceKm == null) return 'Race';
  if (Math.abs(distanceKm - 21.1) < 0.05) return 'Half marathon';
  if (Math.abs(distanceKm - 42.2) < 0.05) return 'Marathon';
  if (distanceKm === 10) return '10K';
  if (distanceKm === 5) return '5K';
  const imperial = unitSystem === 'imperial';
  const n = round1(imperial ? distanceKm / KM_PER_MILE : distanceKm);
  return `${withUnit(n, imperial ? 'mi' : 'km')} race`;
}

/** "half", "marathon", "10K", "5K" or "race" — the race as one word in running talk ("on track for the half"). */
function raceWord(label: string): string {
  if (label === 'Half marathon') return 'half';
  if (label === 'Marathon') return 'marathon';
  if (label === '10K' || label === '5K') return label;
  return 'race';
}

/**
 * Endurance race countdown and phase. The PHASE (build / taper / race week) is
 * the one this calendar week's Monday has — the same one the week plan and the
 * weekly review use, so a Sunday seven days out is still "taper", never "race
 * week" a day before the review calls it taper; `daysToGo` / `weeksToGo` are the
 * real countdown from today. Once race day has passed the race stays for the
 * recovery weeks (phase 'recovery' with `daysSince`), then null (the rebuild
 * weeks carry no race block). Null without a date too.
 */
function raceProgress(input: GoalProgressInput): GoalRaceProgress | null {
  const date = input.race?.date;
  if (input.goal !== 'endurance' || !date) return null;
  const week = raceInfo(input);
  if (week == null) return null;
  const distanceKm = input.race?.distanceKm ?? null;
  const base = { date, distanceKm, label: raceLabel(distanceKm, input.unitSystem) };
  const daysToRace = dayNumber(date) - dayNumber(input.todayKey);
  if (!Number.isFinite(daysToRace)) return null;
  const completed = enduranceCtx(input).raceRun;
  const done = completed ? { completed: { km: round1(completed.km), durationMin: completed.durationMin ?? null } } : {};
  if (daysToRace < 0) {
    // Recovery follows the calendar week of the race day too (a Wednesday race: Thursday on is recovery).
    if (week.phase !== 'recovery' && week.phase !== 'race_week') return null;
    return { ...base, weeksToGo: 0, daysToGo: 0, phase: 'recovery', daysSince: -daysToRace, ...done };
  }
  return { ...base, weeksToGo: daysToRace < 7 ? 0 : Math.ceil(daysToRace / 7), daysToGo: daysToRace, phase: week.phase, ...done };
}

/** "Dec 31" for a race day (YYYY-MM-DD). */
function raceWhen(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${RACE_MONTHS[m - 1]} ${d}`;
}

function raceReason(race: GoalRaceProgress): GoalProgressReason {
  const when = raceWhen(race.date);
  const text = race.phase === 'recovery'
    ? `${race.label} done (${when})`
    : race.daysToGo === 0
      ? `${race.label} is today (${when})`
      : race.weeksToGo === 0
        ? `${race.label} in ${race.daysToGo} ${plural(race.daysToGo, 'day')} (${when})`
        : `${race.label} in ${race.weeksToGo} ${plural(race.weeksToGo, 'week')} (${when})`;
  return { kind: 'race', text, tone: 'neutral' };
}

/**
 * What this week is for, by race phase, right behind the race line — for an
 * endurance goal WITHOUT a weekly distance target (the week plan owns this line
 * when there is one): taper cuts volume and spells out the intensity, race week
 * keeps runs short and easy, recovery is easy only. `targetKm` is the phase's
 * weekly target (`windDownTargetKm`); without one the copy carries no number.
 * Null in the build phase.
 */
function racePhaseReason(
  input: GoalProgressInput, race: GoalRaceProgress, targetKm: number | null,
): GoalProgressReason | null {
  const rep = racePaceReps(unitsPerKm(input));
  let text: string;
  switch (race.phase) {
    case 'taper':
      text = targetKm != null
        ? `Taper: ~${fmtDistance(input, targetKm)} this week — cut volume; keep the long run easy, plus ${rep} at race pace midweek`
        : `Taper: cut volume this week — keep the long run easy, plus ${rep} at race pace midweek`;
      break;
    case 'race_week':
      text = race.daysToGo === 0
        ? race.completed ? 'Walk it off, eat and rest; easy running only from here' : 'Race day — keep the warm-up easy and start relaxed'
        : race.daysToGo === 1
          ? RACE_EVE_LINE
          : `Race week — short easy runs, rest 1–2 days before ${raceWhen(race.date)}`;
      break;
    case 'recovery':
      text = targetKm != null
        ? `Recovery: easy only this week (~${fmtDistance(input, targetKm)} max)`
        : 'Recovery: easy only this week';
      break;
    default:
      return null;
  }
  return { kind: 'race_phase', text, tone: 'neutral' };
}

/**
 * After the race: what comes next — in recovery week 1 only (a month of "Set your next goal" is nagging). A runner
 * who already has a weekly distance target is not offered one. Null from recovery week 2 on.
 */
function nextGoalReason(input: GoalProgressInput, race: GoalRaceProgress): GoalProgressReason | null {
  if (race.phase !== 'recovery' || recoveryWeek(race.daysSince ?? 1) !== 1) return null;
  return {
    kind: 'next_step',
    text: input.target.weeklyDistanceKm != null
      ? 'Set your next goal: a new race or maintenance'
      : 'Set your next goal: a new race, a weekly distance target, or maintenance',
    tone: 'neutral',
  };
}

/**
 * Fold the race lifecycle into an endurance outcome that has no week plan (a
 * goal without a weekly distance target): the race line leads, then (taper /
 * race week) what the week is for, then the outcome's own reasons (cap 3). Once
 * the race is done the headline is the recovery state and the reasons are race
 * done, recovery, next step.
 */
function withRaceLifecycle(input: GoalProgressInput, outcome: Outcome, race: GoalRaceProgress): Outcome {
  const phaseReason = racePhaseReason(input, race, windDownTargetKm(input));
  if (race.phase === 'recovery' && phaseReason) {
    return {
      ...outcome,
      headline: `Race done — ${raceWhen(race.date)} · recovery week ${recoveryWeek(race.daysSince ?? 1)}`,
      reasons: [raceReason(race), phaseReason, nextGoalReason(input, race)].filter((r): r is GoalProgressReason => r != null),
    };
  }
  return { ...outcome, reasons: [raceReason(race), ...(phaseReason ? [phaseReason] : []), ...outcome.reasons].slice(0, 3) };
}

/**
 * Peak long-run distance (km) a runner should reach before the taper, by race
 * distance: 5K 8, 10K 14, half 18, marathon 32, otherwise 85% of the race.
 * Null without a race distance.
 */
export function longRunTargetKm(raceDistanceKm: number | null): number | null {
  return longRunTargetKmFor(raceDistanceKm);
}

/**
 * Long-run progress from RUNNING workouts with a distance: `lastKm` is the
 * longest run of the last 14 days (what the next long run grows from, so a
 * pre-illness long run weeks back no longer makes the next one unsafe), `peakKm`
 * the longest of the last 28. The race itself is not a training long run. Null
 * for non-endurance goals and when there was no run in the last 14 days.
 */
function longRunProgress(input: GoalProgressInput, race: GoalRaceProgress | null): GoalLongRunProgress | null {
  if (input.goal !== 'endurance') return null;
  const ec = enduranceCtx(input);
  const { lastKm, peakKm } = longRunStats(ec.runs, input.todayKey, input.race?.date ?? null);
  if (lastKm == null || peakKm == null) return null;
  // Once the race is done there is no peak left to build to. The peak is the race's, but never more than half of the
  // weekly goal (a long run is not most of a week): then `raceTargetKm` carries the race's own peak.
  const peak = race && race.phase !== 'recovery'
    ? longRunPeakTarget(race.distanceKm, input.target.weeklyDistanceKm ?? null, unitsPerKm(input))
    : null;
  return {
    lastKm,
    peakKm,
    targetPeakKm: peak?.peakKm ?? null,
    ...(peak?.raceTargetKm != null ? { raceTargetKm: peak.raceTargetKm } : {}),
    nextKm: ec.plan?.longRunKm ?? null,
    ...(ec.plan?.longRun.capNoteDue ? { capNoteDue: true } : {}),
    ...(ec.plan?.longRun.peakOversized ? { oversized: true } : {}),
  };
}

/** A long-run distance for the peak lines: imperial to the nearest half mile (as the peak target is), km to one decimal. */
function fmtLongRunPeak(input: GoalProgressInput, km: number): string {
  return input.unitSystem === 'imperial' ? formatTargetLongRun(km, unitsPerKm(input)) : fmtDistance(input, km);
}

/** True once the 28-day peak reaches the peak target, both read at the same rounding (11.2 mi against an 11 mi target is reached). */
function longRunPeakReached(input: GoalProgressInput, lr: GoalLongRunProgress, targetKm: number): boolean {
  const u = unitsPerKm(input);
  return input.unitSystem === 'imperial'
    ? roundLongRunKm(lr.peakKm, u) >= roundLongRunKm(targetKm, u) - 1e-9
    : lr.peakKm >= targetKm;
}

/** "early Dec" / "mid-Dec" / "late Dec" — a loose month position for a YYYY-MM-DD day. */
function looseMonthPosition(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  const month = RACE_MONTHS[m - 1];
  return d <= 7 ? `early ${month}` : d <= 22 ? `mid-${month}` : `late ${month}`;
}

/**
 * The long-run status line behind the race countdown. Build phase: "Long run
 * 14 km · build to 18 km by mid-Dec" below the peak target, "Long run peak 18 km
 * — on target" once the 28-day peak reaches it ("Longest run" below 5 km / 3 mi:
 * a 3 km jog is no long run). The build-up is over once the taper starts: taper
 * and race week say the peak is done instead of "build to". After the race it
 * says nothing. Imperial targets are rounded to the nearest half mile.
 */
function longRunReason(input: GoalProgressInput, lr: GoalLongRunProgress | null, race: GoalRaceProgress | null): GoalProgressReason | null {
  if (lr == null || race == null || lr.targetPeakKm == null) return null;
  if (race.phase === 'recovery') return null;
  // A peak that was most of its own week (over 55%) is never praised: neutral, the watch note says why.
  const praise: ReasonTone = lr.oversized === true ? 'neutral' : 'good';
  if (isWindDownPhase(race.phase)) {
    return { kind: 'long_run', text: `Peak long run ${fmtLongRunPeak(input, lr.peakKm)} — done`, tone: praise };
  }
  // When the weekly goal cannot carry the race's peak long run, say so - in the first build week, then at most every 4th.
  const goalKm = input.target.weeklyDistanceKm ?? null;
  const capNote = goalKm != null && lr.raceTargetKm != null && lr.capNoteDue === true
    ? longRunCapNote({ peakKm: lr.targetPeakKm, raceTargetKm: lr.raceTargetKm }, goalKm, unitsPerKm(input))
    : null;
  const note = capNote != null ? `. ${capNote}` : '';
  if (longRunPeakReached(input, lr, lr.targetPeakKm)) {
    return { kind: 'long_run', text: `Long run peak ${fmtLongRunPeak(input, lr.peakKm)} — on target${note}`, tone: praise };
  }
  const word = longRunWord(lr.lastKm, unitsPerKm(input));
  const lead = `${word.charAt(0).toUpperCase()}${word.slice(1)} ${fmtDistance(input, lr.lastKm)}`;
  const peakBy = addDays(race.date, -raceRules(race.distanceKm).peakLongRunLeadDays);
  const goal = peakBy >= input.todayKey
    ? `build to ${formatTargetLongRun(lr.targetPeakKm, unitsPerKm(input))} by ${looseMonthPosition(peakBy)}`
    : `peak target ${formatTargetLongRun(lr.targetPeakKm, unitsPerKm(input))}`;
  return { kind: 'long_run', text: `${lead} · ${goal}${note}`, tone: 'neutral' };
}

/**
 * Which endurance reasons make the "Why" (cap 3; with a race the race countdown
 * goes in front, so that is race + 2 of these):
 *   1. `lead` — the line the verdict rests on (the week plan's "what this week
 *      is for", or for goals without a distance target the volume trend);
 *   2. anything on watch (resting HR trending up, HRV trending down): a
 *      recovery warning must never be cut;
 *   3. then the rest in fixed priority: long run, sessions, resting HR, HRV.
 * This week's distance is deliberately not a reason: `distance.text` ("24.5 of
 * 30 km running this week") already states it as the card's primary stat.
 */
function enduranceReasons(lead: GoalProgressReason | null, rest: Array<GoalProgressReason | null>): GoalProgressReason[] {
  const others = rest.filter((r): r is GoalProgressReason => r != null);
  return capReasons([lead, ...others.filter(r => r.tone === 'watch'), ...others.filter(r => r.tone !== 'watch')]);
}

// ── The endurance verdict from the week plan ────────────────────────────────

/** "+11%" / "−5%" / "steady" — never "up 0%"; null when the earlier week was too small to compare with. */
function changeClause(changePct: number | null): string {
  if (changePct == null) return '';
  if (changePct === 0) return ' (steady)';
  return ` (${changePct > 0 ? '+' : '−'}${Math.abs(changePct)}%)`;
}

/** Last week more than this share over its step is "above the step" (still under the spike line), not "on plan". */
const ABOVE_STEP_FRACTION = 1.15;

/** Day of the week for a YYYY-MM-DD day (0 = Sunday ... 6 = Saturday). */
function weekdayOf(day: string): number {
  return new Date(dayNumber(day) * 86_400_000).getUTCDay();
}

/**
 * The phase line of a taper / race week / recovery week. Within the plan it is
 * what the week is for; once most of the week's budget is spent it says what is
 * left ("keep Sunday's run ≤ 4 km"); over the band it is a watch line. In race
 * week only the days BEFORE the race share the leftover budget — race day is not
 * one of them. The race eve has no km talk at all (`windDownPlanOutcome` answers it before this runs). On the last
 * day of a taper week the week is done: it says so and what the next one is for.
 */
function windDownLine(
  input: GoalProgressInput, plan: EnduranceWeekPlan, race: GoalRaceProgress,
  doneKm: number, over: boolean, raceDoneToday: boolean, postRace: boolean,
): GoalProgressReason {
  const phase = (plan.wind as NonNullable<EnduranceWeekPlan['wind']>).phase;
  const target = plan.targetKm ?? plan.goalKm;
  const u = unitsPerKm(input);
  // The days of the race's own calendar week after race day are recovery days, whatever the week's Monday said.
  const label = postRace || phase === 'recovery' ? 'Recovery' : phase === 'taper' ? 'Taper' : 'Race week';
  const progress = `${distanceNum(input, doneKm)} of ~${fmtDistance(input, target)}`;
  // The last day of a taper week: the week is done, whatever it held ("rest or a very easy jog from here" has no day left).
  if (phase === 'taper' && !postRace && !raceDoneToday && weekdayOf(input.todayKey) === 0) {
    const nextPhase = racePhaseInfo(race.date, addDays(mondayOfDay(input.todayKey), 7), race.distanceKm)?.phase;
    return {
      kind: 'race_phase',
      text: nextPhase === 'race_week' ? 'Taper week done — keep race week short and easy' : 'Taper week done — keep next week short and easy',
      tone: over ? 'watch' : 'neutral',
    };
  }
  if (over) {
    return { kind: 'race_phase', text: `${label}: ${progress} — over the plan; rest or a very easy jog from here`, tone: 'watch' };
  }
  if (raceDoneToday) {
    return { kind: 'race_phase', text: 'Walk it off, eat and rest; easy running only from here', tone: 'neutral' };
  }
  const left = target - doneKm;
  const toGo = postRace ? null : race.daysToGo;
  // Race week with the race still ahead: the budget is for the days before it (tomorrow's run is a short shakeout at most).
  if (phase === 'race_week' && toGo != null && toGo >= 2) {
    if (doneKm > 0 && doneKm >= target * 0.5 && left >= 1 / u) {
      const when = toGo === 2 ? "tomorrow's run" : 'the days before the race';
      const cap = toGo === 2 ? Math.min(left, (u < 1 ? 2 : 3) / u) : left;
      return { kind: 'race_phase', text: `${label}: ${progress} — keep ${when} ≤ ${fmtDistance(input, cap)}`, tone: 'neutral' };
    }
    return { kind: 'race_phase', text: plan.purpose, tone: 'neutral' };
  }
  // Not on the week's last day: nothing is left of "the rest of the week" then.
  if (toGo == null || toGo > 7) {
    if (doneKm > 0 && doneKm >= target * 0.5 && left >= 1 / u && weekdayOf(input.todayKey) !== 0) {
      const when = weekdayOf(input.todayKey) === 6 ? "Sunday's run" : 'the rest of the week';
      return { kind: 'race_phase', text: `${label}: ${progress} — keep ${when} ≤ ${fmtDistance(input, left)}`, tone: 'neutral' };
    }
  }
  if (postRace && phase !== 'recovery') return { kind: 'race_phase', text: `Recovery: easy only this week (~${fmtDistance(input, target)} max)`, tone: 'neutral' };
  // Just over the recovery ceiling but inside its slack: "right at" it, not "7.5 of up to 7".
  if (label === 'Recovery') {
    const slack = withinCeilingSlack(input, doneKm, target);
    if (slack != null) {
      return { kind: 'race_phase', text: `Recovery: ${fmtDistance(input, doneKm)} — right at your ~${fmtDistance(input, slack)} ceiling; easy from here`, tone: 'neutral' };
    }
  }
  return { kind: 'race_phase', text: plan.purpose, tone: 'neutral' };
}

/**
 * "18 km was 60% of your week — keep long runs ~15 km on 30 km weeks, or add easy km": a long run is the week's biggest
 * run, not most of it (at most half). A watch note, said once for the most recent week that did it.
 */
function longRunShareReason(input: GoalProgressInput, share: LongRunShare): GoalProgressReason {
  const u = unitsPerKm(input);
  const weeks = withUnit(Math.round(share.weekKm * u), input.unitSystem === 'imperial' ? 'mi' : 'km');
  const keep = formatTargetLongRun(share.weekKm * LONG_RUN_MAX_WEEK_SHARE, u);
  return {
    kind: 'long_run',
    text: `${fmtDistance(input, share.longKm)} was ${share.sharePct}% of your week — keep long runs ~${keep} on ${weeks} weeks, or add easy km`,
    tone: 'watch',
  };
}

/** Taper, race week and recovery: the verdict is this week against the phase target — within or under is on track. */
function windDownPlanOutcome(input: GoalProgressInput, ec: EnduranceCtx, plan: EnduranceWeekPlan, race: GoalRaceProgress): Outcome {
  const wind = plan.wind as NonNullable<EnduranceWeekPlan['wind']>;
  const doneKm = ec.thisWeek.km;
  const target = plan.targetKm ?? plan.goalKm;
  const grade = gradeEnduranceWeek(plan, doneKm, { unitsPerKm: unitsPerKm(input) });
  const raceRun = ec.raceRun;
  const raceDoneNow = raceRun != null && ((race.phase !== 'recovery' && race.daysToGo === 0) || (race.phase === 'recovery' && (race.daysSince ?? 99) <= 1));
  const raceDay = race.phase !== 'recovery' && race.daysToGo === 0;
  const postRace = race.phase === 'recovery';
  // The day before the race is for rest: the headline says so whatever the week's km are, and the km are not on the
  // card at all; race day is no day to be "over".
  const eve = !postRace && race.daysToGo === 1;
  if (eve) {
    const heavy = plan.targetKm != null && doneKm >= plan.targetKm * RACE_EVE_HEAVY_WEEK;
    return {
      verdict: 'on_track',
      headline: RACE_EVE_LINE,
      reasons: [
        raceReason(race),
        ...(heavy ? [{ kind: 'race_phase', text: RACE_EVE_CONSERVATIVE_LINE, tone: 'neutral' as const }] : []),
      ],
      raceHandled: true,
    };
  }
  // Having just raced is never "over the plan" for the week; the plan's ceiling is for the runs around it.
  const overBand = grade.gap === 'over' && !(raceDoneNow && race.phase !== 'recovery') && !raceDay;
  const over = overBand;
  const done = distanceNum(input, doneKm);
  const tgt = fmtDistance(input, target);
  // A taper week's low volume is safe (the light-week rule is for build weeks), but ", on plan" is a claim the week can still
  // make: it fails only at the weekend, when what is run plus the taper's long run still to come sits under the taper band
  // (60% of the target - lib/enduranceProgression.ts windDownBand). Before that the long run is still ahead ("5.4 of ~22 km" on a
  // Friday is on plan: 5.4 + the 11.5 km long run lands the week at 17 km), so the claim stands.
  const weekend = weekdayOf(input.todayKey) === 6 || weekdayOf(input.todayKey) === 0;
  const longestSoFar = Math.max(0, ...ec.runs.filter(r => r.day >= ec.weekStart && r.day <= input.todayKey && r.day !== race.date).map(r => r.km));
  const longRunPlanned = plan.longRunKm ?? 0;
  const longRunAhead = longestSoFar < longRunPlanned * 0.6 ? longRunPlanned : 0;
  const underBand = wind.phase === 'taper' && !postRace && weekend && doneKm + longRunAhead < target * TAPER_GOOD_MIN_FRACTION;
  let headline: string;
  if (raceDoneNow && raceRun) {
    const time = formatRaceTime(raceRun.durationMin);
    headline = `${race.label} done — ${fmtDistance(input, raceRun.km)}${time ? ` in ${time}` : ''}. Congratulations!`;
  } else if (raceDay) {
    headline = 'Race day — start relaxed';
  } else if (postRace) {
    const days = race.daysSince ?? 1;
    const week = wind.phase === 'recovery' ? recoveryWeek(-wind.info.daysToRace) : 1;
    headline = `Recovery week ${week} — day ${days} after your ${raceWord(race.label)}: easy only`;
  } else if (wind.phase === 'taper') {
    headline = `Taper week — ${done} of ~${tgt}${over ? ', over the plan' : underBand ? '; easy runs are enough' : doneKm > 0 ? ', on plan' : ''}`;
  } else {
    headline = `Race week — ${done} of ~${tgt} before the race${over ? ', over the plan' : ''}`;
  }
  const phaseLine = windDownLine(input, plan, race, doneKm, overBand, raceDoneNow && raceDay, postRace);
  const longRun = longRunReason(input, longRunProgress(input, race), race);
  let reasons: GoalProgressReason[];
  if (raceDoneNow && raceDay) {
    // The race is run: "Half marathon is today" and the long-run build are old news — only what to do now.
    reasons = [phaseLine];
  } else if (postRace) {
    reasons = [raceReason(race), phaseLine, nextGoalReason(input, race)].filter((r): r is GoalProgressReason => r != null);
  } else {
    reasons = [raceReason(race), phaseLine, ...(longRun ? [longRun] : [])].slice(0, 3);
  }
  return { verdict: over ? 'holding' : 'on_track', headline: clip(headline), reasons, raceHandled: true };
}

/**
 * "3 or 4 runs a week so far" / "4 runs a week over the last 4 weeks": run (or session) days per finished CALENDAR week
 * (Mon-Sun, only weeks that began on or after the goal did), never an average over a part-week window that moves a
 * little every day ("3.7 sessions a week over the last 17 days"). With no finished week yet it counts this week so far.
 * Null when nothing was logged in those weeks (the plain "no sessions" line then speaks).
 */
function wholeWeeksSessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  // The loader's longer run history (~11 weeks) when there is one; else the 28-day workouts (3 whole weeks fit in them).
  const runDays = new Set(enduranceCtx(input).runs.map(r => r.day));
  // A runner with a running week counts RUNS; otherwise (cycling, swimming, no distance) it is sessions.
  const useRuns = input.target.weeklyDistanceKm != null && runDays.size > 0;
  const days = useRuns ? runDays : new Set(sessionDays(input));
  const noun = useRuns ? 'run' : 'session';
  const thisMonday = weekStart(input.todayKey);
  const start = goalStartDay(input);
  const counts: number[] = [];
  const wholeWeeks = useRuns && input.runHistory != null ? 4 : 3;
  for (let k = 1; k <= wholeWeeks; k++) {
    const monday = addDays(thisMonday, -7 * k);
    if (start != null && monday < start) break;
    let n = 0;
    for (let i = 0; i < 7; i++) if (days.has(addDays(monday, i))) n += 1;
    counts.push(n);
  }
  const thisWeek = [...days].filter(d => d >= thisMonday && d <= input.todayKey).length;
  const hi = counts.length > 0 ? Math.max(...counts) : 0;
  const lo = counts.length > 0 ? Math.min(...counts) : 0;
  if (hi === 0) {
    return thisWeek > 0
      ? { kind: 'sessions', text: `${thisWeek} ${plural(thisWeek, noun)} so far this week`, tone: 'neutral' }
      : null;
  }
  const rate = lo === hi ? `${hi}` : hi - lo === 1 ? `${lo} or ${hi}` : `${lo}–${hi}`;
  const span = counts.length >= 3 ? `over the last ${counts.length} weeks` : 'so far';
  return { kind: 'sessions', text: `${rate} ${plural(hi, noun)} a week ${span}`, tone: 'neutral' };
}

/**
 * The sessions line of an endurance goal. On the day the goal is set nothing can have been logged yet, so "No training
 * sessions logged in the last 7 days" is noise there: the line waits until the goal has had a day to collect one.
 */
function enduranceSessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  const reason = weekSessionsReason(input) ?? wholeWeeksSessionsReason(input) ?? sessionsReason(input);
  if (reason?.kind === 'sessions' && reason.tone === 'watch' && (goalAgeDays(input) ?? 99) <= 1
    && sessionCount(input, sessionWindowDays(input)) === 0) return null;
  return reason;
}

/**
 * The endurance verdict for a runner with a weekly distance goal and measured
 * running, from the ONE week plan the weekly review also reads. It rests on
 * FINISHED weeks and on the week's own band, never on a rolling 14-day
 * comparison or on how much of the week has been run so far, so it does not flip
 * between rest days and run days:
 *  - taper / race week / recovery: this week against the phase target — within
 *    or under is 'on_track', over the band 'holding' with a watch line; race day
 *    says "start relaxed", and a race-length run on race day says "done";
 *  - on a break (no run for 7+ days), restart: 'building' ("Building back");
 *  - race eve: "Race tomorrow — rest or a 15-min shakeout; lay out your kit"
 *    whatever the week's km (an over-plan note is a neutral reason, never the
 *    headline); in race week only the days BEFORE the race share what is left;
 *  - build / maintain / hold week whose step is already run: a watch reason
 *    ("the week's step is done; keep Sunday easy and short"), not a spike verdict;
 *  - a jump over the week's safe step (this week so far, or last week's — then
 *    this is the hold week): 'holding', "Over the safe step — 40 of ~25 km. Hold
 *    ~28 km next week", no "distance up X%" praise;
 *  - baseline (first week of running): 'building', nothing to be behind yet;
 *  - rebuild (after the recovery weeks): 'building', never 'behind';
 *  - build: last week's grade — 'building' on plan, 'behind' only when last week
 *    was far short of its step; maintain (at the weekly goal): 'on_track'.
 */
function planOutcome(input: GoalProgressInput, ec: EnduranceCtx, race: GoalRaceProgress | null): Outcome {
  const plan = ec.plan as EnduranceWeekPlan;
  if (plan.wind && race) return windDownPlanOutcome(input, ec, plan, race);

  const u = unitsPerKm(input);
  const fmt = (km: number): string => fmtDistance(input, km);
  const doneKm = ec.thisWeek.km;
  const done = distanceNum(input, doneKm);
  const target = plan.targetKm ?? plan.goalKm;
  const goalText = fmt(plan.goalKm);
  const last = plan.last;
  const raceLine = race ? raceReason(race) : null;
  const lrProgress = longRunProgress(input, race);
  const lrReason = longRunReason(input, lrProgress, race);
  const sessions = enduranceSessionsReason(input);
  const vitals = [restingHrReason(input), hrvReason(input)];
  const planLine: GoalProgressReason = { kind: 'plan', text: plan.purpose, tone: 'neutral' };
  // A long run that was most of its week (over 55%): one watch note for the most recent such week, in the build weeks.
  const buildLike = plan.kind === 'build' || plan.kind === 'maintain' || plan.kind === 'hold';
  const shareNote = buildLike && plan.longRun.share != null && plan.longRun.shareDue ? longRunShareReason(input, plan.longRun.share) : null;
  const withRace = (reasons: GoalProgressReason[]): GoalProgressReason[] => (raceLine ? [raceLine, ...reasons] : reasons).slice(0, 3);
  const body = (lead: GoalProgressReason | null, extra: Array<GoalProgressReason | null> = []): GoalProgressReason[] =>
    withRace(enduranceReasons(lead, [...extra, shareNote, lrReason, sessions, ...vitals]));
  const finish = (verdict: GoalVerdict, headline: string, reasons: GoalProgressReason[]): Outcome =>
    ({ verdict, headline: clip(headline), reasons, raceHandled: true });
  // The week's target is the one number the headline, the distance line, the reasons and the jump check all use - a cutback week's
  // is the cutback number. Only the hold NEXT week steps up from the progression's own step (after a cutback, the week it replaced),
  // the number the coming Monday's plan uses (lib/enduranceProgression.ts, hold).
  const nextHold = weekStepOrGoalKm(plan.cutback?.normalKm ?? target, plan.goalKm, u);

  // A runner who has been off for 7+ days: say so, and where to restart.
  if (plan.onBreak && plan.kind !== 'baseline') {
    const days = plan.daysSinceRun as number;
    const usual = plan.restart?.medianKm ?? null;
    const after = usual != null && usual > plan.restartKm + 0.5
      ? `, then build back toward your usual ~${fmt(usual)}`
      : plan.restartKm >= plan.goalKm - 1e-9 ? '' : ', then build about 10% a week';
    // The number is "if you restart tomorrow": past two weeks off it drops a band, and the card says why instead of changing silently.
    const restartText = plan.restartLong
      ? `Two weeks off now — restart a bit lower, ~${fmt(plan.restartKm)}, with easy runs${after}`
      : `Restart at ~${fmt(plan.restartKm)} with easy runs${after}`;
    return finish('building', `On a break — ${days} days since your last run. Restart at ~${fmt(plan.restartKm)}.`, body(
      { kind: 'plan', text: restartText, tone: 'neutral' },
    ));
  }

  // A jump over this week's safe step: the headline is the warning, and no "distance up X%" praise is given for it.
  const current = plan.kind === 'baseline' ? null : gradeEnduranceWeek(plan, doneKm, { unitsPerKm: u });
  if (current?.gap === 'spike') {
    // On Sunday the week is over: the advice is about the days after it.
    const advice = weekdayOf(input.todayKey) === 0 ? "keep tomorrow's run easy and hold next week's step" : 'keep the rest of the week easy';
    // A comeback week far past its "up to" ceiling (wave 22e): the same read as the Monday card and the review - next week stays AT the ceiling.
    if (plan.upTo) {
      const ceilingAdvice = weekdayOf(input.todayKey) === 0 ? "keep tomorrow's run easy and stay at the ceiling next week" : 'keep the rest of the week easy';
      return finish('holding', `Well over the ceiling — ${done} of up to ~${fmt(target)}. Stay at ~${fmt(target)} next week`, body(
        { kind: 'volume', text: `${fmt(doneKm)} is ${fmt(doneKm - target)} over this week's ceiling; big jumps raise injury risk — ${ceilingAdvice}`, tone: 'watch' },
      ));
    }
    return finish('holding', `Over the safe step — ${done} of ~${fmt(target)}. Hold ~${fmt(nextHold)} next week`, body(
      { kind: 'volume', text: `${fmt(doneKm)} is ${fmt(doneKm - target)} over this week's safe step; big jumps raise injury risk — ${advice}`, tone: 'watch' },
    ));
  }

  // A light week (4+ days without a run, or well behind the week's pace from Friday): don't make it up. Holding, never
  // behind and never "on track for the half": the long run is capped, or skipped after illness.
  if (plan.lightWeek != null) {
    const stepped = target < plan.goalKm - 1e-9;
    return finish('holding', `Light week — ${done} of ${stepped ? '~' : ''}${fmt(target)} so far`, withRace(enduranceReasons(planLine, [sessions, ...vitals])));
  }

  // The last day of the week before a taper: the headline judges THIS week - short of its target, "Eased off early" - and it is fine.
  if (plan.preTaper != null && weekdayOf(input.todayKey) === 0 && doneKm > 0 && (plan.easingOff != null || current?.gap === 'short')) {
    const tomorrow = plan.preTaper.nextPhase === 'race_week' ? 'race week starts tomorrow' : 'taper starts tomorrow';
    return finish('on_track', `Eased off early — ${done} of ${target < plan.goalKm - 1e-9 ? '~' : ''}${fmt(target)}; ${tomorrow}`, withRace(enduranceReasons(planLine, [shareNote, lrReason, sessions, ...vitals])));
  }
  // The week before a taper whose target is out of reach: easing off is the plan's next step, fine - never "light", never "behind".
  if (plan.easingOff != null) {
    return finish('on_track', `Easing off before ${plan.preTaper?.nextPhase === 'race_week' ? 'race week' : 'your taper'} — ${done} of ${target < plan.goalKm - 1e-9 ? '~' : ''}${fmt(target)} so far`, withRace(enduranceReasons(planLine, [sessions, ...vitals])));
  }

  // The week's step (or goal) is already run: say so while there is still a day left to go over it. A watch
  // reason, not a spike verdict — that only fires once the jump itself is a jump.
  let stepDone: GoalProgressReason | null = null;
  if ((plan.kind === 'build' || plan.kind === 'maintain' || plan.kind === 'hold') && doneKm > 0
    && done >= distanceNum(input, target) && weekdayOf(input.todayKey) !== 0) {
    const when = weekdayOf(input.todayKey) === 6 ? 'Sunday' : 'the rest of the week';
    const stepped = target < plan.goalKm - 1e-9;
    stepDone = {
      kind: 'volume',
      text: `${done} of ${plan.upTo ? 'up to ~' : stepped ? '~' : ''}${fmt(target)} — the week's ${plan.kind === 'maintain' ? 'goal' : 'step'} is done; keep ${when} easy and short`,
      tone: 'watch',
    };
  }
  /** The week's lead reason: the step-done warning when it applies (the plan line then follows), else the plan line. */
  const planBody = (): GoalProgressReason[] => (stepDone != null ? body(stepDone, [planLine]) : body(planLine));

  const short = raceWord(input.race?.date ? raceLabel(input.race.distanceKm ?? null, input.unitSystem) : '');
  switch (plan.kind) {
    case 'baseline': {
      const long = `Baseline week — ${fmt(doneKm)} so far; next week's step is built from this week`;
      return finish('building', long.length <= HEADLINE_MAX_CHARS ? long : `Baseline week — ${fmt(doneKm)} so far`, body(planLine));
    }
    case 'restart':
      return finish('building', `Building back — restart at ~${fmt(target)} this week`, body(planLine));
    case 'hold': {
      const hold = plan.hold as NonNullable<EnduranceWeekPlan['hold']>;
      // A cutback week that ran more than 10% over its lowered number: no +10% build on the skip - hold at the week it replaced.
      if (hold.skippedCutback === true) {
        const skippedInfo: GoalProgressReason = { kind: 'volume', text: `Last week's ${fmt(hold.spikeKm)} was above the ~${fmt(hold.spikeStepKm)} cutback — the week it replaced stays the bar`, tone: 'watch' };
        return finish('holding', `You skipped the cutback — hold ~${fmt(target)} this week`, stepDone != null
          ? body(stepDone, [skippedInfo, planLine])
          : body(skippedInfo, [planLine]));
      }
      // A comeback week far past its "up to" ceiling: this week stays AT that ceiling and does not build on the jump.
      if (hold.ceiling === true) {
        const ceilingInfo: GoalProgressReason = { kind: 'volume', text: `Last week's ${fmt(hold.spikeKm)} was well over its ~${fmt(hold.spikeStepKm)} ceiling — don't build on the jump`, tone: 'watch' };
        return finish('holding', `Well over the ceiling last week — stay at ~${fmt(target)} this week`, stepDone != null
          ? body(stepDone, [ceilingInfo, planLine])
          : body(ceilingInfo, [planLine]));
      }
      const jumpInfo: GoalProgressReason = { kind: 'volume', text: `Last week's ${fmt(hold.spikeKm)} was over the safe step of ~${fmt(hold.spikeStepKm)}`, tone: 'watch' };
      return finish('holding', `Over the safe step last week — hold ~${fmt(target)} this week`, stepDone != null
        ? body(stepDone, [jumpInfo, planLine])
        : body(jumpInfo, [planLine]));
    }
    case 'rebuild':
      return finish('building', `Rebuilding after your ${short} — ${done} of ~${fmt(target)}`, body(planLine));
    case 'build':
    case 'maintain':
    default:
      break;
  }

  // Build and maintain: the verdict is how last week went against its own plan.
  const level = last?.grade?.level ?? 'good';
  const lastKm = last?.km ?? 0;
  const lastPlanKm = last?.targetKm ?? null;
  if (plan.kind === 'maintain') {
    if (level === 'good') {
      const peakTarget = lrProgress?.targetPeakKm ?? null;
      const long = race != null && lrProgress != null && peakTarget != null && race.phase === 'build' && lrProgress.oversized !== true
        ? (longRunPeakReached(input, lrProgress, peakTarget)
            ? `long run peak ${fmtLongRunPeak(input, lrProgress.peakKm)} reached`
            : `${longRunWord(lrProgress.lastKm, u)} ${distanceNum(input, lrProgress.lastKm)} of ${formatTargetLongRun(peakTarget, u)}`)
        : null;
      // A cutback week that ran past its lowered number says so, whatever the week's last-week read ("30 of ~24 km" is no on-plan cutback).
      const aboveCutback = plan.cutback != null && doneKm > target * CUTBACK_SKIPPED_FRACTION;
      const lead = aboveCutback ? fmt(doneKm) : long ?? `${goalText} a week`;
      const tail = aboveCutback ? `, above the ~${fmt(target)} cutback` : '';
      const headline = race != null
        ? `On track for the ${raceWord(race.label)} — ${lead}${tail}`
        : `On track — ${lead}${tail}`;
      return finish('on_track', headline, withRace(enduranceReasons(stepDone ?? planLine, [stepDone ? planLine : null, shareNote, long ? null : lrReason, sessions, ...vitals])));
    }
    if (level === 'tough') return finish('behind', `Behind — ${fmt(lastKm)} last week of ${goalText}`, planBody());
    return finish('holding', `Holding steady — ${fmt(lastKm)} last week of ${goalText}`, planBody());
  }
  // build
  if (level === 'tough') {
    return finish('behind', `Behind — ${fmt(lastKm)} last week${lastPlanKm != null ? `, ~${fmt(lastPlanKm)} was the step` : ''}`, planBody());
  }
  // A cutback week that ran well past its lowered number says so ("Cutback week - 25 of ~20 km, above the cutback"), not last week's read.
  if (plan.cutback != null && doneKm > target * CUTBACK_SKIPPED_FRACTION) {
    return finish('building', `Cutback week — ${done} of ~${fmt(target)}, above the cutback`, planBody());
  }
  const above = level === 'good' && lastPlanKm != null && lastKm > lastPlanKm * ABOVE_STEP_FRACTION;
  // A comeback week's "up to ~18 km" is a ceiling: more than 10% over it (but not far) is "a touch over, fine" - said neutrally and once,
  // never "on plan" (the review words it the same; the ceiling then climbs from the ceiling, not from the overshoot). Far over it is a
  // spike: the hold branch above says so.
  if (level === 'good' && last?.capRead === 'touch' && lastPlanKm != null) {
    return finish('building', `Building — ${distanceNum(input, lastKm)} of up to ~${fmt(lastPlanKm)} last week, ${overCapPhrase('touch')}`, planBody());
  }
  const how = last?.kind === 'baseline' ? ', your baseline'
    : last?.kind === 'restart' || last?.kind === 'rebuild' && plan.restart != null ? ', back after your break'
    : last?.cutback && !above && level === 'good' ? ', your cutback week'
    : above ? `, above the ~${fmt(lastPlanKm as number)} ${last?.cutback ? 'cutback' : 'step'}`
    : level === 'good' ? ', on plan'
    : level === 'mixed' ? `, a bit under the ~${fmt(lastPlanKm ?? target)} step`
    : ', a lighter week';
  return finish('building', `Building — ${fmt(lastKm)} last week${changeClause(last?.changePct ?? null)}${how}`, planBody());
}

function enduranceOutcome(input: GoalProgressInput): Outcome {
  const distanceTarget = input.target.weeklyDistanceKm;
  if (input.target.weeklySessions == null && distanceTarget == null) {
    return { verdict: 'needs_target', headline: 'Set a weekly distance or session goal to track your training', reasons: [] };
  }

  // A weekly distance goal with measured running: the ONE week plan decides (see planOutcome).
  const ec = enduranceCtx(input);
  if (ec.plan != null) return planOutcome(input, ec, raceProgress(input));

  const { count, perWeek } = sessionsPerWeek(input);
  const sessions = enduranceSessionsReason(input);
  const race = raceProgress(input);
  const longRun = longRunReason(input, longRunProgress(input, race), race);
  if (count < MIN_SESSIONS_FOR_ENDURANCE) {
    return {
      verdict: 'insufficient_data',
      headline: 'Log a few more sessions to see your training trend',
      reasons: enduranceReasons(null, [longRun, sessions]),
    };
  }

  // Volume: weekly distance when a distance target exists (and distances were
  // recorded), else weekly minutes when durations exist, else sessions/week.
  const wk = (offset: number) => {
    const days = new Set<string>();
    let minutes = 0;
    for (const w of input.workouts) {
      const age = dayNumber(input.todayKey) - dayNumber(w.day);
      if (age >= offset * 7 && age < offset * 7 + 7) minutes += w.durationMin ?? 0;
    }
    for (const d of input.trainingDays) {
      const age = dayNumber(input.todayKey) - dayNumber(d);
      if (age >= offset * 7 && age < offset * 7 + 7) days.add(d);
    }
    return { minutes, sessions: days.size, km: distanceInWeek(input, offset).km };
  };
  const weeks = [wk(0), wk(1), wk(2), wk(3)];
  const useKm = distanceTarget != null && weeks.reduce((s, x) => s + x.km, 0) > 0;
  const useMinutes = !useKm && weeks.reduce((s, x) => s + x.minutes, 0) > 0;
  const metric = (x: { minutes: number; sessions: number; km: number }) => (useKm ? x.km : useMinutes ? x.minutes : x.sessions);
  const recent = metric(weeks[0]) + metric(weeks[1]);
  const prior = metric(weeks[2]) + metric(weeks[3]);
  const changePct = prior > 0 ? ((recent - prior) / prior) * 100 : null;
  const noun = useKm ? 'distance' : useMinutes ? 'time' : 'sessions';
  const perWeekText = (v: number): string => (useKm ? fmtDistance(input, v) : (useMinutes ? withUnit(round1(v), 'min') : `${round1(v)} ${plural(round1(v), 'session')}`));
  // No training before the last 2 weeks (a new runner, or one starting over):
  // the average is over the weeks that exist, and the copy says "base", not
  // "restarted" / "back to regular training".
  const baseWindowDays = statWindowDays(input);
  const baseWeeks = Math.min(2, Math.max(1, baseWindowDays / 7));
  const steady = changePct != null && Math.round(Math.abs(changePct)) === 0;
  const volumeReason: GoalProgressReason | null = prior > 0 || recent > 0
    ? {
        kind: 'volume',
        text: changePct != null
          ? `Weekly training ${noun} ${steady ? 'steady' : `${changePct >= 0 ? 'up' : 'down'} ${Math.round(Math.abs(changePct))}%`} (${arrowPair(perWeekText(prior / 2), perWeekText(recent / 2))} a week, ${ENDURANCE_VOLUME_WINDOW_LABEL})`
          : `Building your base: ${perWeekText(recent / baseWeeks)} a week${baseWindowDays < 14 ? ' so far' : ' over the last 2 weeks'}`,
        tone: changePct == null || changePct >= ENDURANCE_BUILDING_PCT ? 'good' : changePct <= -15 ? 'watch' : 'neutral',
      }
    : null;

  const reasons = enduranceReasons(volumeReason, [longRun, sessions, restingHrReason(input), hrvReason(input)]);
  const building = (prior === 0 && recent > 0) || (changePct != null && changePct >= ENDURANCE_BUILDING_PCT);
  const buildingHeadline = changePct != null
    ? clip(`Building — ${useKm ? 'distance' : useMinutes ? 'time' : 'sessions'} up ${Math.round(changePct)}% (${ENDURANCE_VOLUME_WINDOW_LABEL})`)
    : 'Building your base';

  if (building) return { verdict: 'building', headline: buildingHeadline, reasons };
  const target = input.target.weeklySessions;
  return {
    verdict: 'holding',
    headline: clip(`Holding steady — ${perWeek} ${plural(perWeek, 'session')} a week${target != null ? ` vs a target of ${target}` : ''}`),
    reasons,
  };
}

function generalOutcome(input: GoalProgressInput): Outcome {
  const today = input.todayKey;
  const sessionDays = new Set(input.trainingDays);
  const loggedDays = new Set(input.intakeDays.filter(d => d.source !== 'none').map(d => d.day));
  const sleepGoalMin = input.sleepGoalMinutes * SLEEP_GOAL_FRACTION;

  const windowStats = (fromAge: number, toAge: number) => {
    const inWin = (day: string) => {
      const age = dayNumber(today) - dayNumber(day);
      return age >= fromAge && age < toAge;
    };
    const span = toAge - fromAge;
    const active = [...sessionDays].filter(inWin).length;
    const logging = [...loggedDays].filter(inWin).length;
    const sleepNights = input.sleepMinutes.filter(p => inWin(p.day));
    const sleepHit = sleepNights.filter(p => p.value >= sleepGoalMin).length;
    const parts = [active / span, logging / span];
    if (sleepNights.length >= 3) parts.push(sleepHit / sleepNights.length);
    return { active, logging, sleepHit, sleepWithData: sleepNights.length, span, composite: mean(parts) as number };
  };

  // A goal younger than 28 days is judged over the days it has existed:
  // "Active on 2 of the last 5 days", not "of the last 28". With no more than 14
  // days there is no earlier half to compare against.
  const windowDays = statWindowDays(input);
  const scaled = (at28: number): number => (at28 * windowDays) / STAT_WINDOW_DAYS;
  const recent = windowStats(0, Math.min(14, windowDays));
  const prior = windowDays > 14 ? windowStats(14, windowDays) : null;
  const all28 = windowStats(0, windowDays);

  const dataPoints = all28.active + all28.logging + all28.sleepWithData;
  const reasons = capReasons([
    {
      kind: 'activity',
      text: `Active on ${all28.active} of the last ${windowDays} days`,
      tone: all28.active >= scaled(12) ? 'good' : all28.active >= scaled(6) ? 'neutral' : 'watch',
    },
    all28.sleepWithData >= 3
      ? {
          kind: 'sleep',
          text: `Met your sleep goal on ${all28.sleepHit} of ${all28.sleepWithData} tracked nights`,
          tone: all28.sleepHit / all28.sleepWithData >= 0.7 ? 'good' : all28.sleepHit / all28.sleepWithData < 0.4 ? 'watch' : 'neutral',
        }
      : null,
    {
      kind: 'logging',
      text: `Logged food on ${all28.logging} of the last ${windowDays} days`,
      tone: all28.logging >= scaled(20) ? 'good' : all28.logging >= scaled(10) ? 'neutral' : 'watch',
    },
  ]);

  if (dataPoints < 5) {
    return {
      verdict: 'insufficient_data',
      headline: 'Log meals, workouts or sleep for a week to see your consistency',
      reasons: [],
    };
  }

  const rPct = Math.round(recent.composite * 100);
  if (prior == null) {
    return { verdict: 'holding', headline: clip(`Early days — habit consistency ${rPct}% so far`), reasons };
  }
  const pPct = Math.round(prior.composite * 100);
  if (recent.composite >= prior.composite + GENERAL_BUILDING_DELTA) {
    return { verdict: 'building', headline: clip(`Building — habit consistency ${rPct}% vs ${pPct}% before`), reasons };
  }
  return { verdict: 'holding', headline: clip(`Holding steady — habit consistency ${rPct}% over 2 weeks`), reasons };
}

/**
 * Start weight when none was stored (the user had no weigh-in when the goal
 * began): the trend at the first weigh-in on/after the goal start day, else the
 * first weigh-in overall. Null without a goal start or any weigh-in.
 */
export function deriveStartWeightKg(
  trendDays: Array<{ day: string; trendKg: number }>,
  start: { startedAt: string | null; startedDay?: string | null },
): number | null {
  if (start.startedAt == null && start.startedDay == null) return null;
  if (trendDays.length === 0) return null;
  const startedDay = start.startedDay ?? (start.startedAt as string).slice(0, 10);
  const first = trendDays.find(d => d.day >= startedDay) ?? trendDays[0];
  return round1(first.trendKg);
}

/** The additive `weightRead` payload block: how the weight verdict was read (see GoalWeightRead). */
function weightReadOf(input: GoalProgressInput, w: WeightBlock, verdict: GoalVerdict): GoalWeightRead {
  const plan = w.plan;
  let state: GoalWeightRead['state'] = null;
  if (w.lastWeighInDay != null && !w.stale) {
    if (verdict === 'reached') state = 'reached';
    else if (plan != null) state = plan.state === 'pace' ? 'pace' : plan.state === 'maintenance' ? 'reached' : plan.state;
  }
  const ret = w.ret;
  const returned = plan != null && plan.state === 'returning' && ret != null
    ? { gapDays: ret.gapDays, sinceDay: ret.lastBeforeDay, sinceKg: round1(ret.lastBeforeKg), weighInsSince: ret.weighInsSince }
    : null;
  const stated = plan != null && plan.confirmed && w.eta != null && !w.aging ? plan.weeksVsTarget : null;
  const cause = plan?.plateauCause ?? null;
  return {
    state,
    scaleKg: w.scaleKg != null ? round1(w.scaleKg) : null,
    scaleDay: w.lastWeighInDay,
    weekMeanKg: w.weekMeanKg != null ? round1(w.weekMeanKg) : null,
    weeksVsTarget: verdict === 'ahead' || verdict === 'behind' || verdict === 'on_track' ? stated : null,
    returned,
    reachedDaysAgo: verdict === 'reached' && w.reachedAt != null ? dayNumber(input.todayKey) - dayNumber(w.reachedAt) : null,
    goalAgeDays: goalAgeDays(input),
    paceWindowDays: plan?.pace != null && (state === 'pace' || state === 'plateau') ? plan.pace.windowDays : null,
    intake: input.goal !== 'weight_loss' ? null
      : state === 'plateau' && cause != null && cause.avgKcal != null && cause.targetKcal != null
        ? {
            avgKcal: cause.avgKcal,
            targetKcal: cause.targetKcal,
            loggedDays: cause.loggedDays,
            daysWithinTarget: cause.loggedDays - loggedOverBudgetDays(input, cause),
            low: cause.kind === 'intake',
          }
        : intakeRead(input),
    ...(input.goal === 'weight_loss' ? { plan } : {}),
  };
}

/** Logged days of the plateau's 21-day span that ran over the budget (1.05 x the target) — the count behind `intake.daysWithinTarget`. */
function loggedOverBudgetDays(input: GoalProgressInput, cause: NonNullable<WeightWeekPlan['plateauCause']>): number {
  const target = cause.targetKcal;
  if (target == null) return 0;
  const from = addDays(cause.namedAt, -(PLATEAU_SPAN_DAYS - 1));
  return (input.intakeHistoryDays ?? input.intakeDays).filter(d =>
    d.source !== 'none' && d.kcal != null && d.kcal >= PARTIAL_LOG_KCAL_THRESHOLD && d.day >= from && d.day <= cause.namedAt
    && d.kcal > target * CALORIE_ADHERENCE_TOLERANCE).length;
}

/** The local day of the newest session within the trailing 28 days (the day behind lastSessionDaysAgo); null when there was none. */
function lastSessionDay(input: GoalProgressInput): string | null {
  let newest: string | null = null;
  for (const d of sessionDays(input)) {
    if (!inLastDays(d, input.todayKey, STAT_WINDOW_DAYS)) continue;
    if (newest == null || d > newest) newest = d;
  }
  return newest;
}

/** Days since the newest session within the trailing 28 days; null when there was none. */
function lastSessionDaysAgo(input: GoalProgressInput): number | null {
  let newest: string | null = null;
  for (const d of sessionDays(input)) {
    if (!inLastDays(d, input.todayKey, STAT_WINDOW_DAYS)) continue;
    if (newest == null || d > newest) newest = d;
  }
  return newest == null ? null : dayNumber(input.todayKey) - dayNumber(newest);
}

// ── Public entry point ──────────────────────────────────────────────────────

export function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  const w = buildWeightBlock(input);
  const { count: sessionsLast28d } = sessionsPerWeek(input);
  const liftReturns = liftReturnsOf(input);
  const liftReturn = liftReturns[0] ?? null;

  let outcome: Outcome;
  switch (input.goal) {
    case 'weight_loss': outcome = fatLossOutcome(input, w); break;
    case 'muscle': outcome = muscleOutcome(input, w, liftReturn, liftReturns); break;
    case 'endurance': outcome = enduranceOutcome(input); break;
    default: outcome = generalOutcome(input);
  }

  // Race countdown + phase lead the reasons (cap 3). A week-plan outcome (a weekly distance goal with
  // measured running) already carries the whole race lifecycle; any other endurance goal gets the race
  // line, the phase line and, once the race is done, the recovery headline folded in here.
  const race = raceProgress(input);
  const dist = input.goal === 'endurance' ? distanceProgress(input) : null;
  if (race && !outcome.raceHandled) outcome = withRaceLifecycle(input, outcome, race);

  const safeBand =
    input.goal === 'weight_loss' ? { ...FAT_LOSS_BAND }
    : input.goal === 'muscle' ? { ...MUSCLE_GAIN_BAND }
    : null;

  const startKg = input.start.weightKg ?? deriveStartWeightKg(w.trend.days, input.start);
  const targetKg = input.target.weightKg;
  // weight_loss measures progress from ONE weight — the 7-day raw mean, else the latest scale reading — the same one the
  // headline's "to go", the early read, the coach lines and the opener use. `current.weightKg` is that same weight for a fat-loss
  // goal (the smoothed trend moves to `current.trendKg`), so no surface shows two weights.
  const progressKg = input.goal === 'weight_loss' ? (w.progressKg ?? w.currentKg) : w.currentKg;
  const changeKg = progressKg != null && startKg != null ? round1(progressKg - startKg) : null;
  let progressPct: number | null = null;
  if (progressKg != null && startKg != null && targetKg != null && startKg !== targetKg) {
    const raw = ((startKg - progressKg) / (startKg - targetKg)) * 100;
    progressPct = Math.round(Math.min(100, Math.max(0, raw)));
  }
  // A reached weight target is 100% done — never 99% off a 0.1 kg tolerance, and
  // not 0% when the goal began already past it. (A stale weigh-in proves nothing.)
  const weightGoal = input.goal === 'weight_loss' || input.goal === 'muscle';
  if (weightGoal && w.reached === true && !w.stale && w.currentKg != null && targetKg != null) progressPct = 100;

  // The ETA / pace fields are only meaningful when the goal's verdict logic
  // actually engaged the weight trend; endurance/general never project one.
  const usesWeight = input.goal === 'weight_loss' || input.goal === 'muscle';
  // A stalled verdict (plateau uses a 14-day rate, the ETA a 28-day one) must
  // not carry a projected date that contradicts it.
  const insufficient =
    outcome.verdict === 'insufficient_data' || outcome.verdict === 'needs_target' || outcome.verdict === 'stalled';

  return {
    goal: input.goal,
    target: { ...input.target, weeklyDistanceKm: input.target.weeklyDistanceKm ?? null },
    distance: dist,
    race,
    longRun: longRunProgress(input, race),
    current: {
      // weight_loss: ONE displayed weight (the weekly average, else the scale) so "to go", "Now" and the bar agree;
      // the smoothed trend the chart draws moves to `trendKg`.
      weightKg: input.goal === 'weight_loss'
        ? (progressKg != null ? round1(progressKg) : null)
        : (w.currentKg != null ? round1(w.currentKg) : null),
      startWeightKg: startKg,
      changeKg,
      progressPct,
      ...(input.goal === 'weight_loss' ? { trendKg: w.currentKg != null ? round1(w.currentKg) : null } : {}),
    },
    ratePerWeek: {
      kg: w.rateKg != null ? round2(w.rateKg) : null,
      pctBodyweight: w.pctBw != null ? round2(w.pctBw) : null,
    },
    safeBand,
    // An aging weigh-in (7-14 days) keeps the verdict but quotes no projected
    // date and no pace call off it; a reached target stays reached.
    eta: usesWeight && !insufficient && !w.aging ? w.eta : null,
    onPaceForTargetDate: usesWeight && !insufficient && !(w.aging && w.reached !== true) ? w.onPace : null,
    verdict: outcome.verdict,
    headline: outcome.headline,
    reasons: outcome.reasons,
    lastWeighInDaysAgo: w.ageDays,
    lastSessionDaysAgo: lastSessionDaysAgo(input),
    reachedAt: usesWeight ? w.reachedAt : null,
    weightRead: usesWeight ? weightReadOf(input, w, outcome.verdict) : null,
    adherence: input.goal === 'muscle' ? sessionAdherence(input) : null,
    liftReturn,
    // Muscle only (absent for every other goal, so their payloads are byte-identical to before).
    ...(input.goal === 'muscle' ? { liftReturns: liftReturns.length > 0 ? liftReturns : null } : {}),
    lastSessionOn: lastSessionDay(input),
    dataSufficiency: { weighIns: w.weighIns, needed: WEIGH_INS_NEEDED, sessionsLast28d },
  };
}
