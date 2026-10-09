/**
 * GET /api/review/weekly[?tz=<IANA zone>]
 *
 * The weekly review for the last completed local week (Mon–Sun in the
 * request `tz`, else users.timezone, else UTC), computed and stored on demand
 * when missing (lib/weeklyReviewLoader.ts). Never invents numbers: with too
 * little data the review says so (dataSufficiency.sufficient === false).
 *
 * Response:
 * {
 *   id, seenAt: ISO | null, createdAt: ISO,
 *   review: {
 *     weekStart, weekEnd, goal, verdict (same set as /api/goal/progress),
 *     headline (<= 80 chars),
 *     weekRating: 'good' | 'mixed' | 'tough' | 'light' | null,   // rates THIS week only (never the 4-week goal verdict); absent on rows stored before it existed
 *     stats: [{ label, value, comparison: string | null, tone: 'good'|'watch'|'neutral' }],   // max 4
 *     win: string | null, slip: string | null, nextWeek: string,
 *     dataSufficiency: { daysWithData, statCount, sufficient }
 *   }
 * }
 *
 * Auth: session JWT via middleware -> x-user-id (401 otherwise); 404 if the user row is gone.
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { getOrCreateLastWeekReview } from '@/lib/weeklyReviewLoader';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  try {
    const tz = new URL(request.url).searchParams.get('tz');
    const stored = await getOrCreateLastWeekReview(userId, { tz });
    if (!stored) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    return NextResponse.json(stored);
  } catch (err) {
    console.error('[/api/review/weekly] failed:', err);
    return NextResponse.json({ error: 'Failed to build weekly review' }, { status: 500 });
  }
}
