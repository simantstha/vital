/**
 * Vital — workout_sets repository (roadmap 1.3 / ux-spec-v4 §5.4, W1)
 *
 * Backs the `log_workout` / `get_training_history` coach tools (lib/brain/tools.ts)
 * and the /api/workouts/* routes. Mirrors the shape of other repositories in
 * this codebase (lib/streakRepository.ts, lib/notificationInboxRepository.ts):
 * thin DB access + pure aggregation helpers that are unit-testable without a
 * database.
 */

import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
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

/**
 * All sets whose `local_day` falls in `dayKeys` (e.g. the 7 keys of one
 * local week — see `lib/localDay.ts` weekDayKeys). Bucketed by the
 * already-computed local-day column rather than a `performed_at` range, so
 * this is DST/timezone-proof the same way `local_day` itself is: a
 * Sunday-night set stays in Sunday's bucket regardless of the server's clock.
 */
export async function getSetsForLocalDays(userId: string, dayKeys: string[]): Promise<WorkoutSet[]> {
  if (dayKeys.length === 0) return [];
  return db
    .select()
    .from(schema.workout_sets)
    .where(and(eq(schema.workout_sets.user_id, userId), inArray(schema.workout_sets.local_day, dayKeys)))
    .orderBy(schema.workout_sets.performed_at);
}

/** Distinct local days (YYYY-MM-DD) on which the user logged a non-warmup set. */
export function completedLocalDays(sets: Pick<WorkoutSet, 'local_day' | 'is_warmup'>[]): Set<string> {
  const days = new Set<string>();
  for (const set of sets) {
    if (!set.is_warmup) days.add(set.local_day);
  }
  return days;
}

// ── Last lift ────────────────────────────────────────────────────────────────
// "Today's main lift" can't be reliably identified from plan_items — coach
// GET /api/plan only ever auto-seeds 'meal' and 'sleep' kind rows; 'move'
// rows exist only when a user manually adds one, with a free-text title that
// doesn't reliably map to a workout_sets.exercise value. So `lastLift` is
// instead defined as the most recent top (heaviest) working set of the most
// recent strength session, regardless of what's planned for today.

export interface LastLift {
  exercise: string;       // exercise_display, as the user said/typed it
  date: string;            // local_day of the session
  sets: number;             // working (non-warmup) sets of this exercise in that session
  reps: number;             // reps of the top set
  weightKg: number | null; // load of the top set; null for a bodyweight exercise
}

/**
 * Picks the top (heaviest-load) set among `sets` — all assumed to be
 * non-warmup sets of one exercise from one session. Ties, and the
 * all-bodyweight case (every load_kg null), keep the first set encountered.
 * Pure/unit-testable: no DB access.
 */
export function pickTopSet<T extends { load_kg: number | null; reps: number }>(sets: T[]): T | undefined {
  return sets.reduce<T | undefined>((best, cur) => {
    if (!best) return cur;
    const bestLoad = best.load_kg ?? -Infinity;
    const curLoad = cur.load_kg ?? -Infinity;
    return curLoad > bestLoad ? cur : best;
  }, undefined);
}

/**
 * Given every working set of one exercise from one session (most recent
 * first is NOT required — order doesn't matter), builds the `lastLift` card.
 * null when `sets` is empty (nothing logged).
 */
export function computeLastLift(sets: WorkoutSet[]): LastLift | null {
  if (sets.length === 0) return null;
  const topSet = pickTopSet(sets);
  if (!topSet) return null;
  return {
    exercise: topSet.exercise_display,
    date:     topSet.local_day,
    sets:     sets.length,
    reps:     topSet.reps,
    weightKg: topSet.load_kg,
  };
}

/** The single most recent non-warmup set the user has ever logged, if any. */
export async function getMostRecentWorkingSet(userId: string): Promise<WorkoutSet | undefined> {
  const [row] = await db
    .select()
    .from(schema.workout_sets)
    .where(and(eq(schema.workout_sets.user_id, userId), eq(schema.workout_sets.is_warmup, false)))
    .orderBy(desc(schema.workout_sets.performed_at))
    .limit(1);
  return row;
}

/** Every non-warmup set of `exercise` within one session — the sibling sets of a top set. */
export async function getSessionExerciseSets(
  userId: string,
  sessionId: string,
  exercise: string,
): Promise<WorkoutSet[]> {
  return db
    .select()
    .from(schema.workout_sets)
    .where(and(
      eq(schema.workout_sets.user_id, userId),
      eq(schema.workout_sets.session_id, sessionId),
      eq(schema.workout_sets.exercise, exercise),
      eq(schema.workout_sets.is_warmup, false),
    ))
    .orderBy(asc(schema.workout_sets.set_index));
}

/** DB-backed convenience wrapper: the lastLift card for `GET /api/training/summary`. */
export async function getLastLift(userId: string): Promise<LastLift | null> {
  const latest = await getMostRecentWorkingSet(userId);
  if (!latest) return null;
  const sessionSets = await getSessionExerciseSets(userId, latest.session_id, latest.exercise);
  return computeLastLift(sessionSets);
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
