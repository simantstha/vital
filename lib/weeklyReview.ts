/**
 * Vital — weekly review (pure, no DB or Next.js imports)
 *
 * "How did your week go toward your goal?" for the last completed local week
 * (Monday–Sunday in the user's timezone). `computeWeeklyReview` takes
 * already-loaded data and returns the JSON shape stored in weekly_reviews and
 * served by GET /api/review/weekly. The DB loader lives in
 * lib/weeklyReviewLoader.ts so this module stays unit-testable with no
 * DATABASE_URL.
 *
 * The verdict is NOT re-derived here: the caller passes the verdict from
 * lib/goalProgress.ts so the review and the goal card can never disagree.
 * That verdict is the 4-week goal verdict as of the reviewed week, so it is
 * NOT a rating of the week itself; `weekRating` (see assessWeek) is.
 *
 * Honesty rule (same as goalProgress): never invent a number. A stat whose
 * inputs are missing is omitted. With almost no data the review is a gentle
 * "not enough data" nudge instead of fabricated praise.
 */

import type { GoalKind, GoalLiftReturn, GoalLongRunProgress, GoalProgressBudget, GoalProgressIntakeDay, GoalVerdict, DayValue } from './goalProgress';
import { KG_TO_LB, isRunningWorkoutType, mixedReturnLead, raceLabel } from './goalProgress';
import { PARTIAL_LOG_KCAL_THRESHOLD } from './brain/weightSignals';
import { computeWeightTrend, type WeightReading } from './weightTrend';
import { dayNumber, meanOver, rawPlateau } from './weightPace';
import { isInstruction, WEEK_MEAN_MIN_WEIGH_INS, type WeightWeekPlan } from './weightWeekPlan';
import { localDayKey, weekDayKeys, weekStartKeyForDay } from './localDay';
import { arrowPair, withUnit } from './displayText';
import type { ProgressionSummary } from './workoutRepository';
import {
  cuedLifts,
  easedLoad,
  furthestBehindReturn,
  isDeloadWeek,
  isLiftStalled,
  isMainLift,
  latestTopLoadKg,
  liftDisplayChange,
  liftWeekChangeDisplay,
  liftDisplayName,
  liftReturnDisplay,
  liftShortName,
  liftTrainedAtWorkingWeight,
  MAX_CUED_LIFTS,
  nextLoadCues,
  nextWorkingLoad,
  pickHeadlineLift,
  pickWeekOverWeek,
  priorTopLoadKg,
  rankLifts,
  shortWeekLoadCues,
  weekOverWeekWording,
  type NextLoad,
} from './liftChange';
import {
  PHASE_CEILING_TOLERANCE,
  STRIDES_COPY,
  WEEKLY_DISTANCE_GROWTH,
  enduranceWeekPlan,
  findRaceRun,
  formatTargetLongRun,
  gradeEnduranceWeek,
  isWindDownKind,
  isSpikeWeek,
  isWindDownPhase,
  longRunCapNote,
  longRunWord,
  overCapPhrase,
  overUpToCap,
  planWeekKm,
  raceClass,
  racePaceReps,
  racePhaseInfo,
  racePhaseTargetKm,
  weekStepTarget,
  type EnduranceWeekPlan,
  type PlanRun,
  type RacePhaseInfo,
} from './enduranceProgression';
import { KM_PER_MILE } from './metricFormat';

// ── Constants ───────────────────────────────────────────────────────────────

export const REVIEW_HEADLINE_MAX_CHARS = 80;
export const MAX_REVIEW_STATS = 4;
const KM_TO_MI = 0.621371;
/** A logged day counts as within budget when kcal <= target x this (same as goalProgress). */
const CALORIE_ADHERENCE_TOLERANCE = 1.05;
const PROTEIN_HIT_FRACTION = 0.9;
const SLEEP_GOAL_FRACTION = 0.9;
/** Minimum days of a signal in the week before its stat is shown. */
const MIN_INTAKE_DAYS = 3;
const MIN_SLEEP_NIGHTS = 3;
const MIN_HR_DAYS = 3;
/** Weekend-vs-weekday gap (kcal/day) worth calling out. */
const WEEKEND_GAP_MIN_KCAL = 250;
/** Review is 'sufficient' with at least this many distinct days carrying any data and this many stats. */
const MIN_DATA_DAYS = 3;
const MIN_STATS = 2;
/**
 * Label of the review's weight stat. It is the change in the RAW weekly mean
 * (this week's weigh-ins averaged, against the week before's) — NOT the 4-week
 * pace ("+0.4 kg/wk") the goal sheet quotes, so the label says so. It needs 2+
 * weigh-ins in each of the two weeks.
 */
export const WEIGHT_STAT_LABEL = 'Weekly avg weight';
/**
 * Label when a week lacks the weigh-ins for a weekly mean and the stat falls back
 * to the change in the smoothed trend. Never called a weekly average.
 */
export const WEIGHT_TREND_STAT_LABEL = 'Trend change';
/**
 * The same fallback for a weight-loss goal, worded without "trend": its one weight is the weekly average, and the smoothed line is
 * the chart's drawing, never a weight the card or the review quotes. (Muscle keeps "Trend change": its card quotes a trend weight.)
 */
export const WEIGHT_CHANGE_STAT_LABEL = 'Weight change';
/** Weigh-ins a week needs (each of the two weeks) for the weekly-mean change. */
const MIN_WEIGH_INS_FOR_MEAN = 2;
/** A review may rest on the weight stat alone when the reviewed week had at least this many weigh-ins. */
const MIN_WEIGH_INS_WEIGHT_ONLY = 3;
/** A reached goal: the weekly average within this many kg of the target is "within 1 kg of 84 kg" (goalProgress HOLDING_NEAR_TARGET_KG). */
const HOLDING_RANGE_KG = 1;

// ── Types ───────────────────────────────────────────────────────────────────

export type ReviewTone = 'good' | 'watch' | 'neutral';

export interface WeeklyReviewStat {
  label: string;
  value: string;
  comparison: string | null;
  tone: ReviewTone;
}

/**
 * How the reviewed week itself went, from that week's own stats only (never
 * the 4-week goal verdict): 'light' is a deliberate lighter (deload) week.
 */
export type WeekRating = 'good' | 'mixed' | 'tough' | 'light';

/**
 * The ONE gap between the reviewed week and what it was aiming for, from the
 * same inputs as `weekRating`. It drives all three prose parts: a mixed/tough
 * week's Slip names it, and "Next week" closes it. `null` when the week was
 * good, a deliberate lighter week, or can't be rated.
 */
export type WeekGap =
  | { kind: 'sessions'; done: number; target: number }
  /** General goal: active days against the "good week" bar. */
  | { kind: 'activeDays'; done: number; target: number }
  /**
   * Endurance: running km this week vs the weekly target (km, whatever the
   * display unit). `stepKm` is present when that week's safe step (~10% over the
   * week before, lib/enduranceProgression.ts) was below the goal: the week was
   * graded against the step, and `targetKm` stays the goal beside it. `comebackFromKm` is present for a careful comeback
   * week (the target is a ceiling, "up to ~18 km"): it was graded against the week before it (`comebackFromKm`), and is
   * a gap only because it shrank.
   */
  | { kind: 'distance'; doneKm: number; targetKm: number; stepKm?: number; comebackFromKm?: number }
  /**
   * Endurance: running km far ABOVE that week's safe step (a jump, not a
   * shortfall — see `isSpikeWeek`). Only when a step below the goal applies.
   */
  | { kind: 'spike'; doneKm: number; stepKm: number; targetKm: number }
  /**
   * Endurance, race lifecycle: a taper / race-week / recovery week whose running
   * km sat off that phase's target (lib/enduranceProgression.ts). `over` is true
   * for too much running (taper: far over, race week and recovery: over the
   * ceiling), false for a taper week far under. Never the build-phase
   * `distance` gap, so nothing ever tells the runner to "build" in these weeks.
   */
  | { kind: 'phase'; phase: 'taper' | 'race_week' | 'recovery'; doneKm: number; targetKm: number; over: boolean }
  | { kind: 'budget'; inBudget: number; logged: number }
  | { kind: 'protein'; hit: number; logged: number }
  /** Weight loss with no usable budget days: the week's trend change (kg, signed) was flat or the wrong way / too fast. */
  | { kind: 'weight'; deltaKg: number };

export interface WeeklyReview {
  /** Monday, YYYY-MM-DD (user-local). */
  weekStart: string;
  /** Sunday, YYYY-MM-DD (user-local). */
  weekEnd: string;
  goal: GoalKind;
  /**
   * The 4-week goal verdict as of this week (shared with the goal card) — NOT a rating of the week; use `weekRating` for that.
   * Weight loss with a week plan: the verdict of the coming week's plan (what the goal card shows on that Monday), so the
   * review and the card cannot disagree.
   */
  verdict: GoalVerdict;
  /**
   * Rating of the reviewed week alone (see assessWeek). `null` when the
   * week's own stats can't support one. `undefined` on rows stored before this
   * field existed — readers must tolerate its absence (stored JSON, no migration).
   */
  weekRating?: WeekRating | null;
  /**
   * What kept the week from being good (see `WeekGap`): the Slip line names it
   * and "Next week" closes it. `null` for a good / lighter / unrated week.
   * `undefined` on rows stored before this field existed.
   */
  weekGap?: WeekGap | null;
  /** Plain English, <= 80 chars. */
  headline: string;
  /** At most 4, goal-specific; stats without data are omitted. */
  stats: WeeklyReviewStat[];
  win: string | null;
  slip: string | null;
  nextWeek: string;
  dataSufficiency: { daysWithData: number; statCount: number; sufficient: boolean };
}

export interface WeeklyReviewWorkout {
  day: string;
  durationMin: number | null;
  distanceKm: number | null;
  /** HealthKit workout type name (e.g. "Running"); only running distance counts toward the weekly distance target. */
  type?: string | null;
}

export interface WeeklyReviewInput {
  goal: GoalKind;
  /** Monday of the week being reviewed. */
  weekStart: string;
  /** Verdict from computeGoalProgress — reused verbatim. */
  verdict: GoalVerdict;
  /** Raw weigh-ins; needs some run-in before the week for the trend baseline. */
  weightReadings: WeightReading[];
  /** Resolved intake covering the reviewed week and the week before. */
  intakeDays: GoalProgressIntakeDay[];
  budget: GoalProgressBudget | null;
  /** Distinct local days with a completed session, covering both weeks. */
  trainingDays: string[];
  /**
   * Muscle goal only: distinct local days with a STRENGTH session (logged sets
   * or a HealthKit workout whose type matches /strength/i), covering both
   * weeks (and, from the loader, the ~2 weeks before them: a run of on-target
   * or empty weeks is read from them) — the same definition lib/goalProgress.ts uses. When present, the
   * muscle review counts these instead of every training day (a run is not a
   * lifting session). Other goals ignore it.
   */
  strengthDays?: string[];
  workouts: WeeklyReviewWorkout[];
  progression: ProgressionSummary;
  restingHr: DayValue[];
  /** Daily HRV; optional so older callers/stored inputs still work. */
  hrv?: DayValue[];
  sleepMinutes: DayValue[];
  sleepGoalMinutes: number;
  weeklySessionsTarget: number | null;
  /** Endurance weekly running-distance target (km); optional so older callers/stored inputs still work. */
  weeklyDistanceKmTarget?: number | null;
  /**
   * Endurance long-run progress as of the end of the reviewed week (the same
   * object goal progress computes, km). Lets "Next week" cap long-run growth
   * at the peak target; absent / null -> the long run is not mentioned.
   */
  longRun?: GoalLongRunProgress | null;
  /**
   * Muscle: the "building back after a break" state as of the end of the
   * reviewed week (the same object the goal card carries, lib/goalProgress.ts).
   * While `regained` is false the review calls no e1RM drop a slip and never
   * asks to make up missed sessions; absent / null -> normal rules.
   */
  liftReturn?: GoalLiftReturn | null;
  /**
   * Muscle, additive: the same return lift by lift (the goal card's
   * `liftReturns`, the headline lift first). With it the review claims "back
   * above pre-break" only when every lift is, and names the lift furthest behind
   * otherwise; absent / null: `liftReturn` alone speaks for the return.
   */
  liftReturns?: GoalLiftReturn[] | null;
  /**
   * Endurance race day (YYYY-MM-DD, user-local). With it the reviewed week and
   * the coming week each get a race phase (build / taper / race week /
   * recovery, evaluated on the week's Monday): taper, race and recovery weeks
   * are graded against their own target and "Next week" follows the coming
   * week's phase instead of the growth step. Absent / null: no race.
   */
  raceDate?: string | null;
  /**
   * The race distance (km): sets where the phases fall (a half marathon tapers
   * for one week, a 10K not at all, a marathon for three), the race-length run
   * that counts as the race, and the race's name in the copy. Absent / null:
   * the marathon rules and no race detection.
   */
  raceDistanceKm?: number | null;
  /**
   * Endurance: running workouts with a distance over a longer history than
   * `workouts` (~11 weeks, through the reviewed Sunday; the loader supplies it).
   * The week plan needs the weeks before last week (restart median, spike ->
   * hold, baseline). Absent (tests, old callers): the running `workouts` stand in.
   */
  runHistory?: Array<{ day: string; km: number; durationMin?: number | null }>;
  /**
   * Biggest weekly running km (km) in the 4 weeks before the taper began (the
   * loader computes it from a longer history than `workouts`). The taper, race
   * week and recovery targets are shares of it; absent / null: the weekly
   * distance target stands in.
   */
  racePeakWeekKm?: number | null;
  unitSystem?: 'metric' | 'imperial' | null;
  /** exercise key -> display name; falls back to Title Case ("bench press" -> "Bench Press"). */
  exerciseDisplay?: Record<string, string>;
  /**
   * Weight loss: the COMING week's plan (lib/weightWeekPlan.ts) — the very plan the goal card shows from that Monday. Its
   * action is "Next week" and its verdict is the review's verdict, so the review never gives an instruction the card
   * contradicts. Absent / null (tests, old callers): the review's own tips and `verdict` stand.
   */
  weightPlan?: WeightWeekPlan | null;
  /** Weight loss: the goal's target weight (kg) — names the target when the review is of the week it was reached. */
  targetWeightKg?: number | null;
  /** Weight loss: the local day the target was first reached (goal progress `reachedAt`); null / absent when unknown. */
  reachedAt?: string | null;
  /**
   * The previous week's "Next week" text (the stored review), so the same tip is
   * never given two weeks running. Absent: the tip rotates deterministically with
   * the week number instead.
   */
  previousNextWeek?: string | null;
  /**
   * Local day the user signed up / the goal began (YYYY-MM-DD). Days before it
   * (e.g. HealthKit backfill) never count toward the "enough data" gate or the
   * first review's day counts. Omitted -> every day counts.
   */
  signupDay?: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the last fully completed local week relative to the local `todayKey`. */
export function lastCompletedWeekStart(todayKey: string): string {
  return addDays(weekStartKeyForDay(todayKey), -7);
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function fmtKcal(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function signed(n: number, text: string): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${text}`;
}

function isImperial(input: WeeklyReviewInput): boolean {
  return input.unitSystem === 'imperial';
}

function weightText(input: WeeklyReviewInput, kg: number): string {
  const imperial = isImperial(input);
  return withUnit(round1(imperial ? kg * KG_TO_LB : kg), imperial ? 'lb' : 'kg');
}

/** Like weightText but always one decimal ("84.0 kg"), for averages. */
function weightTextFixed(input: WeeklyReviewInput, kg: number): string {
  const imperial = isImperial(input);
  return withUnit(round1(imperial ? kg * KG_TO_LB : kg).toFixed(1), imperial ? 'lb' : 'kg');
}

/** A km distance in the display unit, rounded to 0.1, no unit suffix. */
function distanceNumber(input: WeeklyReviewInput, km: number): number {
  return round1(isImperial(input) ? km * KM_TO_MI : km);
}

function distanceText(input: WeeklyReviewInput, km: number): string {
  return withUnit(distanceNumber(input, km), isImperial(input) ? 'mi' : 'km');
}

function clipHeadline(text: string): string {
  if (text.length <= REVIEW_HEADLINE_MAX_CHARS) return text;
  return `${text.slice(0, REVIEW_HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m === 60 ? `${h + 1}h 0m` : `${h}h ${m}m`;
}

interface Week {
  days: string[];
  set: Set<string>;
  /** Days on/after signup only (== set when no signupDay). */
  eligible: Set<string>;
}

function makeWeek(weekStart: string, signupDay?: string | null): Week {
  const days = weekDayKeys(weekStart);
  return { days, set: new Set(days), eligible: new Set(signupDay ? days.filter(d => d >= signupDay) : days) };
}

function loggedIntake(days: GoalProgressIntakeDay[], week: Week): GoalProgressIntakeDay[] {
  return days.filter(
    d => week.eligible.has(d.day) && d.source !== 'none' && d.kcal != null && d.kcal >= PARTIAL_LOG_KCAL_THRESHOLD,
  );
}

/** A computed stat plus the sentences it can contribute to win / slip / nextWeek. */
interface Candidate {
  stat: WeeklyReviewStat;
  win?: string;
  slip?: string;
  /** Concrete next-week suggestion when this stat is a 'watch'. */
  fix?: string;
}

// ── Per-metric builders ─────────────────────────────────────────────────────

/** One raw reading per weigh-in day (computeWeightTrend's de-duplicated days) inside the week. */
function weekWeighIns(input: WeeklyReviewInput, week: Week): Array<{ day: string; rawKg: number }> {
  return computeWeightTrend(input.weightReadings).days.filter(d => week.set.has(d.day));
}

interface WeightChange {
  /** Signed kg change. */
  deltaKg: number;
  /** The weekly mean (or, for a trend change, the trend at the week's end), kg. */
  endKg: number;
  /** 'mean': this week's raw mean vs the week before's. 'trend': the smoothed trend's change (a week short of weigh-ins). */
  basis: 'mean' | 'trend';
}

/**
 * The week's weight change (kg, signed): the change in the RAW weekly mean —
 * this week's weigh-ins averaged against the week before's — which needs 2+
 * weigh-ins in each week. A week short of those falls back to the change in the
 * smoothed trend (labelled "Trend change", never a weekly average). Null without
 * a weigh-in in the reviewed week or a baseline from the week before.
 */
function weightChange(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeightChange | null {
  const trend = computeWeightTrend(input.weightReadings).days;
  const cur = trend.filter(d => week.set.has(d.day));
  const prev = trend.filter(d => prevWeek.set.has(d.day));
  // A weight-loss goal has one weight, the weekly average (the card never quotes the smoothed trend): a week after a thin one (a single
  // weigh-in, as after a gap) is still compared with it, not with the smoothed line (wave 22w).
  const prevNeeded = input.goal === 'weight_loss' ? 1 : MIN_WEIGH_INS_FOR_MEAN;
  if (cur.length >= MIN_WEIGH_INS_FOR_MEAN && prev.length >= prevNeeded) {
    const curMean = mean(cur.map(d => d.rawKg)) as number;
    const prevMean = mean(prev.map(d => d.rawKg)) as number;
    return { deltaKg: curMean - prevMean, endKg: curMean, basis: 'mean' };
  }
  const end = [...trend].reverse().find(d => d.day <= week.days[6]);
  if (!end || !week.set.has(end.day)) return null; // no weigh-in inside the reviewed week
  const start = [...trend].reverse().find(d => d.day < week.days[0]);
  if (!start || start.day < prevWeek.days[0]) return null; // no usable baseline from the week before
  return { deltaKg: end.trendKg - start.trendKg, endKg: end.trendKg, basis: 'trend' };
}

/** Weight loss: three flat weeks of raw weekly means (this week and the two before). A flat scale is not a win. */
function isPlateauWeek(input: WeeklyReviewInput, week: Week): boolean {
  if (input.goal !== 'weight_loss') return false;
  const goalAge = input.signupDay ? dayNumber(week.days[6]) - dayNumber(input.signupDay) + 1 : null;
  return rawPlateau(computeWeightTrend(input.weightReadings).days, week.days[6], goalAge) != null;
}

/** A weight-loss review of a goal whose target is reached (verdict 'reached'): the week it was reached, or one spent holding. */
interface ReachedWeek {
  targetKg: number | null;
  /** The target was first reached inside the reviewed week. */
  thisWeek: boolean;
  /** Raw mean of the reviewed week's weigh-ins (kg); null without any. */
  meanKg: number | null;
}

function reachedWeek(input: WeeklyReviewInput, week: Week): ReachedWeek | null {
  if (input.goal !== 'weight_loss' || input.verdict !== 'reached') return null;
  const cur = weekWeighIns(input, week);
  // The goal card's own weekly average (lib/goalProgress.ts buildWeightBlock): the raw mean of the 7 days up to the newest weigh-in
  // (3+ weigh-ins), else that newest reading - rounded once to the 0.1 kg it prints, so "Holding at 83.8 kg" is the same number on the
  // Monday card, the opener, the review and the push (the reviewed Mon-Sun mean differed when the week's last weigh-in was not Sunday).
  const newest = cur.length > 0 ? cur[cur.length - 1] : null;
  const week7 = newest != null ? meanOver(computeWeightTrend(input.weightReadings).days.filter(d => d.day <= newest.day), newest.day, 7) : null;
  return {
    targetKg: input.targetWeightKg ?? null,
    thisWeek: input.reachedAt != null && week.set.has(input.reachedAt),
    meanKg: newest == null ? null : round1(week7 != null && week7.n >= WEEK_MEAN_MIN_WEIGH_INS ? week7.meanKg : newest.rawKg),
  };
}

/** The reviewed week's average is exactly the target at the 0.1 kg it prints: "Holding at your 84 kg target". */
function onTarget(r: ReachedWeek): boolean {
  return r.targetKg != null && r.meanKg != null && Math.round(r.meanKg * 10) === Math.round(r.targetKg * 10);
}

/** Holding more than HOLDING_RANGE_KG under the target: the goal is met, the loss should stop. */
function isUnderTarget(r: ReachedWeek): boolean {
  return r.targetKg != null && r.meanKg != null && r.targetKg - r.meanKg > HOLDING_RANGE_KG;
}

/** Weight loss: the goal card's verdict says the loss pace (21-day line, with the card's hysteresis) is past the ceiling. */
function isTooFastWeek(input: WeeklyReviewInput): boolean {
  return input.goal === 'weight_loss' && input.verdict === 'too_fast';
}

/** Weight loss: the goal card's verdict says the scale is not moving toward the target (behind pace or stalled). */
function isTooSlowWeek(input: WeeklyReviewInput): boolean {
  return input.goal === 'weight_loss' && (input.verdict === 'behind' || input.verdict === 'stalled');
}

/** True for any of the review's weight-change stat labels (weekly mean, or the smoothed fallback under either wording). */
function isWeightStatLabel(label: string): boolean {
  return label === WEIGHT_STAT_LABEL || label === WEIGHT_TREND_STAT_LABEL || label === WEIGHT_CHANGE_STAT_LABEL;
}

/**
 * How the weight stat names what it compared: ONE place for the stat label, its comparison and the win / slip subject, so the
 * weight-loss path can never call the progress weight a "trend" in one string and the weekly average in the next.
 */
function weightWords(input: WeeklyReviewInput, basis: WeightChange['basis']): { label: string; comparison: string; subject: string } {
  if (basis === 'mean') return { label: WEIGHT_STAT_LABEL, comparison: 'vs the week before', subject: 'Your weekly average weight' };
  if (input.goal === 'weight_loss') return { label: WEIGHT_CHANGE_STAT_LABEL, comparison: 'smoothed, vs the week before', subject: 'Your weight' };
  return { label: WEIGHT_TREND_STAT_LABEL, comparison: 'smoothed trend, vs the week before', subject: 'Your weight trend' };
}

function weightCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const change = weightChange(input, week, prevWeek);
  if (!change) return null;
  const { deltaKg } = change;
  const rounded = round1(isImperial(input) ? deltaKg * KG_TO_LB : deltaKg);
  const text = rounded === 0 ? weightText(input, 0) : weightText(input, Math.abs(deltaKg));
  const value = rounded === 0 ? text : signed(rounded, text);
  // A lifter's "no change" is decided in kg, whatever the display unit: 0.04 kg is noise in pounds too (it read "+0.1 lb" beside "no change").
  const flatMuscle = input.goal === 'muscle' && round1(deltaKg) === 0;
  const words = weightWords(input, change.basis);

  let tone: ReviewTone = 'neutral';
  if (input.goal === 'weight_loss') {
    // The weekly change is a neutral stat: one week-to-week move in the mean is noise, not a pace. "Too fast" and
    // "too slow" are the goal card's calls (the 21-day pace, input.verdict) and nothing else.
    if (reachedWeek(input, week) != null || isPlateauWeek(input, week)) tone = 'neutral';
    else if (deltaKg <= -0.05) tone = isTooFastWeek(input) ? 'watch' : 'good';
    else if (deltaKg >= 0.2) tone = isTooSlowWeek(input) ? 'watch' : 'neutral';
  } else if (input.goal === 'muscle') {
    // Weight gain is a win for a lifter who trained that week; in a week without a session it is only a number.
    if (deltaKg > 0.05) tone = weekSessionCount(input, week) > 0 ? 'good' : 'neutral';
    else if (deltaKg <= -0.2) tone = 'watch';
  }
  const cand: Candidate = {
    stat: {
      label: words.label,
      value,
      comparison: words.comparison,
      tone,
    },
  };
  if (input.goal === 'muscle' && (rounded === 0 || flatMuscle)) cand.stat.value = 'no change';
  const subject = words.subject;
  if (tone === 'good') cand.win = `${subject} is ${input.goal === 'muscle' ? 'up' : 'down'} ${weightText(input, Math.abs(deltaKg))}.`;
  if (tone === 'watch') {
    cand.slip = input.goal === 'weight_loss' && deltaKg < 0
      ? 'Your 3-week loss pace is faster than is comfortable to sustain.'
      : `${subject} moved ${rounded > 0 ? 'up' : 'down'} ${weightText(input, Math.abs(deltaKg))}, away from your goal.`;
  }
  return cand;
}

/** Logged days of the week within the calorie budget; null without a target or under MIN_INTAKE_DAYS logged days. */
function budgetDays(input: WeeklyReviewInput, week: Week): { target: number; hit: number; logged: number } | null {
  const target = input.budget?.targetKcal;
  if (target == null) return null;
  const logged = loggedIntake(input.intakeDays, week);
  if (logged.length < MIN_INTAKE_DAYS) return null;
  const hit = logged.filter(d => (d.kcal as number) <= target * CALORIE_ADHERENCE_TOLERANCE).length;
  return { target, hit, logged: logged.length };
}

function budgetCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  const days = budgetDays(input, week);
  if (!days) return null;
  const { target, hit, logged } = days;
  const frac = hit / logged;
  const tone: ReviewTone = frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: {
      label: 'Days in budget',
      value: `${hit}/${logged}`,
      comparison: logged < 7 ? `${logged} ${plural(logged, 'day')} logged` : 'across the week',
      tone,
    },
  };
  if (tone === 'good') cand.win = `You stayed within your ${withUnit(fmtKcal(target), 'kcal')} target on ${hit} of ${logged} logged days.`;
  if (tone === 'watch') {
    cand.slip = `Only ${hit} of ${logged} logged days landed within your ${withUnit(fmtKcal(target), 'kcal')} target.`;
    cand.fix = `Pick the two days most likely to run over and plan those meals ahead.`;
  }
  return cand;
}

function avgKcalCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const logged = loggedIntake(input.intakeDays, week);
  if (logged.length < MIN_INTAKE_DAYS) return null;
  const avg = mean(logged.map(d => d.kcal as number)) as number;
  const prev = loggedIntake(input.intakeDays, prevWeek);
  const prevAvg = prev.length >= MIN_INTAKE_DAYS ? (mean(prev.map(d => d.kcal as number)) as number) : null;
  let comparison: string | null = null;
  if (prevAvg != null) {
    const diff = Math.round(avg - prevAvg);
    comparison = diff === 0 ? 'same as last week' : `${signed(diff, fmtKcal(Math.abs(diff)))} vs last week`;
  }
  return { stat: { label: 'Avg calories', value: withUnit(fmtKcal(avg), 'kcal'), comparison: comparison ?? 'daily avg for the week', tone: 'neutral' } };
}

/** Days that count as a session for the goal: strength sessions only for muscle (mirrors goalProgress `sessionDays`). */
function sessionDays(input: WeeklyReviewInput): string[] {
  return input.goal === 'muscle' && input.strengthDays ? input.strengthDays : input.trainingDays;
}

/** Distinct local days of the week with a completed session (strength-only for muscle). */
function weekSessionCount(input: WeeklyReviewInput, week: Week): number {
  const train = new Set(sessionDays(input));
  return week.days.filter(d => train.has(d)).length;
}

/** Weeks looked back for a run of on-target weeks; a longer run reads "a month running". */
const ON_TARGET_LOOKBACK_WEEKS = 4;
/** Weeks looked back for a run of weeks without a session. */
const OFF_LOOKBACK_WEEKS = 12;

/** "2nd", "3rd", "11th". */
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Weeks in a row, the reviewed one included, that reached `target` sessions (at most ON_TARGET_LOOKBACK_WEEKS; weeks before signup end the run). */
function weeksOnTargetRunning(input: WeeklyReviewInput, week: Week, target: number): number {
  const train = new Set(sessionDays(input));
  let n = 1;
  for (let k = 1; k < ON_TARGET_LOOKBACK_WEEKS; k += 1) {
    const days = weekDayKeys(addDays(week.days[0], -7 * k));
    if (input.signupDay && days[6] < input.signupDay) break;
    if (days.filter(d => train.has(d)).length < target) break;
    n += 1;
  }
  return n;
}

/**
 * The win for a week that reached the sessions target. It varies with the run
 * of on-target weeks, so two good weeks never read word for word the same:
 * "You hit all 4 planned sessions." -> "4 of 4 again — 2 weeks running." -> ...
 * -> (a month in) alternating "a month running" and "Another full week".
 */
function muscleTargetWin(input: WeeklyReviewInput, week: Week, target: number): string {
  const n = weeksOnTargetRunning(input, week, target);
  if (n <= 1) return target === 1 ? 'You hit your planned session.' : `You hit all ${target} planned sessions.`;
  if (n < ON_TARGET_LOOKBACK_WEEKS) return `${target} of ${target} again — ${n} weeks running.`;
  return weekIndex(week) % 2 === 0
    ? `${target} of ${target} again — a month running.`
    : `Another full week: all ${target} planned ${plural(target, 'session')} done.`;
}

/**
 * Weeks in a row, the reviewed one included, without a strength session (1 when
 * only this week was empty; 0 when it had one). A week counts as trained when it
 * has a session day or any logged lift set. The run reaches back only as far as
 * the user's known history — signup, else the earliest session or lift week — so
 * weeks nobody was around for are never "weeks off".
 */
function weeksOffRunning(input: WeeklyReviewInput, week: Week): number {
  if (weekSessionCount(input, week) > 0) return 0;
  const train = new Set(sessionDays(input));
  const setWeeks = new Set<string>();
  for (const weeks of Object.values(input.progression)) for (const w of weeks) if ((w.totalSets ?? 0) > 0) setWeeks.add(w.weekStart);
  const known = input.signupDay ?? [...train, ...setWeeks].sort()[0];
  if (known == null) return 1;
  let n = 1;
  for (let k = 1; k < OFF_LOOKBACK_WEEKS; k += 1) {
    const start = addDays(week.days[0], -7 * k);
    const days = weekDayKeys(start);
    if (days[6] < known || setWeeks.has(start) || days.some(d => train.has(d))) break;
    n += 1;
  }
  return n;
}

function sessionsCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const count = weekSessionCount(input, week);
  const prev = weekSessionCount(input, prevWeek);
  const target = input.weeklySessionsTarget;
  if (count === 0 && prev === 0 && target == null) return null; // nothing to say, and no sign they train
  const label = input.goal === 'weight_loss' ? 'Workouts' : input.goal === 'general' ? 'Active days' : 'Sessions';
  let comparison: string | null;
  let tone: ReviewTone = 'neutral';
  const cand: Candidate = { stat: { label, value: String(count), comparison: null, tone } };
  if (target != null && input.goal !== 'general') {
    comparison = `target ${target} for the week`;
    tone = count >= target ? 'good' : count >= target * 0.75 ? 'neutral' : 'watch';
    if (tone === 'good') cand.win = input.goal === 'muscle' ? muscleTargetWin(input, week, target) : `You hit your ${target}-${plural(target, 'session')} target with ${count}.`;
    if (tone === 'watch') {
      cand.slip = `${count} of ${target} planned ${plural(target, 'session')} done.`;
      cand.fix = `Put ${target} sessions on the calendar now, before the week fills up.`;
    }
  } else {
    comparison = prev > 0 || count > 0 ? `${prev} last week` : 'for the week';
    if (count > prev && prev > 0) { tone = 'good'; cand.win = `${count} ${plural(count, 'session')}, up from ${prev} last week.`; }
    else if (count < prev) { tone = 'watch'; cand.slip = `${count} ${plural(count, 'session')}, down from ${prev} last week.`; cand.fix = `Get back to ${prev} sessions — put the first one on the calendar today.`; }
  }
  cand.stat.comparison = comparison;
  cand.stat.tone = tone;
  return easeForRestWeek(input, week, easeForWindDown(input, week, cand));
}

/** Logged days of the week that hit the protein target; null without a target or under MIN_INTAKE_DAYS logged days. */
function proteinDays(input: WeeklyReviewInput, week: Week): { target: number; hit: number; logged: number } | null {
  const target = input.budget?.proteinG;
  if (target == null || target <= 0) return null;
  const logged = loggedIntake(input.intakeDays, week).filter(d => d.proteinG != null);
  if (logged.length < MIN_INTAKE_DAYS) return null;
  const hit = logged.filter(d => (d.proteinG as number) >= target * PROTEIN_HIT_FRACTION).length;
  return { target, hit, logged: logged.length };
}

function proteinCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  const days = proteinDays(input, week);
  if (!days) return null;
  const { target, hit, logged } = days;
  const frac = hit / logged;
  const tone: ReviewTone = frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: {
      label: 'Protein days hit',
      value: `${hit}/${logged}`,
      comparison: logged < 7 ? `${logged} ${plural(logged, 'day')} logged` : 'across the week',
      tone,
    },
  };
  if (tone === 'good') cand.win = `You hit your ${withUnit(Math.round(target), 'g')} protein target on ${hit} of ${logged} logged days.`;
  if (tone === 'watch') {
    cand.slip = `Protein reached your ${withUnit(Math.round(target), 'g')} target on only ${hit} of ${logged} logged days.`;
    cand.fix = `Add a protein-first breakfast so the day starts ahead of your target.`;
  }
  return cand;
}

/**
 * The Monday every lift comparison in the review is anchored on: the Monday AFTER
 * the reviewed week, i.e. the day the review is read. That is exactly the week
 * the Trends card anchors on that morning (its own week has no sets yet, so it
 * looks back at the reviewed week), so "vs 4 weeks ago" and the headline lift
 * are the same numbers in the card and the review.
 */
function liftAnchor(week: Week): string {
  return addDays(week.days[0], 7);
}

/**
 * The one lift every lift cue in the review talks about: the building-back
 * lift while the user is returning from a break, else the shared headline lift
 * (lib/liftChange.ts `pickHeadlineLift`: the most-trained lift that has a
 * 4-week comparison, the same lift the Trends goal card names), else just the
 * most-trained lift. Null when no lift is in rotation.
 */
function reviewLiftKey(input: WeeklyReviewInput, week: Week): string | null {
  if (input.liftReturn) return input.liftReturn.exercise;
  const anchor = liftAnchor(week);
  return pickHeadlineLift(input.progression, anchor)?.exercise ?? rankLifts(input.progression, anchor)[0] ?? null;
}

/** Every lift's return, the headline lift first (the card's `liftReturns`; just `liftReturn` for callers without it). */
function returnsOf(input: WeeklyReviewInput): GoalLiftReturn[] {
  if (input.liftReturns && input.liftReturns.length > 0) return input.liftReturns;
  return input.liftReturn ? [input.liftReturn] : [];
}

/** Some lift is still under its pre-break best: the week is a rebuild (no drop is a slip, no session is "made up"). */
function stillRebuilding(input: WeeklyReviewInput): boolean {
  return furthestBehindReturn(returnsOf(input)) != null;
}

/** "Squat estimated 1RM is back above your pre-break best: 145 kg (was 142 kg)." */
function returnWinText(input: WeeklyReviewInput, r: GoalLiftReturn): string {
  const { pre, recent, unit } = liftReturnDisplay(r, isImperial(input));
  const name = liftDisplayName(r.exercise, input.exerciseDisplay);
  return recent > pre
    ? `${name} estimated 1RM is back above your pre-break best: ${withUnit(recent, unit)} (was ${withUnit(pre, unit)}).`
    : `${name} estimated 1RM is back at your pre-break best of ${withUnit(recent, unit)}.`;
}

/**
 * The "building back" lift stat: no drop, no slip. The headline lift speaks for
 * it; when some lifts are back and one is not, the lift furthest behind does
 * ("Deadlift est. 1RM 157 kg — 98% of your 160 kg pre-break best", with a win
 * for a lift that is back). Once every pre-break best is regained, the headline
 * lift's stat is a win.
 */
function returnLiftCandidate(input: WeeklyReviewInput): Candidate {
  const rets = returnsOf(input);
  const behind = furthestBehindReturn(rets);
  const mixed = behind != null && rets.some(r => r.regained);
  const ret = mixed && behind ? behind : rets[0];
  // The numbers as printed, and the percentage from those shown numbers (not from the unrounded e1RMs).
  const { pre, recent, pct, unit } = liftReturnDisplay(ret, isImperial(input));
  const name = liftDisplayName(ret.exercise, input.exerciseDisplay);
  const label = `${name} est. 1RM`;
  if (behind) {
    const back = rets.find(r => r.regained);
    return {
      stat: { label, value: withUnit(recent, unit), comparison: `${pct}% of your ${withUnit(pre, unit)} pre-break best`, tone: 'neutral' },
      ...(back ? { win: returnWinText(input, back) } : {}),
    };
  }
  const above = rets.every(r => { const n = liftReturnDisplay(r, isImperial(input)); return n.recent > n.pre; });
  return {
    stat: {
      label,
      value: withUnit(recent, unit),
      comparison: above ? `back above your pre-break ${withUnit(pre, unit)}` : 'back at your pre-break best',
      tone: 'good',
    },
    win: returnWinText(input, ret),
  };
}

/**
 * Headline lift stat of the review: the shared pick from lib/liftChange.ts
 * (`pickHeadlineLift`) with the shared 4-week number ("vs 4 weeks ago"), shown
 * in whole kg/lb. When no lift has 4-weeks-ago data the stat falls back to the
 * most-trained lift's clearly-labelled week-over-week change instead
 * of inventing one. No stat for a week without sessions (an old e1RM is not
 * that week's win) and a "building back" stat while returning from a break.
 * A drop is a slip only when it is a real stall (the ONE stall rule,
 * lib/liftChange.ts isLiftStalled): not in a deload week, not after a break.
 */
function liftCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  if (weekSessionCount(input, week) === 0) return null;
  if (input.liftReturn) return returnLiftCandidate(input);
  const imperial = isImperial(input);
  const unit = imperial ? 'lb' : 'kg';
  let best: { key: string; name: string; shown: number; windowLabel: string; stalled: boolean } | null = null;
  // ONE headline-lift rule (lib/liftChange.ts pickHeadlineLift): the most-trained
  // lift with a 4-week comparison — the same lift the Trends goal card names.
  const picked = pickHeadlineLift(input.progression, liftAnchor(week));
  if (picked) {
    best = {
      key: picked.exercise,
      name: liftDisplayName(picked.exercise, input.exerciseDisplay),
      shown: liftDisplayChange(picked.change, imperial).change,
      windowLabel: 'vs 4 weeks ago',
      stalled: isLiftStalled(input.progression[picked.exercise], liftAnchor(week)),
    };
  } else {
    // No lift has 4-weeks-ago data: a clearly-labelled week-over-week change ("vs the week before") for the most-trained
    // lift — the ONE week-over-week definition the goal card quotes too (lib/liftChange.ts pickWeekOverWeek, whole-kg endpoints).
    const wow = pickWeekOverWeek(input.progression, liftAnchor(week), [week.days[0]]);
    if (wow) {
      best = {
        key: wow.exercise,
        name: liftDisplayName(wow.exercise, input.exerciseDisplay),
        shown: liftWeekChangeDisplay(wow.change, imperial),
        // The window the card labels the same pair with ("Last week: … vs the week before"; lib/liftChange.ts weekOverWeekWording).
        windowLabel: weekOverWeekWording(wow.change, wow.end, liftAnchor(week)).vs,
        stalled: true,
      };
    }
  }
  if (!best) return null;
  const value = best.shown === 0 ? withUnit(0, unit) : signed(best.shown, withUnit(Math.abs(best.shown), unit));
  // A deload week lowers e1RM on purpose, and a drop that is not a stall (a
  // break, a return) is no slip either: both stay neutral.
  const deload = best.shown < 0 && isDeloadWeek(input.progression, week.days[0]);
  // A slack week (half the planned sessions or fewer) colours no lift gain the week did not produce: the numbers stay, as a neutral stat,
  // unless that lift was trained at working weight in the reviewed week.
  const unproduced = slackMuscleWeek(input, week) && !liftTrainedAtWorkingWeight(input.progression[best.key] ?? [], week.days[0]);
  const tone: ReviewTone = best.shown > 0 ? (unproduced ? 'neutral' : 'good') : best.shown < 0 && !deload && best.stalled ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: { label: `${best.name} est. 1RM`, value, comparison: deload ? `Lighter week · ${best.windowLabel}` : best.windowLabel, tone },
  };
  const shownText = withUnit(Math.abs(best.shown), unit);
  if (tone === 'good') cand.win = `${best.name} estimated 1RM is up ${shownText} ${best.windowLabel}.`;
  if (tone === 'watch') cand.slip = `${best.name} estimated 1RM is down ${shownText} ${best.windowLabel}.`;
  return cand;
}

/** True when the user has a positive weekly running-distance target. */
function hasDistanceTarget(input: WeeklyReviewInput): boolean {
  return input.weeklyDistanceKmTarget != null && input.weeklyDistanceKmTarget > 0;
}

// ── Race lifecycle (taper / race week / recovery) ───────────────────────────

/** A week that falls in the taper, race week or the 14 days of recovery, with its running target. */
interface WindDownPlan {
  phase: 'taper' | 'race_week' | 'recovery';
  info: RacePhaseInfo;
  /** The week's running target (km); null when no peak week is known (no running before the taper, no weekly goal). */
  targetKm: number | null;
}

/**
 * The wind-down plan for the week that STARTS on `onDay` (a Monday): the race
 * phase is read on that day, so a whole Mon–Sun week is graded against one
 * target (the shared rule in lib/enduranceProgression.ts). Null for a build
 * week, a week with no race (or one over 14 days ago) and for other goals.
 */
function windDownPlan(input: WeeklyReviewInput, onDay: string): WindDownPlan | null {
  if (input.goal !== 'endurance') return null;
  const info = racePhaseInfo(input.raceDate, onDay, input.raceDistanceKm);
  if (info == null || !isWindDownPhase(info.phase)) return null;
  const goalKm = hasDistanceTarget(input) ? (input.weeklyDistanceKmTarget as number) : null;
  const peakKm = input.racePeakWeekKm ?? goalKm;
  const targetKm = peakKm == null
    ? null
    : racePhaseTargetKm(info, peakKm, { weeklyGoalKm: goalKm, unitsPerKm: isImperial(input) ? 1 / KM_PER_MILE : 1 });
  return { phase: info.phase, info, targetKm };
}

// ── Endurance week plan (ONE plan per calendar week, lib/enduranceProgression.ts) ──

/** A baseline week is rated on consistency: this many run days is a good week. */
const BASELINE_GOOD_RUN_DAYS = 3;
/** A week more than this share over its step is "above the step" (under the spike line), not "on plan". */
const ABOVE_STEP_FRACTION = 1.15;
/** The change vs last week is only quoted when last week was at least this big (km; 3 mi for miles). */
const MIN_COMPARE_KM = 5;
const MIN_COMPARE_MI = 3;

interface ReviewPlans {
  /** Running workouts with a distance up to the reviewed Sunday. */
  runs: PlanRun[];
  /** The plan for the reviewed week (graded against), read on its last day. Null without a weekly distance target or any measured run. */
  plan: EnduranceWeekPlan | null;
  /** The plan for the coming week, read on its Monday: "Next week" IS this plan. */
  next: EnduranceWeekPlan | null;
  /** The reviewed week's running the way the plan counts it: a run on race day is the race, not training. */
  week: { km: number; days: number };
  /** The week before's running, counted the same way. */
  prevWeek: { km: number; days: number };
  /** The race run of the reviewed week (>= 90% of the race distance, within a day of race day). */
  raceRun: PlanRun | null;
}

function unitsPerKmOf(input: WeeklyReviewInput): number {
  return isImperial(input) ? 1 / KM_PER_MILE : 1;
}

const reviewPlansCache = new WeakMap<WeeklyReviewInput, ReviewPlans>();

function reviewPlans(input: WeeklyReviewInput): ReviewPlans {
  const hit = reviewPlansCache.get(input);
  if (hit) return hit;
  const weekEnd = addDays(input.weekStart, 6);
  const runs: PlanRun[] = [];
  if (input.runHistory) {
    for (const r of input.runHistory) {
      if (Number.isFinite(r.km) && r.km > 0 && r.day <= weekEnd) runs.push({ day: r.day, km: r.km, durationMin: r.durationMin ?? null });
    }
  } else {
    for (const w of input.workouts) {
      if (!isRunningWorkoutType(w.type) || w.distanceKm == null || !Number.isFinite(w.distanceKm) || w.distanceKm <= 0) continue;
      if (w.day <= weekEnd) runs.push({ day: w.day, km: w.distanceKm, durationMin: w.durationMin });
    }
  }
  const goalKm = input.weeklyDistanceKmTarget;
  const race = input.raceDate ? { date: input.raceDate, distanceKm: input.raceDistanceKm ?? null } : null;
  const usable = input.goal === 'endurance' && goalKm != null && goalKm > 0 && runs.length > 0;
  const common = { runs, goalKm: goalKm as number, race, racePeakWeekKm: input.racePeakWeekKm ?? null, unitsPerKm: unitsPerKmOf(input), capNoteAnchorDay: input.signupDay ?? null };
  const nextMonday = addDays(input.weekStart, 7);
  const out: ReviewPlans = {
    runs,
    plan: usable ? enduranceWeekPlan({ ...common, weekStart: input.weekStart, today: weekEnd }) : null,
    // The coming week's long run grows from the long run as of the end of the reviewed week (the goal card's own reading).
    next: usable ? enduranceWeekPlan({ ...common, weekStart: nextMonday, today: nextMonday, longRun: input.longRun ?? null }) : null,
    week: planWeekKm(runs, input.weekStart, input.raceDate ?? null),
    prevWeek: planWeekKm(runs, addDays(input.weekStart, -7), input.raceDate ?? null),
    raceRun: findRaceRun(runs.filter(r => r.day >= input.weekStart && r.day <= weekEnd), race),
  };
  reviewPlansCache.set(input, out);
  return out;
}

/** Sessions/volume shortfalls are expected in a wind-down week: drop their slip, fix and win, and any 'watch' tone. */
function easeForWindDown(input: WeeklyReviewInput, week: Week, cand: Candidate, dropWin = false): Candidate {
  if (windDownPlan(input, week.days[0]) == null) return cand;
  delete cand.slip;
  delete cand.fix;
  if (dropWin) delete cand.win;
  if (cand.stat.tone === 'watch') cand.stat.tone = 'neutral';
  return cand;
}

/**
 * The Volume stat of a week with a plan (endurance + a weekly distance target):
 * the running km the plan counts (the race itself left out, and said so), against
 * last week's — a percentage only when last week was a real week (5 km / 3 mi or
 * more), so an early week never reads "+993%". Its tone is the week's grade
 * against its plan, never praise for growth the plan did not ask for, and it
 * carries no win or slip of its own (the plan's win / gap lines say it).
 */
function planVolumeCandidate(input: WeeklyReviewInput, rp: ReviewPlans): Candidate | null {
  const plan = rp.plan as EnduranceWeekPlan;
  const km = rp.week.km;
  const prevKm = rp.prevWeek.km;
  if (km <= 0 && prevKm <= 0 && rp.raceRun == null && plan.daysSinceRun == null) return null;
  const u = unitsPerKmOf(input);
  const grade = gradeEnduranceWeek(plan, km, { runDays: rp.week.days, unitsPerKm: u });
  const compareMin = u < 1 ? MIN_COMPARE_MI / u : MIN_COMPARE_KM;
  let comparison: string;
  if (rp.raceRun != null) {
    const ceiling = plan.targetKm != null ? plan.targetKm * PHASE_CEILING_TOLERANCE : null;
    comparison = ceiling != null && km > ceiling ? `excl. the race · plan was ~${distanceText(input, plan.targetKm as number)}` : 'excl. the race';
  }
  else if (km <= 0 && prevKm <= 0) comparison = plan.daysSinceRun != null ? `${plan.daysSinceRun} days since your last run` : 'none logged';
  else if (km <= 0) comparison = `none logged · ${distanceText(input, prevKm)} last week`;
  // After a hold week or a restart the % against the jump / the sick week is not growth: say what it follows.
  else if (plan.kind === 'hold' && prevKm > 0) comparison = `held after ${distanceText(input, prevKm)} last week`;
  else if (plan.kind === 'restart' && prevKm > 0) comparison = `back after ${distanceText(input, prevKm)} last week`;
  else if (prevKm >= compareMin) {
    const pct = Math.round(((km - prevKm) / prevKm) * 100);
    comparison = pct === 0 ? 'same as last week' : `${signed(pct, `${Math.abs(pct)}%`)} vs last week`;
  } else if (prevKm > 0) comparison = `vs ${distanceText(input, prevKm)} last week`;
  else comparison = 'for the week';
  // A comeback week more than 10% over its "up to" ceiling is neither a win nor a spike: neutral.
  const tone: ReviewTone = isWindDownKind(plan.kind) || rp.raceRun != null || grade.level === 'light' || overUpToCap(plan, km) ? 'neutral'
    : grade.gap === 'spike' || grade.level === 'tough' ? 'watch'
    : grade.level === 'good' ? 'good'
    : 'neutral';
  return { stat: { label: 'Volume', value: distanceText(input, km), comparison, tone } };
}

/** A rest week of a runner who has a plan (no run at all, or a short week that ended in a break) is "rest is fine": fewer sessions is no slip. */
function easeForRestWeek(input: WeeklyReviewInput, week: Week, cand: Candidate): Candidate {
  if (input.goal !== 'endurance') return cand;
  const rp = reviewPlans(input);
  if (rp.plan == null || week.days[0] !== input.weekStart || isWindDownKind(rp.plan.kind)) return cand;
  if (gradeEnduranceWeek(rp.plan, rp.week.km, { runDays: rp.week.days, unitsPerKm: unitsPerKmOf(input) }).level !== 'light') return cand;
  delete cand.slip;
  delete cand.fix;
  if (cand.stat.tone === 'watch') cand.stat.tone = 'neutral';
  return cand;
}

function volumeCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const rp = reviewPlans(input);
  if (rp.plan != null) return planVolumeCandidate(input, rp);
  const inWeek = (w: Week) => input.workouts.filter(x => w.set.has(x.day));
  const sum = (ws: WeeklyReviewWorkout[], pick: (w: WeeklyReviewWorkout) => number | null): number | null => {
    const vals = ws.map(pick).filter((v): v is number => v != null && Number.isFinite(v));
    return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
  };
  const cur = inWeek(week);
  const prev = inWeek(prevWeek);
  // With a weekly distance target the km shown is the number measured against
  // it: running only (like the goal card and weekRating), not a ride or a hike.
  const runningOnly = hasDistanceTarget(input);
  const kmOf = (w: WeeklyReviewWorkout): number | null => (runningOnly && !isRunningWorkoutType(w.type) ? null : w.distanceKm);
  const curKm = sum(cur, kmOf);
  const useKm = curKm != null && curKm > 0;
  const curVal = useKm ? curKm : sum(cur, w => w.durationMin);
  if (curVal == null || curVal <= 0) return null;
  const prevVal = useKm ? sum(prev, kmOf) : sum(prev, w => w.durationMin);
  const fmt = (v: number): string => (useKm ? distanceText(input, v) : withUnit(Math.round(v), 'min'));
  let comparison: string | null = null;
  let tone: ReviewTone = 'neutral';
  const cand: Candidate = { stat: { label: 'Volume', value: fmt(curVal), comparison, tone } };
  if (prevVal != null && prevVal > 0) {
    const pct = Math.round(((curVal - prevVal) / prevVal) * 100);
    comparison = pct === 0 ? 'same as last week' : `${signed(pct, `${Math.abs(pct)}%`)} vs last week`;
    if (pct >= 5) { tone = 'good'; cand.win = `Training volume is up ${pct}% on last week (${arrowPair(fmt(prevVal), fmt(curVal))}).`; }
    else if (pct <= -25) { tone = 'watch'; cand.slip = `Training volume fell ${Math.abs(pct)}% from last week (${arrowPair(fmt(prevVal), fmt(curVal))}).`; cand.fix = `Rebuild toward ${fmt(prevVal)} — add one easy session early in the week.`; }
  }
  cand.stat.comparison = comparison ?? 'for the week';
  cand.stat.tone = tone;
  // Less running is the point of a taper / race / recovery week: no "volume fell" slip, no "volume is up" win.
  return easeForWindDown(input, week, cand, true);
}

function restingHrCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const pick = (w: Week) => input.restingHr.filter(p => w.set.has(p.day)).map(p => p.value);
  const cur = pick(week);
  if (cur.length < MIN_HR_DAYS) return null;
  const avg = mean(cur) as number;
  const prev = pick(prevWeek);
  let comparison: string | null = null;
  let tone: ReviewTone = 'neutral';
  const cand: Candidate = { stat: { label: 'Resting HR', value: withUnit(Math.round(avg), 'bpm'), comparison, tone } };
  if (prev.length >= MIN_HR_DAYS) {
    const diff = Math.round(avg - (mean(prev) as number));
    comparison = diff === 0 ? 'same as last week' : `${signed(diff, withUnit(Math.abs(diff), 'bpm'))} vs last week`;
    if (diff <= -1) { tone = 'good'; cand.win = `Resting heart rate dropped ${withUnit(Math.abs(diff), 'bpm')} — a sign recovery is keeping up.`; }
    else if (diff >= 3) { tone = 'watch'; cand.slip = `Resting heart rate rose ${withUnit(diff, 'bpm')} — your body may be carrying fatigue.`; cand.fix = 'Make one session an easy one — resting heart rate rose last week.'; }
  }
  cand.stat.comparison = comparison ?? 'week avg';
  cand.stat.tone = tone;
  return cand;
}

function sleepNights(input: WeeklyReviewInput, week: Week): number[] {
  return input.sleepMinutes.filter(p => week.set.has(p.day) && p.value > 0).map(p => p.value);
}

function sleepAvgCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  const nights = sleepNights(input, week);
  if (nights.length < MIN_SLEEP_NIGHTS) return null;
  const avg = mean(nights) as number;
  const goal = input.sleepGoalMinutes;
  const tone: ReviewTone = avg >= goal * SLEEP_GOAL_FRACTION ? 'good' : avg < goal * 0.8 ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: { label: 'Avg sleep', value: fmtDuration(avg), comparison: `week avg · goal ${fmtDuration(goal)}`, tone },
  };
  if (tone === 'good') cand.win = `You averaged ${fmtDuration(avg)} of sleep, close to your ${fmtDuration(goal)} goal.`;
  if (tone === 'watch') {
    cand.slip = `You averaged ${fmtDuration(avg)} of sleep against a ${fmtDuration(goal)} goal.`;
    cand.fix = `Move bedtime 30 minutes earlier and keep it there all week.`;
  }
  return cand;
}

function sleepGoalNightsCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  const nights = sleepNights(input, week);
  if (nights.length < MIN_SLEEP_NIGHTS) return null;
  const hit = nights.filter(n => n >= input.sleepGoalMinutes * SLEEP_GOAL_FRACTION).length;
  const frac = hit / nights.length;
  const tone: ReviewTone = frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: {
      label: 'Sleep-goal nights',
      value: `${hit}/${nights.length}`,
      comparison: nights.length < 7 ? `${nights.length} ${plural(nights.length, 'night')} tracked` : 'across the week',
      tone,
    },
  };
  if (tone === 'good') cand.win = `You met your sleep goal on ${hit} of ${nights.length} tracked nights.`;
  if (tone === 'watch') {
    cand.slip = `You met your sleep goal on only ${hit} of ${nights.length} tracked nights.`;
    cand.fix = `Set a nightly wind-down alarm an hour before bed.`;
  }
  return cand;
}

function loggingDaysCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  const logged = loggedIntake(input.intakeDays, week).length;
  if (logged === 0) return null;
  const tone: ReviewTone = logged >= 5 ? 'good' : logged <= 2 ? 'watch' : 'neutral';
  const cand: Candidate = { stat: { label: 'Logging days', value: `${logged}/7`, comparison: 'across the week', tone } };
  if (tone === 'good') cand.win = `You logged food on ${logged} of 7 days.`;
  if (tone === 'watch') {
    cand.slip = `You logged food on only ${logged} of 7 days.`;
    cand.fix = `Log meals on ${Math.min(7, logged + 2)} days — it takes under a minute per meal.`;
  }
  return cand;
}

/** Weekend (Sat+Sun) average intake vs weekday average, this week only. */
function weekendGap(input: WeeklyReviewInput, week: Week): number | null {
  const logged = loggedIntake(input.intakeDays, week);
  const weekend = logged.filter(d => d.day === week.days[5] || d.day === week.days[6]).map(d => d.kcal as number);
  const weekday = logged.filter(d => d.day !== week.days[5] && d.day !== week.days[6]).map(d => d.kcal as number);
  if (weekend.length === 0 || weekday.length < MIN_INTAKE_DAYS) return null;
  return Math.round((mean(weekend) as number) - (mean(weekday) as number));
}

// ── Week rating ─────────────────────────────────────────────────────────────

/**
 * `weekRating` answers "how did THIS week go?" from this week's own numbers
 * only. It deliberately ignores `verdict`, which is the 4-week goal verdict as
 * of the reviewed week ("Sessions behind" can sit next to a perfectly good
 * week). One level per goal, a single modifier may pull it down one level:
 *
 *  - muscle:      sessions vs the weekly target (>= target good, target - 1
 *                 mixed, fewer tough; 0 sessions is always tough). Protein
 *                 hit on under half of the logged days pulls it down a level.
 *                 No weekly sessions target -> null.
 *  - weight_loss: in-budget share of logged days (>= 5/7 good, >= 3/7 mixed,
 *                 else tough; needs 3+ logged days). The weight-trend stat
 *                 moving the wrong way (or losing too fast) pulls it down a
 *                 level. With no usable budget days the weight direction
 *                 alone rates it (down at a sane pace good, otherwise mixed).
 *                 "Too fast" and "wrong way" are the goal card's calls (its
 *                 verdict: the 21-day pace), never one week-to-week move in the
 *                 weekly mean, and the weight alone never makes a week tough.
 *  - endurance:   the week against ITS plan (lib/enduranceProgression.ts
 *                 `enduranceWeekPlan`, the same plan the goal card shows while
 *                 the week is under way; the race phase is read on the week's
 *                 Monday). Build / maintain / hold / restart / rebuild weeks:
 *                 >= 90% of the week's target good, >= 60% mixed, else tough
 *                 (restart: 60% / 30%; rebuild and the comeback weeks after a
 *                 restart: 80% / 50%). The target is the week's safe step (~10%
 *                 over the week before, never past the goal), one step up from
 *                 the step after a jump (hold), a share of the pre-break median
 *                 week after a break (restart: ~75% after 8-14 days, ~55% after
 *                 more, last week's target after 7), then the climb back. A SPIKE — km more than 30% AND at
 *                 least 3 km (2 mi) above the target — is never "on plan": it
 *                 rates mixed (safety, not praise) with its own gap. The first
 *                 week of running (baseline) has no target and is rated on
 *                 consistency: 3+ runs good, never tough. A week with no run at
 *                 all, or a short one that ended in a break, is 'light' — rest is
 *                 fine. A tough sessions count (vs the sessions target) pulls a
 *                 build-type week down a level. Without a distance target (or any
 *                 measured distance) the sessions rating is used; neither -> null.
 *                 A TAPER / RACE-WEEK / RECOVERY week is graded against that
 *                 phase's own target instead (the shared `windDownBand`): sessions
 *                 never pull it down.
 *                 Wave 21e: a CUTBACK week (every 4th calendar week of building,
 *                 ~80% of the week it replaces, long run held) is graded as its own
 *                 target and is never short ("Cutback week: ~24 km, long run 14 km -
 *                 absorb the last three weeks" names it in "Next week"); a jump in
 *                 one is read against the week it replaced. A careful comeback week
 *                 (its target is a ceiling, "Build up to ~18 km") is good when it
 *                 grew on the week before and mixed only when it shrank. The last
 *                 2 build weeks before a taper add "plus 4-6 strides after one
 *                 easy run". Starting a taper early is a win line, never a slip.
 *  - general:     active days (3+ good, 2 mixed, else tough).
 *  - 'light' (muscle): a deliberate lighter week (the shared isDeloadWeek:
 *    logged volume under 75% of the prior 3 weeks' average, or every top set
 *    at or under 90% of its 4-week best) while the user still trained and did
 *    not miss the sessions target by more than one. A missed week is not a
 *    deload.
 *
 * `null` = the week's own stats can't support a rating (never invented). The
 * payload is stored JSON, so rows written before this field existed lack it.
 *
 * The same pass yields `weekGap` — WHAT pulled the week below "good" (sessions
 * short, distance short, days out of budget, low protein days, weight moving
 * the wrong way). The rating, the Slip line and "Next week" are all decided
 * from that one assessment, so the pill can never say "Mixed week" next to a
 * Slip that names something else and a "Repeat this week" that ignores it.
 */
type RatingLevel = 'tough' | 'mixed' | 'good';
const RATING_LEVELS: readonly RatingLevel[] = ['tough', 'mixed', 'good'];

/** Weight loss: share of logged days within budget — 5 of 7 (or the equivalent share) is good, 3 of 7 mixed. */
const BUDGET_GOOD_DAYS_OF_7 = 5;
const BUDGET_MIXED_DAYS_OF_7 = 3;
/** Muscle: protein hit on a smaller share of logged days than this pulls the week down a level. */
const PROTEIN_LOW_FRACTION = 0.5;
/** General goal: active days per week for good / mixed. */
const GENERAL_GOOD_ACTIVE_DAYS = 3;
const GENERAL_MIXED_ACTIVE_DAYS = 2;

function levelDown(level: RatingLevel): RatingLevel {
  return RATING_LEVELS[Math.max(0, RATING_LEVELS.indexOf(level) - 1)];
}

/** Sessions done vs the weekly target. Null without a target. */
function sessionsLevel(count: number, target: number | null | undefined): RatingLevel | null {
  if (target == null || target <= 0) return null;
  if (count >= target) return 'good';
  return count >= target - 1 && count >= 1 ? 'mixed' : 'tough';
}

/** A deliberate lighter week: the shared deload rule (lib/liftChange.ts isDeloadWeek: volume under 75% of the prior 3 weeks, or every top set at or under 90% of its 4-week best). No logged sets this week is "no data", not a deload. */
function isLighterWeek(input: WeeklyReviewInput, week: Week): boolean {
  return isDeloadWeek(input.progression, week.days[0]);
}

/** Total finite running distance (km) in the week; null when no run carries a distance. */
function runningKm(input: WeeklyReviewInput, week: Week): number | null {
  const vals = input.workouts
    .filter(w => week.set.has(w.day) && isRunningWorkoutType(w.type) && w.distanceKm != null && Number.isFinite(w.distanceKm))
    .map(w => w.distanceKm as number);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

/** A week's rating plus the gap that kept it from "good" (null for good / light / unrated). */
interface WeekAssessment {
  rating: WeekRating | null;
  gap: WeekGap | null;
}

const UNRATED: WeekAssessment = { rating: null, gap: null };

/** Rating `level` with `gap` only when the level is not good. */
function rated(level: RatingLevel, gap: WeekGap | null): WeekAssessment {
  return { rating: level, gap: level === 'good' ? null : gap };
}

function muscleWeekAssessment(input: WeeklyReviewInput, week: Week): WeekAssessment {
  const count = weekSessionCount(input, week);
  const target = input.weeklySessionsTarget;
  const sessions = sessionsLevel(count, target);
  // Coming back from a break is a rebuild, not a deload (its lighter loads are not "as planned").
  if (count > 0 && sessions !== 'tough' && !input.liftReturn && isLighterWeek(input, week)) return { rating: 'light', gap: null };
  if (sessions == null || target == null) return UNRATED;
  const protein = proteinDays(input, week);
  const proteinLow = protein != null && protein.hit / protein.logged < PROTEIN_LOW_FRACTION;
  // Missing sessions is the gap when there is one; low protein only when every planned session happened.
  const gap: WeekGap | null = count < target
    ? { kind: 'sessions', done: count, target }
    : proteinLow && protein ? { kind: 'protein', hit: protein.hit, logged: protein.logged } : null;
  return rated(proteinLow ? levelDown(sessions) : sessions, gap);
}

function weightGap(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekGap | null {
  const change = weightChange(input, week, prevWeek);
  return change ? { kind: 'weight', deltaKg: Math.round(change.deltaKg * 100) / 100 } : null;
}

function weightLossWeekAssessment(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekAssessment {
  // The target is reached: the week it was reached is a good week, and so is one spent holding there. Only drifting
  // well under the target is not (the deficit should have stopped). Calories in budget no longer rate the week.
  const reached = reachedWeek(input, week);
  if (reached) {
    return reached.thisWeek || !isUnderTarget(reached) ? { rating: 'good', gap: null } : rated('mixed', weightGap(input, week, prevWeek));
  }
  const days = budgetDays(input, week);
  const weightTone = weightCandidate(input, week, prevWeek)?.stat.tone ?? null;
  // The weight flag is a too-fast loss when the scale fell: then the weight, not the budget days, is the gap.
  const tooFast = weightTone === 'watch' && (weightChange(input, week, prevWeek)?.deltaKg ?? 0) < 0;
  if (days) {
    const level: RatingLevel =
      days.hit * 7 >= days.logged * BUDGET_GOOD_DAYS_OF_7 ? 'good'
      : days.hit * 7 >= days.logged * BUDGET_MIXED_DAYS_OF_7 ? 'mixed'
      : 'tough';
    // Budget days are the gap while they fall short — unless the weight flag (losing too fast) is what pulled the week
    // down, and the weight trend when it alone pulled a good budget week down.
    const gap: WeekGap | null = level !== 'good' && !tooFast ? { kind: 'budget', inBudget: days.hit, logged: days.logged } : weightGap(input, week, prevWeek);
    // A too-fast loss (the card's call) lowers a good week to mixed, never further: the budget days already rate the rest.
    const lowered = weightTone !== 'watch' ? level : tooFast && level !== 'good' ? level : levelDown(level);
    return rated(lowered, gap);
  }
  if (weightTone == null) return UNRATED;
  // The weight alone never makes a week tough: a flag from the card is a mixed week, a loss at a sane pace a good one.
  return rated(weightTone === 'good' ? 'good' : 'mixed', weightGap(input, week, prevWeek));
}

/**
 * The week's running km as a wind-down week counts it: the race itself is not
 * part of race week's volume (its target excludes the race), so runs on race
 * day are left out. Null when no run carries a distance.
 */
function windDownRunningKm(input: WeeklyReviewInput, week: Week, plan: WindDownPlan): number | null {
  const vals = input.workouts
    .filter(w => week.set.has(w.day) && isRunningWorkoutType(w.type) && w.distanceKm != null && Number.isFinite(w.distanceKm))
    .filter(w => !(plan.phase === 'race_week' && w.day === input.raceDate))
    .map(w => w.distanceKm as number);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

/** A half marathon is tapered from 14 days out; runners often start a week early. */
const EARLY_TAPER_DAYS = 21;
/** Early tapering is only "fine" when the week still held at least this share of its target. */
const EARLY_TAPER_MIN_SHARE = 0.5;

/**
 * True for a short build / maintain week inside the 21 days before a half marathon, before the formal taper: the
 * runner started easing off early — fine, not a miss. Needs the week to have run at least half its target.
 */
function startedTaperingEarly(input: WeeklyReviewInput, rp: ReviewPlans): boolean {
  const plan = rp.plan;
  if (plan == null || input.raceDate == null || raceClass(input.raceDistanceKm) !== 'half') return false;
  if (plan.kind !== 'build' && plan.kind !== 'maintain') return false;
  const toRace = Math.round((Date.parse(`${input.raceDate}T00:00:00Z`) - Date.parse(`${input.weekStart}T00:00:00Z`)) / 86_400_000);
  if (!(toRace > 14 && toRace <= EARLY_TAPER_DAYS)) return false;
  const target = plan.targetKm as number;
  const grade = gradeEnduranceWeek(plan, rp.week.km, { runDays: rp.week.days, unitsPerKm: unitsPerKmOf(input) });
  return grade.gap === 'short' && rp.week.km >= target * EARLY_TAPER_MIN_SHARE;
}

/**
 * The ceiling (km) a recovery / race week that ran a little over its target may be called "right at": the stated
 * target itself, within the shared 10% slack. Null when the week is not over the target as the reader sees it, or is
 * over by more than the slack.
 */
function ceilingSlack(input: WeeklyReviewInput, km: number, targetKm: number): number | null {
  if (distanceNumber(input, km) <= distanceNumber(input, targetKm)) return null;
  if (km > targetKm * PHASE_CEILING_TOLERANCE) return null;
  // The stated ceiling stays the stated ceiling: "≤ 7 mi" in "Next week" is "right at your ~7 mi ceiling" in the recap.
  return targetKm;
}

/**
 * Endurance with a weekly distance target and measured running: the week is
 * graded against ITS plan (lib/enduranceProgression.ts `enduranceWeekPlan`, the
 * same plan the goal card shows while the week is under way) with the plan's own
 * band:
 *  - baseline (first week of running): rated on consistency, 3+ run days is
 *    good, never tough — there is no step to measure against yet;
 *  - build / maintain / hold / restart / rebuild: the week's safe step (or the
 *    hold / restart number): >= 90% good (restart: 60%, rebuild / comeback: 80%),
 *    >= 60% mixed (restart: 30%, rebuild / comeback: 50%), else tough; a jump (30% and 3 km / 2 mi over the step) is mixed, with
 *    its own gap — safety, not praise; a tough sessions count pulls a build-type
 *    week down a level;
 *  - taper / race week / recovery: the phase's own target with the shared
 *    `windDownBand`; sessions never pull these weeks down;
 *  - a week with no run at all, or a short week that ended in a break (illness,
 *    travel): 'light' — rest is fine — and never a slip.
 */
function planWeekAssessment(input: WeeklyReviewInput, week: Week, rp: ReviewPlans): WeekAssessment {
  const plan = rp.plan as EnduranceWeekPlan;
  const km = rp.week.km;
  const grade = gradeEnduranceWeek(plan, km, { runDays: rp.week.days, unitsPerKm: unitsPerKmOf(input) });
  if (grade.level === 'light') return { rating: 'light', gap: null };
  // The week the race was run is never rated down for the km around it: the race is the week.
  if (rp.raceRun != null && plan.kind === 'race_week') return { rating: 'good', gap: null };
  // A short week in the 21 days before a half is the taper starting early: fine, not a miss.
  if (startedTaperingEarly(input, rp)) return { rating: 'good', gap: null };
  const goal = plan.goalKm;
  const stepped = plan.targetKm != null && plan.targetKm < goal;
  let gap: WeekGap | null = null;
  if (grade.gap === 'spike') gap = { kind: 'spike', doneKm: round1(km), stepKm: plan.targetKm as number, targetKm: goal };
  else if (grade.gap === 'short') {
    gap = plan.kind === 'baseline'
      ? { kind: 'sessions', done: rp.week.days, target: BASELINE_GOOD_RUN_DAYS }
      : {
          kind: 'distance', doneKm: round1(km), targetKm: goal,
          ...(stepped ? { stepKm: plan.targetKm as number } : {}),
          ...(plan.comeback != null ? { comebackFromKm: round1(rp.prevWeek.km) } : {}),
        };
  } else if (grade.gap === 'over' || grade.gap === 'under') {
    gap = { kind: 'phase', phase: plan.kind as 'taper' | 'race_week' | 'recovery', doneKm: round1(km), targetKm: plan.targetKm as number, over: grade.gap === 'over' };
  }
  const level: RatingLevel = grade.level;
  // A tough sessions count (vs the sessions target) pulls a build-type week down a level; it is the gap only when distance alone was fine.
  if (!isWindDownKind(plan.kind) && plan.kind !== 'baseline') {
    const sessionsTarget = input.weeklySessionsTarget;
    const count = weekSessionCount(input, week);
    if (sessionsLevel(count, sessionsTarget) === 'tough') {
      const sessionsGap: WeekGap | null = sessionsTarget != null && count < sessionsTarget ? { kind: 'sessions', done: count, target: sessionsTarget } : null;
      return rated(levelDown(level), gap ?? sessionsGap);
    }
  }
  return rated(level, gap);
}

function enduranceWeekAssessment(input: WeeklyReviewInput, week: Week): WeekAssessment {
  const rp = reviewPlans(input);
  if (rp.plan != null) return planWeekAssessment(input, week, rp);
  // A taper / race / recovery week is never rated on its session count (fewer sessions are the plan): with no measured running it is unrated.
  if (windDownPlan(input, week.days[0]) != null) return UNRATED;
  const count = weekSessionCount(input, week);
  const sessionsTarget = input.weeklySessionsTarget;
  const sessions = sessionsLevel(count, sessionsTarget);
  const sessionsGap: WeekGap | null = sessionsTarget != null && count < sessionsTarget ? { kind: 'sessions', done: count, target: sessionsTarget } : null;
  return sessions == null ? UNRATED : rated(sessions, sessionsGap);
}

function generalWeekAssessment(input: WeeklyReviewInput, week: Week): WeekAssessment {
  const active = weekSessionCount(input, week);
  const level: RatingLevel = active >= GENERAL_GOOD_ACTIVE_DAYS ? 'good' : active >= GENERAL_MIXED_ACTIVE_DAYS ? 'mixed' : 'tough';
  return rated(level, { kind: 'activeDays', done: active, target: GENERAL_GOOD_ACTIVE_DAYS });
}

function assessWeek(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekAssessment {
  switch (input.goal) {
    case 'muscle': return muscleWeekAssessment(input, week);
    case 'weight_loss': return weightLossWeekAssessment(input, week, prevWeek);
    case 'endurance': return enduranceWeekAssessment(input, week);
    default: return generalWeekAssessment(input, week);
  }
}

// ── Assembly ────────────────────────────────────────────────────────────────

function buildCandidates(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate[] {
  const c = {
    weight: () => weightCandidate(input, week, prevWeek),
    budget: () => budgetCandidate(input, week),
    avgKcal: () => avgKcalCandidate(input, week, prevWeek),
    sessions: () => sessionsCandidate(input, week, prevWeek),
    protein: () => proteinCandidate(input, week),
    lift: () => liftCandidate(input, week),
    volume: () => volumeCandidate(input, week, prevWeek),
    rhr: () => restingHrCandidate(input, week, prevWeek),
    sleepAvg: () => sleepAvgCandidate(input, week),
    sleepNights: () => sleepGoalNightsCandidate(input, week),
    logging: () => loggingDaysCandidate(input, week),
  };
  let order: Array<keyof typeof c>;
  switch (input.goal) {
    case 'weight_loss': order = reachedWeek(input, week) ? ['weight', 'avgKcal', 'sessions'] : ['weight', 'budget', 'avgKcal', 'sessions']; break;
    case 'muscle': order = ['sessions', 'lift', 'protein', 'weight']; break;
    case 'endurance': order = ['sessions', 'volume', 'rhr', 'sleepAvg']; break;
    default: order = ['sessions', 'sleepNights', 'logging']; break;
  }
  return order.map(k => c[k]()).filter((x): x is Candidate => x != null).slice(0, MAX_REVIEW_STATS);
}

function countDataDays(input: WeeklyReviewInput, week: Week): number {
  const days = new Set<string>();
  for (const d of loggedIntake(input.intakeDays, week)) days.add(d.day);
  for (const r of input.weightReadings) if (week.eligible.has(r.localDay)) days.add(r.localDay);
  for (const d of input.trainingDays) if (week.eligible.has(d)) days.add(d);
  for (const w of input.workouts) if (week.eligible.has(w.day)) days.add(w.day);
  for (const p of input.sleepMinutes) if (week.eligible.has(p.day) && p.value > 0) days.add(p.day);
  for (const p of input.restingHr) if (week.eligible.has(p.day)) days.add(p.day);
  return days.size;
}

/** "logged " / "tracked " when the stat's denominator is a partial week, else "". */
function loggedWord(stat: WeeklyReviewStat, word = 'logged '): string {
  return stat.comparison != null && /\d+ (days? logged|nights? tracked)/.test(stat.comparison) ? word : '';
}

/**
 * "24.5 of 30 km" — or, when the week's safe step was below the goal and the
 * goal wasn't reached, the step it was graded against with the goal beside it:
 * "24.5 of ~24 km — on plan · goal 30 km" (met the step) / "21 of ~24 km · goal
 * 30 km" (short of it); a jump far over the step says so ("20 of ~8 km — well
 * above the safe step · goal 30 km"). "On plan" compares the numbers as the
 * reader sees them.
 */
function distanceHeadline(
  input: WeeklyReviewInput, km: number, targetKm: number, stepKm: number,
  opts: { spike: boolean; cutback?: boolean; upTo?: boolean; overCap?: boolean },
): string {
  if (opts.spike) {
    return `${distanceNumber(input, km)} of ~${distanceText(input, stepKm)} — well above the safe step · goal ${distanceText(input, targetKm)}`;
  }
  if (stepKm >= targetKm || km >= targetKm) return `${distanceNumber(input, km)} of ${distanceText(input, targetKm)}`;
  // A comeback's target is a ceiling ("up to ~18 km"), worded so on the goal card too.
  const target = `${opts.upTo ? 'up to ' : ''}~${distanceText(input, stepKm)}`;
  // ... and passed by more than 10% it is said neutrally, as the card says it (never "on plan").
  if (opts.overCap) return `${distanceNumber(input, km)} of ${target} — ${overCapPhrase(stepKm, km)} · goal ${distanceText(input, targetKm)}`;
  const onPlan = distanceNumber(input, km) >= distanceNumber(input, stepKm);
  // Over the step but under the spike line is above the step, not "on plan" (a +33% week is not on a 10% plan).
  const note = onPlan ? (km > stepKm * ABOVE_STEP_FRACTION ? (opts.cutback ? ' — above the cutback' : ' — above the step') : ' — on plan') : '';
  return `${distanceNumber(input, km)} of ${target}${note} · goal ${distanceText(input, targetKm)}`;
}

/** "21 of ~24 km — taper week" / "12 of ~16 km before the race — race week" / "9 of up to 16 km — recovery week". */
function windDownHeadline(input: WeeklyReviewInput, phase: WindDownPlan['phase'], km: number, targetKm: number): string {
  const done = distanceNumber(input, km);
  const target = distanceText(input, targetKm);
  switch (phase) {
    case 'taper': return `${done} of ~${target} — taper week`;
    case 'race_week': return `${done} of ~${target} before the race — race week`;
    case 'recovery': {
      // A little over the ceiling, inside its 10% slack: "right at" it, not "7.5 of up to 7 mi".
      const slack = ceilingSlack(input, km, targetKm);
      return slack != null
        ? `${distanceText(input, km)}, right at your ~${distanceText(input, slack)} ceiling — recovery week`
        : `${done} of up to ${target} — recovery week`;
    }
  }
}

/** The Win line of a weight-loss week at a reached target: the reach itself, then a weight that holds inside the target range. */
function reachedWin(input: WeeklyReviewInput, week: Week): string | null {
  const r = reachedWeek(input, week);
  if (r == null || r.meanKg == null) return null;
  if (r.thisWeek) {
    // The average, as the card says it: its distance from the target when it is not on it ("weekly average within 0.3 kg of it").
    const off = r.targetKg != null ? round1(Math.abs(r.meanKg - r.targetKg)) : 0;
    const avg = off >= 0.1 ? `weekly average within ${weightText(input, off)} of it` : `weekly average ${weightTextFixed(input, r.meanKg)}`;
    return r.targetKg != null
      ? `You reached your ${weightText(input, r.targetKg)} target — ${avg}.`
      : `You reached your target — weekly average ${weightTextFixed(input, r.meanKg)}.`;
  }
  if (isUnderTarget(r)) return null;
  // Exactly on the target "Holding at 84.0 kg, within 1 kg of 84 kg" says it twice.
  if (onTarget(r)) return `Holding at your ${weightText(input, r.targetKg as number)} target.`;
  return r.targetKg != null
    ? `Holding at ${weightTextFixed(input, r.meanKg)}, within ${weightText(input, HOLDING_RANGE_KG)} of ${weightText(input, r.targetKg)}.`
    : `Holding at ${weightTextFixed(input, r.meanKg)}.`;
}

/** The Win line of a taper / race / recovery week that stayed on its plan; null otherwise. */
function windDownWin(input: WeeklyReviewInput, week: Week, assessment: WeekAssessment): string | null {
  const plan = windDownPlan(input, week.days[0]);
  if (assessment.rating !== 'good' || plan == null || plan.targetKm == null || !hasDistanceTarget(input)) return null;
  const km = distanceText(input, windDownRunningKm(input, week, plan) ?? 0);
  const target = distanceText(input, plan.targetKm);
  if (plan.phase === 'recovery' && (windDownRunningKm(input, week, plan) ?? 0) <= 0) return 'You rested through your recovery week — exactly right.';
  switch (plan.phase) {
    case 'taper': return `Taper on plan: ${km} against a ~${target} target.`;
    case 'race_week': return `Race week stayed light: ${km} before the race.`;
    case 'recovery': {
      const ran = windDownRunningKm(input, week, plan) ?? 0;
      const slack = ceilingSlack(input, ran, plan.targetKm);
      return slack != null
        ? `Recovery week kept easy: ${km}, right at your ~${distanceText(input, slack)} ceiling.`
        : `Recovery week kept easy: ${km} (ceiling ${target}).`;
    }
  }
}

/** "the half marathon" / "the marathon" / "the 10K" / "the race" for the race's own label. */
function raceNounPhrase(label: string): string {
  return `the ${/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label}`;
}

/**
 * The headline of a week whose story is not "x of y km": the first week of
 * running ("Baseline week: 15 km in 4 runs"), a rest week ("No runs this week —
 * rest is fine") and the week the race was run ("Raced the half marathon —
 * 21.1 km, after 12 km in race week"). Null otherwise (the usual headline).
 */
function standaloneEnduranceHeadline(input: WeeklyReviewInput): string | null {
  const rp = reviewPlans(input);
  const plan = rp.plan;
  if (plan == null) return null;
  const raceRun = rp.raceRun;
  if (raceRun != null) {
    const label = raceLabel(input.raceDistanceKm ?? null, input.unitSystem);
    // The race leads. Race-week volume is a footnote and only when it was a plain fact (inside the plan), never a dig.
    const planKm = plan.targetKm;
    const insidePlan = planKm == null || rp.week.km <= planKm * PHASE_CEILING_TOLERANCE;
    const before = rp.week.km > 0 && insidePlan ? `, after ${distanceText(input, rp.week.km)} in race week` : '';
    return `Raced ${raceNounPhrase(label)} — ${distanceText(input, raceRun.km)}${before}`;
  }
  if (plan.kind === 'baseline') {
    return `Baseline week: ${distanceText(input, rp.week.km)} in ${rp.week.days} ${plural(rp.week.days, 'run')}`;
  }
  if (rp.week.km <= 0 && !(isWindDownKind(plan.kind) && plan.kind !== 'recovery')) {
    return plan.kind === 'recovery' ? 'No runs in your recovery week — rest is fine' : 'No runs this week — rest is fine';
  }
  // A short week that ended in a break (illness, travel) is a lighter week: say what happened, not "6 of 30 km".
  if (plan.endedOff && !isWindDownKind(plan.kind) && gradeEnduranceWeek(plan, rp.week.km, { runDays: rp.week.days, unitsPerKm: unitsPerKmOf(input) }).level === 'light') {
    return `${distanceText(input, rp.week.km)} this week, then ${plan.daysSinceRun} days off`;
  }
  return null;
}

/**
 * The Win line of an endurance week with a plan: the race itself when it was run
 * ("You ran the half marathon — 21.1 km"), else — for a week that stayed on its
 * plan — what the plan asked for. Never "volume is up" on a jump, never praise
 * for growth the plan did not ask for. Taper / race / recovery weeks have their
 * own line (`windDownWin`). Null otherwise.
 */
function enduranceWin(input: WeeklyReviewInput, assessment: WeekAssessment): string | null {
  const rp = reviewPlans(input);
  const plan = rp.plan;
  if (plan == null) return null;
  if (rp.raceRun != null) {
    return `You ran ${raceNounPhrase(raceLabel(input.raceDistanceKm ?? null, input.unitSystem))} — ${distanceText(input, rp.raceRun.km)}.`;
  }
  if (assessment.rating !== 'good' || isWindDownKind(plan.kind)) return null;
  // Easing off early before a half is fine, and said as a win (a neutral note), never as a slip.
  if (startedTaperingEarly(input, rp)) return 'Started tapering early — fine.';
  const km = distanceText(input, rp.week.km);
  const u = unitsPerKmOf(input);
  const compareMin = u < 1 ? MIN_COMPARE_MI / u : MIN_COMPARE_KM;
  const pct = rp.prevWeek.km >= compareMin ? Math.round(((rp.week.km - rp.prevWeek.km) / rp.prevWeek.km) * 100) : null;
  // A cutback week is for absorbing the last three: done when the running stayed near its lowered number.
  if (plan.cutback != null) {
    return rp.week.km <= (plan.targetKm as number) * PHASE_CEILING_TOLERANCE
      ? `Cutback week done: ${km} — the last three weeks have time to settle in.`
      : null;
  }
  // A comeback week that went more than 10% over its "up to" ceiling is not praised for the extra (the headline says it).
  if (overUpToCap(plan, rp.week.km)) return null;
  // A careful comeback week is good when it grew on the one before; its target is a ceiling, not a bar it missed.
  if (plan.comeback != null && rp.prevWeek.km > 0 && rp.week.km >= rp.prevWeek.km && rp.week.km < plan.goalKm) {
    return `Back on the way up: ${km}, up from ${distanceText(input, rp.prevWeek.km)} last week.`;
  }
  switch (plan.kind) {
    case 'hold': return "Held back after last week's jump — exactly right.";
    case 'baseline': return `Baseline set: ${km} in ${rp.week.days} ${plural(rp.week.days, 'run')} — next week's step builds from it.`;
    case 'restart': return `Back out there: ${km} after the break.`;
    case 'maintain': {
      // "Held" only when the goal was run; a week short of it at its rounded reading is close, not held.
      const ran = distanceNumber(input, rp.week.km);
      const goal = distanceNumber(input, plan.goalKm);
      if (ran < goal) {
        // "Again" only when next week asks for the same number.
        const again = rp.next?.targetKm != null && distanceNumber(input, rp.next.targetKm) === goal ? ` — aim for ${goal} again` : '';
        return `Close to your weekly goal: ${ran} of ${distanceText(input, plan.goalKm)}${again}.`;
      }
      return plan.goalReachedBefore
        ? `You held your weekly goal: ${ran} of ${distanceText(input, plan.goalKm)}.`
        : `You reached your weekly goal: ${ran} of ${distanceText(input, plan.goalKm)}.`;
    }
    default: {
      // Reaching the weekly goal itself is the win, even when the step was lower.
      if (rp.week.km >= plan.goalKm) return `You reached your weekly goal: ${distanceNumber(input, rp.week.km)} of ${distanceText(input, plan.goalKm)}.`;
      // A week well above its step is not praised for the extra.
      if (plan.targetKm != null && rp.week.km > plan.targetKm * ABOVE_STEP_FRACTION) return null;
      const target = plan.targetKm as number;
      // "Hit" is the rounded reading reaching the step; 20 of ~22 km is close, and says what to aim for.
      if (distanceNumber(input, rp.week.km) < distanceNumber(input, target)) {
        // "Again" only when next week asks for the same step; a climb back after a break asks for more.
        const again = rp.next?.targetKm != null && distanceNumber(input, rp.next.targetKm) === distanceNumber(input, target) ? ` — aim for ~${distanceNumber(input, target)} again` : '';
        return `Close to your step: ${distanceNumber(input, rp.week.km)} of ~${distanceText(input, target)}${again}.`;
      }
      return `You hit this week's step: ${distanceNumber(input, rp.week.km)} of ~${distanceText(input, target)}${pct != null && pct !== 0 ? ` (${signed(pct, `${Math.abs(pct)}%`)} on last week)` : ''}.`;
    }
  }
}

/**
 * The building-back / back-above part of the headline: the 142 is an estimated
 * 1RM, and it is said so. With some lifts back and one not it names both
 * ("Squat back above pre-break; deadlift at 98%"); "back above" is said of the
 * headline lift alone only when every lift is.
 */
function returnHeadlinePart(input: WeeklyReviewInput): string {
  const rets = returnsOf(input);
  const mixed = mixedReturnLead(rets, input.exerciseDisplay, isImperial(input));
  if (mixed) return mixed.text;
  const ret = rets[0];
  const { pre, recent, unit } = liftReturnDisplay(ret, isImperial(input));
  const name = liftDisplayName(ret.exercise, input.exerciseDisplay);
  if (furthestBehindReturn(rets) != null) return `${name} est. 1RM ${recent} of ${withUnit(pre, unit)} pre-break`;
  const above = rets.every(r => { const n = liftReturnDisplay(r, isImperial(input)); return n.recent > n.pre; });
  return above ? `${name} est. 1RM back above pre-break ${withUnit(pre, unit)}` : `${name} est. 1RM back at pre-break best`;
}

function buildHeadline(input: WeeklyReviewInput, cands: Candidate[], week: Week): string {
  const standalone = input.goal === 'endurance' ? standaloneEnduranceHeadline(input) : null;
  if (standalone != null) return clipHeadline(standalone);
  const by = (label: string): WeeklyReviewStat | undefined => cands.find(x => x.stat.label === label)?.stat;
  const parts: string[] = [];
  const weight = cands.find(x => isWeightStatLabel(x.stat.label))?.stat;
  const sessions = cands.find(x => ['Workouts', 'Sessions', 'Active days'].includes(x.stat.label))?.stat;
  const sessionCount = (s: WeeklyReviewStat) => `${s.value} ${plural(Number(s.value), 'workout')}`;

  const reached = input.goal === 'weight_loss' ? reachedWeek(input, week) : null;
  if (reached) {
    // The target is met: the headline says so (this week) or where the weight holds (after), never the deficit.
    if (reached.thisWeek) {
      return clipHeadline(`You reached ${reached.targetKg != null ? weightText(input, reached.targetKg) : 'your target'} this week`);
    }
    const holding = reached.meanKg != null
      ? (onTarget(reached) ? `Holding at your ${weightText(input, reached.targetKg as number)} target` : `Holding at ${weightTextFixed(input, reached.meanKg)}`)
      : 'Holding your target weight';
    return clipHeadline(sessions ? `${holding}, ${sessionCount(sessions)}` : holding);
  }

  if (input.goal === 'weight_loss') {
    if (weight) {
      const rounded = weight.value;
      parts.push(
        isPlateauWeek(input, week) ? 'Weight flat for 3 weeks'
        : rounded.startsWith('−') ? `Down ${rounded.slice(1)}`
        : rounded.startsWith('+') ? `Up ${rounded.slice(1)}`
        : 'Weight steady',
      );
    }
    const budget = by('Days in budget');
    if (budget) parts.push(`in budget ${budget.value.replace('/', ' of ')} ${loggedWord(budget)}days`);
    else if (sessions) parts.push(sessionCount(sessions));
    else if (weight && parts.length === 1) {
      // The weight stat alone: say how many weigh-ins it rests on.
      const n = weekWeighIns(input, week).length;
      parts[0] = `${parts[0]}${isPlateauWeek(input, week) ? '' : ' this week'} (${n} ${plural(n, 'weigh-in')})`;
    }
  } else if (input.goal === 'muscle') {
    // A week without a session says so, and how long it has been: no praise for the scale or an old lift in its place.
    if (sessions && weekSessionCount(input, week) === 0) {
      const off = weeksOffRunning(input, week);
      return clipHeadline(off >= 2 ? `No sessions last week (${ordinal(off)} week off)` : 'No sessions last week');
    }
    if (sessions) {
      parts.push(sessions.comparison?.startsWith('target ')
        ? `${sessions.value} of ${sessions.comparison.split(' ')[1]} sessions`
        : `${sessions.value} ${plural(Number(sessions.value), 'session')}`);
    }
    const lift = cands.find(x => x.stat.label.endsWith('est. 1RM'))?.stat;
    const protein = by('Protein days hit');
    // A slack week leads with the week: no lift gain it did not produce, no weight or protein filler after the count.
    if (slackMuscleWeek(input, week) && !input.liftReturn && !(lift && lift.tone === 'good') && parts.length === 1) return clipHeadline(`${parts[0]} — a short week`);
    if (lift && input.liftReturn) {
      // Returning from a break: the rebuild leads ("Squat est. 1RM 136 of 142 kg pre-break"), regained or not.
      parts.push(returnHeadlinePart(input));
    } else if (lift && lift.tone === 'good') {
      // The lift change is a 4-week number inside a one-week sentence: say so.
      const cmp = lift.comparison ?? '';
      const window = cmp.includes('4 weeks') ? `over ${withUnit(4, 'wks')}` : cmp.replace('last trained week', 'last trained wk');
      parts.push(`${lift.label} ${lift.value} ${window}`);
    }
    else if (protein) parts.push(`protein ${protein.value.replace('/', ' of ')} ${loggedWord(protein)}days`);
    else if (weight) parts.push(weight.value === 'no change' ? 'weight steady' : `weight ${weight.value}`);
  } else if (input.goal === 'endurance') {
    if (sessions) {
      parts.push(sessions.comparison?.startsWith('target ')
        ? `${sessions.value} of ${sessions.comparison.split(' ')[1]} sessions`
        : `${sessions.value} ${plural(Number(sessions.value), 'session')}`);
    }
    const volume = by('Volume');
    if (volume) {
      // With a distance target the headline says how far of it the week got
      // ("24.5 of 30 km"); Volume's km is already the running km measured against it.
      const km = runningKm(input, week);
      const kmBased = /\s(km|mi)$/.test(volume.value);
      const target = input.weeklyDistanceKmTarget as number;
      const plan = windDownPlan(input, week.days[0]);
      const windDownKm = plan != null ? windDownRunningKm(input, week, plan) : null;
      if (plan != null && plan.targetKm != null && hasDistanceTarget(input) && kmBased && windDownKm != null) {
        // A taper / race / recovery week is measured against its own target, with no "vs last week" (less running is the plan).
        parts.push(windDownHeadline(input, plan.phase, windDownKm, plan.targetKm));
      } else {
        const reviewed = reviewPlans(input).plan;
        // The week's one target (a cutback week's is the cutback number): the jump check, the figure and the slip all use it.
        const stepKm = reviewed?.targetKm ?? target;
        const overCap = reviewed != null && km != null && stepKm < target && overUpToCap(reviewed, km);
        const runDays = reviewPlans(input).week.days;
        // The jump is the plan's grade (so a comeback regaining its pre-break level is no spike here either, as on the goal card).
        const spike = hasDistanceTarget(input) && kmBased && km != null && (reviewed != null
          ? gradeEnduranceWeek(reviewed, km, { runDays, unitsPerKm: unitsPerKmOf(input) }).gap === 'spike'
          : isSpikeWeek(km, stepKm, target, unitsPerKmOf(input)));
        const value = hasDistanceTarget(input) && kmBased && km != null
          ? distanceHeadline(input, km, target, stepKm, { spike, cutback: reviewed?.cutback != null, upTo: reviewed?.upTo === true, overCap })
          : volume.value;
        // A spike's (or an over-the-cap week's) headline already says it is a jump: no "+186% vs last week" on top (and it would overrun the headline limit).
        parts.push(!(spike || overCap) && volume.comparison && volume.comparison.includes('%') ? `${value}, ${volume.comparison}` : value);
      }
    }
  } else {
    if (sessions) parts.push(`${sessions.value} active ${plural(Number(sessions.value), 'day')}`);
    const sleep = by('Sleep-goal nights');
    const logging = by('Logging days');
    if (sleep) parts.push(`slept to goal ${sleep.value.replace('/', ' of ')} ${loggedWord(sleep, 'tracked ')}nights`);
    else if (logging) parts.push(`logged ${logging.value.replace('/', ' of ')} days`);
  }
  if (parts.length === 0 && cands.length > 0) parts.push(`${cands[0].stat.label}: ${cands[0].stat.value}`);
  if (parts.length === 0) return 'Your week in review';
  const text = parts.join(', ');
  return clipHeadline(text.charAt(0).toUpperCase() + text.slice(1));
}

function weekendSlip(input: WeeklyReviewInput, week: Week): string | null {
  if (input.goal !== 'weight_loss' && input.goal !== 'muscle') return null;
  if (reachedWeek(input, week) != null) return null; // the deficit is over: no weekend-vs-weekday scolding
  const gap = weekendGap(input, week);
  return gap != null && gap >= WEEKEND_GAP_MIN_KCAL ? `Weekends ran +${withUnit(fmtKcal(gap), 'kcal')} over your weekdays.` : null;
}

const SMALL_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function numberWord(n: number): string {
  return SMALL_NUMBER_WORDS[n] ?? String(n);
}

/** "3 of 4 sessions — one short" / "0 of 4 sessions — none done". */
function countSlip(done: number, target: number, noun: string): string {
  const missing = target - done;
  return `${done} of ${target} ${noun} — ${done === 0 ? 'none done' : `${numberWord(missing)} short`}`;
}

/**
 * The Slip line for a mixed / tough week: it ALWAYS names the week's gap (the
 * same one the pill's rating and "Next week" are built from), ahead of any
 * other slip candidate.
 */
function gapSlip(input: WeeklyReviewInput, gap: WeekGap, week: Week, prevWeek: Week): string {
  switch (gap.kind) {
    case 'sessions': {
      // A second week without a single session is not the first one over again.
      const off = input.goal === 'muscle' && gap.done === 0 ? weeksOffRunning(input, week) : 0;
      return off >= 2
        ? `0 of ${gap.target} ${plural(gap.target, 'session')} — ${ordinal(off)} week in a row`
        : countSlip(gap.done, gap.target, plural(gap.target, 'session'));
    }
    case 'activeDays': return countSlip(gap.done, gap.target, `active ${plural(gap.target, 'day')}`);
    case 'distance':
      // A careful comeback is measured against the week before it, not against its ceiling: it is a gap only because it shrank.
      if (gap.comebackFromKm != null && gap.stepKm != null) {
        return `${distanceText(input, gap.doneKm)}, down from ${distanceText(input, gap.comebackFromKm)} last week — keep building back, up to ~${distanceText(input, gap.stepKm)}`;
      }
      // A week graded against its safe step names the step ("21 of ~24 km — 3 km short of this week's step"), not the goal it was never asked to reach.
      return gap.stepKm != null
        ? `${distanceNumber(input, gap.doneKm)} of ~${distanceText(input, gap.stepKm)} — ${withUnit(round1(distanceNumber(input, gap.stepKm) - distanceNumber(input, gap.doneKm)), isImperial(input) ? 'mi' : 'km')} short of this week's step`
        : `${distanceNumber(input, gap.doneKm)} of ${distanceText(input, gap.targetKm)} target — ${distanceText(input, gap.targetKm - gap.doneKm)} short`;
    case 'spike':
      return `Jumped ${withUnit(round1(distanceNumber(input, gap.doneKm) - distanceNumber(input, gap.stepKm)), isImperial(input) ? 'mi' : 'km')} over this week's step — big jumps raise injury risk`;
    case 'phase': {
      const done = distanceText(input, gap.doneKm);
      const target = distanceText(input, gap.targetKm);
      if (gap.phase === 'recovery') return `Ran ${done} — recovery weeks are easy`;
      if (gap.phase === 'race_week') return `Ran ${done} — race week is for short easy runs (~${target} planned)`;
      return gap.over
        ? `Ran ${done} against a ~${target} taper target — the taper is for cutting volume`
        : `${distanceNumber(input, gap.doneKm)} of ~${target} — well under this week's taper target`;
    }
    case 'budget': {
      const target = input.budget?.targetKcal;
      return `In budget ${gap.inBudget} of ${gap.logged} logged ${plural(gap.logged, 'day')}${target != null ? ` (${withUnit(fmtKcal(target), 'kcal')} target)` : ''}`;
    }
    case 'protein': {
      const target = input.budget?.proteinG;
      return `Protein hit ${gap.hit} of ${gap.logged} logged ${plural(gap.logged, 'day')}${target != null && target > 0 ? ` (${withUnit(Math.round(target), 'g')} target)` : ''}`;
    }
    case 'weight':
      return weightCandidate(input, week, prevWeek)?.slip
        ?? (isPlateauWeek(input, week)
          ? 'Your weekly average has been flat for 3 weeks — common, and often water.'
          : `${weightChange(input, week, prevWeek)?.basis === 'trend' ? weightWords(input, 'trend').subject : 'Your weekly average'} barely moved this week.`);
  }
}

/** Slip: the gap for a mixed / tough week; nothing for a deliberate lighter week; the existing candidate logic for good / unrated weeks. */
function buildSlip(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week, assessment: WeekAssessment): string | null {
  if (assessment.rating === 'light') return null;
  const reached = reachedWeek(input, week);
  if (reached) {
    return isUnderTarget(reached) && reached.targetKg != null && reached.meanKg != null
      ? `At ${weightTextFixed(input, reached.meanKg)}, ${weightText(input, reached.targetKg - reached.meanKg)} under your ${weightText(input, reached.targetKg)} target.`
      : null;
  }
  if ((assessment.rating === 'mixed' || assessment.rating === 'tough') && assessment.gap) {
    return gapSlip(input, assessment.gap, week, prevWeek);
  }
  if (input.goal === 'endurance') {
    const rp = reviewPlans(input);
    const jump = rp.next?.longRunJump;
    if (jump != null && rp.next != null && !isWindDownKind(rp.next.kind)) {
      const u = unitsPerKmOf(input);
      const held = formatTargetLongRun(jump.heldKm, u).replace(/\u00a0\D+$/, '');
      return `Long run jumped to ${formatTargetLongRun(jump.actualKm, u)} — hold ${held} next week.`;
    }
  }
  return cands.find(x => x.slip)?.slip ?? weekendSlip(input, week);
}

/** Minimum relative HRV drop vs the week before that counts as "below normal". */
const HRV_DROP_FRACTION = 0.1;
/** Resting HR rise (bpm) vs the week before that counts as elevated (same as the resting-HR slip). */
const RHR_RISE_BPM = 3;
/** Sleep average under this fraction of goal counts as short. */
const SHORT_SLEEP_FRACTION = 0.85;

/** Plain-language recovery warnings for the reviewed week; empty when signals are missing or fine. */
function recoveryFlags(input: WeeklyReviewInput, week: Week): string[] {
  const prevWeek = makeWeek(addDays(week.days[0], -7));
  const flags: string[] = [];
  const pick = (series: DayValue[] | undefined, w: Week) => (series ?? []).filter(p => w.set.has(p.day)).map(p => p.value);

  const hrvCur = pick(input.hrv, week);
  const hrvPrev = pick(input.hrv, prevWeek);
  if (hrvCur.length >= MIN_HR_DAYS && hrvPrev.length >= MIN_HR_DAYS) {
    const prevAvg = mean(hrvPrev) as number;
    if (prevAvg > 0 && ((mean(hrvCur) as number) - prevAvg) / prevAvg <= -HRV_DROP_FRACTION) flags.push('HRV ran below your normal');
  }
  const nights = sleepNights(input, week);
  if (nights.length >= MIN_SLEEP_NIGHTS && (mean(nights) as number) < input.sleepGoalMinutes * SHORT_SLEEP_FRACTION) {
    flags.push('sleep averaged short');
  }
  const rhrCur = pick(input.restingHr, week);
  const rhrPrev = pick(input.restingHr, prevWeek);
  if (rhrCur.length >= MIN_HR_DAYS && rhrPrev.length >= MIN_HR_DAYS && (mean(rhrCur) as number) - (mean(rhrPrev) as number) >= RHR_RISE_BPM) {
    flags.push('resting heart rate rose');
  }
  return flags;
}

/** Lowercase, punctuation-free form for the "next week must not copy the slip" check. */
function normalizeSentence(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Logged-day threshold: below this a user is "sparse" and the logging advice is warranted. */
const MIN_LOGGED_DAYS_FOR_NO_LOG_ADVICE = 3;

/** Distinct eligible days of the week with logged meals or a logged strength session (sets). */
function loggedDayCount(input: WeeklyReviewInput, week: Week): number {
  const days = new Set<string>();
  for (const d of loggedIntake(input.intakeDays, week)) days.add(d.day);
  const train = new Set(sessionDays(input));
  for (const d of week.days) if (week.eligible.has(d) && train.has(d)) days.add(d);
  return days.size;
}

/** Deterministic week number (Mondays are 7 days apart): the rotation index for tips. */
function weekIndex(week: Week): number {
  return Math.floor(dayNumber(week.days[0]) / 7);
}

/**
 * The week's tip from `options`, rotating with the week number so two weeks
 * running never read the same, and skipping last week's stored text when the
 * loader passed it in (`previousNextWeek`).
 */
function rotateTip(input: WeeklyReviewInput, week: Week, options: string[]): string {
  const prev = input.previousNextWeek ? normalizeSentence(input.previousNextWeek) : null;
  const start = weekIndex(week) % options.length;
  for (let k = 0; k < options.length; k++) {
    const tip = options[(start + k) % options.length];
    if (prev == null || normalizeSentence(tip) !== prev) return tip;
  }
  return options[start];
}

const WEEKEND_NEXT_WEEK = "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.";

/** "your 2,000 kcal target" when the budget is known, else "your calorie target". */
function calorieTarget(input: WeeklyReviewInput): string {
  const target = input.budget?.targetKcal;
  return target != null && target > 0 ? `your ${withUnit(fmtKcal(target), 'kcal')} target` : 'your calorie target';
}

/** Weight loss, a week over budget: the weekend plan alternates with other ways in, so it is never the tip two weeks running. */
function budgetTips(input: WeeklyReviewInput, weekendHigh: boolean): string[] {
  const target = input.budget?.targetKcal;
  const plan = 'Pick the two days most likely to run over and plan those meals ahead.';
  const written = 'Log your meals before you eat them on your two busiest days — a plan on paper is easier to follow.';
  const goTo = target != null && target > 0
    ? `Keep one go-to dinner that fits your ${withUnit(fmtKcal(target), 'kcal')} day and use it on your busiest night.`
    : 'Keep one go-to dinner that fits your calorie target and use it on your busiest night.';
  if (!weekendHigh) return [plan, written, goTo];
  return [
    WEEKEND_NEXT_WEEK,
    'Pick the weekend meal most likely to run over and decide it ahead of time.',
    WEEKEND_NEXT_WEEK,
    'Keep weekend breakfast and lunch close to your weekday routine, and let one dinner out be the flexible meal.',
    WEEKEND_NEXT_WEEK,
    'Log weekend meals as you go — it is the easiest way to watch the gap close.',
  ];
}

/** A weight-loss week that lost too fast: eat up to the target, said two ways. */
function tooFastTips(input: WeeklyReviewInput): string[] {
  return [
    `Eat up to your full ${calorieTarget(input).replace(/^your /, '')} each day — a slower loss is easier to keep.`,
    `Add one more protein-rich meal or snack a day and eat up to ${calorieTarget(input)} — a slower loss protects muscle.`,
  ];
}

/** "meals, weigh-in mornings and training days" — only what the user actually did in the reviewed week. */
function loggedRoutine(input: WeeklyReviewInput, week: Week): string {
  const bits: string[] = [];
  if (loggedIntake(input.intakeDays, week).length >= MIN_INTAKE_DAYS) bits.push('meals');
  if (weekWeighIns(input, week).length > 0) bits.push('weigh-in mornings');
  if (weekSessionCount(input, week) > 0) bits.push('training days');
  if (bits.length === 0) return 'routine';
  return bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`;
}

/** A flat three weeks: name it, keep the plan, and the real next step with the user's numbers when they are known. */
function plateauTip(input: WeeklyReviewInput): string {
  const kcal = input.budget?.targetKcal;
  const sessions = input.weeklySessionsTarget;
  const keep = [
    kcal != null && kcal > 0 ? withUnit(fmtKcal(kcal), 'kcal') : null,
    sessions != null && sessions > 0 ? `${sessions} ${plural(sessions, 'session')}` : null,
  ].filter((x): x is string => x != null);
  return `Plateaus are common and often water: keep ${keep.length > 0 ? keep.join(' and ') : 'your routine'}; if the scale is still flat in 2 weeks, trim ~${withUnit(150, 'kcal')} a day or add two 30-minute walks.`;
}

/** A calorie target within this many kcal of the formula maintenance estimate (or above it) is already a maintenance budget. */
const MAINTENANCE_BUDGET_MARGIN_KCAL = 100;

/**
 * True when the calorie target is already at maintenance (within a hair of the formula TDEE or above it), so "switch to
 * maintenance" would be advice already taken. False when it is still a deficit budget or the formula estimate is unknown:
 * a fat-loss goal that is reached but not switched is the normal case, and it must not be told it is on maintenance.
 */
function onMaintenanceBudget(input: WeeklyReviewInput): boolean {
  const target = input.budget?.targetKcal;
  const tdee = input.budget?.formulaTdee;
  return target != null && tdee != null && target >= tdee - MAINTENANCE_BUDGET_MARGIN_KCAL;
}

/** A weight-loss week with the target met: switch to maintenance first (unless the budget already is), then keep the weight honest. */
function reachedTips(input: WeeklyReviewInput): string[] {
  const maintenance = onMaintenanceBudget(input);
  return [
    maintenance
      ? 'Your calorie target is already at maintenance — keep it there and the weight should hold.'
      : 'Switch to maintenance in Goals so your calorie target stops pushing you lower.',
    `Keep weighing in a few mornings a week; if your average drifts ${weightText(input, HOLDING_RANGE_KG)} above or below your target, that is your cue to act.`,
    maintenance
      ? 'Ready for more? Set a new target in Goals, or stay on maintenance and enjoy holding here.'
      : 'Ready for more? Set a new target in Goals, or switch to maintenance and enjoy holding here.',
  ];
}

/**
 * "Next week" from the coming week's weight plan: the plan's one action, word for word, when it is an instruction (move
 * the date or trim a step, eat up to the target, the plateau's cause, keep doing what restarted it, a new target,
 * the maintenance target), or the hold line of a reached goal (keep the maintenance budget / keep weighing in). Null otherwise:
 * the review's own tips apply.
 */
function weightPlanNextWeek(input: WeeklyReviewInput): string | null {
  const plan = input.weightPlan;
  if (input.goal !== 'weight_loss' || plan == null) return null;
  if (isInstruction(plan.action) || ((plan.state === 'maintenance' || plan.state === 'reached') && plan.action.kind === 'hold')) return plan.action.text;
  // Ahead, nearly there or a kilo from the target (wave 22w): the plan asks for nothing, so the review's own food tips (a weekend to plan,
  // a meal to decide ahead) would be restriction the plan does not want. Nothing to tighten.
  if (plan.state !== 'reached' && plan.state !== 'maintenance' && (plan.call === 'ahead' || plan.nearlyThere || plan.call === 'too_fast' || withinAKiloOfTarget(input))) {
    return NO_NEED_TO_TIGHTEN_NEXT_WEEK;
  }
  return null;
}

export const NO_NEED_TO_TIGHTEN_NEXT_WEEK = 'Keep your routine — no need to tighten anything';

/** The goal's weekly average (the card's own: 7 days up to the newest weigh-in, 3+ weigh-ins, else the newest reading) is above the target by at most a kilo. */
function withinAKiloOfTarget(input: WeeklyReviewInput): boolean {
  if (input.targetWeightKg == null) return false;
  const days = computeWeightTrend(input.weightReadings).days;
  if (days.length === 0) return false;
  const newest = days[days.length - 1];
  const week = meanOver(days, newest.day, 7);
  const kg = week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : newest.rawKg;
  const toGo = kg - input.targetWeightKg;
  return toGo >= 0 && toGo <= HOLDING_RANGE_KG;
}

/** Weight loss with nothing else to fix: a tip built from what was actually logged, never asking for what is already done. */
function weightLossFallback(input: WeeklyReviewInput, week: Week): string {
  const weighed = weekWeighIns(input, week).length;
  const meals = loggedIntake(input.intakeDays, week).length;
  const needWeigh = weighed < MIN_WEIGH_INS_WEIGHT_ONLY;
  const needMeals = meals < MIN_INTAKE_DAYS;
  if (needWeigh && needMeals) return 'Weigh in on 3 mornings and log dinner on a few days so next week reads clearly.';
  if (needWeigh) return `You logged meals on ${meals} ${plural(meals, 'day')} — add weigh-ins on 3 mornings so your weight change reads clearly.`;
  if (needMeals) return `You weighed in ${weighed} ${plural(weighed, 'day')} — log dinner on ${MIN_INTAKE_DAYS} days to see how your calories line up.`;
  return rotateTip(input, week, [
    'Keep the same weigh-in mornings and meal logging going next week.',
    'Your logging is solid — keep it up, steady data is what makes the trend easy to read.',
  ]);
}

/** Generic, goal-keyed action used when no gap or fix applies, or a derived suggestion would just repeat the slip. */
function fallbackNextWeek(input: WeeklyReviewInput, week: Week): string {
  switch (input.goal) {
    case 'weight_loss': return weightLossFallback(input, week);
    case 'muscle':
      // "Log every working set…" is for sparse loggers only; someone who logged sets/meals most of the week already does.
      return loggedDayCount(input, week) >= MIN_LOGGED_DAYS_FOR_NO_LOG_ADVICE
        ? 'Keep the same session days and try to add a rep or a little weight on your main lifts.'
        : 'Log every working set and a weigh-in or two so we can see your lifts and weight move.';
    case 'endurance':
      // Distance already shows when the week carried a measured run: the watch advice is only for weeks without one.
      return runningKm(input, week) != null
        ? 'Keep your easy runs easy and your running days regular.'
        : 'Keep sessions easy and regular, and wear your watch so volume and resting HR show up.';
    default: return 'Pick two fixed activity days next week and put them on the calendar.';
  }
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
/**
 * Tie-break order (Monday = 0) for the day to add a session on: Saturday, then mid-week, before Monday.
 * Sunday is never suggested: the review is read on Monday morning, so a Sunday "start" is the last day of the coming week.
 */
const EXTRA_SESSION_DAY_ORDER = [5, 3, 1, 4, 2, 0];

/** Sessions per weekday (Monday = 0) across the reviewed week and the one before it. */
function sessionsPerWeekday(input: WeeklyReviewInput, week: Week, prevWeek: Week): number[] {
  const train = new Set(sessionDays(input));
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const w of [prevWeek, week]) w.days.forEach((d, i) => { if (train.has(d)) counts[i] += 1; });
  return counts;
}

/** The weekday (Monday–Saturday) with the fewest sessions across the reviewed week and the one before it (ties: Saturday first), e.g. "Saturday". */
function freestWeekday(input: WeeklyReviewInput, week: Week, prevWeek: Week): string {
  const counts = sessionsPerWeekday(input, week, prevWeek);
  const fewest = Math.min(...EXTRA_SESSION_DAY_ORDER.map(i => counts[i]));
  return WEEKDAY_NAMES[EXTRA_SESSION_DAY_ORDER.find(i => counts[i] === fewest) as number];
}

/** Where a catch-up starts: Monday or Tuesday (the review is read on Monday morning), whichever has been freer; ties: Monday. */
function startWeekday(input: WeeklyReviewInput, week: Week, prevWeek: Week): string {
  const counts = sessionsPerWeekday(input, week, prevWeek);
  return counts[1] < counts[0] ? 'Tuesday' : 'Monday';
}

/**
 * "Next week" for a build week: build toward the weekly target without a jump.
 * Next week's distance is the plan's step (~10% over this week, in the user's
 * unit — the same `stepTargetKm` the goal card shows for the week then under
 * way); the long run grows by at most 2 km and never past its peak target; the
 * rest of the growth goes to easy runs. Spells out the staging ("30 km the week
 * after") when the cap leaves the target out of reach for one more week.
 */
function buildNextWeekText(input: WeeklyReviewInput, next: EnduranceWeekPlan): string {
  const imperial = isImperial(input);
  const perKm = imperial ? KM_TO_MI : 1;
  const targetText = distanceText(input, next.goalKm);
  const nextKm = next.targetKm as number;
  const nextUnits = Math.round(nextKm * perKm * 10) / 10;
  const goalUnits = next.goalKm * perKm;

  // Long run: +2 km at most, never above the peak target; none without long-run data.
  let longRunPart: string | null = null;
  const lr = next.longRun;
  if (next.longRunKm != null) {
    const atPeak = lr.targetPeakKm != null && lr.lastKm != null && lr.lastKm >= lr.targetPeakKm;
    if (next.longRunJump != null) {
      // Last week's long run jumped over its plan: hold it, do not grow it.
      longRunPart = `${longRunWord(next.longRunKm, perKm)} ${formatTargetLongRun(next.longRunKm, perKm)} (hold it after last week's jump), the rest mostly easy runs`;
    } else if (!atPeak) {
      if (next.longRunKm < nextKm) longRunPart = `${longRunWord(next.longRunKm, perKm)} ${formatTargetLongRun(next.longRunKm, perKm)}, the rest mostly easy runs`;
    } else if (lr.targetPeakKm != null && lr.targetPeakKm < nextKm) {
      // At the peak the goal can carry: say when the race's own peak does not fit under the weekly goal.
      // The cap note is for the first build week and then every 4th, not every Monday.
      const capNote = lr.capNoteDue
        ? longRunCapNote(lr.raceTargetKm != null ? { peakKm: lr.targetPeakKm, raceTargetKm: lr.raceTargetKm } : null, next.goalKm, perKm)
        : null;
      longRunPart = `hold your long run at ${formatTargetLongRun(lr.targetPeakKm, perKm)}${capNote ? ` (${capNote.charAt(0).toLowerCase()}${capNote.slice(1)})` : ''} and put the growth into easy runs`;
    }
  }

  const nextText = `~${withUnit(nextUnits, imperial ? 'mi' : 'km')}`;
  const reachesTarget = Math.round(nextUnits * (1 + WEEKLY_DISTANCE_GROWTH)) >= goalUnits;
  const after = reachesTarget ? `${targetText} the week after` : `then add ~${Math.round(WEEKLY_DISTANCE_GROWTH * 100)}% a week toward ${targetText}`;
  // A careful comeback's target is a ceiling ("up to ~16 km"), not a step to hit.
  // ... and after a week that went over its ceiling it holds at what was run.
  const lead = next.last?.overCap ? 'Hold here, up to' : next.upTo ? 'Build up to' : 'Build to';
  const strides = next.strides ? `, ${STRIDES_COPY}` : '';
  return `${lead} ${nextText}${longRunPart ? `: ${longRunPart}` : ' with mostly easy runs'}${strides}; ${after}.`;
}

/**
 * "Next week" for the COMING week's plan (the one the goal card then shows):
 *  - taper: the phase target and what to run in it;
 *  - race week / recovery: short easy runs / easy only, with the ceiling;
 *  - rebuild: "Back to building" once recovery is over;
 *  - hold (after a spike): one step up from the step it should have been, never
 *    from the jump — "Hold around ~28 km next week";
 *  - restart (after a break or a very light week): a share of the median week by the
 *    gap, easy; the weeks after climb back toward that median;
 *  - build: ~10% up, long run +2 km; maintain: hold the weekly goal, the long
 *    run keeps stepping toward its peak.
 * Null without a plan (no distance target, or nothing run yet).
 */
function plannedNextWeek(input: WeeklyReviewInput): { kind: EnduranceWeekPlan['kind']; text: string } | null {
  const rp = reviewPlans(input);
  const next = rp.next;
  if (next == null) return null;
  const u = unitsPerKmOf(input);
  const t = next.targetKm != null ? distanceText(input, next.targetKm) : null;
  const goalText = distanceText(input, next.goalKm);
  const lr = next.longRunKm != null
    ? `${longRunWord(next.longRunKm, u)} ${formatTargetLongRun(next.longRunKm, u)}${next.longRunJump != null ? " (hold it after last week's jump)" : ''}`
    : null;
  const growth = `${Math.round(WEEKLY_DISTANCE_GROWTH * 100)}%`;
  const rep = racePaceReps(unitsPerKmOf(input));
  let text: string;
  // A cutback week is named as one: "Cutback week: ~24 km, long run 14 km — absorb the last three weeks."
  if (next.cutback != null && (next.kind === 'build' || next.kind === 'maintain')) return { kind: next.kind, text: `${next.purpose}.` };
  switch (next.kind) {
    case 'taper':
      text = `Taper: ~${t} next week — cut volume; ${lr ? `${lr} easy, plus ` : ''}${rep} at race pace midweek${lr ? '' : ', the rest easy'}.`;
      break;
    case 'race_week':
      text = `Race week: short easy runs, ~${t} before the race, then rest 1–2 days before it.`;
      break;
    case 'recovery':
      text = `Recovery: easy only, ≤ ${t} next week.`;
      break;
    case 'rebuild': {
      // "Back to building" is the step out of recovery; later rebuild weeks keep rebuilding.
      const lead = rp.plan != null && rp.plan.kind === 'recovery' ? 'Back to building' : 'Keep rebuilding';
      // At the weekly goal there is nothing left to add 10% toward.
      const atGoal = next.targetKm != null && next.targetKm >= next.goalKm - 1e-9;
      text = next.restart != null
        ? `${lead}: start with a couple of easy runs (~${t})${atGoal ? '' : `, then add ~${growth} a week toward ${goalText}`}.`
        : `${lead}: ~${t} next week${lr && lead === 'Keep rebuilding' ? `, ${lr}` : ''}.`;
      break;
    }
    case 'hold':
      text = (next.targetKm as number) >= next.goalKm
        ? `Hold at ${goalText} next week rather than going higher.`
        : `Hold around ~${t} next week, then build ~${growth} a week toward ${goalText}.`;
      if (next.strides) text = `${text.slice(0, -1)}; ${STRIDES_COPY}.`;
      break;
    case 'restart':
      text = `Restart at ~${t} next week with easy runs${lr ? `; ${lr}` : ''}.`;
      break;
    case 'maintain':
      // A runner who has not yet run the weekly goal is building to it, not holding it.
      text = `${next.goalReachedBefore ? 'Hold' : 'Build to'} ${goalText}; ${lr ? `${lr}, ` : ''}the rest easy${next.strides ? `, ${STRIDES_COPY}` : ''}.`;
      break;
    case 'build':
    default:
      text = buildNextWeekText(input, next);
      break;
  }
  return { kind: next.kind, text };
}

/**
 * "Next week" when the COMING week is a taper, race or recovery week — or
 * when the week just reviewed was the last recovery week — else null. It
 * follows the coming week's phase whatever the reviewed week looked like, and
 * never tells the runner to "build" inside the race lifecycle:
 *  - taper:      "Taper: ~22 km next week — keep a little intensity, cut volume."
 *  - race week:  "Race week: short easy runs, ~16 km before the race, rest 1–2 days before it."
 *  - recovery:   "Recovery: easy only, ≤ 16 km next week."
 *  - after it:   "Back to building: ~13 km next week." (the shared ~10% step over the
 *                reviewed week — the same number the goal card then shows).
 */
function windDownNextWeek(input: WeeklyReviewInput, week: Week): string | null {
  if (input.goal !== 'endurance') return null;
  // With a week plan the coming week's plan owns "Next week" (`plannedNextWeek`); this is the no-distance-target path.
  if (reviewPlans(input).next != null) return null;
  const coming = windDownPlan(input, addDays(week.days[0], 7));
  if (coming != null) {
    const target = coming.targetKm != null ? distanceText(input, coming.targetKm) : null;
    switch (coming.phase) {
      case 'taper':
        return target != null
          ? `Taper: ~${target} next week — cut volume, keep the long run easy, plus ${racePaceReps(unitsPerKmOf(input))} at race pace midweek.`
          : `Taper: cut volume next week, keep the long run easy, plus ${racePaceReps(unitsPerKmOf(input))} at race pace midweek.`;
      case 'race_week':
        return target != null
          ? `Race week: short easy runs, ~${target} before the race, then rest 1–2 days before it.`
          : 'Race week: short easy runs, then rest 1–2 days before the race.';
      case 'recovery':
        return target != null ? `Recovery: easy only, ≤ ${target} next week.` : 'Recovery: easy only next week.';
    }
  }
  // The week just reviewed was recovery and the coming one is not: recovery is over.
  if (windDownPlan(input, week.days[0])?.phase !== 'recovery') return null;
  if (!hasDistanceTarget(input)) return 'Back to building: ease back in with easy runs and add about 10% a week.';
  const perKm = isImperial(input) ? KM_TO_MI : 1;
  const goalKm = input.weeklyDistanceKmTarget as number;
  const next = weekStepTarget((runningKm(input, week) ?? 0) * perKm, goalKm * perKm);
  return next == null
    ? `Back to building: start with a couple of easy runs, then add ~${Math.round(WEEKLY_DISTANCE_GROWTH * 100)}% a week toward ${distanceText(input, goalKm)}.`
    : `Back to building: ~${withUnit(next, isImperial(input) ? 'mi' : 'km')} next week.`;
}

/** A muscle week with a session or more but no more than half the planned ones (1 or 2 of 4): too thin a week for a lift-progress win. */
function slackMuscleWeek(input: WeeklyReviewInput, week: Week): boolean {
  const target = input.weeklySessionsTarget;
  if (input.goal !== 'muscle' || target == null || target <= 0) return false;
  const done = weekSessionCount(input, week);
  return done > 0 && done * 2 <= target;
}

/**
 * The win of a slack week may only cite something done that week. The lift stat's win ("Bench Press estimated 1RM is up 6 kg vs 4
 * weeks ago") quotes a number whose "now" side was set the week before, so it is left out (a return from a break keeps its own win);
 * the week's other wins (weight, protein) stand, else the session itself is the win: "You still got Thursday's bench session in." /
 * "You still got 2 sessions in — Monday and Thursday."
 */
function slackWeekWin(input: WeeklyReviewInput, week: Week, cands: Candidate[]): string {
  const other = cands.find(x => x.win && (input.liftReturn != null || !x.stat.label.endsWith('est. 1RM')))?.win;
  if (other) return other;
  const train = new Set(sessionDays(input));
  const names = week.days.flatMap((d, i) => (train.has(d) ? [WEEKDAY_NAMES[i] as string] : []));
  if (names.length !== 1) {
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : '';
    return `You still got ${names.length} ${plural(names.length, 'session')} in${list ? ` — ${list}` : ''}.`;
  }
  // One session: name the main lifts of that week (at most two), else just the day.
  const trained = rankLifts(input.progression, liftAnchor(week)).filter(key =>
    isMainLift(key) && (input.progression[key] ?? []).some(w => w.weekStart === week.days[0] && (w.sessions ?? w.totalSets) > 0));
  const lifts = trained.length > 0 && trained.length <= 2 ? `${trained.map(key => liftShortName(key, input.exerciseDisplay)).join(' and ')} ` : '';
  return `You still got ${names[0]}'s ${lifts}session in.`;
}

/**
 * The win line of a deload week (muscle goal; a runner's 'light' week is a rest week, not a deload). "As planned" only when the week before
 * asked for a lighter week; after 3+ straight weeks of heavier loads it names the timing; otherwise it just says the lighter week is done.
 */
function deloadWin(input: WeeklyReviewInput, week: Week): string {
  // "As planned" only when last week's "Next week" asked for a lighter week; else the timing: after weeks of heavier loads it was a good call.
  if (input.previousNextWeek && /lighter|deload|ease back/i.test(input.previousNextWeek)) return 'Deload week done — lighter loads, as planned.';
  const climbing = weeksOfHeavierLoads(input, week);
  return climbing >= DELOAD_TIMING_MIN_WEEKS
    ? `Deload week done — lighter loads, good timing after ${climbing} straight weeks of heavier loads.`
    : 'Deload week done — lighter loads.';
}

/** Straight weeks of heavier loads before a deload that earn the "good timing" note. */
const DELOAD_TIMING_MIN_WEEKS = 3;

/** Consecutive weeks just before the reviewed one in which some main lift's top load was above its load the week before (0 when the last one was not). */
function weeksOfHeavierLoads(input: WeeklyReviewInput, week: Week): number {
  const topAt = (key: string, weekStart: string): number | null => (input.progression[key] ?? []).find(w => w.weekStart === weekStart)?.topLoadKg ?? null;
  const keys = Object.keys(input.progression).filter(isMainLift);
  let n = 0;
  for (let k = 1; k <= 8; k += 1) {
    const cur = addDays(week.days[0], -7 * k);
    const before = addDays(cur, -7);
    const up = keys.some(key => {
      const a = topAt(key, cur);
      const b = topAt(key, before);
      return a != null && b != null && a > b;
    });
    if (!up) break;
    n += 1;
  }
  return n;
}

/** "110 → 112.5 kg": the grid load the step starts from and the next one (the unit once, on the target); "~" when the logged load was off the grid ("~195 → 200 lb"). */
function loadPairText(next: NextLoad): string {
  return arrowPair(`${next.approx ? '~' : ''}${next.start}`, withUnit(next.to, next.unit));
}

/**
 * Joins one entry per lift: the first by its display name ("Squat"), the rest by
 * the short spoken one ("bench", "deadlift"), so a cue reads "Squat 110 → 112.5 kg,
 * bench 87.5 → 90 kg" and not a row of capitalised names.
 */
function liftNames(input: WeeklyReviewInput, keys: string[]): string[] {
  return keys.map((key, i) => (i === 0 ? liftDisplayName(key, input.exerciseDisplay) : liftShortName(key, input.exerciseDisplay)));
}

/** After a deload week: back to the pre-deload working weights, plus the usual step, for every main lift trained ("Back to full loads: Squat 107.5 → 110 kg, bench 85 → 86.5 kg."). Null without a known load. */
function afterDeloadNextWeek(input: WeeklyReviewInput, week: Week): string | null {
  const keys = cuedLifts(input.progression, week.days[0], reviewLiftKey(input, week))
    .filter(key => priorTopLoadKg(input.progression[key], week.days[0], 4) != null);
  if (keys.length === 0) return null;
  const names = liftNames(input, keys);
  const parts = keys.map((key, i) => {
    const pre = priorTopLoadKg(input.progression[key], week.days[0], 4) as number;
    return `${names[i]} ${loadPairText(nextWorkingLoad(pre, key, isImperial(input)))}`;
  });
  return `Back to full loads: ${parts.join(', ')}.`;
}

/**
 * A good week's progression cue, for EVERY main lift trained that week (the
 * headline lift first), by the lift logger's next-load rule. A lift whose e1RM
 * fell last week holds its load ("deadlift hold at 130 kg") instead of going up.
 * One lift alone says the others follow when their reps land. Null without a
 * known load, or when no lift is ready to go up.
 */
function progressionCue(input: WeeklyReviewInput, week: Week): string | null {
  const rebuilding = stillRebuilding(input);
  const cues = nextLoadCues(input.progression, week.days[0], { imperial: isImperial(input), leadKey: reviewLiftKey(input, week), rebuilding });
  const up = cues.filter(c => !c.hold);
  if (up.length === 0) return null;
  const held = cues.filter(c => c.hold);
  const ordered = [...up, ...held];
  const names = liftNames(input, ordered.map(c => c.key));
  const raise = up.map((c, i) => `${names[i]} ${loadPairText(c.load)}`);
  const hold = held.map((c, i) => `${names[up.length + i]} hold at ${withUnit(c.load.from, c.load.unit)}`);
  let text = raise.join(', ');
  if (hold.length > 0) text += `; ${hold.join(', ')}`;
  else if (cues.length === 1) text += '; progress the others as they hit their reps';
  return `${rebuilding ? 'Keep rebuilding: ' : ''}${text}.`;
}

/** "Squat ~102.5 kg, bench ~80 kg": ~90% of the last working weight of each main lift in rotation (the headline lift first). Null when none is known. */
function easedLoadsText(input: WeeklyReviewInput, week: Week): string | null {
  const lead = reviewLiftKey(input, week);
  const keys: string[] = [];
  for (const key of [...(lead ? [lead] : []), ...rankLifts(input.progression, liftAnchor(week)).filter(isMainLift)]) {
    if (keys.length >= MAX_CUED_LIFTS) break;
    if (!keys.includes(key) && latestTopLoadKg(input.progression[key] ?? [], week.days[0]) != null) keys.push(key);
  }
  const names = liftNames(input, keys);
  const parts = keys.map((key, i) => {
    const eased = easedLoad(latestTopLoadKg(input.progression[key], week.days[0]) as number, 0.9, isImperial(input));
    return `${names[i]} ~${withUnit(eased.value, eased.unit)}`;
  });
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * A week without a single session: ease in at ~90% of the last working weights
 * (every main lift), starting today — the review is read on Monday, so it is
 * never "starting Monday" — and never "lock in the missed ones". A second week
 * off asks for one easy session first.
 */
function easeBackInNextWeek(input: WeeklyReviewInput, week: Week, target: number): string {
  const loads = easedLoadsText(input, week);
  const weights = loads ? ` (${loads})` : '';
  const off = weeksOffRunning(input, week);
  if (off >= 2) {
    return `${ordinal(off)} week off — book one easy session today at ~90% of your last working weights${weights}, then build back toward ${target} a week.`;
  }
  return `Ease back in: ${target} ${plural(target, 'session')} at ~90% of your last working weights${weights}, starting today.`;
}

/**
 * A muscle week with some sessions but under the target (1..target-1): back to the target, NOT the missed ones made up, with the
 * loads. A lift not trained that week repeats its planned step ("Squat 112.5 kg (the step you skipped)"); a lift that was trained
 * follows the normal next-load rule ("bench 87.5 → 90 kg"). Starting today: the review is read on its Monday. Without a known
 * load the sentence still stands.
 */
function shortWeekNextWeek(input: WeeklyReviewInput, week: Week, target: number): string {
  const head = `Back to ${target} this week — don't make up the missed ones`;
  const cues = shortWeekLoadCues(input.progression, week.days[0], { imperial: isImperial(input), leadKey: reviewLiftKey(input, week), rebuilding: stillRebuilding(input) });
  if (cues.length === 0) return `${head}, starting today.`;
  // The lifts that repeat their planned step come first, with the one note; the rest follow in the usual "110 → 112.5 kg" form.
  const repeat = cues.filter(c => c.kind === 'skipped');
  const rest = cues.filter(c => c.kind !== 'skipped');
  const names = liftNames(input, [...repeat, ...rest].map(c => c.key));
  const repeatParts = repeat.map((c, i) => `${names[i]} ${withUnit(c.load.to, c.load.unit)}`);
  const parts: string[] = [];
  if (repeatParts.length > 0) {
    const list = repeatParts.length === 1 ? repeatParts[0] : `${repeatParts.slice(0, -1).join(', ')} and ${repeatParts[repeatParts.length - 1]}`;
    parts.push(`${list} (${repeat.length === 1 ? 'the step' : 'the steps'} you skipped)`);
  }
  rest.forEach((c, i) => {
    const name = names[repeat.length + i];
    parts.push(c.kind === 'hold' ? `${name} hold at ${withUnit(c.load.from, c.load.unit)}` : `${name} ${loadPairText(c.load)}`);
  });
  return `${head}. ${parts.join(', ')}, starting today.`;
}

/** "Next week" for a mixed / tough week: the concrete action that closes the gap the Slip names. */
function gapNextWeek(input: WeeklyReviewInput, gap: WeekGap, week: Week, prevWeek: Week): string {
  switch (gap.kind) {
    case 'sessions':
    case 'activeDays': {
      const sessions = gap.kind === 'sessions';
      if (sessions && input.goal === 'muscle') {
        // A week off: ease in at lighter weights. Returning from a break: rebuild at today's weights. Never "make up" what was missed.
        if (gap.done === 0) return easeBackInNextWeek(input, week, gap.target);
        if (stillRebuilding(input)) {
          return `Keep rebuilding: aim for ${gap.target} ${plural(gap.target, 'session')} at your current weights and add load only when every set feels solid.`;
        }
        // Some sessions, not all: back to the target with the loads, the missed ones are not made up.
        return shortWeekNextWeek(input, week, gap.target);
      }
      const missing = gap.target - gap.done;
      const day = freestWeekday(input, week, prevWeek);
      const book = sessions ? `Book ${gap.target} ${plural(gap.target, 'session')}` : `Plan ${gap.target} active ${plural(gap.target, 'day')}`;
      return missing === 1
        ? `${book} — put the missed one on ${day}.`
        : `${book} — lock in the missed ones now, starting with ${startWeekday(input, week, prevWeek)}.`;
    }
    // The gap names the week; "Next week" is the coming week's plan (normally answered before this safety net).
    case 'distance':
    case 'spike': return plannedNextWeek(input)?.text ?? fallbackNextWeek(input, week);
    // Normally answered by the coming week's phase (`windDownNextWeek`); this is the safety net.
    case 'phase': return windDownNextWeek(input, week) ?? fallbackNextWeek(input, week);
    case 'budget':
      return input.goal === 'weight_loss'
        ? rotateTip(input, week, budgetTips(input, false))
        : 'Pick the two days most likely to run over and plan those meals ahead.';
    case 'protein': return 'Add a protein-first breakfast so the day starts ahead of your target.';
    case 'weight':
      // Only a loss the stat itself flagged is "too fast"; a flat week is a plateau or just a flat week, not a reason to eat more.
      if (gap.deltaKg < 0 && weightCandidate(input, week, prevWeek)?.stat.tone === 'watch') return rotateTip(input, week, tooFastTips(input));
      if (isPlateauWeek(input, week)) return plateauTip(input);
      // Already weighing in often: do not ask for more weigh-ins.
      return weekWeighIns(input, week).length >= MIN_WEIGH_INS_WEIGHT_ONLY
        ? 'Hold to your calorie target each day — the scale should follow within a couple of weeks.'
        : 'Hold to your calorie target each day and weigh in at least 3 mornings so the trend reads clearly.';
  }
}

/** nextWeek is an action derived from the gap / slip — never a copy of the slip. */
function buildNextWeek(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week, assessment: WeekAssessment, slip: string | null): string {
  const next = buildNextWeekRaw(input, cands, week, prevWeek, assessment);
  return slip != null && normalizeSentence(next) === normalizeSentence(slip) ? fallbackNextWeek(input, week) : next;
}

/** The weekend-plan tip: rotated for weight loss (it alternates with other tips), the one fixed line for muscle. */
function weekendTip(input: WeeklyReviewInput, week: Week): string {
  return input.goal === 'weight_loss' ? rotateTip(input, week, budgetTips(input, true)) : WEEKEND_NEXT_WEEK;
}

function buildNextWeekRaw(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week, assessment: WeekAssessment): string {
  const { rating, gap } = assessment;
  // The coming week's plan owns "Next week" for a runner with a weekly distance target; the race lifecycle
  // (taper, race week, recovery, the step back to building) always wins over advice to go lighter.
  const planned = plannedNextWeek(input);
  if (planned != null && (isWindDownKind(planned.kind) || planned.kind === 'rebuild')) return planned.text;
  // The race lifecycle (taper / race week / recovery, and the step back to building) owns "Next week" in its weeks.
  const windDown = windDownNextWeek(input, week);
  if (windDown != null) return windDown;
  // The coming week's plan owns "Next week" for weight loss: the card shows the same action from that Monday.
  const weightPlanned = weightPlanNextWeek(input);
  if (weightPlanned != null) return weightPlanned;
  // The target is met: no deficit tips. The week it was reached says "switch to maintenance" first.
  const reached = reachedWeek(input, week);
  if (reached) return reached.thisWeek ? reachedTips(input)[0] : rotateTip(input, week, reachedTips(input));
  const weekend = input.goal === 'weight_loss' || input.goal === 'muscle' ? weekendGap(input, week) : null;
  const weekendHigh = weekend != null && weekend >= WEEKEND_GAP_MIN_KCAL;
  const recovery = recoveryFlags(input, week);
  const lighter = recovery.length >= 2
    ? `Go lighter next week and put sleep first — ${(recovery.length === 2 ? recovery.join(' and ') : `${recovery.slice(0, -1).join(', ')} and ${recovery[recovery.length - 1]}`)}.`
    : null;
  // A sessions gap (the distance was fine, the sessions target was not) is closed by booking the sessions, as before;
  // every other week "Next week" is the coming week's plan.
  const sessionsGap = gap?.kind === 'sessions' && (planned?.kind === 'build' || planned?.kind === 'maintain');
  if (planned != null && !sessionsGap) return lighter != null && planned.kind !== 'restart' ? lighter : planned.text;

  if (rating === 'mixed' || rating === 'tough' || rating === 'light') {
    // A budget gap with a heavy weekend is closed by planning the weekend.
    if (gap?.kind === 'budget' && weekendHigh) return weekendTip(input, week);
    if (lighter) return lighter;
    // 'light' is a deload for a lifter, a rest / sick week for a runner: only the lifter's has loads to go back to.
    if (rating === 'light') return (input.goal === 'muscle' ? afterDeloadNextWeek(input, week) : null) ?? 'Back to full volume next week: your usual sessions and loads.';
    if (gap) return gapNextWeek(input, gap, week, prevWeek);
    return fallbackNextWeek(input, week);
  }

  // A flat three weeks is named, with the real next step, ahead of any weekend tip.
  if (input.goal === 'weight_loss' && isPlateauWeek(input, week)) return plateauTip(input);
  if (weekendHigh) return weekendTip(input, week);
  if (lighter) return lighter;
  const fix = cands.find(x => x.stat.tone === 'watch' && x.fix)?.fix;
  if (fix) return fix;
  // "Repeat" is only for a week that was itself good (and a goal verdict that isn't saying otherwise).
  const goodVerdict = ['on_track', 'ahead', 'progressing', 'building', 'reached'].includes(input.verdict);
  // A good lifting week names the next load for the headline lift, unless the goal verdict says the lifts need something else.
  if (rating === 'good' && input.goal === 'muscle' && (goodVerdict || input.verdict === 'insufficient_data')) {
    const cue = progressionCue(input, week);
    if (cue) return cue;
  }
  if (rating === 'good' && goodVerdict) {
    return input.goal === 'weight_loss'
      ? rotateTip(input, week, [
          `Repeat this week: same ${loggedRoutine(input, week)}.`,
          `Nothing to change — keep the same ${loggedRoutine(input, week)} going.`,
        ])
      : 'Repeat this week: same routine, same training days.';
  }
  return fallbackNextWeek(input, week);
}

/**
 * What the reviewed week had and what it still needs, in plain words — it names
 * the actual gap ("You weighed in 5 days; log meals on 3 days to add calories.")
 * and never asks for something the user already did.
 */
function emptyReviewNextWeek(input: WeeklyReviewInput, week: Week, prevWeek: Week): string {
  const weighed = weekWeighIns(input, week).length;
  const prevWeighed = weekWeighIns(input, prevWeek).length;
  const meals = loggedIntake(input.intakeDays, week).length;
  const sessionDaySet = new Set([...sessionDays(input), ...input.workouts.map(w => w.day)].filter(d => week.eligible.has(d)));
  const workouts = sessionDaySet.size;

  const did: string[] = [];
  if (weighed > 0) did.push(`weighed in ${weighed} ${plural(weighed, 'day')}`);
  if (meals > 0) did.push(`logged meals on ${meals} ${plural(meals, 'day')}`);
  if (workouts > 0) did.push(`logged ${workouts} ${plural(workouts, 'workout')}`);
  if (did.length === 0) return 'Log meals, weigh-ins or workouts on a few days and your review will fill in next Monday.';

  const wants: Record<GoalKind, Array<'weigh' | 'meals' | 'workouts'>> = {
    weight_loss: ['weigh', 'meals'],
    muscle: ['workouts', 'meals'],
    endurance: ['workouts'],
    general: ['workouts', 'meals'],
  };
  const missing: string[] = [];
  for (const kind of wants[input.goal]) {
    if (kind === 'weigh' && weighed < MIN_WEIGH_INS_WEIGHT_ONLY) {
      const need = MIN_WEIGH_INS_WEIGHT_ONLY - weighed;
      missing.push(`weigh in on ${need} ${weighed > 0 ? 'more ' : ''}${plural(need, 'morning')} to see your weight change`);
    }
    if (kind === 'meals' && meals < MIN_INTAKE_DAYS) {
      const need = MIN_INTAKE_DAYS - meals;
      missing.push(`log meals on ${need} ${meals > 0 ? 'more ' : ''}${plural(need, 'day')} to add calories`);
    }
    if (kind === 'workouts' && workouts < MIN_INTAKE_DAYS) {
      const need = MIN_INTAKE_DAYS - workouts;
      missing.push(`log ${need} ${workouts > 0 ? 'more ' : ''}${plural(need, 'workout')} to add your sessions`);
    }
  }
  const head = `You ${did.length === 1 ? did[0] : `${did.slice(0, -1).join(', ')} and ${did[did.length - 1]}`}`;
  const needsBaseline = input.goal === 'weight_loss' && weighed >= MIN_WEIGH_INS_FOR_MEAN && prevWeighed < MIN_WEIGH_INS_FOR_MEAN;
  const baseline = needsBaseline ? ' Your weight change shows once last week has weigh-ins to compare against.' : '';
  if (missing.length === 0) {
    return needsBaseline
      ? `${head}.${baseline}`
      : `${head}. Your review fills in next Monday as more of the week is logged.`;
  }
  return `${head}; ${missing.join(' and ')}.${baseline}`;
}

/**
 * A lifter whose week has a sessions target and the sessions to speak of (the
 * target, or three of them) but no second stat yet — the first week, before there
 * is a week to compare weight or lifts with — gets a sessions-only review, not
 * "Not enough data… log meals on 3 days".
 */
function muscleSessionsOnly(input: WeeklyReviewInput, week: Week, cands: Candidate[]): boolean {
  const target = input.weeklySessionsTarget;
  if (input.goal !== 'muscle' || target == null || target <= 0) return false;
  if (cands.length !== 1 || cands[0].stat.label !== 'Sessions') return false;
  return weekSessionCount(input, week) >= Math.min(target, MIN_DATA_DAYS);
}

function emptyReview(input: WeeklyReviewInput, week: Week, prevWeek: Week, daysWithData: number, statCount: number): WeeklyReview {
  return {
    weekStart: week.days[0],
    weekEnd: week.days[6],
    goal: input.goal,
    verdict: input.weightPlan?.verdict ?? input.verdict,
    weekRating: null,
    weekGap: null,
    headline: 'Not enough data for a weekly review yet',
    stats: [],
    win: null,
    slip: null,
    nextWeek: emptyReviewNextWeek(input, week, prevWeek),
    dataSufficiency: { daysWithData, statCount, sufficient: false },
  };
}

export function computeWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
  const week = makeWeek(input.weekStart, input.signupDay);
  const prevWeek = makeWeek(addDays(input.weekStart, -7), input.signupDay);
  const daysWithData = countDataDays(input, week);
  const cands = buildCandidates(input, week, prevWeek);

  // The weight stat alone is enough when the week had 3+ weigh-ins ("Down 0.5 kg this week (5 weigh-ins)").
  const weightOnly = input.goal === 'weight_loss' && cands.length === 1
    && isWeightStatLabel(cands[0].stat.label)
    && weekWeighIns(input, week).length >= MIN_WEIGH_INS_WEIGHT_ONLY;
  // An endurance runner with a plan and a full week since signup always gets a real review: a rest or sick week is not "no data".
  const planned = input.goal === 'endurance' && reviewPlans(input).plan != null && reviewPlans(input).plan?.kind !== 'baseline' && week.eligible.size === 7;
  if (!planned && !muscleSessionsOnly(input, week, cands) && (daysWithData < MIN_DATA_DAYS || (cands.length < MIN_STATS && !weightOnly))) {
    return emptyReview(input, week, prevWeek, daysWithData, cands.length);
  }

  // ONE assessment of the week decides the pill (rating), the Slip line and "Next week".
  const assessment = assessWeek(input, week, prevWeek);
  const slip = buildSlip(input, cands, week, prevWeek, assessment);
  return {
    weekStart: week.days[0],
    weekEnd: week.days[6],
    goal: input.goal,
    verdict: input.weightPlan?.verdict ?? input.verdict,
    weekRating: assessment.rating,
    weekGap: assessment.gap,
    headline: buildHeadline(input, cands, week),
    stats: cands.map(x => x.stat),
    win: reachedWin(input, week) ?? enduranceWin(input, assessment) ?? windDownWin(input, week, assessment) ?? (assessment.rating === 'light' && input.goal === 'muscle' ? deloadWin(input, week) : null) ?? (slackMuscleWeek(input, week) ? slackWeekWin(input, week, cands) : (cands.find(x => x.win)?.win ?? null)),
    slip,
    nextWeek: buildNextWeek(input, cands, week, prevWeek, assessment, slip),
    dataSufficiency: { daysWithData, statCount: cands.length, sufficient: true },
  };
}

/** exercise key -> display name from workout-set rows; the first non-empty display seen for a key wins. */
export function buildExerciseDisplay(rows: ReadonlyArray<{ exercise: string; exercise_display: string | null }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const name = r.exercise_display?.trim();
    if (name && !(r.exercise in out)) out[r.exercise] = name;
  }
  return out;
}

/** Local YYYY-MM-DD of the user's signup (created_at) in `tz`; null when unknown. */
export function signupLocalDay(createdAt: Date | null | undefined, tz: string): string | null {
  return createdAt ? localDayKey(createdAt, tz) : null;
}
