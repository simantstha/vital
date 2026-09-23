/**
 * Vital — workout_sets repository (roadmap 1.3 / ux-spec-v4 §5.4, W1)
 *
 * Backs the `log_workout` / `get_training_history` coach tools (lib/brain/tools.ts)
 * and the /api/workouts/* routes. Mirrors the shape of other repositories in
 * this codebase (lib/streakRepository.ts, lib/notificationInboxRepository.ts):
 * thin DB access + pure aggregation helpers that are unit-testable without a
 * database.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import type { NewWorkoutSet, WorkoutSet } from '@/db/schema';
import { localDayKey } from '@/lib/localDay';

// ── Insert (idempotent by session_id) ───────────────────────────────────────

export interface SetInput {
  exercise: string;          // canonical, lowercase
  exerciseDisplay: string;
  setIndex: number;          // 1-based
  reps: number;
  loadKg: number | null;
  rpe: number | null;
  isWarmup?: boolean;
}

export interface LogSessionInput {
  userId: string;
  sessionId: string;         // client-generated UUID — grouping + idempotency key
  performedAt: Date;
  timezone: string | null | undefined;
  source: 'manual' | 'coach' | 'template';
  workoutId?: string | null; // optional link to a matching HealthKit workout_completed event
  sets: SetInput[];
}

/**
 * Insert (or, on a retried POST with the same session_id, overwrite) a batch
 * of sets logged together. Idempotent via the `workout_sets_session_set_idx`
 * unique index on (session_id, set_index): re-sending the same session_id
 * updates the existing rows in place rather than duplicating them, so a
 * client retry after a dropped response is always safe.
 */
export async function logWorkoutSession(input: LogSessionInput): Promise<WorkoutSet[]> {
  if (input.sets.length === 0) return [];

  const localDay = localDayKey(input.performedAt, input.timezone);

  const values: NewWorkoutSet[] = input.sets.map((set) => ({
    user_id:          input.userId,
    workout_id:       input.workoutId ?? null,
    performed_at:     input.performedAt,
    local_day:        localDay,
    exercise:         set.exercise,
    exercise_display: set.exerciseDisplay,
    set_index:        set.setIndex,
    reps:             set.reps,
    load_kg:          set.loadKg,
    rpe:              set.rpe,
    is_warmup:        set.isWarmup ?? false,
    source:           input.source,
    session_id:       input.sessionId,
  }));

  return db
    .insert(schema.workout_sets)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.workout_sets.session_id, schema.workout_sets.set_index],
      set: {
        user_id:          sqlExcluded('user_id'),
        workout_id:       sqlExcluded('workout_id'),
        performed_at:     sqlExcluded('performed_at'),
        local_day:        sqlExcluded('local_day'),
        exercise:         sqlExcluded('exercise'),
        exercise_display: sqlExcluded('exercise_display'),
        reps:             sqlExcluded('reps'),
        load_kg:          sqlExcluded('load_kg'),
        rpe:              sqlExcluded('rpe'),
        is_warmup:        sqlExcluded('is_warmup'),
        source:           sqlExcluded('source'),
      },
    })
    .returning();
}

// drizzle-orm doesn't expose a typed `excluded` reference the way some ORMs
// do, so this composes the raw SQL fragment Postgres expects inside an
// ON CONFLICT ... DO UPDATE SET clause.
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** All sets for one exercise, most recent first, capped at `limit`. */
export async function getExerciseHistory(
  userId: string,
  exercise: string,
  limit = 100,
): Promise<WorkoutSet[]> {
  return db
    .select()
    .from(schema.workout_sets)
    .where(and(eq(schema.workout_sets.user_id, userId), eq(schema.workout_sets.exercise, exercise)))
    .orderBy(desc(schema.workout_sets.performed_at), desc(schema.workout_sets.set_index))
    .limit(limit);
}

/**
 * The most recent full session that included this exercise — every set in
 * that session_id, not just this exercise's sets, so "repeat last" / "Log as
 * done" (ux-spec §5.4) reproduces the whole workout, not one lift.
 * Returns [] when the exercise has never been logged.
 */
export async function getLastSessionForExercise(
  userId: string,
  exercise: string,
): Promise<WorkoutSet[]> {
  const [mostRecent] = await db
    .select()
    .from(schema.workout_sets)
    .where(and(eq(schema.workout_sets.user_id, userId), eq(schema.workout_sets.exercise, exercise)))
    .orderBy(desc(schema.workout_sets.performed_at))
    .limit(1);

  if (!mostRecent) return [];

  return db
    .select()
    .from(schema.workout_sets)
    .where(and(
      eq(schema.workout_sets.user_id, userId),
      eq(schema.workout_sets.session_id, mostRecent.session_id),
    ))
    .orderBy(schema.workout_sets.exercise, schema.workout_sets.set_index);
}

/** All sets logged within the last `days` days, oldest first (for aggregation). */
export async function getSetsSince(userId: string, days: number): Promise<WorkoutSet[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(schema.workout_sets)
    .where(and(eq(schema.workout_sets.user_id, userId), gte(schema.workout_sets.performed_at, since)))
    .orderBy(schema.workout_sets.performed_at);
}

// ── Pure aggregation (unit-testable without a DB) ───────────────────────────

/** Epley formula: estimated one-rep max from a completed set. */
export function estimateOneRepMax(loadKg: number, reps: number): number {
  if (reps <= 0) return 0;
  if (reps === 1) return loadKg;
  return loadKg * (1 + reps / 30);
}

/** YYYY-MM-DD (UTC) of the Monday that starts the week containing `date`. */
export function weekStartKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

export interface WeeklyExerciseStat {
  weekStart: string;         // YYYY-MM-DD, Monday
  bestEstimatedOneRepMaxKg: number | null; // null when every set that week was bodyweight (no load)
  volumeKg: number;          // sum(reps * load_kg) across loaded sets that week
  totalSets: number;
  totalReps: number;
}

export interface ProgressionSummary {
  [exercise: string]: WeeklyExerciseStat[]; // ascending by weekStart
}

interface SetLike {
  exercise: string;
  performed_at: Date;
  reps: number;
  load_kg: number | null;
  is_warmup: boolean;
}

/**
 * Best estimated 1RM (Epley) per week and weekly training volume, grouped by
 * exercise. Warmup sets are excluded from both — they're not representative
 * of working capacity. Bodyweight sets (load_kg null) count toward
 * totalSets/totalReps but not volume or 1RM (no load to compute from).
 */
export function summarizeProgression(sets: SetLike[]): ProgressionSummary {
  const byExercise = new Map<string, Map<string, WeeklyExerciseStat>>();

  for (const set of sets) {
    if (set.is_warmup) continue;
    const week = weekStartKey(set.performed_at);
    let weeks = byExercise.get(set.exercise);
    if (!weeks) {
      weeks = new Map();
      byExercise.set(set.exercise, weeks);
    }
    let stat = weeks.get(week);
    if (!stat) {
      stat = { weekStart: week, bestEstimatedOneRepMaxKg: null, volumeKg: 0, totalSets: 0, totalReps: 0 };
      weeks.set(week, stat);
    }
    stat.totalSets += 1;
    stat.totalReps += set.reps;
    if (set.load_kg != null) {
      stat.volumeKg += set.reps * set.load_kg;
      const e1rm = estimateOneRepMax(set.load_kg, set.reps);
      stat.bestEstimatedOneRepMaxKg = Math.max(stat.bestEstimatedOneRepMaxKg ?? 0, e1rm);
    }
  }

  const result: ProgressionSummary = {};
  for (const [exercise, weeks] of byExercise) {
    result[exercise] = Array.from(weeks.values())
      .map(stat => ({ ...stat, volumeKg: Math.round(stat.volumeKg * 100) / 100, bestEstimatedOneRepMaxKg: stat.bestEstimatedOneRepMaxKg != null ? Math.round(stat.bestEstimatedOneRepMaxKg * 100) / 100 : null }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }
  return result;
}

/** DB-backed convenience wrapper around summarizeProgression. */
export async function getProgressionSummary(userId: string, days = 84): Promise<ProgressionSummary> {
  const sets = await getSetsSince(userId, days);
  return summarizeProgression(sets);
}
