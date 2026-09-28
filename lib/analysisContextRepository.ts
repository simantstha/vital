/**
 * Vital — DB-reading glue for the workout/sleep analysis `context` object
 * (analysis v2 §1). Thin by design: every real computation (medians, ranks,
 * effort zones, vsNormal, week assembly, before-bed windows) lives in the
 * pure, unit-tested lib/analysisContext.ts. This module only runs the
 * bounded queries and hands their rows to those pure functions.
 *
 * Wired into lib/proactiveHealthRepository.ts as
 * `getWorkoutAnalysisContext` / `getSleepAnalysisContext`.
 *
 * Query bounds (see the analysis-v2 contract, "Performance"):
 *  - up to 8 previous same-type workouts
 *  - up to 180 days for the highest recorded max HR
 *  - up to 14 nights for the sleep "usual"
 *  - up to 7 nights for the "week" strip
 *  - a few-hour window for before-bed events (workouts/meals)
 */

import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import type { AnalysisRecord } from './proactiveHealthHttp';
import { nextDayKey } from './localDay';
import { selectHrvSource, type HrvMetric } from './brain/recovery';
import { queryBaseline } from './brain/tools';
import {
  assembleWeek,
  buildSleepDevicesContext,
  buildWorkoutDevicesContext,
  computeBeforeBed,
  computeEffort,
  computePaceHistory,
  computeSleepUsual,
  computeUsualWorkout,
  sleepNightFromDailyMetric,
  vsNormal,
  type MetricReading,
  type PreviousWorkoutSample,
  type RecoverySource,
  type WorkoutDeviceRow,
} from './analysisContext';

const MAX_PREVIOUS_SESSIONS = 8;
const MAX_HR_WINDOW_DAYS = 180;
const SLEEP_USUAL_WINDOW_NIGHTS = 14;
const WEEK_NIGHTS = 7;

// ── Payload helpers (local copies of the pattern used by lib/brain/brief.ts
//    and lib/brain/recovery.ts — kept local so this module's only DB-y import
//    is `@/db`, matching lib/brain/tools.ts's split) ─────────────────────────

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

type MetricSource = 'healthkit' | 'whoop';

interface RecoverySelection {
  hrvMetric: HrvMetric;
  rhrMetric: 'resting_hr' | 'whoop_resting_hr';
  sleepMetric: 'sleep_minutes' | 'whoop_sleep_min';
  metricSource: MetricSource;
  recoverySource: RecoverySource;
}

/**
 * Same source-selection rule the daily brief uses (lib/brain/recovery.ts's
 * selectHrvSource): WHOOP wins whenever it has fresh data, otherwise
 * HealthKit. Computed at request time, per the contract.
 */
async function resolveRecoverySelection(userId: string): Promise<RecoverySelection | null> {
  const [hrvBaseline, whoopHrvBaseline, hrvPts, whoopHrvPts, whoopConnRows] = await Promise.all([
    queryBaseline(userId, 'hrv_sdnn'),
    queryBaseline(userId, 'whoop_hrv_rmssd'),
    db.select({ date: schema.daily_metrics.date })
      .from(schema.daily_metrics)
      .where(and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'hrv_sdnn'),
        gte(schema.daily_metrics.date, isoDateDaysAgo(14)),
      )),
    db.select({ date: schema.daily_metrics.date })
      .from(schema.daily_metrics)
      .where(and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'whoop_hrv_rmssd'),
        gte(schema.daily_metrics.date, isoDateDaysAgo(14)),
      )),
    db.select({ status: schema.whoop_connections.status })
      .from(schema.whoop_connections).where(eq(schema.whoop_connections.user_id, userId)).limit(1),
  ]);

  const whoopConnected = whoopConnRows[0]?.status === 'active';
  const selected = selectHrvSource({
    whoopConnected,
    whoopRecentPointDays: whoopHrvPts.length,
    whoopBaselineDataDays: whoopHrvBaseline?.dataDays ?? 0,
    healthkitRecentPointDays: hrvPts.length,
    healthkitBaselineDataDays: hrvBaseline?.dataDays ?? 0,
  });

  if (selected === 'whoop_hrv_rmssd') {
    return {
      hrvMetric: 'whoop_hrv_rmssd', rhrMetric: 'whoop_resting_hr', sleepMetric: 'whoop_sleep_min',
      metricSource: 'whoop', recoverySource: 'whoop',
    };
  }
  if (selected === 'hrv_sdnn') {
    return {
      hrvMetric: 'hrv_sdnn', rhrMetric: 'resting_hr', sleepMetric: 'sleep_minutes',
      metricSource: 'healthkit', recoverySource: 'apple',
    };
  }
  return null;
}

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function dailyMetricOnDate(
  userId: string,
  metric: string,
  date: string,
): Promise<{ value: number; payload: unknown } | null> {
  const [row] = await db.select({ value: schema.daily_metrics.value, payload: schema.daily_metrics.payload })
    .from(schema.daily_metrics)
    .where(and(
      eq(schema.daily_metrics.user_id, userId),
      eq(schema.daily_metrics.metric, metric),
      eq(schema.daily_metrics.date, date),
    ))
    .limit(1);
  return row ?? null;
}

async function readingOnDate(
  userId: string,
  metric: string,
  date: string,
  unit: 'ms' | 'bpm',
  recoverySource: RecoverySource,
): Promise<MetricReading | undefined> {
  const [row, baseline] = await Promise.all([
    dailyMetricOnDate(userId, metric, date),
    queryBaseline(userId, metric),
  ]);
  if (!row) return undefined;
  const value = Math.round(row.value);
  const vs = vsNormal(value, baseline
    ? { established: baseline.established, mean: baseline.stats?.mean30 ?? null, sd: baseline.stats?.sd30 ?? null }
    : null);
  const reading: MetricReading = { value, unit, source: recoverySource };
  if (vs) reading.vsNormal = vs;
  return reading;
}

function userSleepGoalQuery(userId: string) {
  return db.select({ sleepGoalMinutes: schema.users.sleep_goal_minutes })
    .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
}

// ── Workout context ──────────────────────────────────────────────────────────

export async function getWorkoutAnalysisContext(
  userId: string,
  analysis: AnalysisRecord,
): Promise<Record<string, unknown> | undefined> {
  const input = pl(analysis.input);
  const type = str(input.type);
  const paceMinPerKm = num(input.paceMinPerKm);
  const avgHrThis = num(input.avgHr);
  const startTimeStr = str(input.startTime);
  const workoutDateKey = analysis.date; // already a 'YYYY-MM-DD' local day key (workout_date column)

  const referenceTimestamp = startTimeStr ? new Date(startTimeStr) : new Date(`${workoutDateKey}T12:00:00.000Z`);
  const since180Key = (() => {
    const d = new Date(referenceTimestamp);
    d.setUTCDate(d.getUTCDate() - MAX_HR_WINDOW_DAYS);
    return d.toISOString().slice(0, 10);
  })();

  const [previousRows, maxHrRows, recovery, otherByMergedInto, selfRow] = await Promise.all([
    type
      ? db.select({ inputPayload: schema.workout_analyses.input_payload, workoutDate: schema.workout_analyses.workout_date })
          .from(schema.workout_analyses)
          .where(and(
            eq(schema.workout_analyses.user_id, userId),
            isNull(schema.workout_analyses.deleted_at),
            sql`${schema.workout_analyses.input_payload}->>'type' = ${type}`,
            sql`coalesce(${schema.workout_analyses.started_at}, ${schema.workout_analyses.workout_date}::timestamptz)
                < ${referenceTimestamp.toISOString()}::timestamptz`,
          ))
          .orderBy(desc(sql`coalesce(${schema.workout_analyses.started_at}, ${schema.workout_analyses.workout_date}::timestamptz)`))
          .limit(MAX_PREVIOUS_SESSIONS)
      : Promise.resolve([] as Array<{ inputPayload: unknown; workoutDate: string }>),
    db.select({ inputPayload: schema.workout_analyses.input_payload })
      .from(schema.workout_analyses)
      .where(and(
        eq(schema.workout_analyses.user_id, userId),
        isNull(schema.workout_analyses.deleted_at),
        gte(schema.workout_analyses.workout_date, since180Key),
        lte(schema.workout_analyses.workout_date, workoutDateKey),
      )),
    resolveRecoverySelection(userId),
    // The row whose merged_into_id points at this analysis: this analysis is
    // the survivor, and `other` is the same-session loser (the common case —
    // the API always serves the survivor).
    db.select({ source: schema.workout_analyses.source, inputPayload: schema.workout_analyses.input_payload })
      .from(schema.workout_analyses)
      .where(and(eq(schema.workout_analyses.user_id, userId), eq(schema.workout_analyses.merged_into_id, analysis.id)))
      .limit(1),
    // This analysis's own merged_into_id: set only when THIS row is itself
    // the loser (contract: "if this row is itself the loser, its
    // merged_into_id target").
    db.select({ mergedIntoId: schema.workout_analyses.merged_into_id })
      .from(schema.workout_analyses)
      .where(and(eq(schema.workout_analyses.user_id, userId), eq(schema.workout_analyses.id, analysis.id)))
      .limit(1),
  ]);

  // previousRows come back newest-first (for the LIMIT 8); reverse for
  // oldest->newest before handing to the pure functions.
  const previousOldestFirst = [...previousRows].reverse();
  const previousSamples: PreviousWorkoutSample[] = previousOldestFirst.map((row) => {
    const p = pl(row.inputPayload);
    return { distanceM: num(p.distanceM), durationMin: num(p.durationMin), paceMinPerKm: num(p.paceMinPerKm), avgHr: num(p.avgHr) };
  });
  const previousPacesOldestFirst = previousOldestFirst
    .map((row) => num(pl(row.inputPayload).paceMinPerKm))
    .filter((v): v is number => v != null);

  const context: Record<string, unknown> = {};

  const usual = computeUsualWorkout(previousSamples);
  if (usual) context.usual = usual;

  const paceHistory = computePaceHistory(previousPacesOldestFirst, paceMinPerKm);
  if (paceHistory) context.paceHistory = paceHistory;

  if (previousOldestFirst.length > 0) {
    const mostRecentPreviousDate = previousOldestFirst[previousOldestFirst.length - 1].workoutDate;
    const days = Math.round(
      (new Date(`${workoutDateKey}T00:00:00Z`).getTime() - new Date(`${mostRecentPreviousDate}T00:00:00Z`).getTime())
      / 86_400_000,
    );
    if (Number.isFinite(days) && days >= 0) {
      context.goingIn = { ...(context.goingIn as object | undefined), daysSinceLastSameType: days };
    }
  }

  const maxHrRecorded = maxHrRows
    .map((row) => num(pl(row.inputPayload).maxHr))
    .filter((v): v is number => v != null)
    .reduce<number | undefined>((best, v) => (best == null || v > best ? v : best), undefined);

  if (recovery) {
    const restingBaseline = await queryBaseline(userId, recovery.rhrMetric);
    const restingHrValue = restingBaseline?.established ? restingBaseline.stats?.mean30 ?? undefined : undefined;
    const effort = computeEffort({
      restingHr: restingHrValue != null ? Math.round(restingHrValue) : undefined,
      maxHr: maxHrRecorded,
      avgHr: avgHrThis,
    });
    if (effort) context.effort = effort;

    const [sleepRow, hrvReading] = await Promise.all([
      dailyMetricOnDate(userId, recovery.sleepMetric, workoutDateKey),
      readingOnDate(userId, recovery.hrvMetric, workoutDateKey, 'ms', recovery.recoverySource),
    ]);
    const goingIn: Record<string, unknown> = { ...(context.goingIn as object | undefined) };
    if (sleepRow) {
      const night = sleepNightFromDailyMetric(recovery.metricSource, sleepRow.value, sleepRow.payload);
      if (night) goingIn.sleepMinutes = night.minutes;
    }
    if (hrvReading) goingIn.hrv = hrvReading;
    if (Object.keys(goingIn).length > 0) context.goingIn = goingIn;

    const nextDateKey = nextDayKey(workoutDateKey);
    const [nextHrv, nextRhr] = await Promise.all([
      readingOnDate(userId, recovery.hrvMetric, nextDateKey, 'ms', recovery.recoverySource),
      readingOnDate(userId, recovery.rhrMetric, nextDateKey, 'bpm', recovery.recoverySource),
    ]);
    const nextMorning: Record<string, unknown> = {};
    if (nextHrv) nextMorning.hrv = nextHrv;
    if (nextRhr) nextMorning.restingHr = nextRhr;
    if (Object.keys(nextMorning).length > 0) context.nextMorning = nextMorning;
  }

  // context.devices: only present when the OTHER device also recorded this
  // session (see db/schema.ts's merged_into_id doc and the module comment
  // above).
  const thisRow: WorkoutDeviceRow = { source: (analysis.source as 'healthkit' | 'whoop') ?? 'healthkit', payload: input };
  const mergedLoser = otherByMergedInto[0];
  if (mergedLoser) {
    // This analysis is the survivor; `mergedLoser` is the suppressed same-session row.
    context.devices = buildWorkoutDevicesContext(thisRow, { source: mergedLoser.source as 'healthkit' | 'whoop', payload: mergedLoser.inputPayload });
  } else if (selfRow[0]?.mergedIntoId) {
    // This analysis is itself the loser — fetch the survivor it points at.
    const [survivorRow] = await db.select({ source: schema.workout_analyses.source, inputPayload: schema.workout_analyses.input_payload })
      .from(schema.workout_analyses)
      .where(and(eq(schema.workout_analyses.user_id, userId), eq(schema.workout_analyses.id, selfRow[0].mergedIntoId)))
      .limit(1);
    if (survivorRow) {
      context.devices = buildWorkoutDevicesContext(
        { source: survivorRow.source as 'healthkit' | 'whoop', payload: survivorRow.inputPayload },
        thisRow,
      );
    }
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

// ── Sleep context ────────────────────────────────────────────────────────────

const DEFAULT_SLEEP_GOAL_MIN = 480;

export async function getSleepAnalysisContext(
  userId: string,
  analysis: AnalysisRecord,
): Promise<Record<string, unknown> | undefined> {
  const input = pl(analysis.input);
  const metricSource: MetricSource = analysis.source === 'whoop' ? 'whoop' : 'healthkit';
  const sleepMetric: 'sleep_minutes' | 'whoop_sleep_min' = metricSource === 'whoop' ? 'whoop_sleep_min' : 'sleep_minutes';
  const wakeDateKey = analysis.date; // sleep_analyses.wake_date, a 'YYYY-MM-DD' local day key
  const bedTime = str(input.bedTime);
  const wakeTime = str(input.wakeTime);

  // "Previous 14 nights, excluding this wake date" (contract) — a half-open
  // window ending the day before wakeDateKey, so this analysis's own night
  // can never leak into its own "usual".
  const usualWindowStart = shiftDayKey(wakeDateKey, -SLEEP_USUAL_WINDOW_NIGHTS);
  const usualWindowEnd = shiftDayKey(wakeDateKey, -1);

  const [userRows, recovery, previousRows, weekRows, secondaryRows] = await Promise.all([
    userSleepGoalQuery(userId),
    resolveRecoverySelection(userId),
    db.select({ date: schema.daily_metrics.date, value: schema.daily_metrics.value, payload: schema.daily_metrics.payload })
      .from(schema.daily_metrics)
      .where(and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, sleepMetric),
        gte(schema.daily_metrics.date, usualWindowStart),
        lte(schema.daily_metrics.date, usualWindowEnd),
      ))
      .orderBy(desc(schema.daily_metrics.date))
      .limit(SLEEP_USUAL_WINDOW_NIGHTS),
    db.select({ date: schema.daily_metrics.date, value: schema.daily_metrics.value, payload: schema.daily_metrics.payload })
      .from(schema.daily_metrics)
      .where(and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, sleepMetric),
        gte(schema.daily_metrics.date, shiftDayKey(wakeDateKey, -(WEEK_NIGHTS - 1))),
        lte(schema.daily_metrics.date, wakeDateKey),
      )),
    db.select({ secondarySource: schema.sleep_analyses.secondary_source, secondaryPayload: schema.sleep_analyses.secondary_payload })
      .from(schema.sleep_analyses)
      .where(and(eq(schema.sleep_analyses.user_id, userId), eq(schema.sleep_analyses.id, analysis.id)))
      .limit(1),
  ]);

  const goalMinutes = userRows[0]?.sleepGoalMinutes ?? DEFAULT_SLEEP_GOAL_MIN;

  const context: Record<string, unknown> = { goalMinutes };

  const previousNights = previousRows
    .map((row) => sleepNightFromDailyMetric(metricSource, row.value, row.payload))
    .filter((n): n is NonNullable<typeof n> => n != null);
  const usual = computeSleepUsual(previousNights);
  if (usual) context.usual = usual;

  const weekDatesOldestFirst: string[] = [];
  for (let i = WEEK_NIGHTS - 1; i >= 0; i--) weekDatesOldestFirst.push(shiftDayKey(wakeDateKey, -i));
  const weekByDate = new Map<string, number>();
  for (const row of weekRows) {
    const night = sleepNightFromDailyMetric(metricSource, row.value, row.payload);
    if (night) weekByDate.set(row.date, night.minutes);
  }
  const week = assembleWeek(weekByDate, weekDatesOldestFirst);
  if (week.length > 0) context.week = week;

  if (bedTime && wakeTime) {
    context.timing = { bedTime, wakeTime };

    const bedTimeDate = new Date(bedTime);
    const workoutWindowStart = new Date(bedTimeDate.getTime() - 4 * 60 * 60 * 1000);
    const mealWindowStart = new Date(bedTimeDate.getTime() - 3 * 60 * 60 * 1000);

    const [workoutRows, mealRows] = await Promise.all([
      db.select({ startedAt: schema.workout_analyses.started_at, endedAt: schema.workout_analyses.ended_at })
        .from(schema.workout_analyses)
        .where(and(
          eq(schema.workout_analyses.user_id, userId),
          isNull(schema.workout_analyses.deleted_at),
          gte(schema.workout_analyses.ended_at, workoutWindowStart),
          lte(schema.workout_analyses.ended_at, bedTimeDate),
        )),
      db.select({ timestamp: schema.events.timestamp })
        .from(schema.events)
        .where(and(
          eq(schema.events.user_id, userId),
          eq(schema.events.type, 'meal_logged'),
          gte(schema.events.timestamp, mealWindowStart),
          lte(schema.events.timestamp, bedTimeDate),
        )),
    ]);

    const beforeBed = computeBeforeBed({
      bedTimeIso: bedTime,
      workoutEndedAtIsos: workoutRows.map((r) => r.endedAt?.toISOString()).filter((v): v is string => v != null),
      mealAtIsos: mealRows.map((r) => r.timestamp.toISOString()),
    });
    context.beforeBed = beforeBed;
  }

  if (recovery) {
    const [hrvReading, rhrReading] = await Promise.all([
      readingOnDate(userId, recovery.hrvMetric, wakeDateKey, 'ms', recovery.recoverySource),
      readingOnDate(userId, recovery.rhrMetric, wakeDateKey, 'bpm', recovery.recoverySource),
    ]);
    const thisMorning: Record<string, unknown> = {};
    if (hrvReading) thisMorning.hrv = hrvReading;
    if (rhrReading) thisMorning.restingHr = rhrReading;
    if (Object.keys(thisMorning).length > 0) context.thisMorning = thisMorning;
  }

  // context.devices: "only when secondary_payload exists" (contract) — the
  // non-owning source's payload, preserved by lib/sleepOwnership.ts's
  // ownership rules instead of being dropped.
  const secondary = secondaryRows[0];
  if (secondary?.secondarySource && secondary.secondaryPayload != null) {
    const devices = buildSleepDevicesContext(
      { source: metricSource, payload: input },
      { source: secondary.secondarySource as 'healthkit' | 'whoop', payload: secondary.secondaryPayload },
    );
    if (devices) context.devices = devices;
  }

  return context;
}

/** `dayKey` shifted by `deltaDays` (negative = earlier), pure calendar-date arithmetic. */
function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}
