import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  formatRecoveryCounts,
  parseRecoveryIds,
  recoverProactiveAnalysisJobs,
  type RecoveryCounts,
  type RecoveryKind,
  type RecoveryRow,
  type RecoveryStore,
} from '../lib/proactiveAnalysisRecovery';

const emptyCounts = (): RecoveryCounts => ({
  requestedCount: 0,
  matchedCount: 0,
  eligibleCount: 0,
  workoutUpdatedCount: 0,
  sleepUpdatedCount: 0,
  totalUpdatedCount: 0,
});

async function main(argv: string[]): Promise<void> {
  const ids = parseRecoveryIds(argv);
  const { db, schema } = await import('@/db');
  const store: RecoveryStore = {
    transaction: (operation) => db.transaction(async (transaction) => operation({
      lockRows: async (requestedIds): Promise<RecoveryRow[]> => {
        const workoutRows = await transaction
          .select({
            id: schema.workout_analyses.id,
            status: schema.workout_analyses.status,
            retryCount: schema.workout_analyses.retry_count,
            leaseToken: schema.workout_analyses.lease_token,
            result: schema.workout_analyses.result,
          })
          .from(schema.workout_analyses)
          .where(inArray(schema.workout_analyses.id, requestedIds))
          .for('update');
        const sleepRows = await transaction
          .select({
            id: schema.sleep_analyses.id,
            status: schema.sleep_analyses.status,
            retryCount: schema.sleep_analyses.retry_count,
            leaseToken: schema.sleep_analyses.lease_token,
            result: schema.sleep_analyses.result,
          })
          .from(schema.sleep_analyses)
          .where(inArray(schema.sleep_analyses.id, requestedIds))
          .for('update');
        return [
          ...workoutRows.map((row) => ({ ...row, kind: 'workout' as const })),
          ...sleepRows.map((row) => ({ ...row, kind: 'sleep' as const })),
        ];
      },
      recover: async (kind: RecoveryKind, requestedIds: string[], now: Date): Promise<string[]> => {
        const table = kind === 'workout' ? schema.workout_analyses : schema.sleep_analyses;
        const rows = await transaction.update(table).set({
          status: 'pending',
          retry_count: 0,
          next_attempt_at: now,
          lease_token: null,
          lease_expires_at: null,
        }).where(and(
          inArray(table.id, requestedIds),
          eq(table.status, 'failed'),
          isNull(table.lease_token),
          isNull(table.result),
        )).returning({ id: table.id });
        return rows.map((row) => row.id);
      },
    })),
  };

  const counts = await recoverProactiveAnalysisJobs(store, ids, new Date());
  console.log(formatRecoveryCounts(counts, true));
}

void main(process.argv.slice(2)).then(
  () => { process.exitCode = 0; },
  () => {
    console.log(formatRecoveryCounts(emptyCounts(), false));
    process.exitCode = 1;
  },
);
