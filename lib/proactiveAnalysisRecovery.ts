export const RECOVERY_JOB_COUNT = 14;
export const RECOVERY_WORKOUT_COUNT = 8;
export const RECOVERY_SLEEP_COUNT = 6;
export type RecoveryKind = 'workout' | 'sleep';

export interface RecoveryRow {
  id: string;
  kind: RecoveryKind;
  status: string;
  retryCount: number;
  leaseToken: string | null;
  result: unknown;
  notificationState: string;
  notificationSentAt: Date | null;
}

export interface RecoveryCounts {
  requestedCount: number;
  matchedCount: number;
  eligibleCount: number;
  workoutUpdatedCount: number;
  sleepUpdatedCount: number;
  totalUpdatedCount: number;
}

export interface RecoveryTransaction {
  lockRows(ids: string[]): Promise<RecoveryRow[]>;
  recover(kind: RecoveryKind, ids: string[], now: Date): Promise<string[]>;
}

export interface RecoveryStore {
  transaction<T>(operation: (tx: RecoveryTransaction) => Promise<T>): Promise<T>;
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalidArguments = (): Error => new Error('Invalid proactive analysis recovery arguments.');

function hasExactIds(actual: string[], expected: string[]): boolean {
  const expectedIds = new Set(expected);
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && actual.every((id) => expectedIds.has(id));
}

export function parseRecoveryIds(argv: string[]): string[] {
  if (argv.length !== RECOVERY_JOB_COUNT * 2) throw invalidArguments();
  const ids: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== '--id' || !canonicalUuid.test(argv[index + 1])) throw invalidArguments();
    ids.push(argv[index + 1]);
  }
  if (new Set(ids).size !== RECOVERY_JOB_COUNT) throw invalidArguments();
  return ids;
}

export async function recoverProactiveAnalysisJobs(
  store: RecoveryStore,
  ids: string[],
  now: Date,
): Promise<RecoveryCounts> {
  if (ids.length !== RECOVERY_JOB_COUNT || new Set(ids).size !== RECOVERY_JOB_COUNT) {
    throw new Error('Invalid proactive analysis recovery request.');
  }

  return store.transaction(async (tx) => {
    const rows = await tx.lockRows(ids);
    const suppliedIds = new Set(ids);
    const lockedIds = rows.map((row) => row.id);
    if (
      rows.length !== RECOVERY_JOB_COUNT
      || new Set(lockedIds).size !== RECOVERY_JOB_COUNT
      || lockedIds.some((id) => !suppliedIds.has(id))
    ) {
      throw new Error('Proactive analysis recovery row mismatch.');
    }
    if (rows.some((row) => (
      row.status !== 'failed'
      || row.leaseToken !== null
      || row.result !== null
      || row.notificationState !== 'failed'
      || row.notificationSentAt !== null
    ))) {
      throw new Error('Proactive analysis recovery row is ineligible.');
    }

    const workoutIds = rows.filter((row) => row.kind === 'workout').map((row) => row.id);
    const sleepIds = rows.filter((row) => row.kind === 'sleep').map((row) => row.id);
    if (workoutIds.length !== RECOVERY_WORKOUT_COUNT || sleepIds.length !== RECOVERY_SLEEP_COUNT) {
      throw new Error('Proactive analysis recovery distribution mismatch.');
    }

    const workoutUpdatedIds = await tx.recover('workout', workoutIds, now);
    const sleepUpdatedIds = await tx.recover('sleep', sleepIds, now);
    const updatedIds = [...workoutUpdatedIds, ...sleepUpdatedIds];
    if (
      !hasExactIds(workoutUpdatedIds, workoutIds)
      || !hasExactIds(sleepUpdatedIds, sleepIds)
      || !hasExactIds(updatedIds, ids)
    ) {
      throw new Error('Proactive analysis recovery update mismatch.');
    }

    return {
      requestedCount: ids.length,
      matchedCount: rows.length,
      eligibleCount: rows.length,
      workoutUpdatedCount: workoutUpdatedIds.length,
      sleepUpdatedCount: sleepUpdatedIds.length,
      totalUpdatedCount: updatedIds.length,
    };
  });
}

export function formatRecoveryCounts(counts: RecoveryCounts, success: boolean): string {
  return [
    `requested_count=${counts.requestedCount}`,
    `matched_count=${counts.matchedCount}`,
    `eligible_count=${counts.eligibleCount}`,
    `workout_updated_count=${counts.workoutUpdatedCount}`,
    `sleep_updated_count=${counts.sleepUpdatedCount}`,
    `total_updated_count=${counts.totalUpdatedCount}`,
    success ? 'success_count=1' : 'failure_count=1',
  ].join('\n');
}
