/**
 * Pure builders for the workout/sleep analysis `input_payload` WHOOP writes
 * (see the multi-device-analyses contract, "Creating WHOOP analyses"). No
 * fetch, no DB — lib/whoop/sync.ts wires these to a repository, same split as
 * lib/whoop/mapping.ts.
 *
 * Both builders omit any field whose source value is null/undefined rather
 * than writing a placeholder 0 — "never write 0 for a missing value" (same
 * convention lib/whoop/mapping.ts already follows for daily_metrics).
 */

import type { WhoopSleep, WhoopWorkout, WhoopZoneDurations } from './client';

const KILOJOULE_PER_KCAL = 4.184;

/** 'running' -> 'Running', 'weightlifting' -> 'Weightlifting', 'high_intensity_interval_training' -> 'High Intensity Interval Training'. */
export function titleCaseSportName(sportName: string): string {
  return sportName
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function kilojoulesToKcal(kilojoule: number | null | undefined): number | null {
  return kilojoule == null ? null : Math.round(kilojoule / KILOJOULE_PER_KCAL);
}

export interface WhoopWorkoutAnalysisInput {
  type: string;
  startTime: string;
  durationMin: number;
  kcal?: number;
  avgHr?: number;
  maxHr?: number;
  distanceM?: number;
  strain?: number;
  /** 5 buckets of seconds (zone 1 through zone 5 — WHOOP's zone 0 is dropped, see zonesFromWhoopZoneDurations). */
  zonesSec?: number[];
  zoneBasis?: 'maxHr';
  source: 'whoop';
}

/**
 * Maps WHOOP's `zone_durations` (milliseconds, zones 0-5) into the 5-bucket
 * `zonesSec` shape (whole seconds, zones 1-5 — zone 0 is "below zone 1",
 * dropped as noise). Returns `undefined` when WHOOP hasn't reported zone
 * durations for this workout at all ("omit it when absent" — phase 2 "both
 * devices" contract, PR A "Zones").
 */
export function zonesFromWhoopZoneDurations(zoneDurations: WhoopZoneDurations | null | undefined): number[] | undefined {
  if (!zoneDurations) return undefined;
  const millisToSec = (ms: number) => Math.round(ms / 1000);
  return [
    millisToSec(zoneDurations.zone_one_milli),
    millisToSec(zoneDurations.zone_two_milli),
    millisToSec(zoneDurations.zone_three_milli),
    millisToSec(zoneDurations.zone_four_milli),
    millisToSec(zoneDurations.zone_five_milli),
  ];
}

/**
 * Builds the `input_payload` for a WHOOP workout analysis row — the same
 * shape the iOS card already decodes (type/durationMin/kcal/avgHr/maxHr/
 * distanceM/startTime), plus `strain` and `source: 'whoop'` which pass
 * through to the model verbatim (lib/proactiveAnalysisFormatting.ts).
 */
export function buildWhoopWorkoutInput(workout: WhoopWorkout): WhoopWorkoutAnalysisInput {
  const start = new Date(workout.start);
  const end = new Date(workout.end);
  const durationMin = Math.round((end.getTime() - start.getTime()) / 60_000);
  const score = workout.score;

  const result: WhoopWorkoutAnalysisInput = {
    type: titleCaseSportName(workout.sport_name),
    startTime: workout.start,
    durationMin,
    source: 'whoop',
  };
  const kcal = kilojoulesToKcal(score?.kilojoule);
  if (kcal != null) result.kcal = kcal;
  if (score?.average_heart_rate != null) result.avgHr = score.average_heart_rate;
  if (score?.max_heart_rate != null) result.maxHr = score.max_heart_rate;
  if (score?.distance_meter != null) result.distanceM = score.distance_meter;
  if (score?.strain != null) result.strain = score.strain;
  const zonesSec = zonesFromWhoopZoneDurations(score?.zone_durations);
  if (zonesSec != null) {
    result.zonesSec = zonesSec;
    result.zoneBasis = 'maxHr';
  }
  return result;
}

export interface WhoopSleepStages {
  core?: number;
  deep?: number;
  rem?: number;
  awake?: number;
}

export interface WhoopSleepAnalysisInput {
  minutes: number;
  stages: WhoopSleepStages;
  source: 'whoop';
}

function millisToMinutes(millis: number | null | undefined): number | null {
  return millis == null ? null : Math.round(millis / 60_000);
}

/**
 * Builds the `input_payload` for a WHOOP sleep analysis row. `minutes` is
 * asleep time (in-bed minus awake), not raw in-bed span — matching
 * lib/brain/recovery.ts's sleepFromWhoopStageSummary, which already treats
 * WHOOP's whoop_sleep_min daily_metrics value as in-bed time and derives
 * asleep time the same way. Returns null when the sleep has no stage summary
 * yet (unscored) — there's nothing true to write.
 */
export function buildWhoopSleepInput(sleep: WhoopSleep): WhoopSleepAnalysisInput | null {
  const stageSummary = sleep.score?.stage_summary as Record<string, unknown> | undefined;
  if (!stageSummary) return null;

  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const inBedMilli = num(stageSummary.total_in_bed_time_milli);
  const awakeMilli = num(stageSummary.total_awake_time_milli);
  if (inBedMilli == null || awakeMilli == null) return null;

  const asleepMinutes = Math.round((inBedMilli - awakeMilli) / 60_000);
  if (asleepMinutes <= 0) return null;

  const stages: WhoopSleepStages = {};
  const core = millisToMinutes(num(stageSummary.total_light_sleep_time_milli));
  const deep = millisToMinutes(num(stageSummary.total_slow_wave_sleep_time_milli));
  const rem = millisToMinutes(num(stageSummary.total_rem_sleep_time_milli));
  const awake = millisToMinutes(awakeMilli);
  if (core != null) stages.core = core;
  if (deep != null) stages.deep = deep;
  if (rem != null) stages.rem = rem;
  if (awake != null) stages.awake = awake;

  return { minutes: asleepMinutes, stages, source: 'whoop' };
}
