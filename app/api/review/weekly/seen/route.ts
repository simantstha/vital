/**
 * POST /api/review/weekly/seen   body: { "id": "<weekly review id>" }
 *
 * Marks the user's weekly review as seen (the Today card's "Got it").
 * Idempotent. 400 on a malformed body, 404 when the review is not the caller's.
 *
 * Auth: session JWT via middleware -> x-user-id (401 otherwise).
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { markWeeklyReviewSeen } from '@/lib/weeklyReviewLoader';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let id: unknown;
  try {
    id = ((await request.json()) as { id?: unknown } | null)?.id;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'id must be a review id.' }, { status: 400 });
  }

  try {
    const ok = await markWeeklyReviewSeen(userId, id);
    if (!ok) return NextResponse.json({ error: 'Review not found.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[/api/review/weekly/seen] failed:', err);
    return NextResponse.json({ error: 'Failed to mark review seen' }, { status: 500 });
  }
}
