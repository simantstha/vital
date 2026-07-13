export const RECOVERY_JOB_COUNT = 9;
export type RecoveryKind = 'workout' | 'sleep';

export interface RecoveryRow {
  id: string;
  kind: RecoveryKind;
  status: string;
  retryCount: number;
  leaseToken: string | null;
  result: unknown;
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
    if (rows.length !== RECOVERY_JOB_COUNT || new Set(rows.map((row) => row.id)).size !== RECOVERY_JOB_COUNT) {
      throw new Error('Proactive analysis recovery row mismatch.');
    }
    if (rows.some((row) => row.status !== 'failed' || row.leaseToken !== null || row.result !== null)) {
      throw new Error('Proactive analysis recovery row is ineligible.');
    }

    const workoutIds = rows.filter((row) => row.kind === 'workout').map((row) => row.id);
    const sleepIds = rows.filter((row) => row.kind === 'sleep').map((row) => row.id);
    const workoutUpdatedIds = workoutIds.length === 0 ? [] : await tx.recover('workout', workoutIds, now);
    const sleepUpdatedIds = sleepIds.length === 0 ? [] : await tx.recover('sleep', sleepIds, now);
    const updatedIds = [...workoutUpdatedIds, ...sleepUpdatedIds];
    const suppliedIds = new Set(ids);
    if (
      updatedIds.length !== RECOVERY_JOB_COUNT
      || new Set(updatedIds).size !== RECOVERY_JOB_COUNT
      || updatedIds.some((id) => !suppliedIds.has(id))
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
