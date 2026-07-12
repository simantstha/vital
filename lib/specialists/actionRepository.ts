import { and, eq } from 'drizzle-orm';
import type { db as applicationDb } from '@/db';
import * as schema from '@/db/schema';
import type {
  SpecialistAction,
  SpecialistActionResult,
  SpecialistActionStore,
} from './orchestration';

type StoredAction = typeof schema.specialist_actions.$inferSelect;
type NewStoredAction = typeof schema.specialist_actions.$inferInsert;
type DrizzleDatabase = typeof applicationDb;

export interface SpecialistActionPersistence {
  find(userId: string, actionId: string): Promise<StoredAction | null>;
  insert(values: NewStoredAction): Promise<StoredAction>;
}

export class SpecialistActionRepository implements SpecialistActionStore {
  constructor(private readonly persistence: SpecialistActionPersistence) {}

  async find(userId: string, actionId: string): Promise<SpecialistActionResult | null> {
    const row = await this.persistence.find(userId, actionId);
    if (!row || row.user_id !== userId) return null;
    return deserializeResult(row.result);
  }

  async save(
    userId: string,
    actionId: string,
    sessionId: string,
    action: SpecialistAction,
    result: SpecialistActionResult,
  ): Promise<SpecialistActionResult> {
    const existing = await this.find(userId, actionId);
    if (existing) return existing;
    const row = await this.persistence.insert({
      user_id: userId,
      action_id: actionId,
      session_id: sessionId,
      action,
      result,
    });
    return deserializeResult(row.result);
  }
}

export class DrizzleSpecialistActionPersistence implements SpecialistActionPersistence {
  constructor(private readonly database: DrizzleDatabase) {}

  async find(userId: string, actionId: string): Promise<StoredAction | null> {
    const [row] = await this.database.select()
      .from(schema.specialist_actions)
      .where(and(
        eq(schema.specialist_actions.user_id, userId),
        eq(schema.specialist_actions.action_id, actionId),
      ))
      .limit(1);
    return row ?? null;
  }

  async insert(values: NewStoredAction): Promise<StoredAction> {
    const [row] = await this.database.insert(schema.specialist_actions)
      .values(values)
      .onConflictDoNothing({
        target: [schema.specialist_actions.user_id, schema.specialist_actions.action_id],
      })
      .returning();
    if (row) return row;
    const existing = await this.find(values.user_id, values.action_id);
    if (!existing) throw new Error('Specialist action conflicted but could not be reloaded');
    return existing;
  }
}

function deserializeResult(value: unknown): SpecialistActionResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid specialist action result');
  const result = structuredClone(value) as SpecialistActionResult;
  const session = result.session;
  for (const key of [
    'proposedAt', 'activatedAt', 'returnProposedAt', 'completedAt',
    'declinedAt', 'failedAt', 'expiresAt', 'updatedAt',
  ] as const) {
    const current = session[key];
    if (typeof current === 'string') session[key] = new Date(current) as never;
  }
  return result;
}
