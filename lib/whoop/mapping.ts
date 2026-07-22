/**
 * Maps raw WHOOP v2 records into the existing daily_metrics / events
 * pipeline (see docs/superpowers/plans/2026-07-19-whoop-integration.md,
 * Task 4). Pure functions — no fetch, no DB — so this is unit-testable with
 * plain objects. lib/whoop/sync.ts wires this to the client + a repository.
 *
 * Day-keying uses the user's timezone via lib/localDay.ts's localDayKey(),
 * same DST-proof convention as the rest of the app. Recoveries have no
 * `start` of their own — WHOOP keys a recovery by the cycle (and sleep) it
 * closes — so a recovery is day-keyed off its cycle's `start`. A recovery
 * whose cycle isn't in the same fetched window is skipped rather than
 * guessing a date (never fabricate).
 *
 * "Missing score = skip, never write 0" (plan constraint) applies to
 * cycle/recovery, whose score can genuinely not exist yet (a recovery
 * doesn't exist until the sleep that produces it closes). Sleep duration is
 * different: start/end are core fields present on every non-nap sleep
 * record regardless of scoring, so whoop_sleep_min is always written when a
 * sleep closes; only the payload extras (stages/respiratory_rate/
 * performance) are null when the record isn't scored yet.
 */

import { localDayKey } from '../localDay';
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from './client';

const KILOJOULE_PER_KCAL = 4.184;

export interface WhoopSyncWindowInput {
  cycles: WhoopCycle[];
  recoveries: WhoopRecovery[];
  sleeps: WhoopSleep[];
  workouts: WhoopWorkout[];
}

export interface MappedDailyMetric {
  date: string;   // YYYY-MM-DD, user-local day
  metric: string;
  value: number;
  payload: unknown;
}

export interface MappedWorkoutEvent {
  whoopId: string;
  timestamp: Date;
  payload: {
    whoopId: string;
    sport_name: string;
    strain: number | null;
    avg_hr: number | null;
    max_hr: number | null;
    kcal: number | null;
    distance_m: number | null;
  };
}

export interface MappedWhoopWindow {
  dailyMetrics: MappedDailyMetric[];
  workoutEvents: MappedWorkoutEvent[];
}

function kilojoulesToKcal(kilojoule: number | null | undefined): number | null {
  return kilojoule == null ? null : Math.round(kilojoule / KILOJOULE_PER_KCAL);
}

function mapCycles(cycles: WhoopCycle[], timezone: string | null | undefined): {
  rows: MappedDailyMetric[];
  startById: Map<number, string>;
} {
  const rows: MappedDailyMetric[] = [];
  const startById = new Map<number, string>();

  for (const cycle of cycles) {
    startById.set(cycle.id, cycle.start);
    if (cycle.score == null) continue; // not scored yet — never write 0
    const date = localDayKey(new Date(cycle.start), timezone);
    if (cycle.score.strain != null) rows.push({ date, metric: 'whoop_day_strain', value: cycle.score.strain, payload: null });
  }

  return { rows, startById };
}

function mapRecoveries(
  recoveries: WhoopRecovery[],
  cycleStartById: Map<number, string>,
  timezone: string | null | undefined,
): MappedDailyMetric[] {
  const rows: MappedDailyMetric[] = [];

  for (const recovery of recoveries) {
    if (recovery.score == null) continue; // recovery doesn't exist until sleep closes — never write 0
    const cycleStart = cycleStartById.get(recovery.cycle_id);
    if (!cycleStart) continue; // cycle not in this window — skip rather than guess the date

    const date = localDayKey(new Date(cycleStart), timezone);
    const { score } = recovery;
    if (score.recovery_score != null) rows.push({ date, metric: 'whoop_recovery', value: score.recovery_score, payload: null });
    if (score.hrv_rmssd_milli != null) rows.push({ date, metric: 'whoop_hrv_rmssd', value: score.hrv_rmssd_milli, payload: null });
    if (score.resting_heart_rate != null) rows.push({ date, metric: 'whoop_resting_hr', value: score.resting_heart_rate, payload: null });
    if (score.spo2_percentage != null) rows.push({ date, metric: 'whoop_spo2', value: score.spo2_percentage, payload: null });
    if (score.skin_temp_celsius != null) rows.push({ date, metric: 'whoop_skin_temp', value: score.skin_temp_celsius, payload: null });
  }

  return rows;
}

function mapSleeps(sleeps: WhoopSleep[], timezone: string | null | undefined): MappedDailyMetric[] {
  const rows: MappedDailyMetric[] = [];

  for (const sleep of sleeps) {
    if (sleep.nap) continue;
    const start = new Date(sleep.start);
    const end = new Date(sleep.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;

    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    const date = localDayKey(start, timezone);
    rows.push({
      date,
      metric: 'whoop_sleep_min',
      value: minutes,
      payload: {
        stages: sleep.score?.stage_summary ?? null,
        respiratory_rate: sleep.score?.respiratory_rate ?? null,
        performance: sleep.score?.sleep_performance_percentage ?? null,
      },
    });
  }

  return rows;
}

function mapWorkouts(workouts: WhoopWorkout[]): MappedWorkoutEvent[] {
  return workouts.map((workout) => ({
    whoopId: workout.id,
    timestamp: new Date(workout.start),
    payload: {
      whoopId: workout.id,
      sport_name: workout.sport_name,
      strain: workout.score?.strain ?? null,
      avg_hr: workout.score?.average_heart_rate ?? null,
      max_hr: workout.score?.max_heart_rate ?? null,
      kcal: kilojoulesToKcal(workout.score?.kilojoule),
      distance_m: workout.score?.distance_meter ?? null,
    },
  }));
}

export function mapWhoopWindow(input: WhoopSyncWindowInput, timezone: string | null | undefined): MappedWhoopWindow {
  const { rows: cycleRows, startById } = mapCycles(input.cycles, timezone);
  const recoveryRows = mapRecoveries(input.recoveries, startById, timezone);
  const sleepRows = mapSleeps(input.sleeps, timezone);
  const workoutEvents = mapWorkouts(input.workouts);

  return {
    dailyMetrics: [...cycleRows, ...recoveryRows, ...sleepRows],
    workoutEvents,
  };
}
