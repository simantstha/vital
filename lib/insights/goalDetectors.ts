/**
 * Goal-aware proactive findings (roadmap v4 Phase 4.1/4.2, v5 goal progress).
 *
 * Pure and DB-free: every detector takes an already-loaded `GoalInsightInput`
 * (see goalInputs.ts for the loader) and returns a rule-shaped `Finding`
 * (pValue null, metrics []) or null. Findings then travel the SAME pipeline as
 * every other insight — evidence gate, two-run confirmation, arbiter scoring
 * and per-kind cooldown, daily/weekly delivery caps, the unique
 * (user, local_day) pending_nudges insert — nothing here pushes anything.
 *
 * Copy rules (lib/brain/persona.ts safety block): never shame, never push a
 * deficit, no calorie numbers. too_fast_loss suggests eating a bit more and
 * checks in on how the person feels, because a fast loss can be an early
 * disordered-eating signal. Numbers shown are only ones present in the input.
 *
 * Cooldown: each finding's `signature` is `goal:<kind>` (no numbers, so its
 * identity is stable day to day), and `kind` is what arbiter.shortlist
 * (COOLDOWN_DAYS = 14 >= the required 7) and nudgeWorker.withinDeliveryCaps
 * key their per-kind cooldown on. Detectors themselves are stateless.
 */
import { formatWeight } from '../metricFormat';
import type { UnitSystem } from '../units';
import type { WeightSignal } from '../brain/weightSignals';
import type { ProgressionSummary } from '../workoutRepository';
import type { Finding, GoalFindingKind, NudgeCopy } from './types';

// ── Thresholds ──────────────────────────────────────────────────────────────

export const STALLED_LIFT_RECENT_WEEKS = 3;
export const STALLED_LIFT_MIN_SESSIONS = 3;
/** A gain smaller than this fraction of the earlier best e1RM does not count as improving. */
export const STALLED_LIFT_MIN_GAIN_FRACTION = 0.01;

export const LOW_PROTEIN_WINDOW_DAYS = 5;
export const LOW_PROTEIN_MIN_LOW_DAYS = 4;
export const LOW_PROTEIN_FRACTION = 0.8;
/** A day only counts toward the streak when at least this many meals were logged (partial logging must not trigger it). */
export const LOW_PROTEIN_MIN_MEALS = 2;
/** The newest qualifying day must be this recent, so we never nudge about a pattern that is already history. */
export const LOW_PROTEIN_MAX_AGE_DAYS = 3;

export const INACTIVITY_MIN_SILENT_DAYS = 5;
/** Past this the user has lapsed, not slipped; a "5 days" style nudge would be stale and naggy. */
export const INACTIVITY_MAX_SILENT_DAYS = 21;
export const INACTIVITY_BASELINE_DAYS = 28;
export const INACTIVITY_MIN_PER_WEEK = 2;

export const OFF_PACE_CONSECUTIVE_WEEKS = 2;

// ── Input ───────────────────────────────────────────────────────────────────

export interface LoggedDay {
  day: string;
  /** Number of logged meals that day. HealthKit-only days have no meal count and are not passed. */
  mealCount: number;
  proteinG: number;
}

export interface WeeklyVerdict {
  /** Local Monday, YYYY-MM-DD. */
  weekStart: string;
  verdict: string;
}

export interface GoalInsightInput {
  /** Canonical diet goal: 'weight_loss' | 'muscle' | 'endurance' | 'general'. */
  goal: string;
  unitSystem: UnitSystem;
  /** The user's current local day. */
  todayKey: string;
  /** assessWeightSignals output (plateau / too_fast_loss are read from it). */
  weightSignals: WeightSignal[];
  targetWeightKg: number | null;
  /** 'YYYY-MM-DD' or null. */
  targetDate: string | null;
  proteinTargetG: number | null;
  loggedDays: LoggedDay[];
  /** Local days with a workout (workout_sets or HealthKit), at least ~49 days back. */
  trainingDays: string[];
  /** summarizeProgression output (best weekly e1RM per exercise). */
  progression: ProgressionSummary;
  /** exercise -> distinct local days with a working set. */
  liftSessionDays: Record<string, string[]>;
  /** exercise -> display name. */
  exerciseDisplay: Record<string, string>;
  /** Most recent weekly reviews, newest first. */
  weeklyVerdicts: WeeklyVerdict[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return date.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function weight(kg: number, units: UnitSystem): string {
  return formatWeight(kg, units) ?? `${Math.round(kg)} kg`;
}

function rule(
  kind: GoalFindingKind,
  effectLabel: string,
  n: number,
  detail: Record<string, string | number>,
  copy: NudgeCopy,
): Finding {
  return {
    kind,
    signature: `goal:${kind}`,
    metrics: [],
    effect: 1,
    effectLabel,
    n,
    pValue: null,
    detail,
    copy,
  };
}

// ── 1. weight_plateau ───────────────────────────────────────────────────────

export function detectWeightPlateau(input: GoalInsightInput): Finding | null {
  if (input.goal !== 'weight_loss') return null;
  const signal = input.weightSignals.find((s) => s.kind === 'plateau');
  if (!signal) return null;
  const trendKg = Number(signal.facts.trendKg);
  if (!Number.isFinite(trendKg) || trendKg <= 0) return null;

  const w = weight(trendKg, input.unitSystem);
  return rule('weight_plateau', 'trend flat for 2 weeks', 14, { trendKg, weeks: 2 }, {
    title: 'Your weight trend has flattened',
    body: `Your trend has been flat at ${w} for 2 weeks — want to look at it together?`,
    openingMessage:
      `I noticed your weight trend has been flat at ${w} for about two weeks. ` +
      `That's really common and it doesn't mean anything is wrong. ` +
      `Want to look at it together — how food, training and sleep have been going — and decide whether anything is worth adjusting?`,
  });
}

// ── 2. too_fast_loss ────────────────────────────────────────────────────────

export function detectTooFastLoss(input: GoalInsightInput): Finding | null {
  if (input.goal !== 'weight_loss') return null;
  const signal = input.weightSignals.find((s) => s.kind === 'too_fast_loss');
  if (!signal) return null;
  const rate = Math.abs(Number(signal.facts.rateKgPerWeek));
  const pct = Number(signal.facts.pctPerWeek);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const perWeek = weight(rate, input.unitSystem);
  return rule('too_fast_loss', `${pct}% of body weight per week`, 7, { rateKgPerWeek: rate, pctPerWeek: pct }, {
    title: 'Your weight is dropping quickly',
    body: `Your trend is down about ${perWeek} a week — a bit faster than is easy to sustain. Want to talk about eating a little more?`,
    openingMessage:
      `Your weight trend has been dropping about ${perWeek} a week lately. That's a little faster than I'd like to see — ` +
      `losing more slowly usually protects your energy, your training and your muscle. ` +
      `Would you be open to eating a bit more? And how have you been feeling day to day — energy, hunger, mood?`,
  });
}

// ── 3. stalled_lift ─────────────────────────────────────────────────────────

export function detectStalledLift(input: GoalInsightInput): Finding | null {
  if (input.goal !== 'muscle') return null;

  const recentStart = shiftDay(mondayOf(input.todayKey), -7 * STALLED_LIFT_RECENT_WEEKS);

  let best: { exercise: string; sessions: number; recentBest: number; priorBest: number } | null = null;
  for (const [exercise, weeks] of Object.entries(input.progression)) {
    const sessions = new Set(
      (input.liftSessionDays[exercise] ?? []).filter((day) => day >= recentStart && day <= input.todayKey),
    ).size;
    if (sessions < STALLED_LIFT_MIN_SESSIONS) continue;

    let recentBest: number | null = null;
    let priorBest: number | null = null;
    for (const week of weeks) {
      const e1rm = week.bestEstimatedOneRepMaxKg;
      if (e1rm == null) continue;
      if (week.weekStart >= recentStart) recentBest = Math.max(recentBest ?? 0, e1rm);
      else priorBest = Math.max(priorBest ?? 0, e1rm);
    }
    if (recentBest == null || priorBest == null) continue;                         // nothing to compare against
    if (recentBest >= priorBest * (1 + STALLED_LIFT_MIN_GAIN_FRACTION)) continue;  // still improving

    // The "top lift" is the one trained most; ties break alphabetically so the pick is stable.
    if (!best || sessions > best.sessions || (sessions === best.sessions && exercise < best.exercise)) {
      best = { exercise, sessions, recentBest, priorBest };
    }
  }
  if (!best) return null;

  const name = input.exerciseDisplay[best.exercise] ?? best.exercise;
  const peak = weight(best.priorBest, input.unitSystem);
  return rule('stalled_lift', `no e1RM gain on ${name} in ${STALLED_LIFT_RECENT_WEEKS}+ weeks`, best.sessions, {
    exercise: name,
    sessions: best.sessions,
    weeks: STALLED_LIFT_RECENT_WEEKS,
    bestE1rmKg: Number(best.priorBest.toFixed(1)),
  }, {
    title: `Your ${name} has levelled off`,
    body: `Your ${name} estimated max hasn't moved past ${peak} in about ${STALLED_LIFT_RECENT_WEEKS} weeks, over ${best.sessions} sessions. Want to look at why?`,
    openingMessage:
      `I noticed your ${name} hasn't gone past an estimated ${peak} for about ${STALLED_LIFT_RECENT_WEEKS} weeks, even though you've trained it ${best.sessions} times. ` +
      `Stalls like this are normal. Want to look at it together — sleep, protein, volume, how the sets have felt — and try one change?`,
  });
}

// ── 4. low_protein_streak ───────────────────────────────────────────────────

export function detectLowProteinStreak(input: GoalInsightInput): Finding | null {
  if (input.goal !== 'muscle' && input.goal !== 'weight_loss') return null;
  const target = input.proteinTargetG;
  if (target == null || !(target > 0)) return null;

  const qualifying = input.loggedDays
    .filter((d) => d.mealCount >= LOW_PROTEIN_MIN_MEALS && d.day <= input.todayKey)
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, LOW_PROTEIN_WINDOW_DAYS);
  if (qualifying.length < LOW_PROTEIN_WINDOW_DAYS) return null;
  if (daysBetween(qualifying[0].day, input.todayKey) > LOW_PROTEIN_MAX_AGE_DAYS) return null;

  const low = qualifying.filter((d) => d.proteinG < target * LOW_PROTEIN_FRACTION);
  if (low.length < LOW_PROTEIN_MIN_LOW_DAYS) return null;

  const avg = Math.round(qualifying.reduce((sum, d) => sum + d.proteinG, 0) / qualifying.length);
  return rule('low_protein_streak', `${low.length} of ${LOW_PROTEIN_WINDOW_DAYS} logged days under 80% of target`, qualifying.length, {
    lowDays: low.length,
    daysChecked: LOW_PROTEIN_WINDOW_DAYS,
    avgProteinG: avg,
    targetProteinG: Math.round(target),
  }, {
    title: 'Protein has been running low',
    body: `You've been under your ${Math.round(target)} g protein goal on ${low.length} of your last ${LOW_PROTEIN_WINDOW_DAYS} logged days (averaging ${avg} g). Want a couple of easy ways to close the gap?`,
    openingMessage:
      `Looking at your last ${LOW_PROTEIN_WINDOW_DAYS} logged days, protein has come in under your ${Math.round(target)} g goal on ${low.length} of them — averaging about ${avg} g. ` +
      `Want to find a couple of easy additions that fit the way you already eat?`,
  });
}

// ── 5. inactivity_streak ────────────────────────────────────────────────────

export function detectInactivityStreak(input: GoalInsightInput): Finding | null {
  const days = new Set(input.trainingDays.filter((d) => d <= input.todayKey));
  if (days.size === 0) return null;

  const sorted = [...days].sort();
  const last = sorted[sorted.length - 1];
  const silent = daysBetween(last, input.todayKey);
  if (silent < INACTIVITY_MIN_SILENT_DAYS || silent > INACTIVITY_MAX_SILENT_DAYS) return null;

  // Baseline is the 4 weeks BEFORE the silence began, so the silence itself
  // doesn't drag the rate down and hide the break.
  const baselineStart = shiftDay(last, -(INACTIVITY_BASELINE_DAYS - 1));
  let active = 0;
  for (const d of days) if (d >= baselineStart && d <= last) active += 1;
  const perWeek = (active / INACTIVITY_BASELINE_DAYS) * 7;
  if (perWeek < INACTIVITY_MIN_PER_WEEK) return null;

  const rounded = Number(perWeek.toFixed(1));
  return rule('inactivity_streak', `${silent} days since the last workout`, active, {
    daysSinceLast: silent,
    workoutsPerWeek: rounded,
  }, {
    title: "It's been a few days",
    body: `No workout in ${silent} days, and you've usually trained about ${rounded} times a week. Everything okay?`,
    openingMessage:
      `I noticed it's been ${silent} days since your last workout, and you'd been training about ${rounded} times a week before that. ` +
      `No judgement — rest and busy weeks happen. What's been going on, and would an easy session this week help get you going again?`,
  });
}

// ── 6. off_pace ─────────────────────────────────────────────────────────────

export function detectOffPace(input: GoalInsightInput): Finding | null {
  if (input.goal !== 'weight_loss') return null;
  if (!input.targetDate || input.targetDate <= input.todayKey) return null;

  // The two newest reviews must be the two most recent COMPLETED weeks —
  // stale or gappy history is not "consecutive".
  const lastCompletedWeek = shiftDay(mondayOf(input.todayKey), -7);
  const [latest, previous] = input.weeklyVerdicts;
  if (!latest || !previous) return null;
  if (latest.weekStart !== lastCompletedWeek || previous.weekStart !== shiftDay(lastCompletedWeek, -7)) return null;
  if (latest.verdict !== 'behind' || previous.verdict !== 'behind') return null;

  const date = formatDay(input.targetDate);
  const goalText = input.targetWeightKg != null ? `${weight(input.targetWeightKg, input.unitSystem)} by ${date}` : `your goal by ${date}`;
  return rule('off_pace', `behind pace for ${OFF_PACE_CONSECUTIVE_WEEKS} weekly reviews in a row`, OFF_PACE_CONSECUTIVE_WEEKS, {
    consecutiveWeeksBehind: OFF_PACE_CONSECUTIVE_WEEKS,
    targetDate: input.targetDate,
  }, {
    title: 'Your target date is slipping',
    body: `Your last 2 weekly reviews put you behind pace for ${goalText}. Want to look at the plan together?`,
    openingMessage:
      `My last two weekly reviews both show you running a bit behind pace for ${goalText}. ` +
      `That's useful information, not a verdict on you. We could look at what's getting in the way, or adjust the date or the plan so it stays realistic and sustainable — which would you prefer?`,
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function detectGoalFindings(input: GoalInsightInput): Finding[] {
  return [
    detectWeightPlateau(input),
    detectTooFastLoss(input),
    detectStalledLift(input),
    detectLowProteinStreak(input),
    detectInactivityStreak(input),
    detectOffPace(input),
  ].filter((f): f is Finding => f !== null);
}
