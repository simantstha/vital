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
 *    and the opener) is measured from ONE weight: the 7-day raw mean, else the scale.
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
 *  - general — consistency: active days, sleep-goal nights, logging days.
 */

import type { WeightReading } from './weightTrend';
import { arrowPair, withUnit } from './displayText';
import { computeWeightTrend, trendDeltaKgPerWeek, trendDeltaSpanDays, trendSpanDays } from './weightTrend';
import {
  ON_PACE_MARGIN_DAYS,
  PACE_MIN_SPAN_DAYS,
  PACE_MIN_WEIGH_INS,
  PACE_RECHECK_DAYS,
  PACE_SETTLE_DAYS,
  PACE_WINDOW_DAYS,
  RETURN_WEIGH_INS_NEEDED,
  bridgedPace,
  etaDaysAhead,
  isReturning,
  meanOver,
  paceEta,
  rawPlateau,
  relationForDays,
  tooFastLoss,
  weeksForDays,
  weighInReturn,
  weightReachedRead,
  type PaceRelation,
  type RawPlateau,
  type WeighInReturn,
  type WeightPace,
} from './weightPace';
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
  isLiftStalled,
  LIFT_LAPSE_MIN_DAYS,
  liftChange4w,
  liftDisplayChange,
  liftDisplayName,
  liftLastBest,
  liftRecentEndWeek,
  liftReturnDisplay,
  liftReturnState,
  pickHeadlineLift,
  pickWeekOverWeek,
  rankLifts,
  type LiftReturnState,
} from './liftChange';
import { weekStartKeyForDay } from './localDay';
import { KM_PER_MILE } from './metricFormat';
import {
  PHASE_CEILING_TOLERANCE,
  RACE_EVE_LINE,
  enduranceWeekPlan,
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
  planWeekKm,
  racePhaseInfo,
  racePhaseTargetKm,
  raceRules,
  recoveryWeek,
  roundLongRunKm,
  roundWeekTargetKm,
  weekStepOrGoalKm,
  type EnduranceWeekKind,
  type EnduranceWeekPlan,
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
export const FAT_LOSS_BAND = { minPct: 0.25, maxPct: TOO_FAST_LOSS_PCT_PER_WEEK } as const;
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
/** Trend and scale further apart than this (kg) and the trend gets its one-line explanation. */
const TREND_SCALE_GAP_KG = 0.3;
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
   *  - 'pace'      a least-squares pace over the last 3 weeks of raw weigh-ins
   *  - 'reached'   the target is reached
   * Null for a goal without a weight read (or no usable weigh-in).
   */
  state: 'early' | 'returning' | 'plateau' | 'pace' | 'reached' | null;
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
   * Additive, weight_loss only. The logged-day calorie picture of the last 7 days behind the plateau advice: the
   * average of the logged days against the budget, and `low` when most of them ran over it. Null without a
   * calorie target or 3+ logged days.
   */
  intake?: { avgKcal: number; targetKcal: number; loggedDays: number; daysWithinTarget: number; low: boolean } | null;
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
    weightKg: number | null;
    startWeightKg: number | null;
    changeKg: number | null;
    progressPct: number | null;
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
   * `behind` verdict (pct < ADHERENCE_BEHIND_PCT), so a client can say WHY the
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
  /** weight_loss only: how the scale was read (null for other goals or without enough weigh-ins). */
  read: WeightLossRead | null;
}

/** weight_loss: what the raw weigh-ins say (see lib/weightPace.ts). */
interface WeightLossRead {
  /** 'unconfirmed': a pace exists but the pace 7 days ago cannot confirm it yet; 'confirmed': both exist. */
  state: 'returning' | 'plateau' | 'early' | 'unconfirmed' | 'confirmed';
  pace: WeightPace | null;
  ret: WeighInReturn | null;
  plateau: RawPlateau | null;
  /** The goal is younger than PACE_SETTLE_DAYS (null age = unknown = not young). */
  young: boolean;
  /** Ahead / on pace / behind as the card states it ('confirmed' with a target date); null otherwise. */
  relation: PaceRelation | null;
  /** Weeks the stated ETA is ahead (+) / behind (−) the target date; null when no claim is made. */
  weeksVsTarget: number | null;
  /** No target date: both the pace now and 7 days ago are under the safe-band floor. */
  slow: boolean;
  /** The pace points away from the target (the scale is going the wrong way). */
  away: boolean;
  /** Losing too fast, with hysteresis (lib/weightPace.ts tooFastLoss); only ever true for a pace state. */
  tooFast: boolean;
}

/** Weigh-ins in the 7 days up to the newest needed before a weekly mean is quoted. */
const WEEK_MEAN_MIN_WEIGH_INS = 3;

/** True when `kg` has reached `targetKg` for the goal's direction (within 0.1 kg counts). Only goals without a weight verdict use this. */
function weightReachedTarget(goal: GoalKind, targetKg: number, kg: number): boolean {
  const needed = targetKg - kg;
  if (Math.abs(needed) < 0.1) return true;
  if (goal === 'weight_loss') return needed > 0;
  if (goal === 'muscle') return needed < 0;
  return false;
}

/** The weight a pace is measured from: its week's raw mean when there is one, else the fitted line's end. */
function paceCurrentKg(days: Array<{ day: string; rawKg: number }>, pace: WeightPace): number {
  const week = meanOver(days, pace.newestDay, 7);
  return week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : pace.fittedKg;
}

/** What the paces say about the target date as of one weigh-in day (before any debouncing). */
interface PaceClaim {
  relation: PaceRelation | null;
  /** Weeks the stated ETA is ahead (+) / behind (−) the target date, 0 = on pace; null when no ahead/behind figure is stated. */
  weeks: number | null;
  /** The date the card states: the target date itself while on pace, the projection when ahead or behind; null when none. */
  eta: string | null;
  onPace: boolean | null;
}

interface WeightLossEval {
  read: WeightLossRead;
  /** The stated date and on-pace call, as computed for this one day. */
  claim: PaceClaim;
  /** Both paces exist and a target date is set, so `claim` is a real pace call. */
  claims: boolean;
  /** No target date: the ETA from the pace alone. */
  eta: string | null;
}

/**
 * The weight-loss read of the scale as of one weigh-in day `anchor`. One
 * function decides the state, the pace and the date claim, so the card, its
 * reasons, the coach lines and the opener all agree. The date (and "N weeks
 * ahead/behind") is only STATED when the pace as of `anchor` AND the pace as of
 * 7 days before it, from the same readings, land on the same side of the target
 * date. Two paces on opposite sides of it do not drop the date: the card says it
 * is on track for the target date itself.
 */
function evaluateWeightLossAt(
  input: GoalProgressInput,
  days: Array<{ day: string; rawKg: number }>,
  anchor: string,
  targetKg: number | null,
  withTooFast = false,
): WeightLossEval {
  const start = goalStartDay(input);
  const goalAge = start != null ? Math.max(1, dayNumber(anchor) - dayNumber(start) + 1) : null;
  const young = goalAge != null && goalAge < PACE_SETTLE_DAYS;
  const known = days.filter(d => d.day <= anchor);
  const ret = weighInReturn(known, start);
  const plateau = rawPlateau(known, anchor, goalAge);
  const pace = bridgedPace(known, anchor);
  const earlier = bridgedPace(known, addDays(anchor, -PACE_RECHECK_DAYS));
  const week = meanOver(known, anchor, 7);
  const weekMeanKg = week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : null;

  let state: WeightLossRead['state'];
  if (isReturning(ret)) state = 'returning';
  else if (plateau) state = 'plateau';
  else if (young || pace == null) state = 'early';
  else if (earlier == null) state = 'unconfirmed';
  else state = 'confirmed';

  const fromKg = pace != null ? (weekMeanKg ?? pace.fittedKg) : null;
  const away = pace != null && fromKg != null && targetKg != null
    && Math.sign(pace.kgPerWeek) !== Math.sign(targetKg - fromKg);
  const etaOpts = { minPct: PLATEAU_MAX_PCT_PER_WEEK, maxDays: MAX_ETA_DAYS };
  const tooFast = withTooFast && (state === 'unconfirmed' || state === 'confirmed') && pace != null && pace.kgPerWeek < 0
    && tooFastLoss(known, anchor, { settledFrom: start != null ? addDays(start, PACE_SETTLE_DAYS - 1) : null });

  let eta: string | null = null;
  let relation: PaceRelation | null = null;
  let weeks: number | null = null;
  let slow = false;
  let onPace: boolean | null = null;
  let claims = false;

  if (state === 'confirmed' && pace != null && earlier != null && targetKg != null && fromKg != null) {
    const etaNow = paceEta(pace, targetKg, { ...etaOpts, fromKg });
    const etaThen = paceEta(earlier, targetKg, { ...etaOpts, fromKg: paceCurrentKg(known, earlier) });
    const date = input.target.date;
    // A pace under the safe band's floor is never "on pace" just because the pace a week ago said something else.
    const slowNow = Math.abs(pace.pctPerWeek) < FAT_LOSS_BAND.minPct;
    if (date != null) {
      claims = true;
      const dNow = etaNow != null ? etaDaysAhead(etaNow, date) : null;
      const dThen = etaThen != null ? etaDaysAhead(etaThen, date) : null;
      if (dNow != null && dThen != null && (dNow >= 0) === (dThen >= 0)) {
        // Both projections land on the same side of the target date: state the one nearer it, so a single reading
        // never moves the claim by more than the two agree on.
        const stated = Math.abs(dNow) <= Math.abs(dThen) ? dNow : dThen;
        relation = relationForDays(stated);
        weeks = relation === 'on_pace' ? 0 : (relation === 'ahead' ? 1 : -1) * weeksForDays(stated);
        eta = relation === 'on_pace' ? date : stated === dNow ? etaNow : etaThen;
      } else if (dNow == null && dThen == null) {
        relation = 'behind'; // no date can be projected from either pace
      } else {
        // The two paces disagree about which side of the target date they land on (or only one projects a date).
        // Opposite sides is no ahead/behind call: on track for the target date. A pace under the floor, or one
        // that lands behind, is behind and states the date its own pace projects.
        relation = (dNow != null && dThen != null ? slowNow : ((dNow ?? dThen) as number) < 0 || slowNow) ? 'behind' : 'on_pace';
        if (relation === 'on_pace') {
          weeks = 0;
          eta = date;
        } else if (dNow != null && relationForDays(dNow) === 'behind') {
          weeks = -weeksForDays(dNow);
          eta = etaNow;
        }
      }
      onPace = relation !== 'behind';
    } else {
      eta = etaNow;
      slow = Math.abs(pace.pctPerWeek) < FAT_LOSS_BAND.minPct && Math.abs(earlier.pctPerWeek) < FAT_LOSS_BAND.minPct;
    }
  }
  // The scale going the wrong way is "not on pace" whatever the date.
  if (onPace == null && input.target.date != null && away && (state === 'unconfirmed' || state === 'confirmed')) onPace = false;

  return {
    read: { state, pace, ret, plateau, young, relation, weeksVsTarget: weeks, slow, away, tooFast },
    claim: { relation, weeks, eta, onPace },
    claims,
    eta,
  };
}

/** The call a weigh-in day states is settled by the weigh-ins of this many days up to it (about six weeks). */
const CLAIM_WALK_DAYS = 42;

/** Two claims make the same call: the same ahead / on pace / behind relation, and both state a date or neither does. */
function sameCall(a: PaceClaim, b: PaceClaim): boolean {
  return a.relation === b.relation && (a.eta == null) === (b.eta == null);
}

/**
 * The weight-loss read as of the newest weigh-in. The call it states (ahead /
 * on pace / behind, with or without a date) changes only after two consecutive
 * weigh-in days make the new call: walking the weigh-ins oldest to newest, a day
 * whose call differs from the one stated keeps the stated one unless the day
 * before made the same new call. So a date never comes and goes, and the call
 * never flips, off a single reading. While the call holds, its weeks and date
 * follow the pace (a behind date moves as the pace does).
 */
function buildWeightLossRead(
  input: GoalProgressInput,
  days: Array<{ day: string; rawKg: number }>,
  anchor: string,
  targetKg: number | null,
): { read: WeightLossRead; eta: string | null; onPace: boolean | null } {
  const now = evaluateWeightLossAt(input, days, anchor, targetKg, true);
  let { read, eta } = now;
  let onPace = now.claim.onPace;

  if (now.claims) {
    let stated: PaceClaim | null = null;
    let previous: PaceClaim | null = null;
    const walkFrom = addDays(anchor, -(CLAIM_WALK_DAYS - 1));
    for (const d of days.filter(x => x.day <= anchor && x.day >= walkFrom)) {
      const ev = d.day === anchor ? now : evaluateWeightLossAt(input, days, d.day, targetKg);
      if (!ev.claims) {
        stated = null;
        previous = null;
        continue;
      }
      if (stated == null || sameCall(ev.claim, stated) || (previous != null && sameCall(ev.claim, previous))) stated = ev.claim;
      previous = ev.claim;
    }
    if (stated != null) {
      read = { ...read, relation: stated.relation, weeksVsTarget: stated.weeks };
      eta = stated.eta;
      onPace = stated.onPace;
    }
  }
  // The scale going the wrong way is "not on pace" whatever the date.
  if (onPace == null && input.target.date != null && read.away && (read.state === 'unconfirmed' || read.state === 'confirmed')) onPace = false;
  return { read, eta, onPace };
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

  const scaleKg = days.length > 0 ? days[days.length - 1].rawKg : null;
  const week = lastWeighInDay != null ? meanOver(days, lastWeighInDay, 7) : null;
  const weekMeanKg = week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : null;
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

  // weight_loss reads the raw scale instead (the trend above only draws the chart).
  let read: WeightLossRead | null = null;
  if (input.goal === 'weight_loss' && lastWeighInDay != null && rateReliable) {
    const built = buildWeightLossRead(input, days, lastWeighInDay, targetKg);
    read = built.read;
    const showsPace = read.pace != null && (read.state === 'plateau' || read.state === 'unconfirmed' || read.state === 'confirmed');
    rateKg = showsPace ? (read.pace as WeightPace).kgPerWeek : null;
    pctBw = showsPace ? (read.pace as WeightPace).pctPerWeek : null;
    rateSpanDays = null;
    neededKg = progressKg != null && targetKg != null ? targetKg - progressKg : null;
    eta = reached === true ? null : built.eta;
    onPace = input.target.date == null ? null : reached === true ? true : built.onPace;
  }

  return {
    weighIns, spanDays, rateReliable, trend, currentKg, rateKg, pctBw, rateSpanDays, reached, neededKg,
    eta, onPace, lastWeighInDay, ageDays, stale, aging, reachedAt, scaleKg, weekMeanKg, progressKg, read,
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
 *    ("6 of 5 planned in 9 days" jumped around daily): "This week 2 of 4 · 6
 *    sessions so far". It is judged (the usual 75% / 90% tones, on the same
 *    numbers as the verdict) only once the first full week is done; before that
 *    it is never amber.
 */
function adherenceReason(input: GoalProgressInput): GoalProgressReason | null {
  const a = sessionAdherence(input);
  if (!a) return null;
  if (isYoungGoal(input)) {
    const start = weekStart(input.todayKey);
    const thisWeek = new Set(sessionDays(input).filter(d => d >= start && d <= input.todayKey)).size;
    const shown = Math.min(thisWeek, a.weeklyTarget);
    const open = firstWeekOpen(input);
    return {
      kind: 'adherence',
      text: `This week ${shown} of ${a.weeklyTarget} · ${a.done} ${plural(a.done, 'session')} so far`,
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

/** ", around Dec 10" — or "" while the weigh-in is aging (no date quoted) and "any day now" for a date already reached. */
function aroundText(input: GoalProgressInput, w: WeightBlock, eta: string): string {
  if (w.aging) return '';
  return eta <= input.todayKey ? ', any day now' : `, around ${fmtDate(eta, input.todayKey)}`;
}

// weight_loss reasons and outcomes (the pace is lib/weightPace.ts) ──────────

/**
 * The pace against the safe band — the same rate the headline quotes, so the card never calls one rate both too fast and inside the band.
 * `held`: the too-fast call is being kept at a pace between 0.9% and the 1% ceiling (hysteresis), so the band is not "safe" yet.
 * `easeToMaintenance`: the target is reached and the loss is still past the ceiling, so the warning says what to do.
 */
function paceReason(
  input: GoalProgressInput,
  pace: WeightPace,
  opts: { held?: boolean; easeToMaintenance?: boolean } = {},
): GoalProgressReason {
  const dir = pace.kgPerWeek < 0 ? 'Down' : 'Up';
  // The shown figure decides the band: a rate printed as "1%" is never called "above the 1% ceiling".
  const abs = round2(Math.abs(pace.pctPerWeek));
  const band = FAT_LOSS_BAND;
  const weeks = Math.round(pace.windowDays / 7);
  let text = `${dir} ${fmtWeight(input, Math.abs(pace.kgPerWeek), 2)}/wk (${abs}% of bodyweight) over the last ${weeks} weeks`;
  let tone: ReasonTone = 'neutral';
  if (pace.kgPerWeek < 0) {
    if (opts.held && abs >= band.minPct && abs <= band.maxPct) {
      tone = 'watch';
      text += `, close to the ${band.maxPct}% a week ceiling`;
    } else if (abs >= band.minPct && abs <= band.maxPct) {
      tone = 'good';
      text += `, inside the ${band.minPct}–${band.maxPct}% safe band`;
    } else if (abs > band.maxPct) {
      tone = 'watch';
      text += `, above the ${band.maxPct}% a week ceiling${opts.easeToMaintenance ? ' — ease calories toward maintenance' : ''}`;
    } else {
      text += `, under the ${band.minPct}% a week floor`;
    }
  } else {
    tone = 'watch';
    text += ', the opposite way from your goal';
  }
  return { kind: 'rate', text, tone };
}

/** What to do about a too-fast loss, with the user's real calorie target when it is known. */
function tooFastActionReason(input: GoalProgressInput): GoalProgressReason {
  const target = input.budget?.targetKcal;
  const full = target != null && target > 0 ? `your full ${withUnit(fmtKcal(target), 'kcal')} target` : 'your full calorie target';
  return { kind: 'action', text: `Eat up to ${full} — a slower loss is easier to keep`, tone: 'neutral' };
}

/** Within a kilo of the target and still losing past the ceiling: ease the calories now, as the loss is about to stop on its own. */
function nearlyThereReason(input: GoalProgressInput, targetKg: number): GoalProgressReason {
  return { kind: 'action', text: `Start easing calories toward maintenance as you close in on ${fmtWeight(input, targetKg)}`, tone: 'neutral' };
}

/** kcal per kg of body weight lost, the usual rule of thumb behind "a 150 kcal a day trim". */
const KCAL_PER_KG = 7700;
/** A suggested trim is rounded to this many kcal a day (and never under it). */
const TRIM_ROUND_KCAL = 50;

/**
 * Behind pace: what the target date would take. "To make Jul 6 you'd need ~0.55 kg/wk — move the date or trim ~150 kcal a day"
 * (with the real budget after it when it is known: "(to ~1,850 kcal)"). The trim is the gap between the pace needed and
 * the pace now, in kcal; it is left out when the pace needed is past the safe band's ceiling or the trim would take the
 * budget under the low-energy floor, and the whole line when the date has passed. Null when nothing more is asked.
 */
function behindActionReason(input: GoalProgressInput, w: WeightBlock, pace: WeightPace, toGo: number, targetDate: string): GoalProgressReason | null {
  const daysLeft = dayNumber(targetDate) - dayNumber(input.todayKey);
  if (daysLeft <= 0 || toGo <= 0) return null;
  const neededKgPerWeek = toGo / (daysLeft / 7);
  const nowKgPerWeek = pace.kgPerWeek < 0 ? -pace.kgPerWeek : 0;
  if (neededKgPerWeek <= nowKgPerWeek) return null;
  const date = fmtDate(targetDate, input.todayKey);
  const needed = `~${fmtWeight(input, neededKgPerWeek, 2)}/wk`;
  const bodyKg = w.progressKg ?? pace.fittedKg;
  const ceilingKgPerWeek = (bodyKg * FAT_LOSS_BAND.maxPct) / 100;
  if (neededKgPerWeek > ceilingKgPerWeek) {
    return { kind: 'action', text: `To make ${date} you'd need ${needed} — faster than is comfortable to keep; move the date`, tone: 'neutral' };
  }
  const trim = Math.max(TRIM_ROUND_KCAL, Math.round((((neededKgPerWeek - nowKgPerWeek) * KCAL_PER_KG) / 7) / TRIM_ROUND_KCAL) * TRIM_ROUND_KCAL);
  const budget = input.budget?.targetKcal;
  const floor = input.budget?.floorKcal ?? 0;
  if (budget != null && budget - trim < floor) {
    return { kind: 'action', text: `To make ${date} you'd need ${needed} — that is more than your calories can safely give; move the date`, tone: 'neutral' };
  }
  const to = budget != null && budget > 0 ? ` (to ~${withUnit(fmtKcal(budget - trim), 'kcal')})` : '';
  return {
    kind: 'action',
    text: `To make ${date} you'd need ${needed} — move the date or trim ~${withUnit(trim, 'kcal')} a day${to}`,
    tone: 'neutral',
  };
}

/**
 * The smoothed trend, explained once and only where it differs from the scale
 * enough to confuse: the first reason that names it says what it is.
 */
function trendExplainReason(input: GoalProgressInput, w: WeightBlock): GoalProgressReason | null {
  if (w.currentKg == null || w.scaleKg == null || Math.abs(w.currentKg - w.scaleKg) < TREND_SCALE_GAP_KG) return null;
  const scale = w.ageDays === 0 ? 'scale today' : 'last weigh-in';
  return {
    kind: 'trend',
    text: `Trend ${fmtWeight(input, w.currentKg)} — smoothed to filter daily water swings; ${scale} ${fmtWeight(input, w.scaleKg)}`,
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
 * scale against the start, no pace, no ETA, no ahead/behind: a week of daily
 * noise is not a pace, and "24 weeks behind" off day 7 is an alarm about nothing.
 */
function earlyReadOutcome(input: GoalProgressInput, w: WeightBlock, read: WeightLossRead, build: ReasonBuilder): Outcome {
  const down = scaleDownKg(input, w);
  const isDown = down != null && down >= EARLY_DOWN_MIN_KG;
  const swing = swingText(input);
  if (read.young) {
    if (isDown) {
      const days = earlyReadDays(input, w);
      return {
        verdict: 'progressing',
        headline: clip(`Early read — down ${fmtWeight(input, down as number)} on the scale in ${days} ${plural(days, 'day')}`),
        reasons: build({ kind: 'pace_note', text: `Your pace estimate settles after 3 weeks of weigh-ins — daily swings of ${swing} are normal`, tone: 'neutral' }),
      };
    }
    return {
      verdict: 'holding',
      headline: clip(`Early days — daily swings of ${swing} are normal`),
      reasons: build({ kind: 'pace_note', text: 'Your pace settles after 3 weeks of weigh-ins', tone: 'neutral' }),
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

/** Back after 7+ days without a weigh-in: what the scale says, no verdict on pace until 3 weigh-ins are back. */
function returningOutcome(input: GoalProgressInput, w: WeightBlock, read: WeightLossRead, build: ReasonBuilder): Outcome {
  const ret = read.ret as WeighInReturn;
  const since = fmtDate(ret.lastBeforeDay, input.todayKey);
  const delta = ret.lastBeforeKg - (w.scaleKg ?? ret.firstBackKg);
  const change = Math.abs(delta) < EARLY_DOWN_MIN_KG
    ? `the scale is about the same as ${since}`
    : `the scale is ${delta > 0 ? 'down' : 'up'} ${fmtWeight(input, Math.abs(delta))} since ${since}`;
  const down = scaleDownKg(input, w);
  const left = RETURN_WEIGH_INS_NEEDED - ret.weighInsSince;
  return {
    verdict: down != null && down >= EARLY_DOWN_MIN_KG ? 'progressing' : 'holding',
    headline: clip(`Welcome back — ${change}`),
    reasons: build({
      kind: 'pace_note',
      text: `Keep weighing in so your trend catches up — ${left} more ${plural(left, 'weigh-in')} before your pace is read again`,
      tone: 'neutral',
    }),
  };
}

/** Three flat weeks of raw weekly means: named as a plateau, with a real next step. */
function plateauOutcome(input: GoalProgressInput, read: WeightLossRead, build: ReasonBuilder): Outcome {
  const mean = (read.plateau as RawPlateau).weeklyMeanKg;
  const kcal = input.budget?.targetKcal;
  const sessions = input.target.weeklySessions;
  const keep = [
    kcal != null && kcal > 0 ? withUnit(fmtKcal(kcal), 'kcal') : null,
    sessions != null && sessions > 0 ? `${sessions} ${plural(sessions, 'session')}` : null,
  ].filter((x): x is string => x != null);
  const keepText = keep.length > 0 ? keep.join(' and ') : 'your routine';
  // Logged days running over the target are the likelier cause than water: lead with the logs, not "often water".
  const intake = intakeRead(input);
  const text = intake?.low
    ? `Logged days averaged ~${withUnit(fmtKcal(Math.round(intake.avgKcal / 10) * 10), 'kcal')} vs your ${withUnit(fmtKcal(intake.targetKcal), 'kcal')} target — getting back to target is the first lever; if still flat 2 weeks after that, trim ~${withUnit(150, 'kcal')} a day`
    : `Common and often water: keep ${keepText}; if still flat in 2 weeks, trim ~${withUnit(150, 'kcal')} a day or add two 30-minute walks`;
  return {
    verdict: 'holding',
    headline: clip(`Plateau — weekly average ~${fmtWeightFixed(input, mean)} for 3 weeks`),
    reasons: build({ kind: 'plateau', text, tone: 'neutral' }),
  };
}

function fatLossOutcome(input: GoalProgressInput, w: WeightBlock): Outcome {
  if (input.target.weightKg == null) {
    return { verdict: 'needs_target', headline: 'Set a target weight to track your fat-loss progress', reasons: [] };
  }
  if (w.stale) return staleWeighInOutcome(w);
  const read = w.read;
  if (!w.rateReliable || w.currentKg == null || read == null) {
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
  const pace = read.pace;

  // Priority: the lead reason(s), the "based on an older weigh-in" caveat, the
  // trend explained once, anything worth a "watch", then the rest.
  const aging = agingReason(w);
  const trendNote = trendExplainReason(input, w);
  const others = [underEating, adherence, weekend, tdee];
  const build: ReasonBuilder = (...lead) =>
    capReasons([...lead, aging, trendNote, ...others.filter(r => r?.tone === 'watch'), ...others.filter(r => r?.tone !== 'watch')]);

  if (w.reached) {
    // The goal is done: lead with the reach, never show continued loss as a
    // green "inside the safe band", and say what to do next. A safety watch
    // (under-eating, still losing past the ceiling) still gets the second slot.
    const stillFast = pace != null && read.tooFast && pace.kgPerWeek < 0
      ? paceReason(input, pace, { held: round2(Math.abs(pace.pctPerWeek)) <= FAT_LOSS_BAND.maxPct, easeToMaintenance: true })
      : null;
    const watch = underEating ?? stillFast;
    const when = w.reachedAt ? ` (${fmtDate(w.reachedAt, input.todayKey)})` : '';
    return {
      verdict: 'reached',
      headline: clip(`Goal reached — ${fmtWeight(input, targetKg)}${when}`),
      reasons: capReasons([
        reachedLeadReason(input, w, targetKg),
        watch ?? targetPositionReason(input, w, targetKg),
        nextStepReason(),
      ]),
    };
  }

  switch (read.state) {
    case 'returning': return returningOutcome(input, w, read, build);
    case 'plateau': return plateauOutcome(input, read, build);
    case 'early': return earlyReadOutcome(input, w, read, build);
    default: break;
  }

  // 'unconfirmed' and 'confirmed' always carry a pace.
  const p = pace as WeightPace;
  const absPct = Math.abs(p.pctPerWeek);
  // Too fast is the pace's call with hysteresis (lib/weightPace.ts tooFastLoss) — the very rate the headline quotes,
  // never a different window's — and a pace still between 0.9% and the ceiling keeps it, without calling that "safe".
  const held = read.tooFast && round2(absPct) <= FAT_LOSS_BAND.maxPct;
  const rate = paceReason(input, p, { held });
  const nearlyThere = read.tooFast && toGo <= HOLDING_NEAR_TARGET_KG;

  const paceOutcome = (): Outcome => {
    const reasons = build(rate);

    // Wrong direction or flat.
    if (p.kgPerWeek >= 0 || absPct <= PLATEAU_MAX_PCT_PER_WEEK) {
      if (p.kgPerWeek >= 0 && absPct > PLATEAU_MAX_PCT_PER_WEEK) {
        return {
          verdict: 'behind',
          headline: clip(`Weight is up ${fmtWeight(input, p.kgPerWeek, 2)} a week, away from your target`),
          reasons,
        };
      }
      return { verdict: 'stalled', headline: clip(`Stalled — weight flat around ${fmtWeight(input, w.progressKg ?? p.fittedKg)}`), reasons };
    }

    // Losing at a safe pace. A pace nothing has confirmed yet makes no ahead/behind call.
    if (read.state === 'unconfirmed') {
      return {
        verdict: 'progressing',
        headline: clip(`Progressing — losing about ${fmtWeight(input, Math.abs(p.kgPerWeek), 2)} a week`),
        reasons: build(rate, { kind: 'pace_note', text: 'Your projected date shows once another week of weigh-ins confirms this pace', tone: 'neutral' }),
      };
    }

    const around = w.eta != null ? aroundText(input, w, w.eta) : '';
    const targetDate = input.target.date;
    if (targetDate != null) {
      if (read.relation === 'ahead') {
        return { verdict: 'ahead', headline: clip(`Ahead of pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
      }
      if (read.relation === 'behind') {
        const action = behindActionReason(input, w, p, toGo, targetDate);
        if (w.eta == null) {
          // Only a pace under the safe band's floor, or one that projects 10 years out, lands here: no date to quote.
          const why = absPct < FAT_LOSS_BAND.minPct ? `pace is under the ${FAT_LOSS_BAND.minPct}% a week floor` : 'too slow to project a date';
          return { verdict: 'behind', headline: clip(`Behind — ${fmtWeight(input, toGo)} to go, ${why}`), reasons: build(rate, action) };
        }
        return { verdict: 'behind', headline: clip(`Behind pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons: build(rate, action) };
      }
      // On pace: the target date itself holds, however the two paces wobble around it.
      // (A weigh-in that is 7+ days old quotes no date; a target date already past reads "any day now".)
      const forDate = !w.aging && targetDate >= input.todayKey ? ` for ${fmtDate(targetDate, input.todayKey)}` : '';
      const anyDayNow = !w.aging && targetDate < input.todayKey ? ', any day now' : '';
      return { verdict: 'on_track', headline: clip(`On track${forDate} — about ${fmtWeight(input, toGo)} to go${anyDayNow}`), reasons };
    }
    if (w.eta == null) {
      return { verdict: 'behind', headline: clip(`Behind — ${fmtWeight(input, toGo)} to go, too slow to project a date`), reasons };
    }
    if (!read.slow) {
      return { verdict: 'on_track', headline: clip(`On track — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
    }
    return { verdict: 'behind', headline: clip(`Slow pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
  };

  if (read.tooFast && !nearlyThere) {
    return {
      verdict: 'too_fast',
      headline: clip(`${held ? 'Still losing fast' : 'Losing too fast'} — ${round2(absPct)}% of bodyweight a week`),
      reasons: build(rate, tooFastActionReason(input)),
    };
  }
  if (nearlyThere) {
    // Within a kilo of the target the loss is about to stop on its own: say so, ease off, and keep the verdict the
    // dates give (the card does not turn "too fast" for the last few days and "reached" right after).
    const base = paceOutcome();
    return {
      verdict: base.verdict === 'behind' || base.verdict === 'stalled' ? 'progressing' : base.verdict,
      headline: clip('Nearly there — start easing calories toward maintenance'),
      reasons: build(rate, nearlyThereReason(input, targetKg)),
    };
  }
  return paceOutcome();
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
 * "8 sessions so far": the plain count, so the headline only changes when a
 * session is logged (an "N of M" against a plan prorated to a part-week flipped
 * between "8 of 8" and "9 sessions" from one day to the next). Null before the
 * first session.
 */
function sessionsSoFarText(input: GoalProgressInput): string | null {
  const n = sessionCount(input, sessionWindowDays(input));
  return n > 0 ? `${n} ${plural(n, 'session')} so far` : null;
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

/** The "building back" state for the payload (lib/liftChange.ts liftReturnState); muscle goal only. */
function liftReturnOf(input: GoalProgressInput): GoalLiftReturn | null {
  if (input.goal !== 'muscle') return null;
  const days = [...new Set([...(input.strengthHistoryDays ?? []), ...sessionDays(input)])];
  const s: LiftReturnState | null = liftReturnState(input.progression, days, input.todayKey);
  if (!s) return null;
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

/** Whole-unit pre-break / recent e1RM in the display unit, and the percentage of those SHOWN numbers (lib/liftChange.ts liftReturnDisplay). */
function returnNumbers(r: GoalLiftReturn, input: GoalProgressInput): { pre: number; recent: number; pct: number; unit: string } {
  return liftReturnDisplay(r, input.unitSystem === 'imperial');
}

/** Verdict + headline while building back (verdict 'building') or once the pre-break best is regained ('progressing'). */
function liftReturnOutcome(r: GoalLiftReturn, input: GoalProgressInput): { verdict: GoalVerdict; headline: string } {
  const { pre, recent, unit } = returnNumbers(r, input);
  if (!r.regained) {
    // The 142 is an estimated 1RM, not a bodyweight or a load: say so ("Squat est. 1RM 136 of 142 kg pre-break").
    return { verdict: 'building', headline: clip(`Building back — ${r.name} est. 1RM ${recent} of ${withUnit(pre, unit)} pre-break`) };
  }
  if (recent <= pre) {
    return { verdict: 'progressing', headline: clip(`Back at your pre-break best — ${r.name} est. 1RM ${withUnit(recent, unit)}`) };
  }
  const full = `Back above your pre-break best — ${r.name} est. 1RM ${withUnit(recent, unit)} (was ${withUnit(pre, unit)})`;
  const short = `Back above your pre-break best — ${r.name} est. 1RM ${withUnit(recent, unit)}`;
  return { verdict: 'progressing', headline: clip(full.length <= HEADLINE_MAX_CHARS ? full : short) };
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
 * line ("Squat est. 1RM +3 kg vs last trained week"), the same pair of weeks
 * (lib/liftChange.ts pickWeekOverWeek: the last completed week, which is the
 * week the review read) and the same whole-kg rounding. Only the week in
 * progress never turns it amber: half a week's best is not a drop.
 */
function weekOverWeekReason(input: GoalProgressInput): GoalProgressReason | null {
  const anchor = weekStartKeyForDay(input.todayKey);
  const pick = pickWeekOverWeek(input.progression, anchor, [addDays(anchor, -7), anchor]);
  if (!pick) return null;
  const imperial = input.unitSystem === 'imperial';
  const d = liftDisplayChange({ baselineKg: pick.change.previousKg, recentKg: pick.change.currentKg, changeKg: pick.change.changeKg }, imperial);
  const delta = d.change === 0 ? 'unchanged' : liftDeltaText({ ...d, unit: imperial ? 'lb' : 'kg' });
  return {
    kind: 'lift',
    text: `${liftDisplayName(pick.exercise, input.exerciseDisplay)} est. 1RM ${delta} vs last trained week`,
    tone: d.change > 0 ? 'good' : d.change < 0 && pick.end < anchor && !isDeloadWeek(input.progression, pick.end) ? 'watch' : 'neutral',
  };
}

function muscleOutcome(input: GoalProgressInput, w: WeightBlock, ret: GoalLiftReturn | null): Outcome {
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
  const sessionsBehind = !windowStale && (adh?.pct ?? 100) < ADHERENCE_BEHIND_PCT;
  const sessions = adherence ?? sessionsReason(input);
  // The first 28 days' sessions line already says "This week 2 of 4": no second week count beside it.
  const young = isYoungGoal(input);
  const weekSessions = young ? null : weekSessionsReason(input);
  const adherenceDemoted = adherence && adherence.tone === 'watch' ? { ...adherence, tone: 'neutral' as const } : adherence;
  const protein = proteinReason(input);
  // A week or more without a session: the lifts are dated, never praised ("+9 kg vs 4 weeks ago" is about a window
  // that ended before the lapse began).
  const daysOff = lastSessionDaysAgo(input);
  const lapseLift = daysOff != null && daysOff >= LIFT_LAPSE_MIN_DAYS ? lapseLiftOf(input, ret?.exercise ?? lifts[0]?.exercise ?? null) : null;
  const lapse = lapseLift != null && daysOff != null ? { days: daysOff, lift: lapseLift } : null;
  const liftReasons = lapse ? [] : lifts.map(l => liftReason(l, input)).filter((r): r is GoalProgressReason => r != null);
  const leadLift = lapse
    ? lapseReason(input, lapse.lift)
    : ret ? liftReturnReason(ret, input) : liftReasons[0] ?? weekOverWeekReason(input);
  // "Back after a 15-day break" explains a rebuild; once the pre-break best is regained it is no longer news.
  const returnBreak = ret && !ret.regained ? liftReturnBreakReason(ret, input) : null;
  // Rate at/above the top of the healthy band is a flag worth surfacing early.
  const rateTop = rate?.tone === 'watch' && w.rateKg != null && w.rateKg > 0;
  const reachLead = weightReached ? reachedLeadReason(input, w, targetKg as number) : null;
  // Low adherence leads (amber) without overriding the lift-based verdict.
  // The second lift outranks the in-band weight rate (a rate inside the band is the quietest line on the card).
  const reasons = windowStale
    ? capReasons([
        leadLift,
        weekSessions ?? sessions,
        ret ? returnBreak : young ? null : adherenceDemoted,
        reachLead,
        rateTop ? rate : null,
        protein,
        ret ? null : liftReasons[1] ?? null,
        rateTop ? null : rate,
        rate ? agingReason(w) : null,
      ])
    : capReasons([
        adherenceLow ? adherence : null,
        leadLift,
        adherenceLow ? null : sessions,
        reachLead,
        rateTop ? rate : null,
        protein,
        liftReasons[1] ?? null,
        rateTop ? null : rate,
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
    liftState = liftReturnOutcome(ret, input);
  } else if (head && headDisplay) {
    // Not up 1%: never print a "+1 kg" next to "stalled" (a gain under 1% reads "up under 1%").
    const headDelta = headDisplay.change < 0 ? liftDeltaText(headDisplay) : headDisplay.change === 0 ? 'unchanged' : 'up under 1%';
    if (liftsUp) {
      liftState = sessionsBehind
        ? { verdict: 'behind', headline: clip(`Lifts up, sessions behind — ${head.name} ${liftDeltaText(headDisplay)}`) }
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
      const soFar = outlook.kind === 'first' ? sessionsSoFarText(input) : null;
      const label = outlook.kind === 'first' ? 'First' : 'Next';
      return {
        verdict: 'insufficient_data',
        headline: clip(`${label} lift comparison on ${fmtDate(outlook.day, input.todayKey)}${soFar ? ` · ${soFar}` : ''}`),
        reasons,
      };
    }
  }

  if (shownPct != null) {
    if (shownPct >= MUSCLE_GAIN_BAND.minPct) {
      // Weight is moving the right way but the planned sessions are not
      // happening: a lifter who stopped training never reads "Progressing".
      if (sessionsBehind) return { verdict: 'behind', headline: sessionsBehindHeadline, reasons };
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
  // One target for the week: when the plan caps it below the goal, say both
  // ("22.7 of ~27 km ... · goal 30 km"); otherwise the goal alone. Recovery's
  // number is a ceiling ("up to"); the first week of running has no target yet.
  let text: string;
  if (plan?.kind === 'baseline') text = `${fmtDistance(input, doneKm)} so far · baseline week`;
  else if (plan?.kind === 'recovery') {
    // Just over the ceiling but inside its 10% slack is "right at" it, never "7.5 of up to 7".
    const slack = withinCeilingSlack(input, doneKm, stepKm);
    text = slack != null
      ? `${fmtDistance(input, doneKm)} so far · right at your ~${fmtDistance(input, slack)} ceiling (recovery)`
      : `${done} of up to ${fmtDistance(input, stepKm)} running this week (recovery)`;
  }
  else if (stepKm < targetKm) text = `${done} of ~${fmtDistance(input, stepKm)} running this week · goal ${fmtDistance(input, targetKm)}`;
  else text = `${done} of ${fmtDistance(input, targetKm)} running this week`;
  return {
    targetKm,
    thisWeekKm: hasData ? round1(doneKm) : null,
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
          },
        }
      : {}),
  };
}

/**
 * The ceiling (km, rounded in the display unit) a recovery / race week that sits a little over its target may be
 * called "right at": the target plus the shared 10% slack. Null when the week is not over the target as the reader
 * sees it, or is over by more than the slack.
 */
function withinCeilingSlack(input: GoalProgressInput, doneKm: number, ceilingKm: number): number | null {
  if (distanceNum(input, doneKm) <= distanceNum(input, ceilingKm)) return null;
  if (doneKm > ceilingKm * PHASE_CEILING_TOLERANCE) return null;
  return Math.max(ceilingKm, roundWeekTargetKm(ceilingKm * PHASE_CEILING_TOLERANCE, unitsPerKm(input)));
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
  const rep = input.unitSystem === 'imperial' ? '3×0.5 mi' : '3×1 km';
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
  if (isWindDownPhase(race.phase)) {
    return { kind: 'long_run', text: `Peak long run ${fmtLongRunPeak(input, lr.peakKm)} — done`, tone: 'good' };
  }
  // When the weekly goal cannot carry the race's peak long run, say so once, with what would.
  const goalKm = input.target.weeklyDistanceKm ?? null;
  const capNote = goalKm != null && lr.raceTargetKm != null
    ? longRunCapNote({ peakKm: lr.targetPeakKm, raceTargetKm: lr.raceTargetKm }, goalKm, unitsPerKm(input))
    : null;
  const note = capNote != null ? `. ${capNote}` : '';
  if (longRunPeakReached(input, lr, lr.targetPeakKm)) {
    return { kind: 'long_run', text: `Long run peak ${fmtLongRunPeak(input, lr.peakKm)} — on target${note}`, tone: 'good' };
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
 * one of them, and the eve is for rest (`eve`: a neutral note, never a scolding).
 */
function windDownLine(
  input: GoalProgressInput, plan: EnduranceWeekPlan, race: GoalRaceProgress,
  doneKm: number, over: boolean, raceDoneToday: boolean, postRace: boolean, eve: boolean,
): GoalProgressReason {
  const phase = (plan.wind as NonNullable<EnduranceWeekPlan['wind']>).phase;
  const target = plan.targetKm ?? plan.goalKm;
  const u = unitsPerKm(input);
  // The days of the race's own calendar week after race day are recovery days, whatever the week's Monday said.
  const label = postRace || phase === 'recovery' ? 'Recovery' : phase === 'taper' ? 'Taper' : 'Race week';
  const progress = `${distanceNum(input, doneKm)} of ~${fmtDistance(input, target)}`;
  if (eve) {
    return {
      kind: 'race_phase',
      text: over
        ? `Race week: ${progress} — a bit more than planned, which is fine; rest now and let it settle`
        : `Race week: ${progress} — keep tomorrow simple, nothing new`,
      tone: 'neutral',
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
  // The day before the race is for rest: the headline says so whatever the week's km are; race day is no day to be "over".
  const eve = !postRace && race.daysToGo === 1;
  // Having just raced is never "over the plan" for the week; the plan's ceiling is for the runs around it.
  const overBand = grade.gap === 'over' && !(raceDoneNow && race.phase !== 'recovery') && !raceDay;
  const over = overBand && !eve;
  const done = distanceNum(input, doneKm);
  const tgt = fmtDistance(input, target);
  let headline: string;
  if (raceDoneNow && raceRun) {
    const time = formatRaceTime(raceRun.durationMin);
    headline = `${race.label} done — ${fmtDistance(input, raceRun.km)}${time ? ` in ${time}` : ''}. Congratulations!`;
  } else if (raceDay) {
    headline = 'Race day — start relaxed';
  } else if (eve) {
    headline = RACE_EVE_LINE;
  } else if (postRace) {
    const days = race.daysSince ?? 1;
    const week = wind.phase === 'recovery' ? recoveryWeek(-wind.info.daysToRace) : 1;
    headline = `Recovery week ${week} — day ${days} after your ${raceWord(race.label)}: easy only`;
  } else if (wind.phase === 'taper') {
    headline = `Taper week — ${done} of ~${tgt}${over ? ', over the plan' : doneKm > 0 ? ', on plan' : ''}`;
  } else {
    headline = `Race week — ${done} of ~${tgt} before the race${over ? ', over the plan' : ''}`;
  }
  const phaseLine = windDownLine(input, plan, race, doneKm, overBand, raceDoneNow && raceDay, postRace, eve);
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
 * The sessions line of an endurance goal. On the day the goal is set nothing can have been logged yet, so "No training
 * sessions logged in the last 7 days" is noise there: the line waits until the goal has had a day to collect one.
 */
function enduranceSessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  const reason = weekSessionsReason(input) ?? sessionsReason(input);
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
  const withRace = (reasons: GoalProgressReason[]): GoalProgressReason[] => (raceLine ? [raceLine, ...reasons] : reasons).slice(0, 3);
  const body = (lead: GoalProgressReason | null, extra: Array<GoalProgressReason | null> = []): GoalProgressReason[] =>
    withRace(enduranceReasons(lead, [...extra, lrReason, sessions, ...vitals]));
  const finish = (verdict: GoalVerdict, headline: string, reasons: GoalProgressReason[]): Outcome =>
    ({ verdict, headline: clip(headline), reasons, raceHandled: true });
  const nextHold = weekStepOrGoalKm(target, plan.goalKm, u);

  // A runner who has been off for 7+ days: say so, and where to restart.
  if (plan.onBreak && plan.kind !== 'baseline') {
    const days = plan.daysSinceRun as number;
    const usual = plan.restart?.medianKm ?? null;
    const after = usual != null && usual > plan.restartKm + 0.5
      ? `, then build back toward your usual ~${fmt(usual)}`
      : plan.restartKm >= plan.goalKm - 1e-9 ? '' : ', then build about 10% a week';
    return finish('building', `On a break — ${days} days since your last run. Restart at ~${fmt(plan.restartKm)}.`, body(
      { kind: 'plan', text: `Restart at ~${fmt(plan.restartKm)} with easy runs${after}`, tone: 'neutral' },
    ));
  }

  // A jump over this week's safe step: the headline is the warning, and no "distance up X%" praise is given for it.
  const current = plan.kind === 'baseline' ? null : gradeEnduranceWeek(plan, doneKm, { unitsPerKm: u });
  if (current?.gap === 'spike') {
    // On Sunday the week is over: the advice is about the days after it.
    const advice = weekdayOf(input.todayKey) === 0 ? "keep tomorrow's run easy and hold next week's step" : 'keep the rest of the week easy';
    return finish('holding', `Over the safe step — ${done} of ~${fmt(target)}. Hold ~${fmt(nextHold)} next week`, body(
      { kind: 'volume', text: `${fmt(doneKm)} is ${fmt(doneKm - target)} over this week's safe step; big jumps raise injury risk — ${advice}`, tone: 'watch' },
    ));
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
      text: `${done} of ${stepped ? '~' : ''}${fmt(target)} — the week's ${plan.kind === 'maintain' ? 'goal' : 'step'} is done; keep ${when} easy and short`,
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
      const long = race != null && lrProgress != null && peakTarget != null && race.phase === 'build'
        ? (longRunPeakReached(input, lrProgress, peakTarget)
            ? `long run peak ${fmtLongRunPeak(input, lrProgress.peakKm)} reached`
            : `${longRunWord(lrProgress.lastKm, u)} ${distanceNum(input, lrProgress.lastKm)} of ${formatTargetLongRun(peakTarget, u)}`)
        : null;
      const headline = race != null
        ? `On track for the ${raceWord(race.label)} — ${long ?? `${goalText} a week`}`
        : `On track — ${goalText} a week`;
      return finish('on_track', headline, withRace(enduranceReasons(stepDone ?? planLine, [stepDone ? planLine : null, long ? null : lrReason, sessions, ...vitals])));
    }
    if (level === 'tough') return finish('behind', `Behind — ${fmt(lastKm)} last week of ${goalText}`, planBody());
    return finish('holding', `Holding steady — ${fmt(lastKm)} last week of ${goalText}`, planBody());
  }
  // build
  if (level === 'tough') {
    return finish('behind', `Behind — ${fmt(lastKm)} last week${lastPlanKm != null ? `, ~${fmt(lastPlanKm)} was the step` : ''}`, planBody());
  }
  const above = level === 'good' && lastPlanKm != null && lastKm > lastPlanKm * ABOVE_STEP_FRACTION;
  const how = last?.kind === 'baseline' ? ', your baseline'
    : last?.kind === 'restart' || last?.kind === 'rebuild' && plan.restart != null ? ', back after your break'
    : above ? `, above the ~${fmt(lastPlanKm as number)} step`
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
  const read = w.read;
  let state: GoalWeightRead['state'] = null;
  if (w.lastWeighInDay != null && !w.stale) {
    if (verdict === 'reached') state = 'reached';
    else if (read != null) state = read.state === 'unconfirmed' || read.state === 'confirmed' ? 'pace' : read.state;
  }
  const ret = read?.ret ?? null;
  const returned = read != null && read.state === 'returning' && ret != null
    ? { gapDays: ret.gapDays, sinceDay: ret.lastBeforeDay, sinceKg: round1(ret.lastBeforeKg), weighInsSince: ret.weighInsSince }
    : null;
  const stated = read != null && read.state === 'confirmed' && w.eta != null && !w.aging ? read.weeksVsTarget : null;
  return {
    state,
    scaleKg: w.scaleKg != null ? round1(w.scaleKg) : null,
    scaleDay: w.lastWeighInDay,
    weekMeanKg: w.weekMeanKg != null ? round1(w.weekMeanKg) : null,
    weeksVsTarget: verdict === 'ahead' || verdict === 'behind' || verdict === 'on_track' ? stated : null,
    returned,
    reachedDaysAgo: verdict === 'reached' && w.reachedAt != null ? dayNumber(input.todayKey) - dayNumber(w.reachedAt) : null,
    goalAgeDays: goalAgeDays(input),
    paceWindowDays: read?.pace != null && (state === 'pace' || state === 'plateau') ? read.pace.windowDays : null,
    intake: input.goal === 'weight_loss' ? intakeRead(input) : null,
  };
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
  const liftReturn = liftReturnOf(input);

  let outcome: Outcome;
  switch (input.goal) {
    case 'weight_loss': outcome = fatLossOutcome(input, w); break;
    case 'muscle': outcome = muscleOutcome(input, w, liftReturn); break;
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
  // headline's "to go", the early read, the coach lines and the opener use. (current.weightKg stays the smoothed trend.)
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
      weightKg: w.currentKg != null ? round1(w.currentKg) : null,
      startWeightKg: startKg,
      changeKg,
      progressPct,
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
    lastSessionOn: lastSessionDay(input),
    dataSufficiency: { weighIns: w.weighIns, needed: WEIGH_INS_NEEDED, sessionsLast28d },
  };
}
