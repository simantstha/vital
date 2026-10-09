/**
 * GET /api/workouts/sessions?limit= — the user's most recent distinct
 * strength sessions (default 8, max 20), newest first, for the lift logger's
 * "Repeat: …" session picker.
 *
 * Response: { sessions: [{ sessionId, performedAt, localDay,
 *   exercises: [{ exercise, display, sets, topSet: { reps, loadKg },
 *   setDetails: [{ reps, loadKg, rpe }] }] }] }
 * — `sessions` is [] when nothing has been logged.
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { getRecentSessions } from '@/lib/workoutRepository';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const raw = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    const sessions = await getRecentSessions(userId, limit);
    return NextResponse.json({ sessions });
  } catch (err) {
    console.error('[workouts/sessions] DB read error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
