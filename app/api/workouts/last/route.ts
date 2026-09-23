/**
 * GET /api/workouts/last?exercise= — the most recent full session that
 * included this exercise (every set in that session, not just this
 * exercise's own sets — see lib/workoutRepository.ts's
 * getLastSessionForExercise doc comment), for ux-spec-v4 §5.4's "repeat
 * last session" ghost-value logger / "Log as done".
 *
 * Response: { sets: [...] } — [] when the exercise has never been logged.
 * 400 if `exercise` is missing.
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { getLastSessionForExercise } from '@/lib/workoutRepository';
import { schema } from '@/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const url = new URL(request.url);
  const exercise = url.searchParams.get('exercise')?.trim().toLowerCase();
  if (!exercise) {
    return NextResponse.json({ error: 'exercise query param is required.' }, { status: 400 });
  }

  try {
    const rows = await getLastSessionForExercise(userId, exercise);
    return NextResponse.json({ sets: rows.map(toWire) });
  } catch (err) {
    console.error('[workouts/last] DB read error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}

function toWire(row: typeof schema.workout_sets.$inferSelect) {
  return {
    id:              row.id,
    sessionId:       row.session_id,
    workoutId:       row.workout_id,
    performedAt:     row.performed_at.toISOString(),
    localDay:        row.local_day,
    exercise:        row.exercise,
    exerciseDisplay: row.exercise_display,
    setIndex:        row.set_index,
    reps:            row.reps,
    loadKg:          row.load_kg,
    rpe:             row.rpe,
    isWarmup:        row.is_warmup,
    source:          row.source,
  };
}
