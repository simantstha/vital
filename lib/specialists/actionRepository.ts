import { and, eq, isNull } from 'drizzle-orm';
import type { db as applicationDb } from '@/db';
import * as schema from '@/db/schema';
import type {
  SpecialistAction,
  SpecialistActionClaim,
  SpecialistActionResult,
  SpecialistActionStore,
} from './orchestration';

type StoredAction = typeof schema.specialist_actions.$inferSelect;
type NewStoredAction = typeof schema.specialist_actions.$inferInsert;
type DrizzleDatabase = typeof applicationDb;

export interface SpecialistActionPersistence {
  find(userId: string, actionId: string): Promise<StoredAction | null>;
  insertClaim(values: NewStoredAction): Promise<{ row: StoredAction; isNew: boolean }>;
  complete(userId: string, actionId: string, result: SpecialistActionResult): Promise<StoredAction>;
}

export class SpecialistActionRepository implements SpecialistActionStore {
  constructor(private readonly persistence: SpecialistActionPersistence) {}

  async claim(
    userId: string,
    actionId: string,
    sessionId: string,
    cardOccurrenceId: string,
    action: SpecialistAction,
  ): Promise<SpecialistActionClaim> {
    const claimed = await this.persistence.insertClaim({
      user_id: userId,
      action_id: actionId,
      session_id: sessionId,
      card_occurrence_id: cardOccurrenceId,
      action,
      result: null,
    });
    const { row } = claimed;
    if (row.user_id !== userId) throw new Error('Specialist action claim crossed user scope');
    return {
      sessionId: row.session_id,
      cardOccurrenceId: row.card_occurrence_id,
      action: row.action as SpecialistAction,
      result: row.result === null ? null : deserializeResult(row.result),
      isNew: claimed.isNew,
    };
  }

  async complete(
    userId: string,
    actionId: string,
    result: SpecialistActionResult,
  ): Promise<SpecialistActionResult> {
    const row = await this.persistence.complete(userId, actionId, result);
    if (row.user_id !== userId || row.result === null) {
      throw new Error('Specialist action result was not completed for user');
    }
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

  async insertClaim(values: NewStoredAction): Promise<{ row: StoredAction; isNew: boolean }> {
    const [row] = await this.database.insert(schema.specialist_actions)
      .values(values)
      .onConflictDoNothing({
        target: [schema.specialist_actions.user_id, schema.specialist_actions.action_id],
      })
      .returning();
    if (row) return { row, isNew: true };
    const existing = await this.find(values.user_id, values.action_id);
    if (!existing) throw new Error('Specialist action conflicted but could not be reloaded');
    return { row: existing, isNew: false };
  }

  async complete(
    userId: string,
    actionId: string,
    result: SpecialistActionResult,
  ): Promise<StoredAction> {
    const [row] = await this.database.update(schema.specialist_actions)
      .set({ result, completed_at: new Date() })
      .where(and(
        eq(schema.specialist_actions.user_id, userId),
        eq(schema.specialist_actions.action_id, actionId),
        isNull(schema.specialist_actions.result),
      ))
      .returning();
    if (row) return row;
    const existing = await this.find(userId, actionId);
    if (!existing) throw new Error('Specialist action claim disappeared before completion');
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
