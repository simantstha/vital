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
 *  - weight_loss — 4-week trend rate vs the 0.25–1.0 %bw/wk safe band; ETA only
 *    with >= 3 weigh-ins over >= 7 days and a rate in the right direction.
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
  assessWeightSignals,
  PARTIAL_LOG_KCAL_THRESHOLD,
  PLATEAU_MAX_PCT_PER_WEEK,
  PLATEAU_MIN_SPAN_DAYS,
  TOO_FAST_LOSS_PCT_PER_WEEK,
  type WeightSignal,
} from './brain/weightSignals';
import type { ProgressionSummary } from './workoutRepository';
import { isLiftProgressing, liftChange4w, liftDisplayChange, liftDisplayName, pickHeadlineLift } from './liftChange';
import { weekStartKeyForDay } from './localDay';
import { KM_PER_MILE } from './metricFormat';
import {
  enduranceWeekPlan,
  findRaceRun,
  formatRaceTime,
  formatTargetLongRun,
  gradeEnduranceWeek,
  isWindDownPhase,
  longRunStats,
  longRunTargetKm as longRunTargetKmFor,
  longRunWord,
  mondayOfDay,
  planWeekKm,
  racePhaseInfo,
  racePhaseTargetKm,
  raceRules,
  recoveryWeek,
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
/** Fat-loss verdict is 'ahead' when the ETA beats the target date by at least this many days. */
const AHEAD_MARGIN_DAYS = 14;
/** An ETA within this many days after the target date still reads as on track (matches iOS GoalProgressLogic and the coach opener). */
export const ON_PACE_GRACE_DAYS = 7;
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
/** Reached-goal copy: within this many kg of the target reads as "Holding near target". */
const HOLDING_NEAR_TARGET_KG = 1;
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
}

export interface GoalProgressReason {
  /** e.g. 'rate', 'lift', 'adherence', 'reached', 'position', 'next_step' (reached goals: "Set a new target or switch to maintenance"). */
  kind: string;
  text: string;
  tone: ReasonTone;
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
   * Weight goals (weight_loss / muscle) whose weight target is currently
   * reached: the local day (YYYY-MM-DD) of the first trend point that crossed
   * the target since the goal started. Null when the target is not reached,
   * the weigh-in is stale, or the crossing is unknown (e.g. the goal started
   * already past the target, or no weigh-in before the crossing).
   */
  reachedAt?: string | null;
  /**
   * Muscle goal with a weekly sessions target only; null/absent otherwise.
   * The structured numbers behind the `adherence` reason and the muscle
   * `behind` verdict (pct < ADHERENCE_BEHIND_PCT), so a client can say WHY the
   * goal is behind and what to aim for ("9 of 16 sessions in 4 wk · aim for 4
   * this week") without parsing reason copy. `planned` = weeklyTarget x the
   * window in weeks (4 for an established goal, fewer while the goal is new).
   */
  adherence?: GoalSessionAdherence | null;
  dataSufficiency: { weighIns: number; needed: number; sessionsLast28d: number };
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
  rateKg: number | null;
  /** Signed: negative = losing. */
  pctBw: number | null;
  /** Calendar days the quoted rate really spans (< RATE_WINDOW_DAYS for a short history); null without a rate. */
  rateSpanDays: number | null;
  /** Target reached for this goal's direction (null when no target weight / no current weight). */
  reached: boolean | null;
  /** targetWeight - current trend (signed), null when unknown. */
  neededKg: number | null;
  /**
   * Projected date, anchored to the newest weigh-in (never moved forward to
   * today). Used for the verdict; the payload hides it once the weigh-in is
   * `aging` or `stale`.
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
  /** First trend day that crossed the target since the goal began; null when not reached / unknown. */
  reachedAt: string | null;
}

/** True when `kg` has reached `targetKg` for the goal's direction (within 0.1 kg counts). */
function weightReachedTarget(goal: GoalKind, targetKg: number, kg: number): boolean {
  const needed = targetKg - kg;
  if (Math.abs(needed) < 0.1) return true;
  if (goal === 'weight_loss') return needed > 0;
  if (goal === 'muscle') return needed < 0;
  return false;
}

/**
 * Local day of the first trend point that crossed the target since the goal
 * began. Null when the crossing is not observable: no trend point before it
 * (the data starts at or past the target), or the goal began already past the
 * target.
 */
function firstCrossingDay(
  goal: GoalKind,
  targetKg: number,
  days: Array<{ day: string; trendKg: number }>,
  startedDay: string | null,
): string | null {
  const hit = (i: number): boolean => weightReachedTarget(goal, targetKg, days[i].trendKg);
  for (let i = 0; i < days.length; i++) {
    if (startedDay != null && days[i].day < startedDay) continue;
    if (!hit(i)) continue;
    // The point before it must be on the far side of the target.
    if (i === 0 || hit(i - 1)) return null;
    return days[i].day;
  }
  return null;
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

  const rateKg = rateReliable ? trendDeltaKgPerWeek(days, RATE_WINDOW_DAYS) : null;
  const rateSpanDays = rateKg != null ? trendDeltaSpanDays(days, RATE_WINDOW_DAYS) : null;
  const pctBw = rateKg != null && currentKg != null && currentKg > 0 ? (rateKg / currentKg) * 100 : null;

  const targetKg = input.target.weightKg;
  const neededKg = currentKg != null && targetKg != null ? targetKg - currentKg : null;

  let reached: boolean | null = null;
  if (currentKg != null && targetKg != null) reached = weightReachedTarget(input.goal, targetKg, currentKg);

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

  const reachedAt =
    reached === true && !stale && targetKg != null && (input.goal === 'weight_loss' || input.goal === 'muscle')
      ? firstCrossingDay(input.goal, targetKg, days, goalStartDay(input))
      : null;

  return {
    weighIns, spanDays, rateReliable, trend, currentKg, rateKg, pctBw, rateSpanDays, reached, neededKg,
    eta, onPace, lastWeighInDay, ageDays, stale, aging, reachedAt,
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

function rateReason(input: GoalProgressInput, w: WeightBlock, band: { minPct: number; maxPct: number } | null): GoalProgressReason | null {
  if (w.rateKg == null || w.pctBw == null) return null;
  const dir = w.rateKg < 0 ? 'down' : 'up';
  const abs = Math.abs(w.pctBw);
  // The rate is measured over the history that exists: under 4 weeks of
  // weigh-ins says the real span ("over 9 days").
  const span = windowSpanText(w.rateSpanDays ?? RATE_WINDOW_DAYS);
  let text = `Trend weight ${dir} ${fmtWeight(input, Math.abs(w.rateKg), 2)}/wk (${round2(abs)}% of bodyweight) over ${span}`;
  let tone: ReasonTone = 'neutral';
  if (band) {
    const wantedDir = input.goal === 'weight_loss' ? w.rateKg < 0 : w.rateKg > 0;
    if (wantedDir && abs >= band.minPct && abs < band.maxPct) {
      tone = 'good';
      text += `, inside the ${band.minPct}–${band.maxPct}% safe band`;
    } else if (wantedDir && abs >= band.maxPct) {
      // At (not just above) the top of the band is already worth a flag.
      tone = 'watch';
      text += `, at or above the ${band.maxPct}% a week ceiling`;
    } else if (wantedDir) {
      tone = 'neutral';
      text += `, under the ${band.minPct}% a week floor`;
    } else {
      tone = 'watch';
      text += ', the opposite way from your goal';
    }
  }
  return { kind: 'rate', text, tone };
}

function calorieAdherenceReason(input: GoalProgressInput): GoalProgressReason | null {
  const target = input.budget?.targetKcal;
  if (target == null) return null;
  const logged = lastSevenIntake(input).filter(
    d => d.source !== 'none' && d.kcal != null && d.kcal >= PARTIAL_LOG_KCAL_THRESHOLD,
  );
  if (logged.length < MIN_LOGGED_DAYS_FOR_ADHERENCE) return null;
  const hit = logged.filter(d => (d.kcal as number) <= target * CALORIE_ADHERENCE_TOLERANCE).length;
  const frac = hit / logged.length;
  return {
    kind: 'calorie_adherence',
    text: `Stayed within your ${withUnit(fmtKcal(target), 'kcal')} target on ${hit} of ${logged.length} logged ${plural(logged.length, 'day')} this week`,
    tone: frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral',
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

/** "9 of 16 planned sessions in 4 weeks (56%)" (or "in 10 days" for a new goal) — watch under 75%. */
function adherenceReason(input: GoalProgressInput): GoalProgressReason | null {
  const a = sessionAdherence(input);
  if (!a) return null;
  return {
    kind: 'adherence',
    text: `${a.done} of ${a.planned} planned ${plural(a.planned, 'session')} in ${windowSpanText(a.windowDays)} (${a.pct}%)`,
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
    text: `${done} of ${target} ${plural(target, 'session')} this week`,
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
}

function liftChanges(progression: ProgressionSummary, todayKey: string, display?: Record<string, string>): LiftChange[] {
  const out: LiftChange[] = [];
  const anchor = weekStartKeyForDay(todayKey);
  // The shared headline lift (lib/liftChange.ts) always leads, even when it is
  // not one of the 3 most-trained lifts.
  const headlineKey = pickHeadlineLift(progression, anchor)?.exercise ?? null;
  for (const [exercise, weeks] of Object.entries(progression)) {
    if (!weeks.some(w => w.bestEstimatedOneRepMaxKg != null)) continue;
    const totalSets = weeks.reduce((s, w) => s + w.totalSets, 0);
    const c = liftChange4w(weeks, anchor);
    out.push({
      exercise,
      name: liftDisplayName(exercise, display),
      totalSets,
      startKg: c?.baselineKg ?? null,
      endKg: c?.recentKg ?? null,
      change4wKg: c?.changeKg ?? null,
    });
  }
  const byVolume = out.sort((a, b) => b.totalSets - a.totalSets || a.exercise.localeCompare(b.exercise));
  const head = byVolume.find(l => l.exercise === headlineKey);
  const rest = byVolume.filter(l => l !== head);
  return (head ? [head, ...rest] : rest).slice(0, 3);
}

function liftReason(l: LiftChange, input: GoalProgressInput): GoalProgressReason | null {
  const d = displayLift(l, input);
  if (d == null) return null;
  return {
    kind: 'lift',
    text: `${l.name} est. 1RM ${d.change === 0 ? 'unchanged' : liftDeltaText(d)} vs 4 weeks ago (${arrowPair(String(d.baseline), withUnit(d.recent, d.unit))})`,
    tone: d.change > 0 ? 'good' : d.change < 0 ? 'watch' : 'neutral',
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

/** The reach itself, first in the reasons. */
function reachedLeadReason(input: GoalProgressInput, w: WeightBlock, targetKg: number): GoalProgressReason {
  const since = w.reachedAt ? `, first reached ${fmtDate(w.reachedAt, input.todayKey)}` : '';
  return {
    kind: 'reached',
    text: `Trend weight ${fmtWeight(input, w.currentKg as number)} is at or past your ${fmtWeight(input, targetKg)} target${since}`,
    tone: 'good',
  };
}

/** Where the trend sits relative to a reached target. Never green: continued movement past the target is not progress. */
function targetPositionReason(input: GoalProgressInput, w: WeightBlock, targetKg: number): GoalProgressReason {
  const diff = (w.currentKg as number) - targetKg;
  if (Math.abs(diff) <= HOLDING_NEAR_TARGET_KG) return { kind: 'position', text: 'Holding near target', tone: 'neutral' };
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

function fatLossOutcome(input: GoalProgressInput, w: WeightBlock): Outcome {
  if (input.target.weightKg == null) {
    return { verdict: 'needs_target', headline: 'Set a target weight to track your fat-loss progress', reasons: [] };
  }
  if (w.stale) return staleWeighInOutcome(w);
  if (!w.rateReliable || w.currentKg == null || w.rateKg == null || w.pctBw == null) {
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
  });
  const { weekend, underEating } = signalReasons(signals);
  const rate = rateReason(input, w, FAT_LOSS_BAND);
  const adherence = calorieAdherenceReason(input);
  const tdee = tdeeReason(input);
  const toGo = Math.abs(w.neededKg ?? 0);
  const absPct = Math.abs(w.pctBw);

  // Priority: the rate itself first, then the "based on an older weigh-in"
  // caveat, then anything worth a "watch", then the rest.
  const aging = agingReason(w);
  const watchFirst = (...rs: Array<GoalProgressReason | null>) =>
    capReasons([rate, aging, ...rs.filter(r => r?.tone === 'watch'), ...rs.filter(r => r?.tone !== 'watch')]);
  const reasons = watchFirst(underEating, adherence, weekend, tdee);

  if (w.reached) {
    // The goal is done: lead with the reach, never show continued loss as a
    // green "inside the safe band", and say what to do next. A safety watch
    // (under-eating, still losing past the ceiling) still gets the second slot.
    const stillFast = w.rateKg < 0 && absPct >= FAT_LOSS_BAND.maxPct ? rate : null;
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

  const plateau = signals.some(s => s.kind === 'plateau');
  if (plateau) {
    return {
      verdict: 'stalled',
      headline: clip(`Stalled — trend flat at ${fmtWeight(input, w.currentKg)} for 2 weeks`),
      reasons,
    };
  }

  const tooFast = signals.some(s => s.kind === 'too_fast_loss') || (w.rateKg < 0 && absPct > FAT_LOSS_BAND.maxPct);
  if (tooFast) {
    return {
      verdict: 'too_fast',
      headline: clip(`Losing too fast — ${round1(absPct)}% of bodyweight a week`),
      reasons,
    };
  }

  // Wrong direction or flat.
  if (w.rateKg >= 0 || absPct <= PLATEAU_MAX_PCT_PER_WEEK) {
    if (w.rateKg >= 0 && absPct > PLATEAU_MAX_PCT_PER_WEEK) {
      return {
        verdict: 'behind',
        headline: clip(`Trend is up ${fmtWeight(input, w.rateKg, 2)} a week, away from your target`),
        reasons,
      };
    }
    if (w.spanDays >= PLATEAU_MIN_SPAN_DAYS) {
      return { verdict: 'stalled', headline: clip(`Stalled — trend flat at ${fmtWeight(input, w.currentKg)}`), reasons };
    }
    return {
      verdict: 'insufficient_data',
      headline: 'Two weeks of weigh-ins will show whether you are plateauing',
      reasons,
    };
  }

  // Losing at a safe pace.
  if (w.eta == null) {
    return { verdict: 'behind', headline: clip(`Behind — ${fmtWeight(input, toGo)} to go, too slow to project a date`), reasons };
  }
  const around = aroundText(input, w, w.eta);
  if (input.target.date != null) {
    if (w.eta <= addDays(input.target.date, -AHEAD_MARGIN_DAYS)) {
      return { verdict: 'ahead', headline: clip(`Ahead of pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
    }
    if (w.eta <= addDays(input.target.date, ON_PACE_GRACE_DAYS)) {
      return { verdict: 'on_track', headline: clip(`On track — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
    }
    return { verdict: 'behind', headline: clip(`Behind pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
  }
  if (absPct >= FAT_LOSS_BAND.minPct) {
    return { verdict: 'on_track', headline: clip(`On track — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
  }
  return { verdict: 'behind', headline: clip(`Slow pace — about ${fmtWeight(input, toGo)} to go${around}`), reasons };
}

/**
 * Day the first lift comparison becomes possible: the first logged set + 28
 * days (a comparison needs a baseline 4 weeks before the recent window). The
 * first set's week comes from the weekly e1RM buckets; its day is refined from
 * the session days we have when one falls in that week, else the week's Monday.
 * Null without any lift or when that date has already passed (the baseline is
 * then missing for another reason, e.g. a gap in training).
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

function muscleOutcome(input: GoalProgressInput, w: WeightBlock): Outcome {
  if (input.target.weightKg == null && input.target.weeklySessions == null) {
    return { verdict: 'needs_target', headline: 'Set a weekly session goal to track your progress', reasons: [] };
  }

  const targetKg = input.target.weightKg;
  // A weigh-in older than WEIGH_IN_STALE_DAYS says nothing about now: no rate,
  // no "reached" off weeks-old weight.
  const weightReached = !w.stale && w.reached === true && targetKg != null && w.currentKg != null;
  const pct = w.stale ? null : w.pctBw;

  const lifts = liftChanges(input.progression, input.todayKey, input.exerciseDisplay);
  const rate = w.stale || weightReached ? null : rateReason(input, w, MUSCLE_GAIN_BAND);
  const adherence = adherenceReason(input);
  const adh = sessionAdherence(input);
  const adherenceLow = (adh?.pct ?? 100) < ADHERENCE_LOW_PCT;
  const sessionsBehind = (adh?.pct ?? 100) < ADHERENCE_BEHIND_PCT;
  const sessions = adherence ?? sessionsReason(input);
  const protein = proteinReason(input);
  const liftReasons = lifts.map(l => liftReason(l, input)).filter((r): r is GoalProgressReason => r != null);
  // Rate at/above the top of the healthy band is a flag worth surfacing early.
  const rateTop = rate?.tone === 'watch' && w.rateKg != null && w.rateKg > 0;
  const reachLead = weightReached ? reachedLeadReason(input, w, targetKg as number) : null;
  // Low adherence leads (amber) without overriding the lift-based verdict.
  const reasons = capReasons([
    adherenceLow ? adherence : null,
    liftReasons[0] ?? null,
    adherenceLow ? null : sessions,
    reachLead,
    rateTop ? rate : null,
    protein,
    rateTop ? null : rate,
    rate ? agingReason(w) : null,
    liftReasons[1] ?? null,
  ]);

  // The headline lift is the shared pick (largest 4-week e1RM change,
  // lib/liftChange.ts); `lifts` lists it first, so the verdict, the headline
  // and the lead lift reason all name the same lift.
  const best = lifts[0]?.change4wKg != null ? lifts[0] : null;
  const bestDisplay = best ? displayLift(best, input) : null;
  const liftsUp = best && bestDisplay
    ? isLiftProgressing({ baselineKg: best.startKg as number, recentKg: best.endKg as number, changeKg: best.change4wKg as number })
    : null;
  const sessionsBehindHeadline = adh ? clip(`Sessions behind — ${adh.done} of ${adh.planned} planned`) : 'Sessions behind';

  // Reaching the weight target never hides training feedback: sessions behind
  // → behind, stalled lifts → stalled, and only then reached.
  if (weightReached) {
    if (sessionsBehind) {
      return {
        verdict: 'behind',
        headline: liftsUp && best && bestDisplay
          ? clip(`Lifts up, sessions behind — ${best.name} ${liftDeltaText(bestDisplay)}`)
          : sessionsBehindHeadline,
        reasons,
      };
    }
    if (liftsUp === false) {
      return { verdict: 'stalled', headline: 'Stalled — no lift is up 1% on 4 weeks ago', reasons };
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

  if (best && bestDisplay) {
    // Same bar as the stalled-lift nudge: up at least 1% on 4 weeks ago.
    if (liftsUp) {
      // Lifts are up but the planned sessions are not happening: no strongest
      // positive verdict next to an amber adherence reason.
      if (sessionsBehind) {
        return {
          verdict: 'behind',
          headline: clip(`Lifts up, sessions behind — ${best.name} ${liftDeltaText(bestDisplay)}`),
          reasons,
        };
      }
      return {
        verdict: 'progressing',
        headline: clip(`Progressing — ${best.name} est. 1RM ${liftDeltaText(bestDisplay)} vs 4 weeks ago`),
        reasons,
      };
    }
    return { verdict: 'stalled', headline: 'Stalled — no lift is up 1% on 4 weeks ago', reasons };
  }

  if (pct != null) {
    if (pct >= MUSCLE_GAIN_BAND.minPct) {
      // Weight is moving the right way but the planned sessions are not
      // happening: a lifter who stopped training never reads "Progressing".
      if (sessionsBehind) return { verdict: 'behind', headline: sessionsBehindHeadline, reasons };
      return {
        verdict: 'progressing',
        headline: clip(`Progressing — weight up ${round2(pct)}% a week, inside the gain band`),
        reasons,
      };
    }
    return { verdict: 'stalled', headline: clip(`Stalled — weight is not trending up (${round2(pct)}% a week)`), reasons };
  }

  // No lift baseline yet: say when the first comparison lands rather than
  // asking for more lifts that cannot create one sooner.
  const firstComparison = firstLiftComparisonDay(input);
  if (firstComparison) {
    return { verdict: 'insufficient_data', headline: clip(`First lift comparison on ${fmtDate(firstComparison, input.todayKey)}`), reasons };
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
  else if (plan?.kind === 'recovery') text = `${done} of up to ${fmtDistance(input, stepKm)} running this week (recovery)`;
  else if (stepKm < targetKm) text = `${done} of ~${fmtDistance(input, stepKm)} running this week · goal ${fmtDistance(input, targetKm)}`;
  else text = `${done} of ${fmtDistance(input, targetKm)} running this week`;
  return {
    targetKm,
    thisWeekKm: hasData ? round1(doneKm) : null,
    avg4wKm: plan?.avg4wKm ?? null,
    weekStart: ec.weekStart,
    stepTargetKm: stepKm,
    text,
    ...(plan ? { plan: { kind: plan.kind, targetKm: plan.targetKm, longRunKm: plan.longRunKm, purpose: plan.purpose } } : {}),
  };
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
        ? 'Race day — keep the warm-up easy and start relaxed'
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

/** After the race: what comes next. */
const NEXT_GOAL_REASON: GoalProgressReason = {
  kind: 'next_step',
  text: 'Set your next goal: a new race, a weekly distance target, or maintenance',
  tone: 'neutral',
};

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
      reasons: [raceReason(race), phaseReason, NEXT_GOAL_REASON],
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
  return {
    lastKm,
    peakKm,
    // Once the race is done there is no peak left to build to.
    targetPeakKm: race && race.phase !== 'recovery' ? longRunTargetKmFor(race.distanceKm) : null,
    nextKm: ec.plan?.longRunKm ?? null,
  };
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
    return { kind: 'long_run', text: `Peak long run ${fmtDistance(input, lr.peakKm)} — done`, tone: 'good' };
  }
  if (lr.peakKm >= lr.targetPeakKm) {
    return { kind: 'long_run', text: `Long run peak ${fmtDistance(input, lr.peakKm)} — on target`, tone: 'good' };
  }
  const word = longRunWord(lr.lastKm, unitsPerKm(input));
  const lead = `${word.charAt(0).toUpperCase()}${word.slice(1)} ${fmtDistance(input, lr.lastKm)}`;
  const peakBy = addDays(race.date, -raceRules(race.distanceKm).peakLongRunLeadDays);
  const goal = peakBy >= input.todayKey
    ? `build to ${formatTargetLongRun(lr.targetPeakKm, unitsPerKm(input))} by ${looseMonthPosition(peakBy)}`
    : `peak target ${formatTargetLongRun(lr.targetPeakKm, unitsPerKm(input))}`;
  return { kind: 'long_run', text: `${lead} · ${goal}`, tone: 'neutral' };
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
 * left ("keep Sunday's run ≤ 4 km"); over the band it is a watch line.
 */
function windDownLine(
  input: GoalProgressInput, plan: EnduranceWeekPlan, doneKm: number, over: boolean, raceDoneToday: boolean, postRace: boolean,
): GoalProgressReason {
  const phase = (plan.wind as NonNullable<EnduranceWeekPlan['wind']>).phase;
  const target = plan.targetKm ?? plan.goalKm;
  // The days of the race's own calendar week after race day are recovery days, whatever the week's Monday said.
  const label = postRace || phase === 'recovery' ? 'Recovery' : phase === 'taper' ? 'Taper' : 'Race week';
  const progress = `${distanceNum(input, doneKm)} of ~${fmtDistance(input, target)}`;
  if (over) {
    return { kind: 'race_phase', text: `${label}: ${progress} — over the plan; rest or a very easy jog from here`, tone: 'watch' };
  }
  if (raceDoneToday) {
    return { kind: 'race_phase', text: 'Walk it off, eat and rest; easy running only from here', tone: 'neutral' };
  }
  const left = target - doneKm;
  // Not on the week's last day: nothing is left of "the rest of the week" then.
  if (doneKm > 0 && doneKm >= target * 0.5 && left >= 1 / unitsPerKm(input) && weekdayOf(input.todayKey) !== 0) {
    const when = weekdayOf(input.todayKey) === 6 ? "Sunday's run" : 'the rest of the week';
    return { kind: 'race_phase', text: `${label}: ${progress} — keep ${when} ≤ ${fmtDistance(input, left)}`, tone: 'neutral' };
  }
  if (postRace && phase !== 'recovery') return { kind: 'race_phase', text: `Recovery: easy only this week (~${fmtDistance(input, target)} max)`, tone: 'neutral' };
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
  // Having just raced is never "over the plan" for the week; the plan's ceiling is for the runs around it.
  const over = grade.gap === 'over' && !(raceDoneNow && race.phase !== 'recovery');
  const raceDay = race.phase !== 'recovery' && race.daysToGo === 0;
  const postRace = race.phase === 'recovery';
  const done = distanceNum(input, doneKm);
  const tgt = fmtDistance(input, target);
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
    headline = `Taper week — ${done} of ~${tgt}${over ? ', over the plan' : doneKm > 0 ? ', on plan' : ''}`;
  } else {
    headline = `Race week — ${done} of ~${tgt} before the race${over ? ', over the plan' : ''}`;
  }
  const phaseLine = windDownLine(input, plan, doneKm, over, raceDoneNow && raceDay, postRace);
  const longRun = longRunReason(input, longRunProgress(input, race), race);
  const reasons = postRace
    ? [raceReason(race), phaseLine, NEXT_GOAL_REASON]
    : [raceReason(race), phaseLine, ...(longRun ? [longRun] : [])].slice(0, 3);
  return { verdict: over ? 'holding' : 'on_track', headline: clip(headline), reasons, raceHandled: true };
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
 *  - on a break (no run for 5+ days), restart: 'building' ("Building back");
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
  const sessions = weekSessionsReason(input) ?? sessionsReason(input);
  const vitals = [restingHrReason(input), hrvReason(input)];
  const planLine: GoalProgressReason = { kind: 'plan', text: plan.purpose, tone: 'neutral' };
  const withRace = (reasons: GoalProgressReason[]): GoalProgressReason[] => (raceLine ? [raceLine, ...reasons] : reasons).slice(0, 3);
  const body = (lead: GoalProgressReason | null, extra: Array<GoalProgressReason | null> = []): GoalProgressReason[] =>
    withRace(enduranceReasons(lead, [...extra, lrReason, sessions, ...vitals]));
  const finish = (verdict: GoalVerdict, headline: string, reasons: GoalProgressReason[]): Outcome =>
    ({ verdict, headline: clip(headline), reasons, raceHandled: true });
  const nextHold = weekStepOrGoalKm(target, plan.goalKm, u);

  // A runner who has been off for 5+ days: say so, and where to restart.
  if (plan.onBreak && plan.kind !== 'baseline') {
    const days = plan.daysSinceRun as number;
    return finish('building', `On a break — ${days} days since your last run. Restart at ~${fmt(plan.restartKm)}.`, body(
      { kind: 'plan', text: `Restart at ~${fmt(plan.restartKm)} with easy runs, then build about 10% a week`, tone: 'neutral' },
    ));
  }

  // A jump over this week's safe step: the headline is the warning, and no "distance up X%" praise is given for it.
  const current = plan.kind === 'baseline' ? null : gradeEnduranceWeek(plan, doneKm, { unitsPerKm: u });
  if (current?.gap === 'spike') {
    return finish('holding', `Over the safe step — ${done} of ~${fmt(target)}. Hold ~${fmt(nextHold)} next week`, body(
      { kind: 'volume', text: `${fmt(doneKm)} is ${fmt(doneKm - target)} over this week's safe step; big jumps raise injury risk — keep the rest of the week easy`, tone: 'watch' },
    ));
  }

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
      return finish('holding', `Over the safe step last week — hold ~${fmt(target)} this week`, body(
        { kind: 'volume', text: `Last week's ${fmt(hold.spikeKm)} was over the safe step of ~${fmt(hold.spikeStepKm)}`, tone: 'watch' },
        [planLine],
      ));
    }
    case 'rebuild':
      return finish('building', `Rebuilding after your ${short} — ${done} of ~${fmt(target)}`, body(planLine, [NEXT_GOAL_REASON]));
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
        ? (lrProgress.peakKm >= peakTarget
            ? `long run peak ${fmt(lrProgress.peakKm)} reached`
            : `${longRunWord(lrProgress.lastKm, u)} ${distanceNum(input, lrProgress.lastKm)} of ${formatTargetLongRun(peakTarget, u)}`)
        : null;
      const headline = race != null
        ? `On track for the ${raceWord(race.label)} — ${long ?? `${goalText} a week`}`
        : `On track — ${goalText} a week`;
      return finish('on_track', headline, withRace(enduranceReasons(planLine, [long ? null : lrReason, sessions, ...vitals])));
    }
    if (level === 'tough') return finish('behind', `Behind — ${fmt(lastKm)} last week of ${goalText}`, body(planLine));
    return finish('holding', `Holding steady — ${fmt(lastKm)} last week of ${goalText}`, body(planLine));
  }
  // build
  if (level === 'tough') {
    return finish('behind', `Behind — ${fmt(lastKm)} last week${lastPlanKm != null ? `, ~${fmt(lastPlanKm)} was the step` : ''}`, body(planLine));
  }
  const above = level === 'good' && lastPlanKm != null && lastKm > lastPlanKm * ABOVE_STEP_FRACTION;
  const how = last?.kind === 'baseline' ? ', your baseline'
    : last?.kind === 'restart' || last?.kind === 'rebuild' && plan.restart != null ? ', back after your break'
    : above ? `, above the ~${fmt(lastPlanKm as number)} step`
    : level === 'good' ? ', on plan'
    : level === 'mixed' ? `, a bit under the ~${fmt(lastPlanKm ?? target)} step`
    : ', a lighter week';
  return finish('building', `Building — ${fmt(lastKm)} last week${changeClause(last?.changePct ?? null)}${how}`, body(planLine));
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
  const sessions = weekSessionsReason(input) ?? sessionsReason(input);
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

  let outcome: Outcome;
  switch (input.goal) {
    case 'weight_loss': outcome = fatLossOutcome(input, w); break;
    case 'muscle': outcome = muscleOutcome(input, w); break;
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
  const changeKg = w.currentKg != null && startKg != null ? round1(w.currentKg - startKg) : null;
  let progressPct: number | null = null;
  if (w.currentKg != null && startKg != null && targetKg != null && startKg !== targetKg) {
    const raw = ((startKg - w.currentKg) / (startKg - targetKg)) * 100;
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
    adherence: input.goal === 'muscle' ? sessionAdherence(input) : null,
    dataSufficiency: { weighIns: w.weighIns, needed: WEIGH_INS_NEEDED, sessionsLast28d },
  };
}
