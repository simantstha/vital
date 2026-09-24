/**
 * Training summary resolver — backs `GET /api/training/summary`.
 *
 * Composes existing repositories instead of re-querying:
 *  - `lib/workoutRepository.ts` for logged strength sets (completed
 *    sessions, lastLift).
 *  - `lib/brain/tools.ts`'s `queryWorkouts` for the HealthKit `workouts`
 *    daily_metrics payload (weekly distance AND completed sessions — the
 *    same source `get_workouts` and the coach prompt use, so this agrees
 *    with what the coach already tells the user; fetched once per request
 *    and shared between the two, never queried twice).
 *  - `plan_items` (kind='move') for planned training sessions — read
 *    directly here, the same way `app/api/plan/route.ts` reads it, since
 *    there's no dedicated plan-items repository yet.
 *
 * `completedSessions`/`days[].completed` are a UNION of two signals, deduped
 * by local day: a logged (non-warmup) `workout_sets` row (strength), or a
 * HealthKit workout entry that's real training, not a trivial auto-detected
 * blip (see MIN_HEALTHKIT_WORKOUT_MINUTES below) — an endurance user's runs/
 * rides/swims never touch `workout_sets`, so counting strength sets alone
 * would report `completedSessions: 0` for a marathoner who trained all week,
 * which is exactly the honesty rule's failure mode in the other direction. A
 * day with both a lift and a run still counts once (it's a Set union, not a
 * sum).
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
import { queryWorkouts, type WorkoutEntry } from '@/lib/brain/tools';
import {
  completedLocalDays,
  getLastLift,
  getSetsForLocalDays,
  type LastLift,
} from '@/lib/workoutRepository';

// A HealthKit workout always carries a duration (`DailyIngestWorkout.durationMin`
// in ios/Vital/Sources/Health/HealthKitBackfill.swift is non-optional), so a
// day only counts as "completed" from HealthKit data when at least one
// workout that day is >= this long — a 2-minute walk HealthKit auto-detected
// shouldn't light up a training dot. If an entry is ever missing the field
// (e.g. an older/foreign payload shape), it's counted rather than dropped —
// the honesty rule cuts toward not hiding real activity, not toward stricter
// filtering than the data can support.
const MIN_HEALTHKIT_WORKOUT_MINUTES = 10;

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

/**
 * Fetches this local week's HealthKit `workouts` entries — the same source
 * `resolveVolume`'s distance sum and `resolveWeek`'s completed-day union both
 * read, so it's fetched once here and shared rather than queried twice.
 * `queryWorkouts` is date-range-only (no upper bound needed — callers filter
 * down to the exact week day keys), so `days` just needs to cover back to
 * the earliest day of the current week.
 */
async function fetchWeekWorkouts(userId: string, dayKeys: string[]): Promise<WorkoutEntry[]> {
  const lookbackDays = Math.min(30, dayKeys.length + 1);
  const workouts = await queryWorkouts(userId, lookbackDays);
  return workouts.filter(w => dayKeys.includes(w.date));
}

/**
 * Distinct local days with >= 1 HealthKit workout that's real training, not
 * a trivial auto-detected blip — see MIN_HEALTHKIT_WORKOUT_MINUTES above.
 * Pure/unit-testable: takes entries already scoped to the week.
 */
export function healthKitWorkoutDays(entries: WorkoutEntry[]): Set<string> {
  const days = new Set<string>();
  for (const w of entries) {
    const duration = w.durationMin;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration < MIN_HEALTHKIT_WORKOUT_MINUTES) {
      continue; // has a duration field and it's below the floor
    }
    days.add(w.date);
  }
  return days;
}

function resolveVolume(weekWorkouts: WorkoutEntry[]): VolumeSummary {
  const withDistance = weekWorkouts.filter(
    (w): w is WorkoutEntry & { distanceM: number } =>
      typeof w.distanceM === 'number' && Number.isFinite(w.distanceM),
  );

  const done = withDistance.length === 0
    ? null
    : Math.round((withDistance.reduce((sum, w) => sum + w.distanceM, 0) / 1000) * 10) / 10;

  return { unit: 'km', done, target: null };
}

export async function resolveTrainingSummary(userId: string, todayKey: string): Promise<TrainingSummary> {
  const start = weekStartKeyForDay(todayKey);
  const dayKeys = weekDayKeys(start);

  const [planned, sets, weekWorkouts, lastLift] = await Promise.all([
    plannedMoveDays(userId, dayKeys),
    getSetsForLocalDays(userId, dayKeys),
    fetchWeekWorkouts(userId, dayKeys),
    getLastLift(userId),
  ]);

  // Completed = logged strength sets OR a real HealthKit workout that day —
  // a union, deduped by local day, so a day with both counts once.
  const completed = new Set([...completedLocalDays(sets), ...healthKitWorkoutDays(weekWorkouts)]);

  const days: WeekDay[] = dayKeys.map(date => ({
    date,
    planned:   planned.has(date),
    completed: completed.has(date),
  }));

  const week: WeekSummary = {
    start,
    plannedSessions:   planned.size > 0 ? planned.size : null,
    completedSessions: completed.size,
    days,
  };

  return { week, volume: resolveVolume(weekWorkouts), lastLift };
}
