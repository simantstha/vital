/**
 * Day-keyed chart annotations for the Trends screen. Scope for now: workout
 * markers only (kept under a string-union `kind` so later kinds — e.g.
 * weight_logged — can be added without breaking clients that already switch
 * on it).
 *
 * Two sources feed workout markers, because HealthKit and WHOOP workouts
 * live in different tables:
 *
 * - PRIMARY: `daily_metrics` rows with `metric = 'workouts'`
 *   (app/api/ingest/daily/route.ts, ~line 180) — one row per user per day,
 *   `value` = the day's workout count, `payload` = the array of
 *   `DailyIngestWorkout` objects the iOS client posted (camelCase: hkUuid,
 *   type, durationMin, kcal, distanceM?, avgHr?, maxHr?, paceMinPerKm?,
 *   elevationGainM?, startTime? — see ios/Vital/Sources/Core/APIClient.swift).
 *   Its `date` is ALREADY the user's local day (the client attributes each
 *   workout to its local start day before posting), so no timezone bucketing
 *   is applied here.
 * - SECONDARY: `workout_completed` events (WHOOP only, in practice — see
 *   lib/whoop/sync.ts), bucketed into the user's local day via `localDayKey`
 *   since those timestamps are absolute instants. Used ONLY for a day that
 *   has no `daily_metrics` workouts row, so a workout recorded by both
 *   sources isn't double-counted.
 */

import { localDayKey } from '@/lib/localDay';

export type MarkerKind = 'workout';

export interface Marker {
  date: string;     // 'YYYY-MM-DD', the user's local day
  kind: MarkerKind;
  label: string;
  count: number;
}

export interface RawEvent {
  timestamp: Date;
  payload: unknown;
}

export interface DailyMetricWorkoutRow {
  date: string;      // already the user's local day
  value: number;     // workout count, fallback when payload isn't an array
  payload: unknown;  // expected: DailyIngestWorkout[]
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The workout type as written into a `workout_completed` event's payload.
 * `type`/`workout_type` come from HealthKit-derived payloads (see
 * lib/logItems.ts's formatEventTitle and scripts/seed-dev.ts); `sport_name`
 * comes from WHOOP (lib/whoop/mapping.ts's mapWorkouts).
 */
function workoutType(payload: unknown): string | undefined {
  const p = payloadObject(payload);
  const value = p.type ?? p.workout_type ?? p.sport_name;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Buckets `workout_completed` events into the user's LOCAL day (via
 * `localDayKey`, DST-proof) and produces one marker per day, oldest → newest.
 * When a day has exactly one workout, the label names its type (when known);
 * with several, it's a plain count ("2 workouts").
 */
export function bucketWorkoutMarkers(events: RawEvent[], tz: string | null | undefined): Marker[] {
  const byDate = new Map<string, { count: number; types: string[] }>();

  for (const event of events) {
    const date = localDayKey(event.timestamp, tz);
    const bucket = byDate.get(date) ?? { count: 0, types: [] };
    bucket.count += 1;
    const type = workoutType(event.payload);
    if (type) bucket.types.push(type);
    byDate.set(date, bucket);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { count, types }]) => {
      const label = count === 1 && types.length === 1
        ? titleCase(types[0])
        : `${count} workout${count === 1 ? '' : 's'}`;
      return { date, kind: 'workout' as const, label, count };
    });
}

/** The single workout's `type`, when the payload is a one-element array carrying one. */
function soleWorkoutType(payload: unknown): string | undefined {
  if (!Array.isArray(payload) || payload.length !== 1) return undefined;
  const [workout] = payload;
  if (workout === null || typeof workout !== 'object' || Array.isArray(workout)) return undefined;
  const type = (workout as Record<string, unknown>).type;
  return typeof type === 'string' && type.length > 0 ? type : undefined;
}

/**
 * Builds one marker per `daily_metrics` 'workouts' row. `count` is the
 * payload array's length; a malformed/missing payload (not an array) falls
 * back to the row's `value` rather than dropping the day. Rows with
 * `count <= 0` are dropped entirely — an empty-array payload or a `value` of
 * 0 happens when HealthKit re-syncs a day after its only workout was
 * deleted, and that's not a workout day.
 */
export function markersFromDailyMetrics(rows: DailyMetricWorkoutRow[]): Marker[] {
  return rows
    .map((row) => {
      const count = Array.isArray(row.payload) ? row.payload.length : row.value;
      const type = soleWorkoutType(row.payload);
      const label = count === 1 && type
        ? titleCase(type)
        : `${count} workout${count === 1 ? '' : 's'}`;
      return { date: row.date, kind: 'workout' as const, label, count };
    })
    .filter((marker) => marker.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Combines the two sources: every `daily_metrics` marker (primary), plus any
 * `events`-sourced marker for a date `daily_metrics` didn't cover — never
 * both for the same date, which would double-count one workout recorded by
 * both HealthKit and WHOOP.
 *
 * Both inputs are filtered to `count > 0` before anything else — in
 * particular, a zero-count primary marker (see `markersFromDailyMetrics`'s
 * doc comment) is dropped BEFORE `primaryDates` is built, so it can never
 * suppress a real WHOOP-sourced marker on the same date.
 */
export function mergeWorkoutMarkers(primary: Marker[], secondary: Marker[]): Marker[] {
  const nonEmptyPrimary = primary.filter((m) => m.count > 0);
  const nonEmptySecondary = secondary.filter((m) => m.count > 0);
  const primaryDates = new Set(nonEmptyPrimary.map((m) => m.date));
  return [...nonEmptyPrimary, ...nonEmptySecondary.filter((m) => !primaryDates.has(m.date))]
    .sort((a, b) => a.date.localeCompare(b.date));
}
