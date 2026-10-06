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
 * 'needs_target'.
 *
 * Per goal:
 *  - weight_loss — 4-week trend rate vs the 0.25–1.0 %bw/wk safe band; ETA only
 *    with >= 3 weigh-ins over >= 7 days and a rate in the right direction.
 *  - muscle — lift e1RM progression (top 3 lifts), weight gain band
 *    0.1–0.5 %bw/wk, sessions/week vs target, protein-target days.
 *  - endurance — training-volume trend, sessions/week vs target, resting HR /
 *    HRV direction. Verdict building/holding.
 *  - general — consistency: active days, sleep-goal nights, logging days.
 */

import type { WeightReading } from './weightTrend';
import { computeWeightTrend, trendDeltaKgPerWeek, trendSpanDays } from './weightTrend';
import {
  assessWeightSignals,
  PARTIAL_LOG_KCAL_THRESHOLD,
  PLATEAU_MAX_PCT_PER_WEEK,
  PLATEAU_MIN_SPAN_DAYS,
  TOO_FAST_LOSS_PCT_PER_WEEK,
  type WeightSignal,
} from './brain/weightSignals';
import type { ProgressionSummary } from './workoutRepository';

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
export const HEADLINE_MAX_CHARS = 70;

// ── Types ───────────────────────────────────────────────────────────────────

export type GoalKind = 'weight_loss' | 'muscle' | 'endurance' | 'general';

export type GoalVerdict =
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

export interface GoalProgressReason {
  kind: string;
  text: string;
  tone: ReasonTone;
}

export interface GoalProgress {
  goal: GoalKind;
  target: { weightKg: number | null; date: string | null; weeklySessions: number | null };
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
  dataSufficiency: { weighIns: number; needed: number; sessionsLast28d: number };
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
  target: { weightKg: number | null; date: string | null; weeklySessions: number | null };
  start: { weightKg: number | null; startedAt: string | null };
  /** Raw weigh-ins; ~90 days gives the EWMA run-in room. */
  weightReadings: WeightReading[];
  /** Resolved intake for the trailing 28 local days (any order). */
  intakeDays: GoalProgressIntakeDay[];
  budget: GoalProgressBudget | null;
  progression: ProgressionSummary;
  /** Distinct local days with a completed session (logged strength set or real HealthKit workout), trailing 28 days. */
  trainingDays: string[];
  /** HealthKit workouts, trailing 28 days (durationMin null when unknown). */
  workouts: Array<{ day: string; durationMin: number | null }>;
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

export const KG_TO_LB = 2.20462;

/** A kg value converted to the input's display unit and rounded, no unit suffix. */
function weightNum(input: GoalProgressInput, kg: number, digits: 1 | 2 = 1): number {
  const v = input.unitSystem === 'imperial' ? kg * KG_TO_LB : kg;
  return digits === 2 ? round2(v) : round1(v);
}

/** Formats a kg value in the input's display unit, e.g. "72.5 kg" / "159.8 lb". */
function fmtWeight(input: GoalProgressInput, kg: number, digits: 1 | 2 = 1): string {
  return `${weightNum(input, kg, digits)} ${input.unitSystem === 'imperial' ? 'lb' : 'kg'}`;
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
  /** Target reached for this goal's direction (null when no target weight / no current weight). */
  reached: boolean | null;
  /** targetWeight - current trend (signed), null when unknown. */
  neededKg: number | null;
  eta: string | null;
  onPace: boolean | null;
}

function buildWeightBlock(input: GoalProgressInput): WeightBlock {
  const trend = computeWeightTrend(input.weightReadings);
  const days = trend.days;
  const weighIns = days.length;
  const spanDays = trendSpanDays(days);
  const rateReliable = weighIns >= WEIGH_INS_NEEDED && spanDays >= RATE_MIN_SPAN_DAYS;
  const currentKg = days.length > 0 ? days[days.length - 1].trendKg : null;

  const rateKg = rateReliable ? trendDeltaKgPerWeek(days, RATE_WINDOW_DAYS) : null;
  const pctBw = rateKg != null && currentKg != null && currentKg > 0 ? (rateKg / currentKg) * 100 : null;

  const targetKg = input.target.weightKg;
  const neededKg = currentKg != null && targetKg != null ? targetKg - currentKg : null;

  let reached: boolean | null = null;
  if (neededKg != null) {
    if (Math.abs(neededKg) < 0.1) reached = true;
    else if (input.goal === 'weight_loss') reached = neededKg > 0;
    else if (input.goal === 'muscle') reached = neededKg < 0;
    else reached = false;
  }

  // ETA only with a reliable rate pointing toward the target, a meaningful
  // (non-plateau) pace, and a sane horizon.
  let eta: string | null = null;
  if (
    reached === false && neededKg != null && rateKg != null && pctBw != null &&
    Math.sign(rateKg) === Math.sign(neededKg) && Math.abs(pctBw) > PLATEAU_MAX_PCT_PER_WEEK
  ) {
    const daysToGo = Math.ceil((Math.abs(neededKg) / Math.abs(rateKg)) * 7);
    if (daysToGo <= MAX_ETA_DAYS) eta = addDays(input.todayKey, daysToGo);
  }

  let onPace: boolean | null = null;
  if (input.target.date != null) {
    if (reached === true) onPace = true;
    else if (eta != null) onPace = eta <= input.target.date;
    else if (reached === false && rateReliable) onPace = false; // moving the wrong way / flat
  }

  return { weighIns, spanDays, rateReliable, trend, currentKg, rateKg, pctBw, reached, neededKg, eta, onPace };
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
  let text = `Trend weight ${dir} ${fmtWeight(input, Math.abs(w.rateKg), 2)}/wk (${round2(abs)}% of bodyweight) over 4 weeks`;
  let tone: ReasonTone = 'neutral';
  if (band) {
    const wantedDir = input.goal === 'weight_loss' ? w.rateKg < 0 : w.rateKg > 0;
    if (wantedDir && abs >= band.minPct && abs <= band.maxPct) {
      tone = 'good';
      text += `, inside the ${band.minPct}–${band.maxPct}% safe band`;
    } else if (wantedDir && abs > band.maxPct) {
      tone = 'watch';
      text += `, faster than the ${band.maxPct}% a week ceiling`;
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
    text: `Stayed within your ${fmtKcal(target)} kcal target on ${hit} of ${logged.length} logged ${plural(logged.length, 'day')} this week`,
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
          text: `Weekends average ${fmtKcal(Number(wk.facts.weekendAvgKcal))} kcal vs ${fmtKcal(Number(wk.facts.weekdayAvgKcal))} on weekdays`,
          tone: 'watch',
        }
      : null,
    underEating: ue
      ? {
          kind: 'under_eating',
          text: `Average intake of ${fmtKcal(Number(ue.facts.avgKcal))} kcal is under the ${fmtKcal(Number(ue.facts.floorKcal))} kcal safe floor`,
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
    text: `Your logs suggest you burn about ${fmtKcal(b.learnedTdee)} kcal a day, ${fmtKcal(Math.abs(gap))} ${gap < 0 ? 'less' : 'more'} than the ${fmtKcal(b.formulaTdee)} formula estimate`,
    tone: 'neutral',
  };
}

function sessionsPerWeek(input: GoalProgressInput): { count: number; perWeek: number } {
  const count = new Set(input.trainingDays.filter(d => inLastDays(d, input.todayKey, 28))).size;
  return { count, perWeek: round1(count / 4) };
}

function sessionsReason(input: GoalProgressInput): GoalProgressReason | null {
  const { count, perWeek } = sessionsPerWeek(input);
  const target = input.target.weeklySessions;
  if (count === 0) {
    return { kind: 'sessions', text: 'No training sessions logged in the last 4 weeks', tone: 'watch' };
  }
  if (target == null) {
    return { kind: 'sessions', text: `Averaging ${perWeek} sessions a week over the last 4 weeks`, tone: 'neutral' };
  }
  return {
    kind: 'sessions',
    text: `Averaging ${perWeek} sessions a week vs your target of ${target}`,
    tone: perWeek >= target ? 'good' : perWeek >= target * 0.75 ? 'neutral' : 'watch',
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
    text: `Hit your ${Math.round(target)} g protein target on ${hit} of ${logged.length} logged ${plural(logged.length, 'day')} this week`,
    tone: frac >= 0.7 ? 'good' : frac < 0.5 ? 'watch' : 'neutral',
  };
}

// ── Lift progression (muscle) ───────────────────────────────────────────────

interface LiftChange {
  exercise: string;
  totalSets: number;
  /** e1RM at the earliest week within the last ~5 weeks vs the latest week; null when < 2 weeks. */
  startKg: number | null;
  endKg: number | null;
  change4wKg: number | null;
  /** Best e1RM in the last 3 weeks minus the best before; null when either side is missing. */
  gain3wKg: number | null;
}

function liftChanges(progression: ProgressionSummary, todayKey: string): LiftChange[] {
  const out: LiftChange[] = [];
  const windowStart = addDays(todayKey, -35);
  const recentStart = addDays(todayKey, -21);
  for (const [exercise, weeks] of Object.entries(progression)) {
    const withE1rm = weeks.filter(w => w.bestEstimatedOneRepMaxKg != null);
    if (withE1rm.length === 0) continue;
    const totalSets = weeks.reduce((s, w) => s + w.totalSets, 0);

    const inWindow = withE1rm.filter(w => w.weekStart >= windowStart);
    let startKg: number | null = null;
    let endKg: number | null = null;
    let change4wKg: number | null = null;
    if (inWindow.length >= 2) {
      startKg = inWindow[0].bestEstimatedOneRepMaxKg as number;
      endKg = inWindow[inWindow.length - 1].bestEstimatedOneRepMaxKg as number;
      change4wKg = round1(endKg - startKg);
    }

    const prior = withE1rm.filter(w => w.weekStart < recentStart).map(w => w.bestEstimatedOneRepMaxKg as number);
    const recent = withE1rm.filter(w => w.weekStart >= recentStart).map(w => w.bestEstimatedOneRepMaxKg as number);
    const gain3wKg = prior.length > 0 && recent.length > 0 ? round1(Math.max(...recent) - Math.max(...prior)) : null;

    out.push({ exercise, totalSets, startKg, endKg, change4wKg, gain3wKg });
  }
  return out.sort((a, b) => b.totalSets - a.totalSets || a.exercise.localeCompare(b.exercise)).slice(0, 3);
}

function liftReason(l: LiftChange, input: GoalProgressInput): GoalProgressReason | null {
  if (l.change4wKg == null || l.startKg == null || l.endKg == null) return null;
  const sign = l.change4wKg > 0 ? '+' : l.change4wKg < 0 ? '−' : '';
  return {
    kind: 'lift',
    text: `${l.exercise} estimated 1RM ${sign}${fmtWeight(input, Math.abs(l.change4wKg))} over 4 weeks (${weightNum(input, l.startKg)} → ${fmtWeight(input, l.endKg)})`,
    tone: l.change4wKg > 0 ? 'good' : l.change4wKg < 0 ? 'watch' : 'neutral',
  };
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
    text: `Resting heart rate ${dir}: ${round1(p)} → ${round1(r)} bpm (last 2 weeks vs the 2 before)`,
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
    text: `HRV ${dir}: ${Math.round(p)} → ${Math.round(r)} ms (last 2 weeks vs the 2 before)`,
    tone: pct >= HRV_DIRECTION_PCT ? 'good' : pct <= -HRV_DIRECTION_PCT ? 'watch' : 'neutral',
  };
}

// ── Per-goal verdicts ───────────────────────────────────────────────────────

interface Outcome {
  verdict: GoalVerdict;
  headline: string;
  reasons: GoalProgressReason[];
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

function fatLossOutcome(input: GoalProgressInput, w: WeightBlock): Outcome {
  if (input.target.weightKg == null) {
    return { verdict: 'needs_target', headline: 'Set a target weight to track your fat-loss progress', reasons: [] };
  }
  if (!w.rateReliable || w.currentKg == null || w.rateKg == null || w.pctBw == null) {
    return insufficientWeightOutcome(w);
  }

  const today = input.todayKey;
  const targetKg = input.target.weightKg;
  const signals = assessWeightSignals({
    trend: w.trend,
    dailyIntakeKcal: toSignalPoints(lastSevenIntake(input)),
    floorKcal: input.budget?.floorKcal ?? 0,
    goal: input.goal,
    weekendPatternIntakeKcal: toSignalPoints(input.intakeDays),
  });
  const { weekend, underEating } = signalReasons(signals);
  const rate = rateReason(input, w, FAT_LOSS_BAND);
  const adherence = calorieAdherenceReason(input);
  const tdee = tdeeReason(input);
  const toGo = Math.abs(w.neededKg ?? 0);
  const absPct = Math.abs(w.pctBw);

  // Priority: the rate itself first, then anything worth a "watch", then the rest.
  const watchFirst = (...rs: Array<GoalProgressReason | null>) =>
    capReasons([rate, ...rs.filter(r => r?.tone === 'watch'), ...rs.filter(r => r?.tone !== 'watch')]);
  const reasons = watchFirst(underEating, adherence, weekend, tdee);

  if (w.reached) {
    return {
      verdict: 'ahead',
      headline: clip(`Target reached — trend ${fmtWeight(input, w.currentKg)} vs ${fmtWeight(input, targetKg)} goal`),
      reasons,
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
  const when = fmtDate(w.eta, today);
  if (input.target.date != null) {
    if (w.eta <= addDays(input.target.date, -AHEAD_MARGIN_DAYS)) {
      return { verdict: 'ahead', headline: clip(`Ahead of pace — about ${fmtWeight(input, toGo)} to go, around ${when}`), reasons };
    }
    if (w.eta <= input.target.date) {
      return { verdict: 'on_track', headline: clip(`On track — about ${fmtWeight(input, toGo)} to go, around ${when}`), reasons };
    }
    return { verdict: 'behind', headline: clip(`Behind pace — about ${fmtWeight(input, toGo)} to go, around ${when}`), reasons };
  }
  if (absPct >= FAT_LOSS_BAND.minPct) {
    return { verdict: 'on_track', headline: clip(`On track — about ${fmtWeight(input, toGo)} to go, around ${when}`), reasons };
  }
  return { verdict: 'behind', headline: clip(`Slow pace — about ${fmtWeight(input, toGo)} to go, around ${when}`), reasons };
}

function muscleOutcome(input: GoalProgressInput, w: WeightBlock): Outcome {
  if (input.target.weightKg == null && input.target.weeklySessions == null) {
    return { verdict: 'needs_target', headline: 'Set a weekly session goal to track your progress', reasons: [] };
  }

  const lifts = liftChanges(input.progression, input.todayKey);
  const rate = rateReason(input, w, MUSCLE_GAIN_BAND);
  const sessions = sessionsReason(input);
  const protein = proteinReason(input);
  const liftReasons = lifts.map(l => liftReason(l, input)).filter((r): r is GoalProgressReason => r != null);
  const reasons = capReasons([liftReasons[0] ?? null, sessions, protein, rate, liftReasons[1] ?? null]);

  if (w.reached) {
    return {
      verdict: 'ahead',
      headline: clip(`Target weight reached — trend ${fmtWeight(input, w.currentKg as number)}`),
      reasons,
    };
  }

  if (w.pctBw != null && w.pctBw > MUSCLE_GAIN_BAND.maxPct) {
    return {
      verdict: 'too_fast',
      headline: clip(`Gaining too fast — ${round1(w.pctBw)}% of bodyweight a week`),
      reasons,
    };
  }

  const comparable = lifts.filter(l => l.gain3wKg != null);
  if (comparable.length > 0) {
    const best = comparable.reduce((a, b) => ((b.gain3wKg as number) > (a.gain3wKg as number) ? b : a));
    if ((best.gain3wKg as number) > 0) {
      return {
        verdict: 'progressing',
        headline: clip(`Progressing — ${best.exercise} estimated 1RM up ${fmtWeight(input, best.gain3wKg as number)}`),
        reasons,
      };
    }
    return { verdict: 'stalled', headline: 'Stalled — no lift has set a new best in 3 weeks', reasons };
  }

  if (w.pctBw != null) {
    if (w.pctBw >= MUSCLE_GAIN_BAND.minPct) {
      return {
        verdict: 'progressing',
        headline: clip(`Progressing — weight up ${round2(w.pctBw)}% a week, inside the gain band`),
        reasons,
      };
    }
    return { verdict: 'stalled', headline: clip(`Stalled — weight is not trending up (${round2(w.pctBw)}% a week)`), reasons };
  }

  return {
    verdict: 'insufficient_data',
    headline: 'Log a few more lifts or weigh-ins to see your progress',
    reasons,
  };
}

function enduranceOutcome(input: GoalProgressInput): Outcome {
  if (input.target.weeklySessions == null) {
    return { verdict: 'needs_target', headline: 'Set a weekly session goal to track your training', reasons: [] };
  }

  const { count, perWeek } = sessionsPerWeek(input);
  const sessions = sessionsReason(input);
  if (count < MIN_SESSIONS_FOR_ENDURANCE) {
    return {
      verdict: 'insufficient_data',
      headline: 'Log a few more sessions to see your training trend',
      reasons: capReasons([sessions]),
    };
  }

  // Volume: weekly minutes when durations exist, else sessions per week.
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
    return { minutes, sessions: days.size };
  };
  const weeks = [wk(0), wk(1), wk(2), wk(3)];
  const useMinutes = weeks.reduce((s, x) => s + x.minutes, 0) > 0;
  const metric = (x: { minutes: number; sessions: number }) => (useMinutes ? x.minutes : x.sessions);
  const recent = metric(weeks[0]) + metric(weeks[1]);
  const prior = metric(weeks[2]) + metric(weeks[3]);
  const changePct = prior > 0 ? ((recent - prior) / prior) * 100 : null;
  const unit = useMinutes ? 'min' : 'sessions';
  const volumeReason: GoalProgressReason | null = prior > 0 || recent > 0
    ? {
        kind: 'volume',
        text: changePct != null
          ? `Weekly training ${useMinutes ? 'time' : 'sessions'} ${changePct >= 0 ? 'up' : 'down'} ${Math.round(Math.abs(changePct))}% (${round1(prior / 2)} → ${round1(recent / 2)} ${unit} a week, last 2 weeks vs the 2 before)`
          : `Training ${useMinutes ? 'time' : 'sessions'} restarted: ${round1(recent / 2)} ${unit} a week over the last 2 weeks after none before`,
        tone: changePct == null || changePct >= ENDURANCE_BUILDING_PCT ? 'good' : changePct <= -15 ? 'watch' : 'neutral',
      }
    : null;

  const reasons = capReasons([sessions, volumeReason, restingHrReason(input), hrvReason(input)]);

  if ((prior === 0 && recent > 0) || (changePct != null && changePct >= ENDURANCE_BUILDING_PCT)) {
    return {
      verdict: 'building',
      headline: changePct != null
        ? clip(`Building — training ${useMinutes ? 'time' : 'sessions'} up ${Math.round(changePct)}% over 4 weeks`)
        : 'Building — you are back to regular training',
      reasons,
    };
  }
  return {
    verdict: 'holding',
    headline: clip(`Holding steady — ${perWeek} sessions a week vs a target of ${input.target.weeklySessions}`),
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

  const recent = windowStats(0, 14);
  const prior = windowStats(14, 28);
  const all28 = windowStats(0, 28);

  const dataPoints = all28.active + all28.logging + all28.sleepWithData;
  const reasons = capReasons([
    {
      kind: 'activity',
      text: `Active on ${all28.active} of the last 28 days`,
      tone: all28.active >= 12 ? 'good' : all28.active >= 6 ? 'neutral' : 'watch',
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
      text: `Logged food on ${all28.logging} of the last 28 days`,
      tone: all28.logging >= 20 ? 'good' : all28.logging >= 10 ? 'neutral' : 'watch',
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
  const pPct = Math.round(prior.composite * 100);
  if (recent.composite >= prior.composite + GENERAL_BUILDING_DELTA) {
    return { verdict: 'building', headline: clip(`Building — habit consistency ${rPct}% vs ${pPct}% before`), reasons };
  }
  return { verdict: 'holding', headline: clip(`Holding steady — habit consistency ${rPct}% over 2 weeks`), reasons };
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

  const safeBand =
    input.goal === 'weight_loss' ? { ...FAT_LOSS_BAND }
    : input.goal === 'muscle' ? { ...MUSCLE_GAIN_BAND }
    : null;

  const startKg = input.start.weightKg;
  const targetKg = input.target.weightKg;
  const changeKg = w.currentKg != null && startKg != null ? round1(w.currentKg - startKg) : null;
  let progressPct: number | null = null;
  if (w.currentKg != null && startKg != null && targetKg != null && startKg !== targetKg) {
    const raw = ((startKg - w.currentKg) / (startKg - targetKg)) * 100;
    progressPct = Math.round(Math.min(100, Math.max(0, raw)));
  }

  // The ETA / pace fields are only meaningful when the goal's verdict logic
  // actually engaged the weight trend; endurance/general never project one.
  const usesWeight = input.goal === 'weight_loss' || input.goal === 'muscle';
  const insufficient = outcome.verdict === 'insufficient_data' || outcome.verdict === 'needs_target';

  return {
    goal: input.goal,
    target: { ...input.target },
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
    eta: usesWeight && !insufficient ? w.eta : null,
    onPaceForTargetDate: usesWeight && !insufficient ? w.onPace : null,
    verdict: outcome.verdict,
    headline: outcome.headline,
    reasons: outcome.reasons,
    dataSufficiency: { weighIns: w.weighIns, needed: WEIGH_INS_NEEDED, sessionsLast28d },
  };
}
