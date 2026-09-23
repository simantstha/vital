/**
 * POST /api/workouts/sets — log a session of strength-training sets.
 *
 * Body: {
 *   sessionId: string (client-generated UUID — groups these sets and makes a
 *     retried POST idempotent; see lib/workoutRepository.ts),
 *   performedAt?: string (ISO 8601; default: now),
 *   tz?: string (IANA timezone for local_day bucketing; default: user's saved timezone, else UTC),
 *   source: 'manual' | 'coach' | 'template',
 *   workoutId?: string | null (optional link to a matching HealthKit workout_completed event),
 *   sets: Array<{
 *     exercise: string,          // canonical name, e.g. "squat" — see lib/workoutParse.ts's alias map
 *     exerciseDisplay?: string,  // defaults to `exercise`
 *     setIndex?: number,         // defaults to 1-based position in the array
 *     reps: number,
 *     loadKg?: number | null,    // omit/null for bodyweight movements
 *     rpe?: number | null,
 *     isWarmup?: boolean,        // default false
 *   }>
 * }
 * Response: { ok: true, sets: [...] }
 *
 * Follows the same auth/validation shape as app/api/meals/log/route.ts.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { logWorkoutSession, type SetInput } from '@/lib/workoutRepository';

export const dynamic = 'force-dynamic';

const VALID_SOURCES = ['manual', 'coach', 'template'];

interface SetBody {
  exercise: string;
  exerciseDisplay?: string;
  setIndex?: number;
  reps: number;
  loadKg?: number | null;
  rpe?: number | null;
  isWarmup?: boolean;
}

interface LogSetsBody {
  sessionId: string;
  performedAt?: string;
  tz?: string;
  source: string;
  workoutId?: string | null;
  sets: SetBody[];
}

function isValidSet(s: unknown): s is SetBody {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.exercise === 'string' && o.exercise.trim().length > 0 &&
    typeof o.reps === 'number' && Number.isFinite(o.reps) && o.reps > 0 &&
    (o.exerciseDisplay === undefined || typeof o.exerciseDisplay === 'string') &&
    (o.setIndex === undefined || (typeof o.setIndex === 'number' && Number.isInteger(o.setIndex) && o.setIndex > 0)) &&
    (o.loadKg === undefined || o.loadKg === null || (typeof o.loadKg === 'number' && Number.isFinite(o.loadKg) && o.loadKg >= 0)) &&
    (o.rpe === undefined || o.rpe === null || (typeof o.rpe === 'number' && Number.isFinite(o.rpe) && o.rpe >= 0 && o.rpe <= 10)) &&
    (o.isWarmup === undefined || typeof o.isWarmup === 'boolean')
  );
}

function isValidBody(b: unknown): b is LogSetsBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.sessionId === 'string' && o.sessionId.trim().length > 0 &&
    typeof o.source === 'string' && VALID_SOURCES.includes(o.source) &&
    (o.performedAt === undefined || typeof o.performedAt === 'string') &&
    (o.tz === undefined || typeof o.tz === 'string') &&
    (o.workoutId === undefined || o.workoutId === null || typeof o.workoutId === 'string') &&
    Array.isArray(o.sets) && o.sets.length > 0 && o.sets.every(isValidSet)
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json(
      {
        error:
          'Body must include { sessionId: string, source: "manual"|"coach"|"template", ' +
          'sets: [{ exercise: string, reps: number, loadKg?, rpe?, isWarmup? }] }.',
      },
      { status: 400 },
    );
  }

  let performedAt: Date;
  if (body.performedAt !== undefined) {
    performedAt = new Date(body.performedAt);
    if (Number.isNaN(performedAt.getTime())) {
      return NextResponse.json({ error: 'performedAt must be a valid ISO 8601 timestamp.' }, { status: 400 });
    }
  } else {
    performedAt = new Date();
  }

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let tz = body.tz;
  if (!tz) {
    const [userRow] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    tz = userRow?.timezone ?? undefined;
  }

  const sets: SetInput[] = body.sets.map((s, i) => ({
    exercise:        s.exercise.trim().toLowerCase(),
    exerciseDisplay: s.exerciseDisplay?.trim() || s.exercise.trim(),
    setIndex:        s.setIndex ?? i + 1,
    reps:            Math.round(s.reps),
    loadKg:          s.loadKg ?? null,
    rpe:             s.rpe ?? null,
    isWarmup:        s.isWarmup ?? false,
  }));

  try {
    const rows = await logWorkoutSession({
      userId,
      sessionId: body.sessionId,
      performedAt,
      timezone: tz,
      source: body.source as 'manual' | 'coach' | 'template',
      workoutId: body.workoutId ?? null,
      sets,
    });

    return NextResponse.json({
      ok: true,
      sets: rows.map(toWire),
    });
  } catch (err) {
    console.error('[workouts/sets] DB insert error:', err);
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
