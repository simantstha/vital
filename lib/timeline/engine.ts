/**
 * Timeline engine: emulates the DB-facing loaders (lib/goalProgressLoader.ts, lib/weeklyReviewLoader.ts,
 * lib/racePeakLoader.ts, lib/runHistoryLoader.ts) on in-memory synthetic rows, then calls the REAL pure
 * functions (computeGoalProgress, computeWeeklyReview, formatGoalProgressLines, requiredOpenerLine,
 * goalFallbackOpener, ...). No database, no network, no LLM.
 *
 * KEEP IN SYNC WITH THE LOADERS: `computeProgressFor` and `computeReviewFor` mirror the row -> input
 * mapping of the real loaders line by line. When a loader changes how it builds its input, change the
 * matching block here (the comments say which loader and which wave), or the timeline suite stops testing
 * what production does. Everything that is NOT the real function is marked `EMULATION:`.
 *
 * Public API: `runTimeline(scenarioName)` -> `DaySnapshot[]` (cached per process).
 */
import {
  computeGoalProgress,
  isRunningWorkoutType,
  isStrengthWorkoutType,
  type GoalProgress,
  type GoalProgressBudget,
  type GoalProgressInput,
} from '../goalProgress';
import {
  buildExerciseDisplay,
  computeWeeklyReview,
  lastCompletedWeekStart,
  signupLocalDay,
  type WeeklyReviewInput,
} from '../weeklyReview';
import { formatGoalProgressLines } from '../goalPromptText';
import { goalFallbackOpener, requiredOpenerLine } from '../brain/openerText';
import {
  isWindDownPhase,
  mondayOfDay,
  peakWeekKmBeforeTaper,
  racePhase,
  racePhaseInfo,
  peakWeekEndDaysOut,
} from '../enduranceProgression';
import { localDayKey, previousDayKey, weekDayKeys } from '../localDay';
import { endOfLocalWeek } from '../weeklyReviewFreshness';
import { weeklyReviewAlert } from '../weeklyReviewWorker';
import type { WeightReading } from '../weightTrend';
import { completedLocalDays, healthKitWorkoutDays } from '../workoutDays';
import { summarizeProgression } from '../progressionMath';
import type { WorkoutEntry } from '../brain/tools';
import { buildScenario, type ScenarioName } from './scenarios';
import { addDays, weekdayOf, type DaySnapshot, type ReviewResult, type Scenario, type SetRow } from './types';

const TZ = 'UTC'; // EMULATION: every scenario user is in UTC (no DST / tz edge cases exercised)

/** MIRRORS lib/goalProgressLoader.ts INTAKE_HISTORY_DAYS (wave 21w; the loader module imports @/db so it is copied): weight_loss reads 70 days of intake for the plateau cause. */
const INTAKE_HISTORY_DAYS = 70;

function trailingDayKeys(todayKey: string, n: number): string[] {
  // verbatim from lib/goalProgressLoader.ts
  const keys = [todayKey];
  for (let i = 1; i < n; i++) keys.unshift(previousDayKey(keys[0]));
  return keys;
}

/** lowEnergyThresholdKcal(): copied constants from lib/brain/dietBudget.ts (module imports @/db). */
const LOW_ENERGY_KCAL = { male: 1500, female: 1200 } as const;

// ── Row selectors: "what the DB would return on local day D" ───────────────

/** EMULATION: end-of-day state — every row dated <= D is visible (including D itself). */
function weightReadingsAsOf(scn: Scenario, asOf: string, lookbackDays: number): WeightReading[] {
  // getWeightReadings(userId, lookbackDays): events newer than now-lookbackDays; EMULATION: cutoff by local day.
  const from = addDays(asOf, -lookbackDays);
  return scn.weighIns
    .filter(w => w.day <= asOf && w.day >= from)
    .map(w => ({ measuredAt: `${w.day}T07:30:00.000Z`, valueKg: w.kg, source: 'manual' as const, localDay: w.day }));
}

function setsAsOf(scn: Scenario, asOf: string, sinceDays: number) {
  // getSetsSince(userId, days): performed_at >= now - days. EMULATION: cutoff by local day; performed_at = 18:00Z.
  const from = addDays(asOf, -sinceDays);
  return scn.sets
    .filter(s => s.day <= asOf && s.day >= from)
    .map(s => ({
      exercise: s.exercise,
      exercise_display: s.display as string | null,
      performed_at: new Date(`${s.day}T18:00:00.000Z`),
      local_day: s.day,
      rpe: s.rpe,
      reps: s.reps,
      load_kg: s.loadKg,
      is_warmup: s.isWarmup,
    }));
}

function workoutEntriesAsOf(scn: Scenario, asOf: string, windowDays: number): WorkoutEntry[] {
  // queryWorkouts(userId, days): daily_metrics 'workouts' rows with date >= today-days, newest first, payload items spread.
  const from = addDays(asOf, -windowDays);
  return scn.workouts
    .filter(w => w.day >= from && w.day <= asOf)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map(w => ({ date: w.day, type: w.type, durationMin: w.durationMin, distanceM: w.distanceM }));
}

/**
 * EMULATION of lib/racePeakLoader.ts loadRacePeakWeekKm: same gate (isWindDownPhase on any of `onDays`),
 * same window arithmetic, same row filter; the SQL query is replaced by an in-memory filter.
 * The arithmetic itself is the real `peakWeekKmBeforeTaper`.
 */
function racePeakWeekKmAsOf(scn: Scenario, asOf: string, onDays: string[]): number | null {
  const raceDate = scn.user.raceDate;
  const raceKm = scn.user.raceDistanceKm;
  if (!raceDate || !onDays.some(day => isWindDownPhase(racePhase(raceDate, day, raceKm)))) return null;
  const to = addDays(raceDate, -peakWeekEndDaysOut(raceKm));
  const from = addDays(to, -27);
  const runs: Array<{ day: string; km: number }> = [];
  for (const w of scn.workouts) {
    if (w.day < from || w.day > to || w.day > asOf) continue;
    if (!isRunningWorkoutType(w.type)) continue;
    if (typeof w.distanceM !== 'number' || !Number.isFinite(w.distanceM) || w.distanceM <= 0) continue;
    runs.push({ day: w.day, km: w.distanceM / 1000 });
  }
  return peakWeekKmBeforeTaper(runs, raceDate, raceKm);
}

/**
 * EMULATION of lib/runHistoryLoader.ts loadRunHistory: running workouts with a distance on local days
 * [asOf - 77, asOf], oldest first. The SQL query is replaced by an in-memory filter.
 */
function runHistoryAsOf(scn: Scenario, asOf: string): Array<{ day: string; km: number; durationMin: number | null }> {
  const from = addDays(asOf, -77);
  return scn.workouts
    .filter(w => w.day >= from && w.day <= asOf && isRunningWorkoutType(w.type) && typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) && w.distanceM > 0)
    .map(w => ({ day: w.day, km: (w.distanceM as number) / 1000, durationMin: w.durationMin }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function intakeDaysFor(scn: Scenario, dayKeys: string[]): GoalProgressInput['intakeDays'] {
  const byDay = new Map(scn.intake.map(i => [i.day, i]));
  return dayKeys.map(day => {
    const i = byDay.get(day);
    return i
      ? { day, kcal: i.kcal, proteinG: i.proteinG, source: 'logged' as const }
      : { day, kcal: null, proteinG: null, source: 'none' as const };
  });
}

// ── Goal progress (emulates loadGoalProgress) ───────────────────────────────

export function computeProgressFor(scn: Scenario, todayKey: string): GoalProgress {
  const WINDOW_DAYS = 28;
  const dayKeys = trailingDayKeys(todayKey, WINDOW_DAYS);
  const daySet = new Set(dayKeys);

  const progressionSets = setsAsOf(scn, todayKey, 84);
  const progression = summarizeProgression(progressionSets);
  const sets = progressionSets.filter(set => dayKeys.includes(set.local_day));
  const exerciseDisplay: Record<string, string> = {};
  for (const set of progressionSets) if (set.exercise_display) exerciseDisplay[set.exercise] = set.exercise_display;

  const workoutEntries = workoutEntriesAsOf(scn, todayKey, WINDOW_DAYS);
  const strengthDays = new Set<string>([
    ...completedLocalDays(sets),
    ...healthKitWorkoutDays(workoutEntries.filter(w => isStrengthWorkoutType(typeof w.type === 'string' ? w.type : null))),
  ]);
  const trainingDays = new Set<string>([
    ...completedLocalDays(sets),
    ...healthKitWorkoutDays(workoutEntries),
  ]);
  const workouts = workoutEntries
    .filter(w => daySet.has(w.date))
    .map(w => ({
      day: w.date,
      durationMin: typeof w.durationMin === 'number' && Number.isFinite(w.durationMin) ? w.durationMin : null,
      distanceKm: typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) ? w.distanceM / 1000 : null,
      type: typeof w.type === 'string' ? w.type : null,
    }));

  const budgetInput: GoalProgressBudget = {
    targetKcal: scn.budget.targetKcal,
    proteinG: scn.budget.proteinG,
    floorKcal: LOW_ENERGY_KCAL[scn.profile.sex],
    formulaTdee: null,
    learnedTdee: null,
    tdeeConfidence: null,
  };

  const startedAt = new Date(`${scn.user.goalStartedDay}T12:00:00.000Z`);
  const racePeakWeekKm = scn.goal === 'endurance' ? racePeakWeekKmAsOf(scn, todayKey, [todayKey, mondayOfDay(todayKey)]) : null;
  const runHistory = scn.goal === 'endurance' ? runHistoryAsOf(scn, todayKey) : undefined;

  const input: GoalProgressInput = {
    goal: scn.goal,
    todayKey,
    target: {
      weightKg: scn.user.targetWeightKg,
      date: scn.user.targetDate,
      weeklySessions: scn.user.weeklySessions,
      weeklyDistanceKm: scn.user.weeklyDistanceKm,
    },
    race: { date: scn.user.raceDate, distanceKm: scn.user.raceDistanceKm },
    racePeakWeekKm,
    runHistory,
    start: {
      weightKg: scn.user.goalStartWeightKg,
      startedAt: startedAt.toISOString(),
      startedDay: localDayKey(startedAt, TZ),
    },
    weightReadings: weightReadingsAsOf(scn, todayKey, 120),
    intakeDays: intakeDaysFor(scn, dayKeys),
    // MIRRORS lib/goalProgressLoader.ts (wave 21w): weight loss reads 70 days of intake (the card's own stats still use the 28).
    intakeHistoryDays: scn.goal === 'weight_loss' ? intakeDaysFor(scn, trailingDayKeys(todayKey, INTAKE_HISTORY_DAYS)) : undefined,
    budget: budgetInput,
    progression,
    trainingDays: [...trainingDays].filter(d => daySet.has(d)),
    strengthDays: [...strengthDays].filter(d => daySet.has(d)),
    // EMULATION (mirrors lib/goalProgressLoader.ts, wave 19b): the 84 days of logged sets already loaded for the lift progression + HealthKit strength days.
    strengthHistoryDays: [...new Set<string>([...completedLocalDays(progressionSets), ...strengthDays])],
    exerciseDisplay,
    workouts,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: scn.user.sleepGoalMinutes,
    unitSystem: scn.profile.units,
  };
  return computeGoalProgress(input);
}

// ── Weekly review (emulates computeLastWeekReview) ──────────────────────────

/** Reviews already computed for a scenario (a review reads the previous week's "Next week" text, so they chain). */
const reviewMemo = new WeakMap<Scenario, Map<string, ReviewResult>>();

export function computeReviewFor(scn: Scenario, runDay: string): ReviewResult {
  let memo = reviewMemo.get(scn);
  if (!memo) {
    memo = new Map();
    reviewMemo.set(scn, memo);
  }
  const hit = memo.get(runDay);
  if (hit) return hit;
  const result = computeReviewForUncached(scn, runDay);
  memo.set(runDay, result);
  return result;
}

function computeReviewForUncached(scn: Scenario, runDay: string): ReviewResult {
  const now = new Date(`${runDay}T06:30:00.000Z`);
  const weekStart = lastCompletedWeekStart(localDayKey(now, TZ));
  // The loader evaluates the goal verdict as of 23:59 local on the reviewed Sunday.
  const verdictAsOf = localDayKey(endOfLocalWeek(weekStart, TZ), TZ);
  const progress = computeProgressFor(scn, verdictAsOf);

  // EMULATION: all data dated through the reviewed Sunday is visible; Monday has not happened yet (the job runs at the user's
  // morning-brief time). The real loaders query relative to the REAL clock, so Monday-morning rows would also be visible.
  const asOf = verdictAsOf;
  const dayKeys = [...weekDayKeys(addDays(weekStart, -7)), ...weekDayKeys(weekStart)];
  const daySet = new Set(dayKeys);

  // MIRRORS lib/weeklyReviewLoader.ts (wave 23s): getProgressionSummary(84) and getSetsSince(32) read relative to the REAL clock, so a set logged on
  // the review's own Monday (the review is recomputed when opened) is in `progression` (the next week's bucket) and in `strengthDays`.
  // EMULATION: the end-of-day view of that Monday, like the weight-loss second read below. Only logged sets are affected (no scenario
  // carries both sets and HealthKit strength workouts), and `trainingDays` below is filtered to the two reviewed weeks as in the loader.
  const progression = summarizeProgression(setsAsOf(scn, runDay, 84));
  const sets = setsAsOf(scn, runDay, 30 + 2);
  const workoutEntries = workoutEntriesAsOf(scn, asOf, 30);
  const displayRows = setsAsOf(scn, asOf, 84).map(s => ({ exercise: s.exercise, exercise_display: s.exercise_display }));

  const budgetInput: GoalProgressBudget = {
    targetKcal: scn.budget.targetKcal,
    proteinG: scn.budget.proteinG,
    floorKcal: 0, // as in lib/weeklyReviewLoader.ts
    formulaTdee: null,
    learnedTdee: null,
    tdeeConfidence: null,
  };

  const trainingDays = new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(workoutEntries)]);
  const strengthDays = new Set<string>([
    ...completedLocalDays(sets),
    ...healthKitWorkoutDays(workoutEntries.filter(w => isStrengthWorkoutType(typeof w.type === 'string' ? w.type : null))),
  ]);

  const racePeakWeekKm = scn.goal === 'endurance' ? racePeakWeekKmAsOf(scn, asOf, [weekStart, addDays(weekStart, 7)]) : null;

  // MIRRORS lib/weeklyReviewLoader.ts (wave 21w): weight loss makes a SECOND goal-progress read, the card as it reads NOW (the
  // Monday the job runs on). Its week plan is the review's "Next week" and verdict; it is used only when it is the plan of the
  // week after the reviewed one. EMULATION: it sees the same rows as that Monday's daily card (end-of-day view): production
  // recomputes an unseen, young review when it is opened (getOrCreateLastWeekReview), so the review and the card read one
  // database state, and the suite compares the review's use of the plan rather than the 06:30 job clock against a 07:30 weigh-in.
  const comingWeekProgress = scn.goal === 'weight_loss' ? computeProgressFor(scn, localDayKey(now, TZ)) : null;
  const comingWeekPlan = comingWeekProgress?.weightRead?.plan;
  const weightPlan = comingWeekPlan != null && comingWeekPlan.weekStart === addDays(weekStart, 7) ? comingWeekPlan : null;

  const input: WeeklyReviewInput = {
    goal: scn.goal,
    weekStart,
    verdict: progress?.verdict ?? 'insufficient_data',
    weightReadings: weightReadingsAsOf(scn, asOf, 90),
    intakeDays: intakeDaysFor(scn, dayKeys),
    budget: budgetInput,
    trainingDays: [...trainingDays].filter(d => daySet.has(d)),
    // MIRRORS lib/weeklyReviewLoader.ts (wave 20b): the whole ~30 days read, not just the two reviewed weeks.
    strengthDays: [...strengthDays],
    workouts: workoutEntries
      .filter(w => daySet.has(w.date))
      .map(w => ({
        day: w.date,
        durationMin: typeof w.durationMin === 'number' && Number.isFinite(w.durationMin) ? w.durationMin : null,
        distanceKm: typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) ? w.distanceM / 1000 : null,
        type: typeof w.type === 'string' ? w.type : null,
      })),
    progression,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: scn.user.sleepGoalMinutes,
    weeklySessionsTarget: scn.user.weeklySessions,
    // MIRRORS lib/weeklyReviewLoader.ts (wave 19c): the reached target / day come from the same goal progress, and the
    // previous week's stored "Next week" text is passed so a tip is never repeated two weeks running.
    targetWeightKg: progress?.target.weightKg ?? scn.user.targetWeightKg ?? null,
    reachedAt: progress?.reachedAt ?? null,
    previousNextWeek: previousNextWeekFor(scn, weekStart),
    weightPlan,
    weeklyDistanceKmTarget: scn.user.weeklyDistanceKm,
    longRun: progress?.longRun ?? null,
    // EMULATION (mirrors lib/weeklyReviewLoader.ts, wave 19b): the building-back state as of the reviewed week's end.
    liftReturn: progress?.liftReturn ?? null,
    // MIRRORS lib/weeklyReviewLoader.ts (wave 21s): every lift's return, so the review claims "back above" only when all are.
    liftReturns: progress?.liftReturns ?? null,
    cardExplainedEst1rm: progress?.reasons?.some(r => r.kind === 'explainer') ?? false,
    raceDate: scn.goal === 'endurance' ? scn.user.raceDate : null,
    raceDistanceKm: scn.goal === 'endurance' ? scn.user.raceDistanceKm : null,
    runHistory: scn.goal === 'endurance' ? runHistoryAsOf(scn, addDays(weekStart, 6)) : undefined,
    racePeakWeekKm,
    unitSystem: scn.profile.units,
    exerciseDisplay: buildExerciseDisplay(displayRows),
    signupDay: signupLocalDay(new Date(`${scn.user.createdDay}T10:00:00.000Z`), TZ),
  };
  const review = computeWeeklyReview(input);
  return { weekStart, runDay, verdictAsOf, progress, racePeakWeekKm, review, alert: weeklyReviewAlert(review) };
}

/** The "Next week" text of the review for the week before `weekStart` (the loader reads it from weekly_reviews); null when that Monday is before day 7. */
function previousNextWeekFor(scn: Scenario, weekStart: string): string | null {
  const prevRunDay = weekStart; // the previous review ran on the Monday that starts `weekStart`... i.e. the Monday after the week before it
  if (prevRunDay < addDays(scn.day0, 7)) return null;
  return computeReviewFor(scn, prevRunDay).review.nextWeek;
}

// ── One day ─────────────────────────────────────────────────────────────────

function safe<T>(label: string, errors: string[], fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    const err = e as Error;
    errors.push(`${label}: ${err?.name ?? 'Error'}: ${err?.message} @ ${(err?.stack ?? '').split('\n').slice(1, 3).map(s => s.trim()).join(' | ')}`);
    return null;
  }
}

/** One-line description of what the synthetic user logged that day (not part of the app output). */
export function activityFor(scn: Scenario, day: string): string {
  const bits: string[] = [];
  for (const w of scn.workouts.filter(x => x.day === day)) {
    const km = w.distanceM != null ? ` ${(w.distanceM / 1000).toFixed(1)} km` : '';
    bits.push(`${w.type}${km}${w.durationMin != null ? ` ${w.durationMin} min` : ''}`);
  }
  const sets = scn.sets.filter(s => s.day === day && !s.isWarmup);
  if (sets.length) {
    const byEx = new Map<string, SetRow[]>();
    for (const s of sets) byEx.set(s.exercise, [...(byEx.get(s.exercise) ?? []), s]);
    const parts = [...byEx.entries()].map(([ex, ss]) => `${ex} ${ss.length}x${ss[0].reps}@${Math.max(...ss.map(s => s.loadKg ?? 0))}`);
    bits.push(`lifts: ${parts.join(', ')}`);
  }
  const wi = scn.weighIns.find(w => w.day === day);
  if (wi) bits.push(`weigh-in ${wi.kg.toFixed(1)} kg`);
  const fi = scn.intake.find(i => i.day === day);
  if (fi) bits.push(`food ${fi.kcal} kcal / ${fi.proteinG} g protein`);
  return bits.length ? bits.join('; ') : '(nothing logged)';
}

/** Steps one day: the card, the coach lines, the opener and, on a Monday from day 7, the weekly review. Never throws. */
export function stepDay(scn: Scenario, idx: number): DaySnapshot {
  const date = addDays(scn.day0, idx);
  const errors: string[] = [];
  const info = scn.user.raceDate ? racePhaseInfo(scn.user.raceDate, date, scn.user.raceDistanceKm) : null;
  const snap: DaySnapshot = {
    scenario: scn.name,
    idx,
    date,
    weekday: weekdayOf(date),
    activity: activityFor(scn, date),
    race: info ? { daysToRace: info.daysToRace, phase: info.phase } : null,
    card: null,
    reasons: [],
    distanceText: null,
    coach: null,
    opener: null,
    review: null,
    errors,
  };
  snap.card = safe('computeGoalProgress', errors, () => computeProgressFor(scn, date));
  if (snap.card) {
    const gp = snap.card;
    snap.reasons = gp.reasons;
    snap.distanceText = gp.distance?.text ?? null;
    snap.coach = safe('formatGoalProgressLines', errors, () => formatGoalProgressLines(gp, scn.profile.units));
    const goal = gp.goal;
    snap.opener = {
      required: safe('requiredOpenerLine', errors, () => requiredOpenerLine(gp, goal, scn.profile.units)),
      fallback: safe('goalFallbackOpener', errors, () => goalFallbackOpener(gp, goal, scn.profile.units)),
    };
  }
  if (weekdayOf(date) === 'Mon' && idx >= 7) {
    snap.review = safe('computeWeeklyReview', errors, () => computeReviewFor(scn, date));
  }
  return snap;
}

// ── Public API ──────────────────────────────────────────────────────────────

const timelineCache = new Map<ScenarioName, DaySnapshot[]>();

/**
 * Runs the named scenario day by day and returns one snapshot per stepped day (all days from day 0 to
 * `lastDay`, or only the scenario's `dayFilter` days). Computed once per process and cached: treat the
 * result as read-only.
 */
export function runTimeline(scenarioName: ScenarioName): DaySnapshot[] {
  const hit = timelineCache.get(scenarioName);
  if (hit) return hit;
  const scn = buildScenario(scenarioName);
  const snapshots: DaySnapshot[] = [];
  for (let idx = 0; idx <= scn.lastDay; idx++) {
    if (scn.dayFilter && !scn.dayFilter(idx, addDays(scn.day0, idx))) continue;
    snapshots.push(stepDay(scn, idx));
  }
  timelineCache.set(scenarioName, snapshots);
  return snapshots;
}
