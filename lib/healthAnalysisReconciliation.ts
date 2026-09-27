import { createHash } from 'node:crypto';

export interface HealthKitWorkout {
  hkUuid: string;
  [key: string]: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function fingerprintHealthPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

export function reconcileWorkouts(
  previous: HealthKitWorkout[],
  current: HealthKitWorkout[],
): {
  upserts: Array<{ workout: HealthKitWorkout; fingerprint: string }>;
  removedHkUuids: string[];
} {
  const previousById = new Map(previous.map((workout) => [workout.hkUuid, workout]));
  const currentById = new Map(current.map((workout) => [workout.hkUuid, workout]));
  const upserts = Array.from(currentById.values())
    .filter((workout) => {
      const existing = previousById.get(workout.hkUuid);
      return !existing || fingerprintHealthPayload(existing) !== fingerprintHealthPayload(workout);
    })
    .sort((left, right) => left.hkUuid.localeCompare(right.hkUuid))
    .map((workout) => ({ workout, fingerprint: fingerprintHealthPayload(workout) }));
  const removedHkUuids = Array.from(previousById.keys())
    .filter((hkUuid) => !currentById.has(hkUuid))
    .sort();

  return { upserts, removedHkUuids };
}

interface PersistedWorkoutAnalysis {
  hkUuid: string;
  workoutDate: string;
  contentFingerprint: string;
  status?: string;
  /**
   * Defensive filter (belt-and-suspenders with the SQL query that feeds this
   * function — see app/api/ingest/daily/route.ts's listWorkoutAnalyses,
   * scoped to `source = 'healthkit'`): a WHOOP row must never be treated as
   * "vanished from the HealthKit payload" and marked deleted just because a
   * phone upload didn't mention its hk_uuid. Rows with no `source` at all
   * (older callers/tests) are treated as healthkit, matching the schema
   * column's default.
   */
  source?: string;
}

interface DatedWorkout {
  workoutDate: string;
  workout: HealthKitWorkout;
}

export function reconcilePersistedWorkouts(
  persisted: PersistedWorkoutAnalysis[],
  current: DatedWorkout[],
): {
  upserts: Array<DatedWorkout & { fingerprint: string }>;
  removedHkUuids: string[];
} {
  const healthkitPersisted = persisted.filter((entry) => (entry.source ?? 'healthkit') === 'healthkit');
  const persistedById = new Map(healthkitPersisted.map((entry) => [entry.hkUuid, entry]));
  const currentById = new Map(current.map((entry) => [entry.workout.hkUuid, entry]));
  const upserts = Array.from(currentById.values())
    .map((entry) => ({ ...entry, fingerprint: fingerprintHealthPayload(entry.workout) }))
    .filter((entry) => {
      const existing = persistedById.get(entry.workout.hkUuid);
      return !existing
        || existing.status === 'deleted'
        || existing.workoutDate !== entry.workoutDate
        || existing.contentFingerprint !== entry.fingerprint;
    })
    .sort((left, right) => left.workout.hkUuid.localeCompare(right.workout.hkUuid));
  const removedHkUuids = Array.from(persistedById.keys())
    .filter((hkUuid) => !currentById.has(hkUuid))
    .sort();

  return { upserts, removedHkUuids };
}

export function shouldRefreshSleepAnalysis(
  persistedFingerprint: string,
  incomingFingerprint: string,
): boolean {
  return persistedFingerprint !== incomingFingerprint;
}

export function sleepAnalysisCandidate(
  wakeDate: string,
  sleep: { minutes: number; stages?: unknown },
  receivedAt: Date,
): { wakeDate: string; fingerprint: string; analyzeAfter: Date } {
  return {
    wakeDate,
    fingerprint: fingerprintHealthPayload(sleep),
    analyzeAfter: new Date(receivedAt.getTime() + 30 * 60 * 1000),
  };
}
