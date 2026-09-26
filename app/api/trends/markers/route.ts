/**
 * GET /api/trends/markers?days=N (1-365, default 90)
 *
 * Day-keyed chart event markers for the Trends screen. Scope for now:
 * `workout_completed` events only (see lib/trendsMarkers.ts's `MarkerKind`
 * union for how a later kind, e.g. weight_logged, would slot in).
 *
 * Response: { days, markers: [{ date, kind: 'workout', label, count }] }
 * — oldest → newest, at most one marker per (date, kind).
 */

import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { pickTimeZone } from '@/lib/localDay';
import { bucketWorkoutMarkers } from '@/lib/trendsMarkers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const days = Math.max(1, Math.min(365, Number(searchParams.get('days') ?? '90')));

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

  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ timestamp: schema.events.timestamp, payload: schema.events.payload })
    .from(schema.events)
    .where(and(
      eq(schema.events.user_id, userId),
      eq(schema.events.type, 'workout_completed'),
      gte(schema.events.timestamp, windowStart),
    ));

  const markers = bucketWorkoutMarkers(rows, tz);

  return NextResponse.json({ days, markers });
}
