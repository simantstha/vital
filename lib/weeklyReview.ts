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
 * NOT a rating of the week itself; `weekRating` (see computeWeekRating) is.
 *
 * Honesty rule (same as goalProgress): never invent a number. A stat whose
 * inputs are missing is omitted. With almost no data the review is a gentle
 * "not enough data" nudge instead of fabricated praise.
 */

import type { GoalKind, GoalProgressBudget, GoalProgressIntakeDay, GoalVerdict, DayValue } from './goalProgress';
import { KG_TO_LB, isRunningWorkoutType } from './goalProgress';
import { PARTIAL_LOG_KCAL_THRESHOLD, TOO_FAST_LOSS_PCT_PER_WEEK } from './brain/weightSignals';
import { computeWeightTrend, type WeightReading } from './weightTrend';
import { localDayKey, weekDayKeys, weekStartKeyForDay } from './localDay';
import type { ProgressionSummary } from './workoutRepository';
import { isDeload, liftDisplayChange, liftDisplayName, pickHeadlineLift } from './liftChange';

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

export interface WeeklyReview {
  /** Monday, YYYY-MM-DD (user-local). */
  weekStart: string;
  /** Sunday, YYYY-MM-DD (user-local). */
  weekEnd: string;
  goal: GoalKind;
  /** The 4-week goal verdict as of this week (shared with the goal card) — NOT a rating of the week; use `weekRating` for that. */
  verdict: GoalVerdict;
  /**
   * Rating of the reviewed week alone (see computeWeekRating). `null` when the
   * week's own stats can't support one. `undefined` on rows stored before this
   * field existed — readers must tolerate its absence (stored JSON, no migration).
   */
  weekRating?: WeekRating | null;
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
  return `${round1(imperial ? kg * KG_TO_LB : kg)} ${imperial ? 'lb' : 'kg'}`;
}

function distanceText(input: WeeklyReviewInput, km: number): string {
  return isImperial(input) ? `${round1(km * KM_TO_MI)} mi` : `${round1(km)} km`;
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

function weightCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const trend = computeWeightTrend(input.weightReadings).days;
  const end = [...trend].reverse().find(d => d.day <= week.days[6]);
  if (!end || !week.set.has(end.day)) return null; // no weigh-in inside the reviewed week
  const start = [...trend].reverse().find(d => d.day < week.days[0]);
  if (!start || start.day < prevWeek.days[0]) return null; // no usable baseline from the week before
  const deltaKg = end.trendKg - start.trendKg;
  const rounded = round1(isImperial(input) ? deltaKg * KG_TO_LB : deltaKg);
  const text = rounded === 0 ? weightText(input, 0) : weightText(input, Math.abs(deltaKg));
  const value = rounded === 0 ? text : signed(rounded, text);

  let tone: ReviewTone = 'neutral';
  const pct = end.trendKg > 0 ? (deltaKg / end.trendKg) * 100 : 0;
  if (input.goal === 'weight_loss') {
    if (deltaKg <= -0.05) tone = -pct > TOO_FAST_LOSS_PCT_PER_WEEK ? 'watch' : 'good';
    else if (deltaKg >= 0.2) tone = 'watch';
  } else if (input.goal === 'muscle') {
    if (deltaKg > 0.05) tone = 'good';
    else if (deltaKg <= -0.2) tone = 'watch';
  }
  const cand: Candidate = {
    stat: { label: 'Weight trend', value, comparison: 'vs the week before', tone },
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
  if (tone === 'good') cand.win = `You stayed within your ${fmtKcal(target)} kcal target on ${hit} of ${logged} logged days.`;
  if (tone === 'watch') {
    cand.slip = `Only ${hit} of ${logged} logged days landed within your ${fmtKcal(target)} kcal target.`;
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
  return { stat: { label: 'Avg calories', value: `${fmtKcal(avg)} kcal`, comparison: comparison ?? 'daily avg for the week', tone: 'neutral' } };
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
  return cand;
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
  if (tone === 'good') cand.win = `You hit your ${Math.round(target)} g protein target on ${hit} of ${logged} logged days.`;
  if (tone === 'watch') {
    cand.slip = `Protein reached your ${Math.round(target)} g target on only ${hit} of ${logged} logged days.`;
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
  const value = best.shown === 0 ? `0 ${unit}` : signed(best.shown, `${Math.abs(best.shown)} ${unit}`);
  // A deload (week volume < 60% of the 4-week average) lowers e1RM on purpose:
  // never a slip, just a neutral "Lighter week".
  const lighter = best.shown < 0 && isDeload(totalVolumeByWeek(input.progression), week.days[0], 1);
  const tone: ReviewTone = lighter ? 'neutral' : best.shown > 0 ? 'good' : best.shown < 0 ? 'watch' : 'neutral';
  const cand: Candidate = {
    stat: { label: `${best.name} est. 1RM`, value, comparison: lighter ? `Lighter week · ${best.windowLabel}` : best.windowLabel, tone },
  };
  const shownText = `${Math.abs(best.shown)} ${unit}`;
  if (tone === 'good') cand.win = `${best.name} estimated 1RM is up ${shownText} ${best.windowLabel}.`;
  if (tone === 'watch') cand.slip = `${best.name} estimated 1RM is down ${shownText} ${best.windowLabel}.`;
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
  const curKm = sum(cur, w => w.distanceKm);
  const useKm = curKm != null && curKm > 0;
  const curVal = useKm ? curKm : sum(cur, w => w.durationMin);
  if (curVal == null || curVal <= 0) return null;
  const prevVal = useKm ? sum(prev, w => w.distanceKm) : sum(prev, w => w.durationMin);
  const fmt = (v: number): string => (useKm ? distanceText(input, v) : `${Math.round(v)} min`);
  let comparison: string | null = null;
  let tone: ReviewTone = 'neutral';
  const cand: Candidate = { stat: { label: 'Volume', value: fmt(curVal), comparison, tone } };
  if (prevVal != null && prevVal > 0) {
    const pct = Math.round(((curVal - prevVal) / prevVal) * 100);
    comparison = pct === 0 ? 'same as last week' : `${signed(pct, `${Math.abs(pct)}%`)} vs last week`;
    if (pct >= 5) { tone = 'good'; cand.win = `Training volume is up ${pct}% on last week (${fmt(prevVal)} → ${fmt(curVal)}).`; }
    else if (pct <= -25) { tone = 'watch'; cand.slip = `Training volume fell ${Math.abs(pct)}% from last week (${fmt(prevVal)} → ${fmt(curVal)}).`; cand.fix = `Rebuild toward ${fmt(prevVal)} — add one easy session early in the week.`; }
  }
  cand.stat.comparison = comparison ?? 'for the week';
  cand.stat.tone = tone;
  return cand;
}

function restingHrCandidate(input: WeeklyReviewInput, week: Week, prevWeek: Week): Candidate | null {
  const pick = (w: Week) => input.restingHr.filter(p => w.set.has(p.day)).map(p => p.value);
  const cur = pick(week);
  if (cur.length < MIN_HR_DAYS) return null;
  const avg = mean(cur) as number;
  const prev = pick(prevWeek);
  let comparison: string | null = null;
  let tone: ReviewTone = 'neutral';
  const cand: Candidate = { stat: { label: 'Resting HR', value: `${Math.round(avg)} bpm`, comparison, tone } };
  if (prev.length >= MIN_HR_DAYS) {
    const diff = Math.round(avg - (mean(prev) as number));
    comparison = diff === 0 ? 'same as last week' : `${signed(diff, String(Math.abs(diff)))} bpm vs last week`;
    if (diff <= -1) { tone = 'good'; cand.win = `Resting heart rate dropped ${Math.abs(diff)} bpm — a sign recovery is keeping up.`; }
    else if (diff >= 3) { tone = 'watch'; cand.slip = `Resting heart rate rose ${diff} bpm — your body may be carrying fatigue.`; cand.fix = 'Make one session an easy one — resting heart rate rose this week.'; }
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
 *  - endurance:   running distance vs the weekly distance target (>= 90% good,
 *                 >= 60% mixed, else tough). A tough sessions count (vs the
 *                 sessions target) pulls it down a level. Without a distance
 *                 target (or any measured distance) the sessions rating is
 *                 used; neither -> null.
 *  - general:     active days (3+ good, 2 mixed, else tough).
 *  - 'light' (muscle): a deliberate lighter week — logged training volume
 *    under 60% of the prior 4-week average (the shared isDeload) while the
 *    user still trained and did not miss the sessions target by more than
 *    one. A missed week is not a deload.
 *
 * `null` = the week's own stats can't support a rating (never invented). The
 * payload is stored JSON, so rows written before this field existed lack it.
 */
type RatingLevel = 'tough' | 'mixed' | 'good';
const RATING_LEVELS: readonly RatingLevel[] = ['tough', 'mixed', 'good'];

/** Weight loss: share of logged days within budget — 5 of 7 (or the equivalent share) is good, 3 of 7 mixed. */
const BUDGET_GOOD_DAYS_OF_7 = 5;
const BUDGET_MIXED_DAYS_OF_7 = 3;
/** Endurance: this week's running distance as a share of the weekly target. */
const DISTANCE_GOOD_FRACTION = 0.9;
const DISTANCE_MIXED_FRACTION = 0.6;
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

function muscleWeekRating(input: WeeklyReviewInput, week: Week): WeekRating | null {
  const count = weekSessionCount(input, week);
  const sessions = sessionsLevel(count, input.weeklySessionsTarget);
  if (count > 0 && sessions !== 'tough' && isLighterWeek(input, week)) return 'light';
  if (sessions == null) return null;
  const protein = proteinDays(input, week);
  return protein != null && protein.hit / protein.logged < PROTEIN_LOW_FRACTION ? levelDown(sessions) : sessions;
}

function weightLossWeekRating(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekRating | null {
  const days = budgetDays(input, week);
  const weightTone = weightCandidate(input, week, prevWeek)?.stat.tone ?? null;
  if (days) {
    const level: RatingLevel =
      days.hit * 7 >= days.logged * BUDGET_GOOD_DAYS_OF_7 ? 'good'
      : days.hit * 7 >= days.logged * BUDGET_MIXED_DAYS_OF_7 ? 'mixed'
      : 'tough';
    return weightTone === 'watch' ? levelDown(level) : level;
  }
  if (weightTone == null) return null;
  return weightTone === 'good' ? 'good' : weightTone === 'watch' ? 'tough' : 'mixed';
}

function enduranceWeekRating(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekRating | null {
  const sessions = sessionsLevel(weekSessionCount(input, week), input.weeklySessionsTarget);
  const target = input.weeklyDistanceKmTarget;
  const cur = runningKm(input, week);
  // A week with no run is a measured 0 km only when the week before did carry a distance.
  if (target != null && target > 0 && (cur != null || runningKm(input, prevWeek) != null)) {
    const frac = (cur ?? 0) / target;
    const distance: RatingLevel = frac >= DISTANCE_GOOD_FRACTION ? 'good' : frac >= DISTANCE_MIXED_FRACTION ? 'mixed' : 'tough';
    return sessions === 'tough' ? levelDown(distance) : distance;
  }
  return sessions;
}

function generalWeekRating(input: WeeklyReviewInput, week: Week): WeekRating {
  const active = weekSessionCount(input, week);
  return active >= GENERAL_GOOD_ACTIVE_DAYS ? 'good' : active >= GENERAL_MIXED_ACTIVE_DAYS ? 'mixed' : 'tough';
}

function computeWeekRating(input: WeeklyReviewInput, week: Week, prevWeek: Week): WeekRating | null {
  switch (input.goal) {
    case 'muscle': return muscleWeekRating(input, week);
    case 'weight_loss': return weightLossWeekRating(input, week, prevWeek);
    case 'endurance': return enduranceWeekRating(input, week, prevWeek);
    default: return generalWeekRating(input, week);
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

function buildHeadline(input: WeeklyReviewInput, cands: Candidate[]): string {
  const by = (label: string): WeeklyReviewStat | undefined => cands.find(x => x.stat.label === label)?.stat;
  const parts: string[] = [];
  const weight = by('Weight trend');
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
      const window = lift.comparison?.includes('4 weeks') ? 'over 4 wks' : 'vs last trained wk';
      parts.push(`${lift.label} ${lift.value} ${window}`);
    }
    else if (protein) parts.push(`protein ${protein.value.replace('/', ' of ')} ${loggedWord(protein)}days`);
    else if (weight) parts.push(`weight ${weight.value}`);
  } else if (input.goal === 'endurance') {
    if (sessions) parts.push(`${sessions.value} ${plural(Number(sessions.value), 'session')}`);
    const volume = by('Volume');
    if (volume) parts.push(volume.comparison && volume.comparison.includes('%') ? `${volume.value}, ${volume.comparison}` : volume.value);
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
  return gap != null && gap >= WEEKEND_GAP_MIN_KCAL ? `Weekends ran +${fmtKcal(gap)} kcal over your weekdays.` : null;
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

/** Generic, goal-keyed action used when a derived suggestion would just repeat the slip. */
function fallbackNextWeek(input: WeeklyReviewInput): string {
  switch (input.goal) {
    case 'weight_loss': return 'Weigh in at least 3 mornings and log dinner each day so next week reads clearly.';
    case 'muscle': return 'Log every working set and a weigh-in or two so we can see your lifts and weight move.';
    case 'endurance': return 'Keep sessions easy and regular, and wear your watch so volume and resting HR show up.';
    default: return 'Pick two fixed activity days next week and put them on the calendar.';
  }
}

/** nextWeek is an action derived from the slip — never a copy of it. */
function buildNextWeek(input: WeeklyReviewInput, cands: Candidate[], week: Week, slip: string | null): string {
  const next = buildNextWeekRaw(input, cands, week);
  return slip != null && normalizeSentence(next) === normalizeSentence(slip) ? fallbackNextWeek(input) : next;
}

function buildNextWeekRaw(input: WeeklyReviewInput, cands: Candidate[], week: Week): string {
  const gap = input.goal === 'weight_loss' || input.goal === 'muscle' ? weekendGap(input, week) : null;
  if (gap != null && gap >= WEEKEND_GAP_MIN_KCAL) {
    return "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.";
  }
  const recovery = recoveryFlags(input, week);
  if (recovery.length >= 2) {
    return `Go lighter next week and put sleep first — ${(recovery.length === 2 ? recovery.join(' and ') : `${recovery.slice(0, -1).join(', ')} and ${recovery[recovery.length - 1]}`)}.`;
  }
  const fix = cands.find(x => x.stat.tone === 'watch' && x.fix)?.fix;
  if (fix) return fix;
  const good = ['on_track', 'ahead', 'progressing', 'building'].includes(input.verdict);
  if (good) return 'Repeat this week: same routine, same training days.';
  return fallbackNextWeek(input);
}

function emptyReview(input: WeeklyReviewInput, week: Week, daysWithData: number, statCount: number): WeeklyReview {
  return {
    weekStart: week.days[0],
    weekEnd: week.days[6],
    goal: input.goal,
    verdict: input.verdict,
    weekRating: null,
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

  const slip = cands.find(x => x.slip)?.slip ?? weekendSlip(input, week);
  return {
    weekStart: week.days[0],
    weekEnd: week.days[6],
    goal: input.goal,
    verdict: input.verdict,
    weekRating: computeWeekRating(input, week, prevWeek),
    headline: buildHeadline(input, cands),
    stats: cands.map(x => x.stat),
    win: cands.find(x => x.win)?.win ?? null,
    slip,
    nextWeek: buildNextWeek(input, cands, week, slip),
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
