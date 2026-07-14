/**
 * GET /api/logs?days=3
 *
 * Returns a unified activity log across meal_logged, workout_completed,
 * weight_logged, hrv_reading, and sleep_session events — newest first.
 *
 * Response:
 * {
 *   items: [{
 *     id:        string,
 *     type:      string,
 *     timestamp: string (ISO 8601),
 *     title:     string,
 *     subtitle:  string,
 *     imageThumb?: string,  // meal_logged only, when the log had a photo
 *     kcal?:       number,  // meal_logged only — kcal eaten (not burned)
 *     km?:         number,  // workout_completed only — distance, 2dp
 *     sleepMs?:    number,  // sleep_session only — duration in ms
 *     hasExactTime?: boolean, // HealthKit-derived items only
 *   }]
 * }
 * (redesign-v3 Phase 6: kcal/km/sleepMs added so the Logs day-pager can
 * summarize a day's entries without re-parsing title/subtitle strings.
 * Each is a conditional-spread field, present only when the source payload
 * carries it — same convention as the pre-existing imageThumb field.)
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, gte, inArray, desc } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { queryMetricPoints, queryWorkouts } from '@/lib/brain/tools';
import {
  mapDailySleepRow,
  mapEventToLogItem,
  mapHealthKitWorkout,
  sortLogItemsNewestFirst,
} from '@/lib/logItems';

export const dynamic = 'force-dynamic';

const LOG_TYPES = ['meal_logged', 'workout_completed', 'weight_logged', 'hrv_reading', 'sleep_session'];

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const days = Math.max(1, Math.min(90, Number(searchParams.get('days') ?? '3')));

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);

  const events = await db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.user_id, userId),
        gte(schema.events.timestamp, since),
        inArray(schema.events.type, LOG_TYPES),
      ),
    )
    .orderBy(desc(schema.events.timestamp))
    .limit(200);

  const eventItems = events.map(mapEventToLogItem);

  // HealthKit workouts and sleep are synced into daily_metrics rather than the
  // events ledger. Workout startTime is an exact instant when available; daily
  // sleep remains day-level data attributed to its existing wake date.
  const [workouts, sleepRows] = await Promise.all([
    queryWorkouts(userId, days),
    queryMetricPoints(userId, 'sleep_minutes', days),
  ]);
  const workoutItems = workouts.map(mapHealthKitWorkout);
  const sleepItems = sleepRows.map(mapDailySleepRow);

  const items = sortLogItemsNewestFirst([...eventItems, ...workoutItems, ...sleepItems]);

  return NextResponse.json({ items });
}
