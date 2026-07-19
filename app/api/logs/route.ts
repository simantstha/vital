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
 *     dayKey?:     string,  // day-level HealthKit source date (yyyy-MM-dd)
 *     analysisId?: string,  // ready proactive-analysis id — workout_completed
 *                           // items match workout_analyses by (user_id, hk_uuid),
 *                           // sleep_session items match sleep_analyses by
 *                           // (user_id, wake_date = the item's day); present only
 *                           // when a status='ready' (and non-deleted) analysis
 *                           // exists, so clients can deep-link to GET
 *                           // /api/{workout,sleep}-analyses/:id
 *   }]
 * }
 * (redesign-v3 Phase 6: kcal/km/sleepMs added so the Logs day-pager can
 * summarize a day's entries without re-parsing title/subtitle strings.
 * Each is a conditional-spread field, present only when the source payload
 * carries it — same convention as the pre-existing imageThumb field.)
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, gte, inArray, desc, isNull } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { queryMetricPoints, queryWorkouts } from '@/lib/brain/tools';
import {
  dedupeWorkoutLogItems,
  mapDailySleepRow,
  mapEventToLogItem,
  mapHealthKitWorkout,
  sortLogItemsNewestFirst,
  type LogItem,
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

  const items = dedupeWorkoutLogItems(
    sortLogItemsNewestFirst([...eventItems, ...workoutItems, ...sleepItems]),
  );

  return NextResponse.json({ items: await withAnalysisIds(userId, items) });
}

// ── Proactive-analysis linkage ──────────────────────────────────────────────

/**
 * Attaches `analysisId` to items that have a ready proactive analysis.
 * Workout items are keyed by HealthKit UUID (the item id IS the hkUuid);
 * sleep items are keyed by wake date (the item's day). Both lookups are
 * batched into one query per kind for the whole range — never per item.
 */
async function withAnalysisIds(userId: string, items: LogItem[]): Promise<LogItem[]> {
  const workoutIds = items.filter((i) => i.type === 'workout_completed').map((i) => i.id);
  const sleepDays = items
    .filter((i) => i.type === 'sleep_session')
    .map((i) => i.dayKey ?? i.timestamp.slice(0, 10));

  const [workoutRows, sleepRows] = await Promise.all([
    workoutIds.length === 0 ? [] : db
      .select({ hkUuid: schema.workout_analyses.hk_uuid, analysisId: schema.workout_analyses.id })
      .from(schema.workout_analyses)
      .where(
        and(
          eq(schema.workout_analyses.user_id, userId),
          inArray(schema.workout_analyses.hk_uuid, workoutIds),
          eq(schema.workout_analyses.status, 'ready'),
          isNull(schema.workout_analyses.deleted_at),
        ),
      ),
    sleepDays.length === 0 ? [] : db
      .select({ wakeDate: schema.sleep_analyses.wake_date, analysisId: schema.sleep_analyses.id })
      .from(schema.sleep_analyses)
      .where(
        and(
          eq(schema.sleep_analyses.user_id, userId),
          inArray(schema.sleep_analyses.wake_date, sleepDays),
          eq(schema.sleep_analyses.status, 'ready'),
        ),
      ),
  ]);

  const workoutAnalysisByHkUuid = new Map(workoutRows.map((r) => [r.hkUuid, r.analysisId]));
  const sleepAnalysisByWakeDate = new Map(sleepRows.map((r) => [r.wakeDate, r.analysisId]));

  return items.map((item) => {
    const analysisId = item.type === 'workout_completed'
      ? workoutAnalysisByHkUuid.get(item.id)
      : item.type === 'sleep_session'
        ? sleepAnalysisByWakeDate.get(item.dayKey ?? item.timestamp.slice(0, 10))
        : undefined;
    return analysisId ? { ...item, analysisId } : item;
  });
}
