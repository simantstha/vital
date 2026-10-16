/**
 * Pure "which local days count as a completed session" helpers (no DB, no Next.js imports).
 *
 * Moved out of lib/workoutRepository.ts (`completedLocalDays`) and lib/trainingSummary.ts
 * (`healthKitWorkoutDays`), which re-export them so existing imports keep working. The split exists so code
 * that must run without DATABASE_URL (the day-by-day timeline suite in lib/timeline/) can import the real
 * implementation instead of a copy. Bodies are unchanged from where they lived before.
 */
import type { WorkoutSet } from '@/db/schema';
import type { WorkoutEntry } from '@/lib/brain/tools';

/** Distinct local days (YYYY-MM-DD) on which the user logged a non-warmup set. */
export function completedLocalDays(sets: Pick<WorkoutSet, 'local_day' | 'is_warmup'>[]): Set<string> {
  const days = new Set<string>();
  for (const set of sets) {
    if (!set.is_warmup) days.add(set.local_day);
  }
  return days;
}

// A HealthKit workout always carries a duration (`DailyIngestWorkout.durationMin`
// in ios/Vital/Sources/Health/HealthKitBackfill.swift is non-optional), so a
// day only counts as "completed" from HealthKit data when at least one
// workout that day is >= this long — a 2-minute walk HealthKit auto-detected
// shouldn't light up a training dot. If an entry is ever missing the field
// (e.g. an older/foreign payload shape), it's counted rather than dropped —
// the honesty rule cuts toward not hiding real activity, not toward stricter
// filtering than the data can support.
const MIN_HEALTHKIT_WORKOUT_MINUTES = 10;

/**
 * Distinct local days with >= 1 HealthKit workout that's real training, not
 * a trivial auto-detected blip — see MIN_HEALTHKIT_WORKOUT_MINUTES above.
 * Pure/unit-testable: takes entries already scoped to the week.
 */
export function healthKitWorkoutDays(entries: WorkoutEntry[]): Set<string> {
  const days = new Set<string>();
  for (const w of entries) {
    const duration = w.durationMin;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration < MIN_HEALTHKIT_WORKOUT_MINUTES) {
      continue; // has a duration field and it's below the floor
    }
    days.add(w.date);
  }
  return days;
}
