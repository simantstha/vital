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

import type { GoalKind, GoalLongRunProgress, GoalProgressBudget, GoalProgressIntakeDay, GoalVerdict, DayValue } from './goalProgress';
import { KG_TO_LB, isRunningWorkoutType } from './goalProgress';
import { PARTIAL_LOG_KCAL_THRESHOLD, TOO_FAST_LOSS_PCT_PER_WEEK } from './brain/weightSignals';
import { computeWeightTrend, type WeightReading } from './weightTrend';
import { localDayKey, weekDayKeys, weekStartKeyForDay } from './localDay';
import { arrowPair, withUnit } from './displayText';
import type { ProgressionSummary } from './workoutRepository';
import { isDeload, liftDisplayChange, liftDisplayName, pickHeadlineLift } from './liftChange';
import {
  WEEKLY_DISTANCE_GROWTH,
  isWindDownPhase,
  longRunAtPeak,
  longRunStepKm,
  racePhaseInfo,
  racePhaseTargetKm,
  weekStepOrGoalKm,
  weekStepTarget,
  windDownBand,
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
 * Label of the review's weight stat. It is the week's average weight against the
 * week before's (a one-week change), NOT the 4-week trend rate ("+0.4 kg/wk")
 * the goal sheet quotes — the label says so, so the two never read as one number.
 */
export const WEIGHT_STAT_LABEL = 'Weekly avg weight';

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
   * graded against the step, and `targetKm` stays the goal beside it.
   */
  | { kind: 'distance'; doneKm: number; targetKm: number; stepKm?: number }
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
  /** The 4-week goal verdict as of this week (shared with the goal card) — NOT a rating of the week; use `weekRating` for that. */
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
   * weeks — the same definition lib/goalProgress.ts uses. When present, the
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
   * Endurance race day (YYYY-MM-DD, user-local). With it the reviewed week and
   * the coming week each get a race phase (build / taper / race week /
   * recovery, evaluated on the week's Monday): taper, race and recovery weeks
   * are graded against their own target and "Next week" follows the coming
   * week's phase instead of the growth step. Absent / null: no race.
   */
  raceDate?: string | null;
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

/** The week's weight-trend change (kg, signed) and the trend at its end; null without a weigh-in in the week or a baseline from the week before. */
function weightChange(input: WeeklyReviewInput, week: Week, prevWeek: Week): { deltaKg: number; endKg: number } | null {
  const trend = computeWeightTrend(input.weightReadings).days;
  const end = [...trend].reverse().find(d => d.day <= week.days[6]);
  if (!end || !week.set.has(end.day)) return null; // no weigh-in inside the reviewed week
  const start = [...trend].reverse().find(d => d.day < week.days[0]);
  if (!start || start.day < prevWeek.days[0]) return null; // no usable baseline from the week before
  return { deltaKg: end.trendKg - start.trendKg, endKg: end.trendKg };
}

function weightCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const change = weightChange(input, week, prevWeek);
  if (!change) return null;
  const { deltaKg } = change;
  const rounded = round1(isImperial(input) ? deltaKg * KG_TO_LB : deltaKg);
  const text = rounded === 0 ? weightText(input, 0) : weightText(input, Math.abs(deltaKg));
  const value = rounded === 0 ? text : signed(rounded, text);

  let tone: ReviewTone = 'neutral';
  const pct = change.endKg > 0 ? (deltaKg / change.endKg) * 100 : 0;
  if (input.goal === 'weight_loss') {
    if (deltaKg <= -0.05) tone = -pct > TOO_FAST_LOSS_PCT_PER_WEEK ? 'watch' : 'good';
    else if (deltaKg >= 0.2) tone = 'watch';
  } else if (input.goal === 'muscle') {
    if (deltaKg > 0.05) tone = 'good';
    else if (deltaKg <= -0.2) tone = 'watch';
  }
  const cand: Candidate = {
    stat: { label: WEIGHT_STAT_LABEL, value, comparison: 'vs the week before', tone },
  };
  if (tone === 'good') cand.win = input.goal === 'muscle' ? `Your weight trend is up ${weightText(input, Math.abs(deltaKg))}.` : `Your weight trend is down ${weightText(input, Math.abs(deltaKg))}.`;
  if (tone === 'watch') {
    cand.slip = input.goal === 'weight_loss' && deltaKg < 0
      ? `Weight dropped ${weightText(input, Math.abs(deltaKg))} — faster than is comfortable to sustain.`
      : `Your weight trend moved ${rounded > 0 ? 'up' : 'down'} ${weightText(input, Math.abs(deltaKg))}, away from your goal.`;
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
    if (tone === 'good') cand.win = `You hit your ${target}-${plural(target, 'session')} target with ${count}.`;
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
  return easeForWindDown(input, week, cand);
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

/** weekStart -> total training volume across every lift (set count when nothing was loaded). */
function totalVolumeByWeek(progression: ProgressionSummary): Record<string, number> {
  const kg: Record<string, number> = {};
  const sets: Record<string, number> = {};
  for (const weeks of Object.values(progression)) {
    for (const w of weeks) {
      kg[w.weekStart] = (kg[w.weekStart] ?? 0) + w.volumeKg;
      sets[w.weekStart] = (sets[w.weekStart] ?? 0) + w.totalSets;
    }
  }
  return Object.values(kg).some(v => v > 0) ? kg : sets;
}

/**
 * Headline lift of the review: the shared pick from lib/liftChange.ts
 * (`pickHeadlineLift` — largest 4-week e1RM change, the same lift the Trends
 * goal card names) with the shared 4-week number ("vs 4 weeks ago"), shown in
 * whole kg/lb. When no lift has 4-weeks-ago data the stat falls back to the
 * most-trained lift's clearly-labelled "vs last trained week" change instead
 * of inventing one.
 */
function liftCandidate(input: WeeklyReviewInput, week: Week): Candidate | null {
  const imperial = isImperial(input);
  const unit = imperial ? 'lb' : 'kg';
  let best: { name: string; shown: number; windowLabel: string } | null = null;
  // ONE headline-lift rule (lib/liftChange.ts pickHeadlineLift): the lift with
  // the largest 4-week e1RM change — the same lift the Trends goal card names.
  const picked = pickHeadlineLift(input.progression, week.days[0]);
  if (picked) {
    best = {
      name: liftDisplayName(picked.exercise, input.exerciseDisplay),
      shown: liftDisplayChange(picked.change, imperial).change,
      windowLabel: 'vs 4 weeks ago',
    };
  } else {
    // No lift has 4-weeks-ago data: clearly-labelled "vs last trained week" for the most-trained lift.
    let top: { exercise: string; sets: number; deltaKg: number } | null = null;
    for (const [exercise, weeks] of Object.entries(input.progression)) {
      const cur = weeks.find(w => w.weekStart === week.days[0]);
      if (!cur || cur.bestEstimatedOneRepMaxKg == null) continue;
      const earlier = weeks.filter(w => w.weekStart < week.days[0] && w.bestEstimatedOneRepMaxKg != null);
      if (earlier.length === 0) continue;
      const deltaKg = cur.bestEstimatedOneRepMaxKg - (earlier[earlier.length - 1].bestEstimatedOneRepMaxKg as number);
      if (!top || cur.totalSets > top.sets || (cur.totalSets === top.sets && exercise < top.exercise)) top = { exercise, sets: cur.totalSets, deltaKg };
    }
    if (top) {
      best = {
        name: liftDisplayName(top.exercise, input.exerciseDisplay),
        shown: Math.round(top.deltaKg * (imperial ? KG_TO_LB : 1)),
        windowLabel: 'vs last trained week',
      };
    }
  }
  if (!best) return null;
  const value = best.shown === 0 ? withUnit(0, unit) : signed(best.shown, withUnit(Math.abs(best.shown), unit));
  // A deload (week volume < 60% of the 4-week average) lowers e1RM on purpose:
  // never a slip, just a neutral "Lighter week".
  const lighter = best.shown < 0 && isDeload(totalVolumeByWeek(input.progression), week.days[0], 1);
  const tone: ReviewTone = lighter ? 'neutral' : best.shown > 0 ? 'good' : best.shown < 0 ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: { label: `${best.name} est. 1RM`, value, comparison: lighter ? `Lighter week · ${best.windowLabel}` : best.windowLabel, tone },
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
  const info = racePhaseInfo(input.raceDate, onDay);
  if (info == null || !isWindDownPhase(info.phase)) return null;
  const goalKm = hasDistanceTarget(input) ? (input.weeklyDistanceKmTarget as number) : null;
  const peakKm = input.racePeakWeekKm ?? goalKm;
  const targetKm = peakKm == null
    ? null
    : racePhaseTargetKm(info, peakKm, { weeklyGoalKm: goalKm, unitsPerKm: isImperial(input) ? 1 / KM_PER_MILE : 1 });
  return { phase: info.phase, info, targetKm };
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

function volumeCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
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
    else if (diff >= 3) { tone = 'watch'; cand.slip = `Resting heart rate rose ${withUnit(diff, 'bpm')} — your body may be carrying fatigue.`; cand.fix = 'Make one session an easy one — resting heart rate rose this week.'; }
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
 *                 alone rates it (down at a sane pace good, flat mixed, wrong
 *                 way / too fast tough).
 *  - endurance:   running distance vs the bar for THAT week (>= 90% good,
 *                 >= 60% mixed, else tough). The bar is the week's safe step —
 *                 ~10% over the week before, never past the goal (the same
 *                 `weekStepOrGoalKm` the goal card showed while the week was
 *                 under way) — so a runner who followed the plan is not marked
 *                 down against the full goal; the goal itself when no step
 *                 applies (no running measured the week before, or the step
 *                 reaches the goal). A SPIKE — km more than 30% AND at least
 *                 3 km (2 mi) above that step — is never "on plan": it rates
 *                 mixed (safety, not praise) with its own gap. A tough sessions
 *                 count (vs the sessions target) pulls it down a level. Without a distance target (or
 *                 any measured distance) the sessions rating is used; neither
 *                 -> null. With a race date, a TAPER / RACE-WEEK / RECOVERY week
 *                 (race phase read on the week's Monday) is graded against that
 *                 phase's own target instead (see `windDownWeekAssessment`):
 *                 no growth step, no spike guard, and sessions never pull it down.
 *  - general:     active days (3+ good, 2 mixed, else tough).
 *  - 'light' (muscle): a deliberate lighter week — logged training volume
 *    under 60% of the prior 4-week average (the shared isDeload) while the
 *    user still trained and did not miss the sessions target by more than
 *    one. A missed week is not a deload.
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
/** Endurance: this week's running distance as a share of the weekly target. */
const DISTANCE_GOOD_FRACTION = 0.9;
const DISTANCE_MIXED_FRACTION = 0.6;
/** Endurance spike: running km above the week's step by more than this fraction AND by at least the minimum excess (3 km / 2 mi). */
const SPIKE_OVER_STEP_FRACTION = 0.3;
const SPIKE_MIN_EXCESS_KM = 3;
const SPIKE_MIN_EXCESS_MI = 2;
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

/** Logged strength volume this week under 60% of the prior 4-week average (shared isDeload). No logged volume this week is "no data", not a deload. */
function isLighterWeek(input: WeeklyReviewInput, week: Week): boolean {
  const volume = totalVolumeByWeek(input.progression);
  return (volume[week.days[0]] ?? 0) > 0 && isDeload(volume, week.days[0], 1);
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
  /**
   * Endurance, good week only: the distance build still under way (the week met
   * its safe step, but that step — and so the week — is below the goal). Not a
   * gap (the week was good, so no Slip); "Next week" continues the build.
   */
  build?: Extract<WeekGap, { kind: 'distance' }> | null;
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
  if (count > 0 && sessions !== 'tough' && isLighterWeek(input, week)) return { rating: 'light', gap: null };
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
  const days = budgetDays(input, week);
  const weightTone = weightCandidate(input, week, prevWeek)?.stat.tone ?? null;
  if (days) {
    const level: RatingLevel =
      days.hit * 7 >= days.logged * BUDGET_GOOD_DAYS_OF_7 ? 'good'
      : days.hit * 7 >= days.logged * BUDGET_MIXED_DAYS_OF_7 ? 'mixed'
      : 'tough';
    // Budget days are the gap while they fall short; the weight trend only when it alone pulled a good budget week down.
    const gap: WeekGap | null = level !== 'good' ? { kind: 'budget', inBudget: days.hit, logged: days.logged } : weightGap(input, week, prevWeek);
    return rated(weightTone === 'watch' ? levelDown(level) : level, gap);
  }
  if (weightTone == null) return UNRATED;
  return rated(weightTone === 'good' ? 'good' : weightTone === 'watch' ? 'tough' : 'mixed', weightGap(input, week, prevWeek));
}

/**
 * The bar the reviewed week's running km is graded against, in km (<= the
 * goal): that week's safe step from the week BEFORE it — the same number the
 * goal card showed while the week was under way — or the goal itself when no
 * step applies (see `weekStepOrGoalKm`).
 */
function weekStepKm(input: WeeklyReviewInput, prevWeek: Week, targetKm: number): number {
  return weekStepOrGoalKm(runningKm(input, prevWeek), targetKm, isImperial(input) ? 1 / KM_PER_MILE : 1);
}

/**
 * A jump, not a good week: running km more than 30% above the week's step AND
 * at least 3 km (2 mi) over it. Only when a step below the goal applies — with
 * the goal as the bar, going past it is simply a hit target.
 */
function isSpikeWeek(input: WeeklyReviewInput, km: number, stepKm: number, targetKm: number): boolean {
  if (stepKm >= targetKm) return false;
  const imperial = isImperial(input);
  const excess = (km - stepKm) * (imperial ? KM_TO_MI : 1);
  return km > stepKm * (1 + SPIKE_OVER_STEP_FRACTION) && excess >= (imperial ? SPIKE_MIN_EXCESS_MI : SPIKE_MIN_EXCESS_KM);
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

/**
 * Rate a taper / race-week / recovery week against ITS target (not the growth
 * step, no spike guard — those are build-phase rules), with the ONE band rule
 * the goal card's verdict also uses (`windDownBand`, lib/enduranceProgression.ts):
 *  - taper: on plan from 60% of the target up to 25% over it (and under 3 km /
 *    2 mi over); far over is a slip, far under a milder one;
 *  - race week and recovery: the target is a ceiling — at or under it (10%
 *    slack) is good, running more is mixed ("Ran X km — recovery weeks are easy").
 * Sessions counts never pull these weeks down. Unrated without a target or any
 * measured running.
 */
function windDownWeekAssessment(input: WeeklyReviewInput, week: Week, prevWeek: Week, plan: WindDownPlan): WeekAssessment {
  const measured = windDownRunningKm(input, week, plan);
  if (plan.targetKm == null || (measured == null && runningKm(input, prevWeek) == null)) return UNRATED;
  const km = measured ?? 0;
  const targetKm = plan.targetKm;
  const gap = (over: boolean): WeekGap => ({ kind: 'phase', phase: plan.phase, doneKm: round1(km), targetKm, over });
  const band = windDownBand(plan.phase, km, targetKm, { unitsPerKm: isImperial(input) ? 1 / KM_PER_MILE : 1 });
  return band === 'within' ? rated('good', null) : rated('mixed', gap(band === 'over'));
}

function enduranceWeekAssessment(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekAssessment {
  const plan = windDownPlan(input, week.days[0]);
  // A taper / race / recovery week is never rated on its session count (fewer sessions are the plan): with no distance target it is unrated.
  if (plan != null) return hasDistanceTarget(input) ? windDownWeekAssessment(input, week, prevWeek, plan) : UNRATED;
  const count = weekSessionCount(input, week);
  const sessionsTarget = input.weeklySessionsTarget;
  const sessions = sessionsLevel(count, sessionsTarget);
  const sessionsGap: WeekGap | null = sessionsTarget != null && count < sessionsTarget ? { kind: 'sessions', done: count, target: sessionsTarget } : null;
  const target = input.weeklyDistanceKmTarget;
  const cur = runningKm(input, week);
  // A week with no run is a measured 0 km only when the week before did carry a distance.
  if (target != null && target > 0 && (cur != null || runningKm(input, prevWeek) != null)) {
    const km = cur ?? 0;
    // Graded against that week's safe step when it was below the goal (the step is the goal otherwise).
    const stepKm = weekStepKm(input, prevWeek, target);
    const stepped = stepKm < target;
    const frac = km / stepKm;
    const spike = isSpikeWeek(input, km, stepKm, target);
    const distance: RatingLevel = spike ? 'mixed' : frac >= DISTANCE_GOOD_FRACTION ? 'good' : frac >= DISTANCE_MIXED_FRACTION ? 'mixed' : 'tough';
    // Distance off the bar (a jump over it, or short of it) is the gap; a tough sessions count only when distance alone was fine.
    const gap: WeekGap | null = spike
      ? { kind: 'spike', doneKm: round1(km), stepKm, targetKm: target }
      : distance !== 'good'
        ? { kind: 'distance', doneKm: round1(km), targetKm: target, ...(stepped ? { stepKm } : {}) }
        : sessionsGap;
    const assessment = rated(sessions === 'tough' ? levelDown(distance) : distance, gap);
    // Met the step but not the goal yet: no gap, yet the build goes on next week.
    const build: WeekAssessment['build'] = assessment.rating === 'good' && stepped && km < target
      ? { kind: 'distance', doneKm: round1(km), targetKm: target }
      : null;
    return { ...assessment, build };
  }
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
    case 'endurance': return enduranceWeekAssessment(input, week, prevWeek);
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
    case 'weight_loss': order = ['weight', 'budget', 'avgKcal', 'sessions']; break;
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
function distanceHeadline(input: WeeklyReviewInput, km: number, targetKm: number, stepKm: number): string {
  if (isSpikeWeek(input, km, stepKm, targetKm)) {
    return `${distanceNumber(input, km)} of ~${distanceText(input, stepKm)} — well above the safe step · goal ${distanceText(input, targetKm)}`;
  }
  if (stepKm >= targetKm || km >= targetKm) return `${distanceNumber(input, km)} of ${distanceText(input, targetKm)}`;
  const onPlan = distanceNumber(input, km) >= distanceNumber(input, stepKm);
  return `${distanceNumber(input, km)} of ~${distanceText(input, stepKm)}${onPlan ? ' — on plan' : ''} · goal ${distanceText(input, targetKm)}`;
}

/** "21 of ~24 km — taper week" / "12 of ~16 km before the race — race week" / "9 of up to 16 km — recovery week". */
function windDownHeadline(input: WeeklyReviewInput, phase: WindDownPlan['phase'], km: number, targetKm: number): string {
  const done = distanceNumber(input, km);
  const target = distanceText(input, targetKm);
  switch (phase) {
    case 'taper': return `${done} of ~${target} — taper week`;
    case 'race_week': return `${done} of ~${target} before the race — race week`;
    case 'recovery': return `${done} of up to ${target} — recovery week`;
  }
}

/** The Win line of a taper / race / recovery week that stayed on its plan; null otherwise. */
function windDownWin(input: WeeklyReviewInput, week: Week, assessment: WeekAssessment): string | null {
  const plan = windDownPlan(input, week.days[0]);
  if (assessment.rating !== 'good' || plan == null || plan.targetKm == null || !hasDistanceTarget(input)) return null;
  const km = distanceText(input, windDownRunningKm(input, week, plan) ?? 0);
  const target = distanceText(input, plan.targetKm);
  switch (plan.phase) {
    case 'taper': return `Taper on plan: ${km} against a ~${target} target.`;
    case 'race_week': return `Race week stayed light: ${km} before the race.`;
    case 'recovery': return `Recovery week kept easy: ${km} (ceiling ${target}).`;
  }
}

function buildHeadline(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week): string {
  const by = (label: string): WeeklyReviewStat | undefined => cands.find(x => x.stat.label === label)?.stat;
  const parts: string[] = [];
  const weight = by(WEIGHT_STAT_LABEL);
  const sessions = cands.find(x => ['Workouts', 'Sessions', 'Active days'].includes(x.stat.label))?.stat;
  const sessionCount = (s: WeeklyReviewStat) => `${s.value} ${plural(Number(s.value), 'workout')}`;

  if (input.goal === 'weight_loss') {
    if (weight) {
      const rounded = weight.value;
      parts.push(rounded.startsWith('−') ? `Down ${rounded.slice(1)}` : rounded.startsWith('+') ? `Up ${rounded.slice(1)}` : 'Weight steady');
    }
    const budget = by('Days in budget');
    if (budget) parts.push(`in budget ${budget.value.replace('/', ' of ')} ${loggedWord(budget)}days`);
    else if (sessions) parts.push(sessionCount(sessions));
  } else if (input.goal === 'muscle') {
    if (sessions) {
      parts.push(sessions.comparison?.startsWith('target ')
        ? `${sessions.value} of ${sessions.comparison.split(' ')[1]} sessions`
        : `${sessions.value} ${plural(Number(sessions.value), 'session')}`);
    }
    const lift = cands.find(x => x.stat.label.endsWith('est. 1RM'))?.stat;
    const protein = by('Protein days hit');
    if (lift && lift.tone === 'good') {
      // The lift change is a 4-week number inside a one-week sentence: say so.
      const window = lift.comparison?.includes('4 weeks') ? `over ${withUnit(4, 'wks')}` : 'vs last trained wk';
      parts.push(`${lift.label} ${lift.value} ${window}`);
    }
    else if (protein) parts.push(`protein ${protein.value.replace('/', ' of ')} ${loggedWord(protein)}days`);
    else if (weight) parts.push(`weight ${weight.value}`);
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
        const stepKm = hasDistanceTarget(input) ? weekStepKm(input, prevWeek, target) : target;
        const value = hasDistanceTarget(input) && kmBased && km != null
          ? distanceHeadline(input, km, target, stepKm)
          : volume.value;
        // A spike's headline already says it is a jump: no "+186% vs last week" on top (and it would overrun the headline limit).
        const spike = hasDistanceTarget(input) && kmBased && km != null && isSpikeWeek(input, km, stepKm, target);
        parts.push(!spike && volume.comparison && volume.comparison.includes('%') ? `${value}, ${volume.comparison}` : value);
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
    case 'sessions': return countSlip(gap.done, gap.target, plural(gap.target, 'session'));
    case 'activeDays': return countSlip(gap.done, gap.target, `active ${plural(gap.target, 'day')}`);
    case 'distance':
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
      return weightCandidate(input, week, prevWeek)?.slip ?? 'Your weight trend barely moved this week.';
  }
}

/** Slip: the gap for a mixed / tough week; nothing for a deliberate lighter week; the existing candidate logic for good / unrated weeks. */
function buildSlip(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week, assessment: WeekAssessment): string | null {
  if (assessment.rating === 'light') return null;
  if ((assessment.rating === 'mixed' || assessment.rating === 'tough') && assessment.gap) {
    return gapSlip(input, assessment.gap, week, prevWeek);
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

/** Generic, goal-keyed action used when no gap or fix applies, or a derived suggestion would just repeat the slip. */
function fallbackNextWeek(input: WeeklyReviewInput, week: Week): string {
  switch (input.goal) {
    case 'weight_loss': return 'Weigh in at least 3 mornings and log dinner each day so next week reads clearly.';
    case 'muscle':
      // "Log every working set…" is for sparse loggers only; someone who logged sets/meals most of the week already does.
      return loggedDayCount(input, week) >= MIN_LOGGED_DAYS_FOR_NO_LOG_ADVICE
        ? 'Keep the same session days and try to add a rep or a little weight on your main lifts.'
        : 'Log every working set and a weigh-in or two so we can see your lifts and weight move.';
    case 'endurance': return 'Keep sessions easy and regular, and wear your watch so volume and resting HR show up.';
    default: return 'Pick two fixed activity days next week and put them on the calendar.';
  }
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
/** Tie-break order (Monday = 0) for the day to add a session on: Saturday, then mid-week, before Monday. */
const EXTRA_SESSION_DAY_ORDER = [5, 3, 1, 6, 4, 2, 0];

/** The weekday with the fewest sessions across the reviewed week and the one before it (ties: Saturday first), e.g. "Saturday". */
function freestWeekday(input: WeeklyReviewInput, week: Week, prevWeek: Week): string {
  const train = new Set(sessionDays(input));
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const w of [prevWeek, week]) w.days.forEach((d, i) => { if (train.has(d)) counts[i] += 1; });
  const fewest = Math.min(...counts);
  return WEEKDAY_NAMES[EXTRA_SESSION_DAY_ORDER.find(i => counts[i] === fewest) as number];
}

/**
 * "Next week" for a distance gap: build toward the weekly target without a
 * jump. Next week's distance is capped at ~10% over this week (the shared
 * rule in lib/enduranceProgression.ts, in the user's unit — the same step
 * goalProgress shows as `distance.stepTargetKm` for the week now under way);
 * the long run grows by at most 2 km and never past its peak target; the rest
 * of the growth goes to easy runs. Spells out the staging ("30 km the week
 * after") when the cap leaves the target out of reach for one more week.
 */
function distanceNextWeek(input: WeeklyReviewInput, gap: Extract<WeekGap, { kind: 'distance' }>): string {
  const imperial = isImperial(input);
  const unit = imperial ? 'mi' : 'km';
  const perKm = imperial ? KM_TO_MI : 1;
  const done = gap.doneKm * perKm;
  const target = gap.targetKm * perKm;
  const targetText = distanceText(input, gap.targetKm);

  // A week with (almost) no running has no base to take 10% of: restart gently.
  const next = weekStepTarget(done, target);
  if (next == null) return `Restart with a couple of easy runs, then build gradually toward ${targetText}.`;
  const staged = next < target;
  const nextKm = next / perKm;

  // Long run: +2 km at most, never above the peak target; none without long-run data.
  let longRunPart: string | null = null;
  const lr = input.longRun;
  if (lr != null && Number.isFinite(lr.lastKm) && lr.lastKm > 0) {
    const peak = lr.targetPeakKm;
    const longKm = longRunStepKm(lr.lastKm, peak);
    if (!longRunAtPeak(lr.lastKm, peak)) {
      if (longKm < nextKm) longRunPart = `long run ${distanceText(input, longKm)}, the rest mostly easy runs`;
    } else if (peak != null && peak < nextKm) {
      longRunPart = `hold your long run at ${distanceText(input, peak)} and put the growth into easy runs`;
    }
  }

  if (!staged) return `Aim for ${targetText}: ${longRunPart ?? 'add the extra on easy runs'}.`;

  const nextText = `~${withUnit(next, unit)}`;
  const reachesTarget = Math.round(next * (1 + WEEKLY_DISTANCE_GROWTH)) >= target;
  const after = reachesTarget ? `${targetText} the week after` : `then add ~${Math.round(WEEKLY_DISTANCE_GROWTH * 100)}% a week toward ${targetText}`;
  return `Build to ${nextText}${longRunPart ? `: ${longRunPart}` : ' with mostly easy runs'}; ${after}.`;
}

/**
 * "Next week" after a spike: hold roughly at the safe step, then build. The
 * number comes from the shared rule applied to the STEP (what the runner should
 * have run), never to the spike, so a jump never ratchets next week's target up.
 */
function spikeNextWeek(input: WeeklyReviewInput, gap: Extract<WeekGap, { kind: 'spike' }>): string {
  const unit = isImperial(input) ? 'mi' : 'km';
  const stepShown = distanceNumber(input, gap.stepKm);
  const targetShown = distanceNumber(input, gap.targetKm);
  const next = weekStepTarget(stepShown, targetShown);
  const targetText = distanceText(input, gap.targetKm);
  if (next == null) return `Keep next week close to ${distanceText(input, gap.stepKm)}, then build gradually toward ${targetText}.`;
  if (next >= targetShown) return `Hold at ${targetText} next week rather than going higher.`;
  return `Hold around ~${withUnit(next, unit)} next week, then build ~${Math.round(WEEKLY_DISTANCE_GROWTH * 100)}% a week toward ${targetText}.`;
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
  const coming = windDownPlan(input, addDays(week.days[0], 7));
  if (coming != null) {
    const target = coming.targetKm != null ? distanceText(input, coming.targetKm) : null;
    switch (coming.phase) {
      case 'taper':
        return target != null
          ? `Taper: ~${target} next week — keep a little intensity, cut volume.`
          : 'Taper: cut volume next week, keep a little intensity.';
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

/** "Next week" for a mixed / tough week: the concrete action that closes the gap the Slip names. */
function gapNextWeek(input: WeeklyReviewInput, gap: WeekGap, week: Week, prevWeek: Week): string {
  switch (gap.kind) {
    case 'sessions':
    case 'activeDays': {
      const sessions = gap.kind === 'sessions';
      const missing = gap.target - gap.done;
      const day = freestWeekday(input, week, prevWeek);
      const book = sessions ? `Book ${gap.target} ${plural(gap.target, 'session')}` : `Plan ${gap.target} active ${plural(gap.target, 'day')}`;
      return missing === 1
        ? `${book} — put the missed one on ${day}.`
        : `${book} — lock in the missed ones now, starting with ${day}.`;
    }
    case 'distance': return distanceNextWeek(input, gap);
    case 'spike': return spikeNextWeek(input, gap);
    // Normally answered by the coming week's phase (`windDownNextWeek`); this is the safety net.
    case 'phase': return windDownNextWeek(input, week) ?? fallbackNextWeek(input, week);
    case 'budget': return 'Pick the two days most likely to run over and plan those meals ahead.';
    case 'protein': return 'Add a protein-first breakfast so the day starts ahead of your target.';
    case 'weight':
      return gap.deltaKg < 0
        ? 'Eat up to your full calorie target each day — a slower loss is easier to keep.'
        : 'Hold to your calorie target each day and weigh in at least 3 mornings so the trend reads clearly.';
  }
}

/** nextWeek is an action derived from the gap / slip — never a copy of the slip. */
function buildNextWeek(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week, assessment: WeekAssessment, slip: string | null): string {
  const next = buildNextWeekRaw(input, cands, week, prevWeek, assessment);
  return slip != null && normalizeSentence(next) === normalizeSentence(slip) ? fallbackNextWeek(input, week) : next;
}

const WEEKEND_NEXT_WEEK = "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.";

function buildNextWeekRaw(input: WeeklyReviewInput, cands: Candidate[], week: Week, prevWeek: Week, assessment: WeekAssessment): string {
  const { rating, gap, build } = assessment;
  // The race lifecycle (taper / race week / recovery, and the step back to building) owns "Next week" in its weeks.
  const windDown = windDownNextWeek(input, week);
  if (windDown != null) return windDown;
  const weekend = input.goal === 'weight_loss' || input.goal === 'muscle' ? weekendGap(input, week) : null;
  const weekendHigh = weekend != null && weekend >= WEEKEND_GAP_MIN_KCAL;
  const recovery = recoveryFlags(input, week);
  const lighter = recovery.length >= 2
    ? `Go lighter next week and put sleep first — ${(recovery.length === 2 ? recovery.join(' and ') : `${recovery.slice(0, -1).join(', ')} and ${recovery[recovery.length - 1]}`)}.`
    : null;

  if (rating === 'mixed' || rating === 'tough' || rating === 'light') {
    // A budget gap with a heavy weekend is closed by planning the weekend.
    if (gap?.kind === 'budget' && weekendHigh) return WEEKEND_NEXT_WEEK;
    if (lighter) return lighter;
    if (rating === 'light') return 'Back to full volume next week: your usual sessions and loads.';
    if (gap) return gapNextWeek(input, gap, week, prevWeek);
    return fallbackNextWeek(input, week);
  }

  if (weekendHigh) return WEEKEND_NEXT_WEEK;
  if (lighter) return lighter;
  // A good endurance week that met its step but is still below the goal: the build goes on (same rule as a short week's).
  if (rating === 'good' && build) return distanceNextWeek(input, build);
  const fix = cands.find(x => x.stat.tone === 'watch' && x.fix)?.fix;
  if (fix) return fix;
  // "Repeat" is only for a week that was itself good (and a goal verdict that isn't saying otherwise).
  const goodVerdict = ['on_track', 'ahead', 'progressing', 'building', 'reached'].includes(input.verdict);
  if (rating === 'good' && goodVerdict) return 'Repeat this week: same routine, same training days.';
  return fallbackNextWeek(input, week);
}

function emptyReview(input: WeeklyReviewInput, week: Week, daysWithData: number, statCount: number): WeeklyReview {
  return {
    weekStart: week.days[0],
    weekEnd: week.days[6],
    goal: input.goal,
    verdict: input.verdict,
    weekRating: null,
    weekGap: null,
    headline: 'Not enough data for a weekly review yet',
    stats: [],
    win: null,
    slip: null,
    nextWeek: 'Log meals, weigh-ins or workouts on a few days and your review will fill in next Monday.',
    dataSufficiency: { daysWithData, statCount, sufficient: false },
  };
}

export function computeWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
  const week = makeWeek(input.weekStart, input.signupDay);
  const prevWeek = makeWeek(addDays(input.weekStart, -7), input.signupDay);
  const daysWithData = countDataDays(input, week);
  const cands = buildCandidates(input, week, prevWeek);

  if (daysWithData < MIN_DATA_DAYS || cands.length < MIN_STATS) {
    return emptyReview(input, week, daysWithData, cands.length);
  }

  // ONE assessment of the week decides the pill (rating), the Slip line and "Next week".
  const assessment = assessWeek(input, week, prevWeek);
  const slip = buildSlip(input, cands, week, prevWeek, assessment);
  return {
    weekStart: week.days[0],
    weekEnd: week.days[6],
    goal: input.goal,
    verdict: input.verdict,
    weekRating: assessment.rating,
    weekGap: assessment.gap,
    headline: buildHeadline(input, cands, week, prevWeek),
    stats: cands.map(x => x.stat),
    win: windDownWin(input, week, assessment) ?? cands.find(x => x.win)?.win ?? null,
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
