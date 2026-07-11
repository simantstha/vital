/**
 * GET /api/nudges
 *
 * Returns pending (unsent) coach nudges for the authenticated user, oldest
 * scheduled_for first. The iOS NudgeSyncer polls this on app foreground,
 * schedules each item as a local one-shot notification, then acks via
 * POST /api/nudges/ack.
 *
 * Response:
 * {
 *   items: [{
 *     id:           string,
 *     type:         string,
 *     message:      string,
 *     scheduledFor: string (ISO 8601),
 *   }]
 * }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(schema.pending_nudges)
    .where(
      and(
        eq(schema.pending_nudges.user_id, userId),
        isNull(schema.pending_nudges.sent_at),
      ),
    )
    .orderBy(asc(schema.pending_nudges.scheduled_for))
    .limit(50);

  const items = rows.map(r => {
    const payload = r.payload as Record<string, unknown> | null;
    const message = typeof payload?.message === 'string' ? payload.message : '';
    return {
      id:           r.id,
      type:         r.type,
      message,
      scheduledFor: r.scheduled_for.toISOString(),
    };
  });

  return NextResponse.json({ items });
}
