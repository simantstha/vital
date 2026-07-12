import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { db as applicationDb } from '@/db';
import type { SpecialistMessageAttribution } from './sessions';

type StoredMessage = typeof schema.messages.$inferSelect;
type NewStoredMessage = typeof schema.messages.$inferInsert;
type DrizzleDatabase = typeof applicationDb;

export interface NewSpecialistMessage {
  userId: string;
  timestamp: Date;
  content: string;
  attribution: SpecialistMessageAttribution;
  toolCalls?: unknown;
  sources?: unknown[];
  metadata?: unknown;
}

export interface SpecialistMessage extends NewSpecialistMessage {
  id: string;
}

export interface SpecialistMessagePersistence {
  insert(values: NewStoredMessage): Promise<StoredMessage>;
  findByUserAndId(userId: string, id: string): Promise<StoredMessage | null>;
}

export class SpecialistMessageRepository {
  constructor(private readonly persistence: SpecialistMessagePersistence) {}

  async insert(input: NewSpecialistMessage): Promise<SpecialistMessage> {
    return fromStoredMessage(await this.persistence.insert(toStoredMessage(input)));
  }

  async findByUserAndId(userId: string, id: string): Promise<SpecialistMessage | null> {
    const row = await this.persistence.findByUserAndId(userId, id);
    return row ? fromStoredMessage(row) : null;
  }
}

export class DrizzleSpecialistMessagePersistence implements SpecialistMessagePersistence {
  constructor(private readonly database: DrizzleDatabase) {}

  async insert(values: NewStoredMessage): Promise<StoredMessage> {
    const [row] = await this.database.insert(schema.messages).values(values).returning();
    return row;
  }

  async findByUserAndId(userId: string, id: string): Promise<StoredMessage | null> {
    const [row] = await this.database.select()
      .from(schema.messages)
      .where(and(eq(schema.messages.user_id, userId), eq(schema.messages.id, id)))
      .limit(1);
    return row ?? null;
  }
}

export function toStoredMessage(input: NewSpecialistMessage): NewStoredMessage {
  return {
    user_id: input.userId,
    timestamp: input.timestamp,
    role: 'assistant',
    speaker: input.attribution.speaker,
    content: input.content,
    tool_calls: input.toolCalls ?? null,
    sources: input.sources ?? [],
    metadata: input.metadata ?? null,
    specialist_session_id: input.attribution.specialist_session_id,
    specialist_metadata: input.attribution.specialist_metadata,
  };
}

export function fromStoredMessage(row: StoredMessage): SpecialistMessage {
  if (row.role !== 'assistant' || row.speaker !== 'specialist' ||
      !row.specialist_session_id || !row.specialist_metadata) {
    throw new Error(`Message ${row.id} is not a persisted specialist message`);
  }
  return {
    id: row.id,
    userId: row.user_id,
    timestamp: row.timestamp,
    content: row.content,
    attribution: {
      speaker: 'specialist',
      specialist_session_id: row.specialist_session_id,
      specialist_metadata: row.specialist_metadata as SpecialistMessageAttribution['specialist_metadata'],
    },
    toolCalls: row.tool_calls ?? undefined,
    sources: row.sources as unknown[],
    metadata: row.metadata ?? undefined,
  };
}
