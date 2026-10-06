/**
 * Account deletion (App Store guideline 5.1.1(v)).
 *
 * `USER_SCOPED_TABLES_IN_DELETE_ORDER` lists EVERY table that holds per-user
 * rows, ordered children-before-parents so FK constraints are satisfied.
 * lib/accountDeletion.test.ts asserts this list covers every table in
 * db/schema.ts that has a `user_id` column (or an FK to `users`), so a new
 * user-scoped table cannot be forgotten.
 */
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { DATA_DIR } from './dataDir';
import * as schema from '../db/schema';

export const USER_SCOPED_TABLES_IN_DELETE_ORDER = [
  schema.coach_recommendation_interactions, // -> daily_coach_recommendations, plan_items
  schema.daily_coach_recommendations,
  schema.plan_items,
  schema.push_attempts,                     // -> push_devices
  schema.push_devices,
  schema.messages,                          // -> specialist_sessions
  schema.specialist_actions,                // -> specialist_sessions
  schema.specialist_sessions,
  schema.edges,                             // -> nodes
  schema.nodes,
  schema.events,
  schema.pending_facts,
  schema.daily_metrics,
  schema.baselines,
  schema.pending_nudges,
  schema.insight_findings,
  schema.notification_preferences,
  schema.workout_analyses,
  schema.sleep_analyses,
  schema.morning_notification_slots,
  schema.notification_inbox,
  schema.daily_briefs,
  schema.calendar_blocks,
  schema.whoop_connections,
  schema.workout_sets,
] as const;

type UserScopedTable = (typeof USER_SCOPED_TABLES_IN_DELETE_ORDER)[number];

/** Minimal surface of a drizzle transaction/db that we use. */
interface DeleteExecutor {
  delete(table: UserScopedTable | typeof schema.users): { where(cond: unknown): PromiseLike<unknown> };
}
interface TransactionalDb {
  transaction<T>(fn: (tx: DeleteExecutor) => Promise<T>): Promise<T>;
}

/** Deletes every row owned by `userId`, then the user, in one transaction. */
export async function deleteUserData(database: TransactionalDb, userId: string): Promise<void> {
  await database.transaction(async (tx) => {
    for (const table of USER_SCOPED_TABLES_IN_DELETE_ORDER) {
      await tx.delete(table).where(eq(table.user_id, userId));
    }
    await tx.delete(schema.users).where(eq(schema.users.id, userId));
  });
}

/** Removes the legacy on-disk memory dir `<DATA_DIR>/.vital-memory/<userId>/`. */
export function removeLegacyMemoryDir(userId: string, dataDir: string = DATA_DIR): void {
  // userId is a uuid from our own JWT; guard against path traversal anyway.
  if (!/^[0-9a-fA-F-]{36}$/.test(userId)) return;
  const dir = path.join(dataDir, '.vital-memory', userId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
