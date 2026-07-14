import { and, eq, inArray, isNull } from 'drizzle-orm';
import type * as RecoverySchema from '../db/schema';
import type { RecoveryKind, RecoveryRow, RecoveryStore } from './proactiveAnalysisRecovery';

type Schema = typeof RecoverySchema;
type AnalysisTable = Schema['workout_analyses'] | Schema['sleep_analyses'];

interface DrizzleTransaction {
  select(selection: Record<string, unknown>): {
    from(table: AnalysisTable): {
      where(predicate: unknown): { for(lock: 'update'): Promise<Array<Record<string, unknown>>> };
    };
  };
  update(table: AnalysisTable): {
    set(values: Record<string, unknown>): {
      where(predicate: unknown): {
        returning(selection: Record<string, unknown>): Promise<Array<{ id: string }>>;
      };
    };
  };
}

interface DrizzleDatabase {
  transaction<T>(operation: (transaction: DrizzleTransaction) => Promise<T>): Promise<T>;
}

export function createProactiveAnalysisRecoveryStore(database: unknown, schema: Schema): RecoveryStore {
  const db = database as DrizzleDatabase;
  return {
    transaction: (operation) => db.transaction(async (transaction) => operation({
      lockRows: async (requestedIds): Promise<RecoveryRow[]> => {
        const workoutRows = await transaction
          .select({
            id: schema.workout_analyses.id,
            status: schema.workout_analyses.status,
            retryCount: schema.workout_analyses.retry_count,
            leaseToken: schema.workout_analyses.lease_token,
            result: schema.workout_analyses.result,
            notificationState: schema.workout_analyses.notification_state,
            notificationSentAt: schema.workout_analyses.notification_sent_at,
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
            notificationState: schema.sleep_analyses.notification_state,
            notificationSentAt: schema.sleep_analyses.notification_sent_at,
          })
          .from(schema.sleep_analyses)
          .where(inArray(schema.sleep_analyses.id, requestedIds))
          .for('update');
        return [
          ...workoutRows.map((row) => ({ ...row, kind: 'workout' as const } as RecoveryRow)),
          ...sleepRows.map((row) => ({ ...row, kind: 'sleep' as const } as RecoveryRow)),
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
          notification_state: 'pending',
        }).where(and(
          inArray(table.id, requestedIds),
          eq(table.status, 'failed'),
          isNull(table.lease_token),
          isNull(table.result),
          eq(table.notification_state, 'failed'),
          isNull(table.notification_sent_at),
        )).returning({ id: table.id });
        return rows.map((row) => row.id);
      },
    })),
  };
}
