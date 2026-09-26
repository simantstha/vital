/**
 * Day-keyed chart annotations for the Trends screen, sourced from the
 * `events` table. Scope for now: `workout_completed` only (kept as a string
 * union so later kinds — e.g. `weight_logged` — can be added without
 * breaking clients that already switch on `kind`).
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
