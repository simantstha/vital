/**
 * DB-facing loader for goal-aware findings: assembles a `GoalInsightInput`
 * (goalDetectors.ts) from the same sources the goal-progress and coach-context
 * code already use — weight readings + computeWeightTrend + assessWeightSignals,
 * workout_sets via summarizeProgression, HealthKit workouts, meal_logged
 * events, the diet budget, and persisted weekly reviews. No scoring or
 * thresholds live here.
 *
 * Imports are dynamic (same pattern as series.ts) so the pure insight modules
 * stay importable without DATABASE_URL.
 */
import type { GoalInsightInput } from './goalDetectors';

const TRAINING_LOOKBACK_DAYS = 56;   // 28-day baseline + up to 21 silent days
const SETS_LOOKBACK_DAYS = 84;
const WEIGHT_LOOKBACK_DAYS = 120;
const MEAL_LOOKBACK_DAYS = 14;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function loadGoalInsightInput(userId: string, localDay: string): Promise<GoalInsightInput | null> {
  const { db, schema } = await import('@/db');
  const { and, desc, eq, gte } = await import('drizzle-orm');
  const { localDayKey, pickTimeZone, previousDayKey } = await import('@/lib/localDay');
  const { normalizeGoal, resolveDietBudget } = await import('@/lib/brain/dietBudget');
  const { resolveUnitSystem } = await import('@/lib/units');
  const { computeWeightTrend } = await import('@/lib/weightTrend');
  const { assessWeightSignals } = await import('@/lib/brain/weightSignals');
  const { getWeightReadings } = await import('@/lib/weightRepository');
  const { getSetsSince, summarizeProgression, completedLocalDays } = await import('@/lib/workoutRepository');
  const { healthKitWorkoutDays } = await import('@/lib/trainingSummary');

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;

  const tz = pickTimeZone(null, user.timezone) ?? 'UTC';
  const goal = normalizeGoal(user.goal);
  const dayAgo = (n: number): string => {
    let key = localDay;
    for (let i = 0; i < n; i += 1) key = previousDayKey(key);
    return key;
  };

  // Weight trend signals (fat-loss goals only — nothing else reads them).
  let weightSignals: GoalInsightInput['weightSignals'] = [];
  if (goal === 'weight_loss') {
    const readings = await getWeightReadings(userId, WEIGHT_LOOKBACK_DAYS, tz);
    // Intake-based signals (under_eating, weekend_overeating) are not used here,
    // so no intake is passed and they cannot fire.
    weightSignals = assessWeightSignals({ trend: computeWeightTrend(readings), dailyIntakeKcal: [], floorKcal: 0, goal });
  }

  // Protein adherence inputs (muscle + fat loss).
  let proteinTargetG: number | null = null;
  const loggedDays: GoalInsightInput['loggedDays'] = [];
  if (goal === 'muscle' || goal === 'weight_loss') {
    const budget = await resolveDietBudget(user, userId);
    proteinTargetG = budget.protein ?? null;

    const since = new Date(Date.now() - (MEAL_LOOKBACK_DAYS + 2) * 86_400_000);
    const meals = await db
      .select({ timestamp: schema.events.timestamp, payload: schema.events.payload })
      .from(schema.events)
      .where(and(eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged'), gte(schema.events.timestamp, since)));
    const earliest = dayAgo(MEAL_LOOKBACK_DAYS - 1);
    const byDay = new Map<string, { mealCount: number; proteinG: number }>();
    for (const meal of meals) {
      const day = localDayKey(meal.timestamp, tz);
      if (day < earliest || day > localDay) continue;
      const p = (meal.payload !== null && typeof meal.payload === 'object' ? meal.payload : {}) as Record<string, unknown>;
      const bucket = byDay.get(day) ?? { mealCount: 0, proteinG: 0 };
      bucket.mealCount += 1;
      bucket.proteinG += Math.round(num(p.p) || num(p.protein));
      byDay.set(day, bucket);
    }
    for (const [day, v] of byDay) loggedDays.push({ day, ...v });
  }

  // Training: workout_sets + HealthKit workouts, same union as goalProgressLoader.
  const sets = await getSetsSince(userId, SETS_LOOKBACK_DAYS);
  const progression = summarizeProgression(sets);
  const liftDays = new Map<string, Set<string>>();
  const exerciseDisplay: Record<string, string> = {};
  for (const set of sets) {
    if (set.is_warmup) continue;
    exerciseDisplay[set.exercise] = set.exercise_display;
    const days = liftDays.get(set.exercise) ?? new Set<string>();
    days.add(set.local_day);
    liftDays.set(set.exercise, days);
  }
  const liftSessionDays: Record<string, string[]> = {};
  for (const [exercise, days] of liftDays) liftSessionDays[exercise] = [...days];

  // queryWorkouts clamps to 30 days; inactivity needs a 28-day baseline BEFORE the
  // silence, so read the 'workouts' daily_metrics rows directly over 56 days.
  const hkRows = await db
    .select({ date: schema.daily_metrics.date, payload: schema.daily_metrics.payload })
    .from(schema.daily_metrics)
    .where(and(
      eq(schema.daily_metrics.user_id, userId),
      eq(schema.daily_metrics.metric, 'workouts'),
      gte(schema.daily_metrics.date, dayAgo(TRAINING_LOOKBACK_DAYS - 1)),
    ));
  const entries = hkRows.flatMap((row) =>
    (Array.isArray(row.payload) ? (row.payload as Record<string, unknown>[]) : []).map((w) => ({ date: String(row.date), ...w })),
  );
  const trainingDays = [...new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(entries)])];

  // Weekly review verdicts (fat loss with a target date only).
  let weeklyVerdicts: GoalInsightInput['weeklyVerdicts'] = [];
  if (goal === 'weight_loss' && user.target_date) {
    const rows = await db
      .select({ weekStart: schema.weekly_reviews.week_start, payload: schema.weekly_reviews.payload })
      .from(schema.weekly_reviews)
      .where(eq(schema.weekly_reviews.user_id, userId))
      .orderBy(desc(schema.weekly_reviews.week_start))
      .limit(2);
    weeklyVerdicts = rows.map((row) => ({
      weekStart: String(row.weekStart),
      verdict: String((row.payload as { verdict?: unknown } | null)?.verdict ?? ''),
    }));
  }

  return {
    goal,
    unitSystem: resolveUnitSystem(user.unit_system),
    todayKey: localDay,
    weightSignals,
    targetWeightKg: user.target_weight_kg ?? null,
    targetDate: user.target_date ? String(user.target_date) : null,
    proteinTargetG,
    loggedDays,
    trainingDays,
    progression,
    liftSessionDays,
    exerciseDisplay,
    weeklyVerdicts,
    goalStartedDay: user.goal_started_at ? localDayKey(user.goal_started_at, tz) : null,
  };
}
