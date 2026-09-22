/**
 * GET /api/workouts/summary?days= — progression summary across every logged
 * exercise: best estimated one-rep max (Epley) per week and weekly training
 * volume (sets × reps × load), grouped by exercise. See
 * lib/workoutRepository.ts's summarizeProgression for the aggregation rules
 * (warmup sets excluded; bodyweight sets count toward reps but not
 * volume/1RM).
 *
 * ?days= optional, default 84 (12 weeks), clamped to [7, 365].
 * Response: { days: number, exercises: { [exercise]: WeeklyExerciseStat[] } }
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { getProgressionSummary } from '@/lib/workoutRepository';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 84;
const MIN_DAYS = 7;
const MAX_DAYS = 365;

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const url = new URL(request.url);
  const rawDays = url.searchParams.get('days');
  let days = DEFAULT_DAYS;
  if (rawDays !== null) {
    const parsed = Number(rawDays);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return NextResponse.json({ error: 'days must be an integer.' }, { status: 400 });
    }
    days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, parsed));
  }

  try {
    const exercises = await getProgressionSummary(userId, days);
    return NextResponse.json({ days, exercises });
  } catch (err) {
    console.error('[workouts/summary] DB read error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
