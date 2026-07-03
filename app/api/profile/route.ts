/**
 * GET /api/profile
 *
 * Returns the dev user's profile, integration statuses, and aggregate stats.
 *
 * Response:
 * {
 *   name: string,
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
import { getOrCreateDevUser, DEV_NAME } from '@/lib/brain/user';

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

export async function GET(): Promise<NextResponse> {
  let userId: string;
  try {
    userId = await getOrCreateDevUser();
  } catch (err) {
    return NextResponse.json({ error: `DB error resolving user: ${String(err)}` }, { status: 500 });
  }

  // Fetch all events for this user (profile stats span all time)
  const allEvents = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.user_id, userId));

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
    name: DEV_NAME,
    integrations: [
      { name: 'Apple Health', status: hasHealthKit ? 'connected' : 'disconnected' },
    ],
    stats: {
      loggedDays:  dateSet.size,
      mealsLogged,
      avgHrv,
      workouts,
    },
  });
}
