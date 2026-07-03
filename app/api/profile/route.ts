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
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { getCalibration } from '@/lib/brain/baselines';

export const dynamic = 'force-dynamic';

// ── Payload helpers ─────────────────────────────────────────────────────────

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // Fetch all events for this user (profile stats span all time)
  const [allEvents, userRow, calibration] = await Promise.all([
    db.select().from(schema.events).where(eq(schema.events.user_id, userId)),
    db
      .select({ name: schema.users.name, onboarded_at: schema.users.onboarded_at })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1),
    getCalibration(userId),
  ]);
  const name = userRow[0]?.name ?? 'Vital User';
  const onboarded = userRow[0]?.onboarded_at != null;

  // ── Integration: Apple Health ─────────────────────────────────────────────
  // Connected if any event came from healthkit source
  const hasHealthKit = allEvents.some(e => e.source === 'healthkit');

  // ── Stats ─────────────────────────────────────────────────────────────────

  // loggedDays: distinct UTC calendar dates with any event
  const dateSet = new Set<string>();
  for (const e of allEvents) {
    dateSet.add(e.timestamp.toISOString().split('T')[0]);
  }

  // mealsLogged
  const mealsLogged = allEvents.filter(e => e.type === 'meal_logged').length;

  // avgHrv
  const hrvValues: number[] = [];
  for (const e of allEvents.filter(e => e.type === 'hrv_reading')) {
    const p = pl(e.payload);
    const v = num(p.value) ?? num(p.hrv) ?? num(p.valueMs) ?? num(p.sdnn);
    if (v != null) hrvValues.push(v);
  }
  const avgHrv =
    hrvValues.length > 0
      ? Math.round((hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length) * 10) / 10
      : null;

  // workouts
  const workouts = allEvents.filter(e => e.type === 'workout_completed').length;

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
