/**
 * Vital — weekly review loader / store
 *
 * DB-facing wrapper around the pure computeWeeklyReview (lib/weeklyReview.ts):
 * loads two weeks of weigh-ins, intake, sessions, lifts and vitals, takes the
 * verdict from loadGoalProgress (so the review and the goal card agree), and
 * persists the result in weekly_reviews (one row per user per local week).
 * No scoring logic lives here.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { localDayKey, pickTimeZone, weekDayKeys } from '@/lib/localDay';
import { getWeightReadings } from '@/lib/weightRepository';
import { getProgressionSummary, getSetsSince, completedLocalDays } from '@/lib/workoutRepository';
import { healthKitWorkoutDays } from '@/lib/trainingSummary';
import { queryMetricPoints, queryWorkouts } from '@/lib/brain/tools';
import { resolveDailyIntake } from '@/lib/brain/nutritionIntake';
import { normalizeGoal, resolveDietBudget } from '@/lib/brain/dietBudget';
import { resolveUnitSystem } from '@/lib/units';
import { loadGoalProgress } from '@/lib/goalProgressLoader';
import type { DayValue, GoalProgressBudget } from '@/lib/goalProgress';
import { endOfLocalWeek, shouldRecomputeReview } from '@/lib/weeklyReviewFreshness';
import { computeWeeklyReview, lastCompletedWeekStart, type WeeklyReview } from '@/lib/weeklyReview';

const WEIGHT_LOOKBACK_DAYS = 90;
const WINDOW_DAYS = 30; // queryWorkouts / queryMetricPoints clamp here
const DEFAULT_SLEEP_GOAL_MIN = 480; // kept in sync with lib/goalProgressLoader.ts

export interface StoredWeeklyReview {
  id: string;
  review: WeeklyReview;
  seenAt: string | null;
  createdAt: string;
}

function toStored(row: typeof schema.weekly_reviews.$inferSelect): StoredWeeklyReview {
  return {
    id: row.id,
    review: row.payload as WeeklyReview,
    seenAt: row.seen_at ? row.seen_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function seriesWithFallback(userId: string, primary: string, fallback: string): Promise<DayValue[]> {
  let points = await queryMetricPoints(userId, primary, WINDOW_DAYS);
  if (points.length === 0) points = await queryMetricPoints(userId, fallback, WINDOW_DAYS);
  return points.map(p => ({ day: p.date, value: p.value }));
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const lastRecomputeAt = new Map<string, number>();

/** Computes (without persisting) the review for the last completed local week. Null when the user is gone. */
export async function computeLastWeekReview(
  userId: string,
  opts: { tz?: string | null; now?: Date } = {},
): Promise<WeeklyReview | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;

  const tz = pickTimeZone(opts.tz ?? null, user.timezone) ?? 'UTC';
  const now = opts.now ?? new Date();
  const weekStart = lastCompletedWeekStart(localDayKey(now, tz));
  // Intake window: the reviewed week plus the week before it, for comparisons.
  const dayKeys = [...weekDayKeys(addDays(weekStart, -7)), ...weekDayKeys(weekStart)];
  const daySet = new Set(dayKeys);

  const goal = normalizeGoal(user.goal);
  const [progress, weightReadings, intakeByDay, budget, progression, sets, workoutEntries, restingHr, hrv, sleep] =
    await Promise.all([
      loadGoalProgress(userId, { tz, now: endOfLocalWeek(weekStart, tz) }),
      getWeightReadings(userId, WEIGHT_LOOKBACK_DAYS, tz),
      resolveDailyIntake(userId, dayKeys, tz),
      resolveDietBudget(user, userId),
      getProgressionSummary(userId, 84),
      getSetsSince(userId, WINDOW_DAYS + 2),
      queryWorkouts(userId, WINDOW_DAYS),
      seriesWithFallback(userId, 'resting_hr', 'whoop_resting_hr'),
      seriesWithFallback(userId, 'hrv_sdnn', 'whoop_hrv_rmssd'),
      queryMetricPoints(userId, 'sleep_minutes', WINDOW_DAYS),
    ]);

  const budgetInput: GoalProgressBudget = {
    targetKcal: budget.targetKcal,
    proteinG: budget.protein,
    floorKcal: 0,
    formulaTdee: null,
    learnedTdee: null,
    tdeeConfidence: null,
  };

  const trainingDays = new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(workoutEntries)]);

  return computeWeeklyReview({
    goal,
    weekStart,
    verdict: progress?.verdict ?? 'insufficient_data',
    weightReadings,
    intakeDays: dayKeys.map(day => {
      const i = intakeByDay.get(day);
      const has = i != null && i.source !== 'none';
      return { day, kcal: has ? i.kcal : null, proteinG: has ? i.protein : null, source: i?.source ?? 'none' };
    }),
    budget: budgetInput,
    trainingDays: [...trainingDays].filter(d => daySet.has(d)),
    workouts: workoutEntries
      .filter(w => daySet.has(w.date))
      .map(w => ({
        day: w.date,
        durationMin: typeof w.durationMin === 'number' && Number.isFinite(w.durationMin) ? w.durationMin : null,
        distanceKm: typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) ? w.distanceM / 1000 : null,
      })),
    progression,
    restingHr,
    hrv,
    sleepMinutes: sleep.map(p => ({ day: p.date, value: p.value })),
    sleepGoalMinutes: user.sleep_goal_minutes ?? DEFAULT_SLEEP_GOAL_MIN,
    weeklySessionsTarget: user.weekly_sessions_target ?? null,
    unitSystem: resolveUnitSystem(user.unit_system),
  });
}

/**
 * The stored review for the last completed local week, computing and storing
 * it first when missing. Concurrency-safe: the unique (user_id, week_start)
 * index makes a racing insert a no-op, and the row is re-read afterwards.
 */
export async function getOrCreateLastWeekReview(
  userId: string,
  opts: { tz?: string | null; now?: Date; /** Skip the recompute throttle (the push path). */ forceFresh?: boolean } = {},
): Promise<StoredWeeklyReview | null> {
  const [user] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) return null;
  const tz = pickTimeZone(opts.tz ?? null, user.timezone) ?? 'UTC';
  const weekStart = lastCompletedWeekStart(localDayKey(opts.now ?? new Date(), tz));

  const find = async () => {
    const [row] = await db
      .select()
      .from(schema.weekly_reviews)
      .where(and(eq(schema.weekly_reviews.user_id, userId), eq(schema.weekly_reviews.week_start, weekStart)))
      .limit(1);
    return row ?? null;
  };

  const existing = await find();
  if (existing) {
    const now = opts.now ?? new Date();
    const memoKey = `${userId}|${weekStart}`;
    if (!shouldRecomputeReview({ seenAt: existing.seen_at, createdAt: existing.created_at }, now, lastRecomputeAt.get(memoKey) ?? null, { force: opts.forceFresh })) {
      return toStored(existing);
    }
    // Unseen and young: re-read the data so a late Sunday sync isn't lost.
    // pushed_at / seen_at are untouched, so the push stays at-most-once.
    try {
      const fresh = await computeLastWeekReview(userId, { ...opts, tz });
      lastRecomputeAt.set(memoKey, now.getTime());
      if (!fresh) return toStored(existing);
      await db.update(schema.weekly_reviews).set({ payload: fresh }).where(and(eq(schema.weekly_reviews.id, existing.id), isNull(schema.weekly_reviews.seen_at)));
      return toStored({ ...existing, payload: fresh });
    } catch (err) {
      console.error(`[weeklyReview] recompute failed for user ${userId}; serving stored payload:`, err);
      return toStored(existing);
    }
  }

  const review = await computeLastWeekReview(userId, { ...opts, tz });
  if (!review) return null;
  await db
    .insert(schema.weekly_reviews)
    .values({ user_id: userId, week_start: weekStart, payload: review })
    .onConflictDoNothing();
  const row = await find();
  return row ? toStored(row) : null;
}

/** Marks a review seen (idempotent: keeps the first seen_at). False when no such review belongs to this user. */
export async function markWeeklyReviewSeen(userId: string, id: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.weekly_reviews.id })
    .from(schema.weekly_reviews)
    .where(and(eq(schema.weekly_reviews.id, id), eq(schema.weekly_reviews.user_id, userId)))
    .limit(1);
  if (!row) return false;
  await db
    .update(schema.weekly_reviews)
    .set({ seen_at: now })
    .where(and(eq(schema.weekly_reviews.id, id), isNull(schema.weekly_reviews.seen_at)));
  return true;
}
