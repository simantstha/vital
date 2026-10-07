/**
 * Vital — goal progress loader
 *
 * Thin DB-facing wrapper around the pure computeGoalProgress
 * (lib/goalProgress.ts): loads the user's goal columns, weigh-ins, intake,
 * lifts, sessions and vitals from the existing repositories, then hands them
 * over. No scoring logic lives here.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { localDayKey, pickTimeZone, previousDayKey } from '@/lib/localDay';
import { getWeightReadings } from '@/lib/weightRepository';
import { getSetsSince, completedLocalDays, summarizeProgression } from '@/lib/workoutRepository';
import { healthKitWorkoutDays } from '@/lib/trainingSummary';
import { queryMetricPoints, queryWorkouts } from '@/lib/brain/tools';
import { resolveDailyIntake } from '@/lib/brain/nutritionIntake';
import { normalizeGoal, resolveDietBudget, lowEnergyThresholdKcal } from '@/lib/brain/dietBudget';
import { resolveUnitSystem } from '@/lib/units';
import { readCoreProfile } from '@/lib/coreProfileStore';
import { parseProfileDetails } from '@/lib/profileDetails';
import {
  computeGoalProgress,
  type DayValue,
  type GoalProgress,
  type GoalProgressBudget,
  isStrengthWorkoutType,
} from '@/lib/goalProgress';

const WINDOW_DAYS = 28;
const WEIGHT_LOOKBACK_DAYS = 120; // EWMA run-in beyond the 28-day rate window
const DEFAULT_SLEEP_GOAL_MIN = 480; // kept in sync with app/api/profile/route.ts

function trailingDayKeys(todayKey: string, n: number): string[] {
  const keys = [todayKey];
  for (let i = 1; i < n; i++) keys.unshift(previousDayKey(keys[0]));
  return keys;
}

/** Prefers the primary metric; falls back to the WHOOP equivalent when empty. */
async function seriesWithFallback(userId: string, primary: string, fallback: string): Promise<DayValue[]> {
  let points = await queryMetricPoints(userId, primary, WINDOW_DAYS);
  if (points.length === 0) points = await queryMetricPoints(userId, fallback, WINDOW_DAYS);
  return points.map(p => ({ day: p.date, value: p.value }));
}

/**
 * `tz` is the request-supplied timezone (freshest — tracks travel); the
 * stored one is the fallback, then UTC. `now` is injectable for tests.
 */
export async function loadGoalProgress(
  userId: string,
  opts: { tz?: string | null; now?: Date } = {},
): Promise<GoalProgress | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;

  const tz = pickTimeZone(opts.tz ?? null, user.timezone) ?? 'UTC';
  const todayKey = localDayKey(opts.now ?? new Date(), tz);
  const dayKeys = trailingDayKeys(todayKey, WINDOW_DAYS);
  const goal = normalizeGoal(user.goal);

  const [
    weightReadings, intakeByDay, budget, profileMd,
    progressionSets, workoutEntries, restingHr, hrv, sleep,
  ] = await Promise.all([
    getWeightReadings(userId, WEIGHT_LOOKBACK_DAYS, tz),
    resolveDailyIntake(userId, dayKeys, tz),
    resolveDietBudget(user, userId),
    readCoreProfile(userId),
    getSetsSince(userId, 84),
    queryWorkouts(userId, WINDOW_DAYS),
    seriesWithFallback(userId, 'resting_hr', 'whoop_resting_hr'),
    seriesWithFallback(userId, 'hrv_sdnn', 'whoop_hrv_rmssd'),
    queryMetricPoints(userId, 'sleep_minutes', WINDOW_DAYS),
  ]);

  const profile = parseProfileDetails(profileMd);
  const budgetInput: GoalProgressBudget = {
    targetKcal: budget.targetKcal,
    proteinG: budget.protein,
    floorKcal: lowEnergyThresholdKcal(profile.biologicalSex),
    formulaTdee: budget.expenditure?.formulaTdee ?? null,
    learnedTdee: budget.expenditure?.learnedTdee ?? null,
    tdeeConfidence: budget.expenditure?.confidence ?? null,
  };

  const progression = summarizeProgression(progressionSets);
  const sets = progressionSets.filter(set => dayKeys.includes(set.local_day));
  const exerciseDisplay: Record<string, string> = {};
  for (const set of progressionSets) if (set.exercise_display) exerciseDisplay[set.exercise] = set.exercise_display;

  const daySet = new Set(dayKeys);
  // Muscle goal: strength sessions only — logged sets plus HealthKit strength
  // workouts (a run or a walk is not a lifting session).
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

  return computeGoalProgress({
    goal,
    todayKey,
    target: {
      weightKg: user.target_weight_kg ?? null,
      date: user.target_date ?? null,
      weeklySessions: user.weekly_sessions_target ?? null,
      weeklyDistanceKm: user.weekly_distance_km_target ?? null,
    },
    start: {
      weightKg: user.goal_start_weight_kg ?? null,
      startedAt: user.goal_started_at ? user.goal_started_at.toISOString() : null,
      startedDay: user.goal_started_at ? localDayKey(user.goal_started_at, tz) : null,
    },
    weightReadings,
    intakeDays: dayKeys.map(day => {
      const i = intakeByDay.get(day);
      const has = i != null && i.source !== 'none';
      return { day, kcal: has ? i.kcal : null, proteinG: has ? i.protein : null, source: i?.source ?? 'none' };
    }),
    budget: budgetInput,
    progression,
    trainingDays: [...trainingDays].filter(d => daySet.has(d)),
    strengthDays: [...strengthDays].filter(d => daySet.has(d)),
    exerciseDisplay,
    workouts,
    restingHr,
    hrv,
    sleepMinutes: sleep.map(p => ({ day: p.date, value: p.value })),
    sleepGoalMinutes: user.sleep_goal_minutes ?? DEFAULT_SLEEP_GOAL_MIN,
    unitSystem: resolveUnitSystem(user.unit_system),
  });
}
