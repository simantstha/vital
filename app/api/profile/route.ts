/**
 * GET /api/profile
 *
 * Returns the dev user's profile, integration statuses, and aggregate stats.
 *
 * Response:
 * {
 *   name: string,
 *   onboarded: boolean,   // true once users.onboarded_at is set (POST /api/onboarding)
 *   integrations: [
 *     { name: "Apple Health", status: "connected" | "disconnected" },
 *   ],
 *   stats: {
 *     loggedDays:  number,   // distinct UTC dates with at least one event
 *     mealsLogged: number,   // total meal_logged events
 *     avgHrv:      number | null,   // avg SDNN ms across all hrv_reading events
 *     workouts:    number,   // total workout_completed events
 *   },
 * }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { getCalibration } from '@/lib/brain/baselines';

export const dynamic = 'force-dynamic';

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // HealthKit-derived stats (avgHrv, workouts, tracked days, integration
  // status) come from daily_metrics — the store the backfill and background
  // sync write to, and the same source Today/Trends read — NOT the events
  // ledger. The app stopped writing hrv_reading/workout_completed events when
  // health sync moved to daily_metrics, so reading events here reported zero.
  // Meals are still logged as events (meal_logged), so mealsLogged stays there.
  const [userRow, calibration, dmAgg, dmDates, mealRows] = await Promise.all([
    db
      .select({ name: schema.users.name, onboarded_at: schema.users.onboarded_at })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1),
    getCalibration(userId),
    db.execute(sql`
      select
        avg(value)  filter (where metric = 'hrv_sdnn')             as avg_hrv,
        coalesce(sum(value) filter (where metric = 'workouts'), 0) as workouts,
        count(*)                                                   as row_count
      from ${schema.daily_metrics}
      where ${schema.daily_metrics.user_id} = ${userId}
    `),
    db
      .selectDistinct({ date: schema.daily_metrics.date })
      .from(schema.daily_metrics)
      .where(eq(schema.daily_metrics.user_id, userId)),
    db
      .select({ timestamp: schema.events.timestamp })
      .from(schema.events)
      .where(and(eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged'))),
  ]);

  const name = userRow[0]?.name ?? 'Vital User';
  const onboarded = userRow[0]?.onboarded_at != null;

  const aggRow = (dmAgg as unknown as Record<string, unknown>[])[0] ?? {};

  // ── Integration: Apple Health ─────────────────────────────────────────────
  // Connected once any HealthKit data has landed in daily_metrics.
  const hasHealthKit = Number(aggRow.row_count ?? 0) > 0;

  // ── Stats ─────────────────────────────────────────────────────────────────

  // loggedDays: distinct calendar dates the user was tracked — union of
  // daily_metrics days (device-local 'YYYY-MM-DD') and meal-logged UTC days.
  const dateSet = new Set<string>();
  for (const r of dmDates) dateSet.add(String(r.date));
  for (const m of mealRows) dateSet.add(m.timestamp.toISOString().split('T')[0]);

  const mealsLogged = mealRows.length;

  // pg returns aggregates as numeric strings; null when no hrv_sdnn rows exist.
  const avgHrvRaw = aggRow.avg_hrv != null ? Number(aggRow.avg_hrv) : NaN;
  const avgHrv = Number.isFinite(avgHrvRaw) ? Math.round(avgHrvRaw * 10) / 10 : null;

  const workouts = Math.round(Number(aggRow.workouts ?? 0));

  // ── Response ──────────────────────────────────────────────────────────────
  return NextResponse.json({
    name,
    onboarded,
    integrations: [
      { name: 'Apple Health', status: hasHealthKit ? 'connected' : 'disconnected' },
    ],
    stats: {
      loggedDays:  dateSet.size,
      mealsLogged,
      avgHrv,
      workouts,
    },
    calibration,
  });
}
