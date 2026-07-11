/**
 * POST /api/nudges/ack
 *
 * Batch-acknowledges nudges the device has fetched and scheduled locally
 * (D4): sets sent_at = now() for each id, scoped to this user and only if
 * still unsent (idempotent — re-acking an already-acked id is a no-op).
 *
 * Request body (JSON):
 *   { ids: string[] }   // 1-50 pending_nudges row uuids
 *
 * Response:
 *   { ok: true, acked: number }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { ids } = (body ?? {}) as { ids?: unknown };

  const isValidIds =
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= 50 &&
    ids.every(id => typeof id === 'string' && id.trim().length > 0);

  if (!isValidIds) {
    return NextResponse.json({ error: '"ids" must be an array of 1-50 uuid strings.' }, { status: 400 });
  }

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const updated = await db
    .update(schema.pending_nudges)
    .set({ sent_at: new Date() })
    .where(
      and(
        eq(schema.pending_nudges.user_id, userId),
        inArray(schema.pending_nudges.id, ids as string[]),
        isNull(schema.pending_nudges.sent_at),
      ),
    )
    .returning({ id: schema.pending_nudges.id });

  return NextResponse.json({ ok: true, acked: updated.length });
}
