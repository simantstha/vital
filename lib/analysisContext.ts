/**
 * Vital — deterministic `context` for workout/sleep analyses (analysis v2,
 * phase 1, §1 of docs/superpowers' analysis-v2 contract).
 *
 * Every number the iOS AnalysisView renders outside the model's own text
 * (headline/shortInsight/narrative/observations/nextSteps) comes from this
 * module. Pure functions only — no `@/db` import, so this is directly
 * unit-testable without a DATABASE_URL, same split as lib/brain/recovery.ts
 * and lib/brain/whoopContext.ts. The thin DB-reading glue that feeds these
 * functions lives in lib/proactiveHealthRepository.ts.
 *
 * A section whose inputs are missing/insufficient returns `undefined` — the
 * caller omits the key entirely rather than sending a null or a fabricated
 * value (see the contract's "principles" section).
 */

import { sleepFromWhoopStageSummary } from './brain/recovery';

// ── Shared primitives ───────────────────────────────────────────────────────

/** The two recovery-metric sources iOS renders — NOT the same strings as the
 *  `daily_metrics.source` / `workout_analyses.source` / `sleep_analyses.source`
 *  columns ('healthkit' | 'whoop'): 'healthkit' maps to 'apple' here. */
export type RecoverySource = 'whoop' | 'apple';
export type VsNormal = 'above' | 'normal' | 'below';

export interface MetricReading {
  value: number;
  unit: 'ms' | 'bpm';
  vsNormal?: VsNormal;
  source: RecoverySource;
}

/** Maps a daily_metrics/analysis `source` column value to the `context` DTO's `RecoverySource`. */
export function recoverySourceFromMetricSource(source: 'healthkit' | 'whoop'): RecoverySource {
  return source === 'whoop' ? 'whoop' : 'apple';
}

export interface BaselineForVsNormal {
  established: boolean;
  mean: number | null;
  sd: number | null;
}

/**
 * `vsNormal` per the contract: "using that metric's baseline (mean30 ± 1
 * sd30). Only report it when the baseline is established." An sd30 of 0 (or
 * missing) can never produce a meaningful band, so that also yields
 * `undefined` rather than everything reading 'above'/'below' off a
 * zero-width band.
 */
export function vsNormal(value: number, baseline: BaselineForVsNormal | null | undefined): VsNormal | undefined {
  if (!baseline || !baseline.established || baseline.mean == null || baseline.sd == null || baseline.sd <= 0) {
    return undefined;
  }
  if (value > baseline.mean + baseline.sd) return 'above';
  if (value < baseline.mean - baseline.sd) return 'below';
  return 'normal';
}

/** Standard median (average of the two middle values on an even count). `undefined` for an empty array. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianOfPresent(values: Array<number | undefined | null>): number | undefined {
  return median(values.filter((v): v is number => v != null));
}

// ── Workout: usual ──────────────────────────────────────────────────────────

const MIN_SESSIONS_FOR_USUAL = 3;

export interface PreviousWorkoutSample {
  distanceM?: number;
  durationMin?: number;
  paceMinPerKm?: number;
  avgHr?: number;
}

export interface UsualWorkout {
  sessions: number;
  distanceM?: number;
  durationMin?: number;
  paceMinPerKm?: number;
  avgHr?: number;
}

/**
 * Median of up to 8 previous same-type workouts (the caller bounds the query
 * to 8; this function just needs `n >= 3` to report anything at all).
 */
export function computeUsualWorkout(previous: PreviousWorkoutSample[]): UsualWorkout | undefined {
  if (previous.length < MIN_SESSIONS_FOR_USUAL) return undefined;

  const usual: UsualWorkout = { sessions: previous.length };
  const distanceM = medianOfPresent(previous.map(p => p.distanceM));
  const durationMin = medianOfPresent(previous.map(p => p.durationMin));
  const paceMinPerKm = medianOfPresent(previous.map(p => p.paceMinPerKm));
  const avgHr = medianOfPresent(previous.map(p => p.avgHr));
  if (distanceM != null) usual.distanceM = distanceM;
  if (durationMin != null) usual.durationMin = durationMin;
  if (paceMinPerKm != null) usual.paceMinPerKm = paceMinPerKm;
  if (avgHr != null) usual.avgHr = avgHr;
  return usual;
}

// ── Workout: pace history ────────────────────────────────────────────────────

export interface PaceHistory {
  previous: number[]; // min/km, oldest → newest
  rank: number;       // 1 = fastest among previous + this one
}

/**
 * `previousPacesOldestFirst` is the same population `computeUsualWorkout` was
 * given, filtered to entries that have a pace, oldest → newest. Rank counts
 * how many of (previous + this) are strictly faster (lower min/km) than this
 * one, so ties share the better rank rather than depending on array order.
 */
export function computePaceHistory(
  previousPacesOldestFirst: number[],
  currentPace: number | undefined,
): PaceHistory | undefined {
  if (currentPace == null) return undefined;
  if (previousPacesOldestFirst.length < MIN_SESSIONS_FOR_USUAL) return undefined;

  const faster = previousPacesOldestFirst.filter(p => p < currentPace).length;
  return { previous: previousPacesOldestFirst, rank: faster + 1 };
}

// ── Workout: effort ──────────────────────────────────────────────────────────

export type EffortZone = 'easy' | 'steady' | 'hard' | 'max';

export function effortZoneFromPct(avgPct: number): EffortZone {
  if (avgPct < 0.60) return 'easy';
  if (avgPct < 0.75) return 'steady';
  if (avgPct < 0.90) return 'hard';
  return 'max';
}

export interface Effort {
  restingHr: number;
  maxHr: number;
  avgPct: number;
  zone: EffortZone;
}

/**
 * Only reported "when both are known and maxHr >= restingHr + 20" — a resting
 * HR within 20bpm of max is either bad data or too narrow a range to divide
 * into a meaningful percentage, so this deliberately omits the section rather
 * than emitting a nonsensical or wildly clamped zone.
 */
export function computeEffort(input: {
  restingHr?: number;
  maxHr?: number;
  avgHr?: number;
}): Effort | undefined {
  const { restingHr, maxHr, avgHr } = input;
  if (restingHr == null || maxHr == null || avgHr == null) return undefined;
  if (maxHr < restingHr + 20) return undefined;

  const avgPct = Math.min(1, Math.max(0, (avgHr - restingHr) / (maxHr - restingHr)));
  return { restingHr, maxHr, avgPct, zone: effortZoneFromPct(avgPct) };
}

// ── Sleep: usual ─────────────────────────────────────────────────────────────

const MIN_NIGHTS_FOR_USUAL = 5;

export interface SleepStages {
  core?: number;
  deep?: number;
  rem?: number;
  awake?: number;
}

export interface SleepNightSample {
  minutes: number;
  stages?: SleepStages;
}

export interface SleepUsual {
  nights: number;
  minutes: number;
  stages?: SleepStages;
}

const STAGE_KEYS = ['core', 'deep', 'rem', 'awake'] as const;

/** Median over the previous 14 nights (caller bounds the query); reports nothing under 5 nights. */
export function computeSleepUsual(previous: SleepNightSample[]): SleepUsual | undefined {
  if (previous.length < MIN_NIGHTS_FOR_USUAL) return undefined;
  const minutes = median(previous.map(p => p.minutes));
  if (minutes == null) return undefined;

  const usual: SleepUsual = { nights: previous.length, minutes };
  const stages: SleepStages = {};
  for (const key of STAGE_KEYS) {
    const value = medianOfPresent(previous.map(p => p.stages?.[key]));
    if (value != null) stages[key] = value;
  }
  if (Object.keys(stages).length > 0) usual.stages = stages;
  return usual;
}

// ── Sleep: week strip ────────────────────────────────────────────────────────

export interface WeekNight {
  date: string;
  minutes: number;
}

/**
 * Assembles the last-7-nights strip from a sparse date→minutes map, in the
 * given oldest→newest date order. A date with no entry (no sync, no
 * analysis, a rest day with no sleep row) is simply left out — never
 * backfilled with a zero or an interpolated value.
 */
export function assembleWeek(nightsByDate: Map<string, number>, datesOldestFirst: string[]): WeekNight[] {
  const week: WeekNight[] = [];
  for (const date of datesOldestFirst) {
    const minutes = nightsByDate.get(date);
    if (minutes != null) week.push({ date, minutes });
  }
  return week;
}

// ── Sleep: before-bed window ─────────────────────────────────────────────────

export const BEFORE_BED_WORKOUT_WINDOW_HOURS = 4;
export const BEFORE_BED_MEAL_WINDOW_HOURS = 3;

export interface BeforeBed {
  lastWorkoutEndedAt?: string;
  lastMealAt?: string;
}

/**
 * Picks the latest workout end / meal timestamp that falls inside
 * (bedTime - window, bedTime] — "these often go with lighter sleep", so only
 * things that happened close enough to bedtime to plausibly matter. Multiple
 * candidates in-window collapse to the one closest to bedtime.
 */
export function computeBeforeBed(input: {
  bedTimeIso: string;
  workoutEndedAtIsos: string[];
  mealAtIsos: string[];
}): BeforeBed {
  const bedTime = new Date(input.bedTimeIso).getTime();

  function latestWithin(isos: string[], windowHours: number): string | undefined {
    const windowMs = windowHours * 60 * 60 * 1000;
    let best: { iso: string; t: number } | undefined;
    for (const iso of isos) {
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) continue;
      if (t > bedTime || t <= bedTime - windowMs) continue;
      if (!best || t > best.t) best = { iso, t };
    }
    return best?.iso;
  }

  const result: BeforeBed = {};
  const lastWorkoutEndedAt = latestWithin(input.workoutEndedAtIsos, BEFORE_BED_WORKOUT_WINDOW_HOURS);
  const lastMealAt = latestWithin(input.mealAtIsos, BEFORE_BED_MEAL_WINDOW_HOURS);
  if (lastWorkoutEndedAt != null) result.lastWorkoutEndedAt = lastWorkoutEndedAt;
  if (lastMealAt != null) result.lastMealAt = lastMealAt;
  return result;
}

// ── Sleep stage payload normalization ───────────────────────────────────────

/**
 * HealthKit's daily_metrics `sleep_minutes` payload (and a HealthKit sleep
 * analysis's own `input_payload.stages`) is already normalized to
 * `{core?, deep?, rem?, awake?}` in minutes by the time it reaches this
 * store — see lib/proactiveAnalysisFormatting.ts's SLEEP_STAGE_KEYS and
 * app/api/ingest/daily/route.ts, which writes `day.sleep.stages` verbatim.
 */
export function appleStagesFromPayload(payload: unknown): SleepStages | undefined {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const stages: SleepStages = {};
  for (const key of STAGE_KEYS) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) stages[key] = value;
  }
  return Object.keys(stages).length > 0 ? stages : undefined;
}

function millisToMinutes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / 60_000) : undefined;
}

/**
 * WHOOP's `daily_metrics.whoop_sleep_min` payload is the raw
 * `sleep.score.stage_summary` object (see lib/whoop/mapping.ts) — the same
 * shape lib/brain/recovery.ts's `sleepFromWhoopStageSummary` and
 * lib/whoop/analysisPayloads.ts's `buildWhoopSleepInput` already read.
 */
export function whoopStagesFromSummary(stageSummary: unknown): SleepStages | undefined {
  if (stageSummary == null || typeof stageSummary !== 'object' || Array.isArray(stageSummary)) return undefined;
  const record = stageSummary as Record<string, unknown>;
  const stages: SleepStages = {};
  const core = millisToMinutes(record.total_light_sleep_time_milli);
  const deep = millisToMinutes(record.total_slow_wave_sleep_time_milli);
  const rem = millisToMinutes(record.total_rem_sleep_time_milli);
  const awake = millisToMinutes(record.total_awake_time_milli);
  if (core != null) stages.core = core;
  if (deep != null) stages.deep = deep;
  if (rem != null) stages.rem = rem;
  if (awake != null) stages.awake = awake;
  return Object.keys(stages).length > 0 ? stages : undefined;
}

/**
 * Converts one raw `daily_metrics` sleep row into an asleep-minutes sample
 * (contract: "WHOOP uses `whoop_sleep_min`, which is IN-BED time. Use
 * sleepFromWhoopStageSummary for asleep minutes."). HealthKit's
 * `sleep_minutes` value is already asleep time — no conversion needed.
 * Returns `undefined` for a WHOOP night whose stage summary can't yield an
 * asleep figure yet (unscored sleep) — that night is genuinely unknown, not
 * zero, so it must be left out of any median/week rather than guessed at.
 */
export function sleepNightFromDailyMetric(
  source: 'healthkit' | 'whoop',
  value: number,
  payload: unknown,
): SleepNightSample | undefined {
  if (source === 'healthkit') {
    return { minutes: value, stages: appleStagesFromPayload(payload) };
  }
  const derived = sleepFromWhoopStageSummary(value, payload);
  if (!derived) return undefined;
  return { minutes: derived.asleepMinutes, stages: whoopStagesFromSummary(payload) };
}

// ── context.devices (phase 2 "both devices" contract, PR A) ────────────────
// Only present when BOTH devices recorded the session — see
// db/schema.ts's workout_analyses.merged_into_id and
// sleep_analyses.secondary_source/secondary_payload docs, and
// lib/analysisContextRepository.ts for how the "other" row is found.

/** The `context.devices` DTO's device id — 'healthkit' maps to 'apple', same convention as RecoverySource. */
export type DeviceId = 'apple' | 'whoop';

export function deviceIdFromSource(source: 'healthkit' | 'whoop'): DeviceId {
  return source === 'whoop' ? 'whoop' : 'apple';
}

export interface WorkoutDeviceRunning {
  cadenceSpm?: number;
  groundContactMs?: number;
  powerW?: number;
  strideM?: number;
}

export interface WorkoutDeviceSession {
  source: DeviceId;
  durationMin?: number;
  distanceM?: number;
  avgHr?: number;
  maxHr?: number;
  /** Only present on the primary session — "kcal appears only on the primary session" (contract). */
  kcal?: number;
  strain?: number;
  zonesSec?: number[];
  zoneBasis?: 'reserve' | 'maxHr';
  hrSeries?: number[];
  running?: WorkoutDeviceRunning;
}

export interface WorkoutDevicesContext {
  primary: DeviceId;
  /** Primary session first (contract). */
  sessions: WorkoutDeviceSession[];
}

/** A `workout_analyses.input_payload` field reader — mirrors the local `pl`/`num` helpers used throughout this module and lib/analysisContextRepository.ts. */
function plainObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return numbers.length > 0 ? numbers : undefined;
}

function workoutSessionFromPayload(
  source: 'healthkit' | 'whoop',
  payload: unknown,
  isPrimary: boolean,
): WorkoutDeviceSession {
  const p = plainObject(payload);
  const session: WorkoutDeviceSession = { source: deviceIdFromSource(source) };

  const durationMin = finiteNumber(p.durationMin);
  if (durationMin != null) session.durationMin = durationMin;
  const distanceM = finiteNumber(p.distanceM);
  if (distanceM != null) session.distanceM = distanceM;
  const avgHr = finiteNumber(p.avgHr);
  if (avgHr != null) session.avgHr = avgHr;
  const maxHr = finiteNumber(p.maxHr);
  if (maxHr != null) session.maxHr = maxHr;
  if (isPrimary) {
    // "kcal appears only on the primary session. The other session omits it,
    // and the UI says 'not counted'." — counted totals come only from the
    // primary device, so nothing is counted twice.
    const kcal = finiteNumber(p.kcal);
    if (kcal != null) session.kcal = kcal;
  }
  const strain = finiteNumber(p.strain);
  if (strain != null) session.strain = strain;
  const zonesSec = numberArray(p.zonesSec);
  if (zonesSec != null) session.zonesSec = zonesSec;
  if (p.zoneBasis === 'reserve' || p.zoneBasis === 'maxHr') session.zoneBasis = p.zoneBasis;
  const hrSeries = numberArray(p.hrSeries);
  if (hrSeries != null) session.hrSeries = hrSeries;
  if (p.running !== null && typeof p.running === 'object' && !Array.isArray(p.running)) {
    const r = p.running as Record<string, unknown>;
    const running: WorkoutDeviceRunning = {};
    const cadenceSpm = finiteNumber(r.cadenceSpm);
    if (cadenceSpm != null) running.cadenceSpm = cadenceSpm;
    const groundContactMs = finiteNumber(r.groundContactMs);
    if (groundContactMs != null) running.groundContactMs = groundContactMs;
    const powerW = finiteNumber(r.powerW);
    if (powerW != null) running.powerW = powerW;
    const strideM = finiteNumber(r.strideM);
    if (strideM != null) running.strideM = strideM;
    if (Object.keys(running).length > 0) session.running = running;
  }

  return session;
}

export interface WorkoutDeviceRow {
  source: 'healthkit' | 'whoop';
  payload: unknown;
}

/**
 * Builds `context.devices` for a workout analysis from the survivor's and the
 * other (suppressed same-session) row's payloads. `survivor` becomes the
 * primary session (first, with kcal); `other` is the secondary session
 * (no kcal — "not counted").
 */
export function buildWorkoutDevicesContext(
  survivor: WorkoutDeviceRow,
  other: WorkoutDeviceRow,
): WorkoutDevicesContext {
  return {
    primary: deviceIdFromSource(survivor.source),
    sessions: [
      workoutSessionFromPayload(survivor.source, survivor.payload, true),
      workoutSessionFromPayload(other.source, other.payload, false),
    ],
  };
}

export interface SleepDeviceSession {
  source: DeviceId;
  minutes: number;
  stages?: SleepStages;
}

export interface SleepDevicesContext {
  primary: DeviceId;
  sessions: SleepDeviceSession[];
}

/**
 * `sleep_analyses.input_payload` already stores `minutes` (asleep minutes)
 * and `stages` (already in `{core,deep,rem,awake}` minutes) for BOTH sources
 * — lib/whoop/analysisPayloads.ts's buildWhoopSleepInput and the HealthKit
 * ingest route both normalize to this shape before it's ever persisted — so,
 * unlike the daily_metrics-derived `sleepNightFromDailyMetric` above, no
 * source-specific conversion is needed here.
 */
function sleepSessionFromPayload(source: 'healthkit' | 'whoop', payload: unknown): SleepDeviceSession | undefined {
  const p = plainObject(payload);
  const minutes = finiteNumber(p.minutes);
  if (minutes == null) return undefined;
  const session: SleepDeviceSession = { source: deviceIdFromSource(source), minutes };
  const stages = appleStagesFromPayload(p.stages);
  if (stages) session.stages = stages;
  return session;
}

export interface SleepDeviceRow {
  source: 'healthkit' | 'whoop';
  payload: unknown;
}

/**
 * Builds `context.devices` for a sleep analysis, only when both the primary
 * row and the secondary payload yield a real minutes figure — "only when
 * secondary_payload exists" (contract), and never a fabricated 0 for either
 * side.
 */
export function buildSleepDevicesContext(
  primary: SleepDeviceRow,
  secondary: SleepDeviceRow,
): SleepDevicesContext | undefined {
  const primarySession = sleepSessionFromPayload(primary.source, primary.payload);
  const secondarySession = sleepSessionFromPayload(secondary.source, secondary.payload);
  if (!primarySession || !secondarySession) return undefined;
  return { primary: deviceIdFromSource(primary.source), sessions: [primarySession, secondarySession] };
}
