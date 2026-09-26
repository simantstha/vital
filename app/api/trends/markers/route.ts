/**
 * GET /api/trends/markers?days=N (1-365, default 90)
 *
 * Day-keyed chart event markers for the Trends screen. Scope for now:
 * workout markers only (see lib/trendsMarkers.ts's `MarkerKind` union for
 * how a later kind, e.g. weight_logged, would slot in).
 *
 * Two sources, merged by lib/trendsMarkers.ts's `mergeWorkoutMarkers`:
 * - PRIMARY: `daily_metrics` rows with `metric = 'workouts'`
 *   (app/api/ingest/daily/route.ts) — HealthKit-derived, `date` already the
 *   user's local day, no timezone bucketing needed.
 * - SECONDARY: `workout_completed` events (WHOOP, in practice), bucketed
 *   into the user's local day here, used only for a date `daily_metrics`
 *   didn't already cover — so one workout logged by both sources isn't
 *   double-counted.
 *
 * Response: { days, markers: [{ date, kind: 'workout', label, count }] }
 * — oldest → newest, at most one marker per (date, kind).
 */

import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { pickTimeZone } from '@/lib/localDay';
import { bucketWorkoutMarkers, markersFromDailyMetrics, mergeWorkoutMarkers } from '@/lib/trendsMarkers';

export const dynamic = 'force-dynamic';

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

const DEFAULT_DAYS = 90;

/**
 * `Number('abc')` is NaN, which survives both `Math.min` and `Math.max`
 * unscathed — so an unparseable `?days=` must be caught explicitly and
 * replaced with the default before clamping, not just clamped.
 */
function parseDaysParam(raw: string | null): number {
  const parsed = raw === null ? DEFAULT_DAYS : Number(raw);
  const days = Number.isFinite(parsed) ? parsed : DEFAULT_DAYS;
  return Math.max(1, Math.min(365, Math.floor(days)));
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const days = parseDaysParam(searchParams.get('days'));

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const [row] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const tz = pickTimeZone(searchParams.get('tz'), row?.timezone);

  const since = isoDateDaysAgo(days);
  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [dailyMetricRows, eventRows] = await Promise.all([
    db
      .select({
        date: schema.daily_metrics.date,
        value: schema.daily_metrics.value,
        payload: schema.daily_metrics.payload,
      })
      .from(schema.daily_metrics)
      .where(and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'workouts'),
        gte(schema.daily_metrics.date, since),
      )),
    db
      .select({ timestamp: schema.events.timestamp, payload: schema.events.payload })
      .from(schema.events)
      .where(and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'workout_completed'),
        gte(schema.events.timestamp, windowStart),
      )),
  ]);

  const primary = markersFromDailyMetrics(dailyMetricRows);
  const secondary = bucketWorkoutMarkers(eventRows, tz);
  const markers = mergeWorkoutMarkers(primary, secondary);

  return NextResponse.json({ days, markers });
}
