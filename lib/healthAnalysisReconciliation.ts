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
