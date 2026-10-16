/**
 * Pure lift-progression math (no DB, no Next.js imports).
 *
 * Moved out of lib/workoutRepository.ts, which re-exports every name here so existing imports keep working.
 * The split exists so code that must run without DATABASE_URL (the day-by-day timeline suite in lib/timeline/)
 * can import the real implementation instead of a copy. Bodies are unchanged from where they lived before.
 */
import { weekStartKeyForDay } from './localDay';

/** Highest rep count that still yields a meaningful e1RM; Epley overshoots beyond this. */
export const E1RM_MAX_REPS = 12;

/**
 * Epley estimated one-rep max. Returns 0 for reps outside 1..E1RM_MAX_REPS
 * (high-rep sets count toward volume but not toward best e1RM). When `rpe`
 * (5..10) is given, reps-in-reserve (10 - rpe) is added to the reps, with the
 * effective count still capped at E1RM_MAX_REPS.
 */
export function estimateOneRepMax(loadKg: number, reps: number, rpe?: number | null): number {
  if (reps <= 0 || reps > E1RM_MAX_REPS) return 0;
  const rir = rpe != null && Number.isFinite(rpe) && rpe >= 5 && rpe <= 10 ? 10 - rpe : 0;
  const effective = Math.min(reps + rir, E1RM_MAX_REPS);
  if (effective <= 1) return loadKg;
  return loadKg * (1 + effective / 30);
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
  /**
   * Additive (optional so older fixtures / stored payloads stay valid): distinct
   * local days that week with a working set of this exercise ("sessions that
   * contain the lift" — the headline-lift ranking in lib/liftChange.ts).
   */
  sessions?: number;
  /** Additive: heaviest loaded working set that week (kg); null when every set was bodyweight. */
  topLoadKg?: number | null;
}

export interface ProgressionSummary {
  [exercise: string]: WeeklyExerciseStat[]; // ascending by weekStart
}

interface SetLike {
  exercise: string;
  performed_at: Date;
  /** Local calendar day (YYYY-MM-DD) the set belongs to; preferred over performed_at for week buckets. */
  local_day?: string | null;
  rpe?: number | null;
  reps: number;
  load_kg: number | null;
  is_warmup: boolean;
}

/**
 * Best estimated 1RM (Epley, sets of <= 12 reps only) per week and weekly training volume, grouped by
 * exercise. Weeks are Monday-start buckets of the stored `local_day`, so a
 * Sunday-evening set stays in its own local week. Warmup sets are excluded from both — they're not representative
 * of working capacity. Bodyweight sets (load_kg null) count toward
 * totalSets/totalReps but not volume or 1RM (no load to compute from).
 */
export function summarizeProgression(sets: SetLike[]): ProgressionSummary {
  const byExercise = new Map<string, Map<string, WeeklyExerciseStat>>();
  const sessionDaysByWeek = new Map<string, Set<string>>();

  for (const set of sets) {
    if (set.is_warmup) continue;
    const week = set.local_day ? weekStartKeyForDay(set.local_day) : weekStartKey(set.performed_at);
    let weeks = byExercise.get(set.exercise);
    if (!weeks) {
      weeks = new Map();
      byExercise.set(set.exercise, weeks);
    }
    let stat = weeks.get(week);
    if (!stat) {
      stat = { weekStart: week, bestEstimatedOneRepMaxKg: null, volumeKg: 0, totalSets: 0, totalReps: 0, topLoadKg: null };
      weeks.set(week, stat);
    }
    stat.totalSets += 1;
    stat.totalReps += set.reps;
    const sessionKey = `${set.exercise}|${week}`;
    const sessionDays = sessionDaysByWeek.get(sessionKey) ?? new Set<string>();
    sessionDays.add(set.local_day ?? set.performed_at.toISOString().slice(0, 10));
    sessionDaysByWeek.set(sessionKey, sessionDays);
    if (set.load_kg != null) {
      stat.topLoadKg = Math.max(stat.topLoadKg ?? 0, set.load_kg);
      stat.volumeKg += set.reps * set.load_kg;
      const e1rm = estimateOneRepMax(set.load_kg, set.reps, set.rpe);
      if (e1rm > 0) stat.bestEstimatedOneRepMaxKg = Math.max(stat.bestEstimatedOneRepMaxKg ?? 0, e1rm);
    }
  }

  const result: ProgressionSummary = {};
  for (const [exercise, weeks] of byExercise) {
    result[exercise] = Array.from(weeks.values())
      .map(stat => ({
        ...stat,
        volumeKg: Math.round(stat.volumeKg * 100) / 100,
        bestEstimatedOneRepMaxKg: stat.bestEstimatedOneRepMaxKg != null ? Math.round(stat.bestEstimatedOneRepMaxKg * 100) / 100 : null,
        sessions: sessionDaysByWeek.get(`${exercise}|${stat.weekStart}`)?.size ?? 0,
        topLoadKg: stat.topLoadKg != null ? Math.round(stat.topLoadKg * 100) / 100 : null,
      }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }
  return result;
}
