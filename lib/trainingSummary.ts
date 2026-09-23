/**
 * Training summary resolver — backs `GET /api/training/summary`.
 *
 * Composes existing repositories instead of re-querying:
 *  - `lib/workoutRepository.ts` for logged strength sets (completed
 *    sessions, lastLift).
 *  - `lib/brain/tools.ts`'s `queryWorkouts` for the HealthKit `workouts`
 *    daily_metrics payload (weekly distance) — the same source `get_workouts`
 *    and the coach prompt use, so this agrees with what the coach already
 *    tells the user.
 *  - `plan_items` (kind='move') for planned training sessions — read
 *    directly here, the same way `app/api/plan/route.ts` reads it, since
 *    there's no dedicated plan-items repository yet.
 *
 * Honesty rule (non-negotiable, see the route's header): every field here is
 * null when the underlying data doesn't exist, never a guessed or zeroed
 * default. In particular:
 *  - `plannedSessions` is null when the user has never added a 'move' plan
 *    item for any day in the week — GET /api/plan only ever auto-seeds
 *    'meal'/'sleep' rows, so most weeks legitimately have zero plan data,
 *    which is different from "0 sessions planned".
 *  - `volume.done` is null when no logged workout this week carries a
 *    distance reading at all — distinct from a real (if unlikely) 0km.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db';
import { weekDayKeys, weekStartKeyForDay } from '@/lib/localDay';
import { queryWorkouts } from '@/lib/brain/tools';
import {
  completedLocalDays,
  getLastLift,
  getSetsForLocalDays,
  type LastLift,
} from '@/lib/workoutRepository';

export interface WeekDay {
  date:      string;  // YYYY-MM-DD
  planned:   boolean;
  completed: boolean;
}

export interface WeekSummary {
  start:            string;        // YYYY-MM-DD, local Monday
  plannedSessions:  number | null;
  completedSessions: number;
  days:             WeekDay[];
}

export interface VolumeSummary {
  unit:   'km';
  done:   number | null;
  target: number | null; // always null today — no plan/goal in this schema defines a weekly distance target
}

export interface TrainingSummary {
  week:     WeekSummary;
  volume:   VolumeSummary;
  lastLift: LastLift | null;
}

/** Distinct local days (within `dayKeys`) that have a 'move'-kind plan item. */
async function plannedMoveDays(userId: string, dayKeys: string[]): Promise<Set<string>> {
  const rows = await db
    .select({ local_day: schema.plan_items.local_day })
    .from(schema.plan_items)
    .where(and(
      eq(schema.plan_items.user_id, userId),
      eq(schema.plan_items.kind, 'move'),
      inArray(schema.plan_items.local_day, dayKeys),
    ));
  return new Set(rows.map(r => r.local_day));
}

async function resolveWeek(userId: string, todayKey: string): Promise<WeekSummary> {
  const start = weekStartKeyForDay(todayKey);
  const dayKeys = weekDayKeys(start);

  const [planned, sets] = await Promise.all([
    plannedMoveDays(userId, dayKeys),
    getSetsForLocalDays(userId, dayKeys),
  ]);
  const completed = completedLocalDays(sets);

  const days: WeekDay[] = dayKeys.map(date => ({
    date,
    planned:   planned.has(date),
    completed: completed.has(date),
  }));

  return {
    start,
    plannedSessions:   planned.size > 0 ? planned.size : null,
    completedSessions: completed.size,
    days,
  };
}

/**
 * Sums `distanceM` across every HealthKit workout logged this local week.
 * `queryWorkouts` is date-range-only (no upper bound needed here — we filter
 * down to the exact week day keys below), so `days` just needs to cover back
 * to the earliest day of the current week.
 */
async function resolveVolume(userId: string, dayKeys: string[]): Promise<VolumeSummary> {
  const lookbackDays = Math.min(30, dayKeys.length + 1);
  const workouts = await queryWorkouts(userId, lookbackDays);
  const inWeek = workouts.filter(w => dayKeys.includes(w.date));

  const withDistance = inWeek.filter(
    (w): w is typeof w & { distanceM: number } =>
      typeof w.distanceM === 'number' && Number.isFinite(w.distanceM),
  );

  const done = withDistance.length === 0
    ? null
    : Math.round((withDistance.reduce((sum, w) => sum + w.distanceM, 0) / 1000) * 10) / 10;

  return { unit: 'km', done, target: null };
}

export async function resolveTrainingSummary(userId: string, todayKey: string): Promise<TrainingSummary> {
  const week = await resolveWeek(userId, todayKey);
  const [volume, lastLift] = await Promise.all([
    resolveVolume(userId, week.days.map(d => d.date)),
    getLastLift(userId),
  ]);
  return { week, volume, lastLift };
}
