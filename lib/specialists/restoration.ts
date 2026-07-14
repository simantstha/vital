import { and, desc, eq, gte } from 'drizzle-orm';
import type { db as applicationDb } from '@/db';
import * as schema from '@/db/schema';
import { getConversationStart } from '@/lib/brain/conversationWindow';
import type { SpecialistRegistry } from './registry';
import type { SpecialistMessageAttribution } from './sessions';
import type { SpecialistSessionService } from './sessions';
import {
  specialistPersona,
  VITAL_PERSONA,
  type PersonaSnapshot,
} from './orchestration';

type DrizzleDatabase = typeof applicationDb;

export interface RestoredCoachMessage {
  id: string;
  role: string;
  speaker: string;
  content: string;
  timestamp: Date;
  specialistSessionId: string | null;
  specialistMetadata: SpecialistMessageAttribution['specialist_metadata'] | null;
}

export interface CoachHistoryRepository {
  latest(userId: string, limit: number): Promise<RestoredCoachMessage[]>;
}

export class DrizzleCoachHistoryRepository implements CoachHistoryRepository {
  constructor(private readonly database: DrizzleDatabase) {}

  async latest(userId: string, limit: number): Promise<RestoredCoachMessage[]> {
    // Restore only the current conversation — messages before the 4h
    // inactivity gap or the user's last manual "New chat" reset are excluded
    // (see lib/brain/conversationWindow.ts).
    const conversationStart = await getConversationStart(this.database, userId);
    const where = conversationStart
      ? and(eq(schema.messages.user_id, userId), gte(schema.messages.timestamp, conversationStart))
      : eq(schema.messages.user_id, userId);

    const rows = await this.database.select({
      id: schema.messages.id,
      role: schema.messages.role,
      speaker: schema.messages.speaker,
      content: schema.messages.content,
      timestamp: schema.messages.timestamp,
      specialistSessionId: schema.messages.specialist_session_id,
      specialistMetadata: schema.messages.specialist_metadata,
    })
      .from(schema.messages)
      .where(where)
      .orderBy(desc(schema.messages.timestamp), desc(schema.messages.id))
      .limit(limit);
    return rows.reverse().map((row) => ({
      ...row,
      specialistMetadata: row.specialistMetadata as SpecialistMessageAttribution['specialist_metadata'] | null,
    }));
  }
}

export function compareRestoredMessages(
  left: RestoredCoachMessage,
  right: RestoredCoachMessage,
): number {
  const byTimestamp = left.timestamp.getTime() - right.timestamp.getTime();
  return byTimestamp || left.id.localeCompare(right.id);
}

export interface PendingHandoffCard {
  phase: 'proposed' | 'return_proposed';
  sessionId: string;
  cardOccurrenceId: string;
  specialist: PersonaSnapshot;
  objective: string;
  returnSummary?: unknown;
}

export interface CoachRestoration {
  messages: RestoredCoachMessage[];
  activePersona: PersonaSnapshot;
  pendingCard: PendingHandoffCard | null;
}

interface RestorationDependencies {
  history: CoachHistoryRepository;
  sessions: Pick<SpecialistSessionService, 'findOpen' | 'disableOpen'>;
  manifests: SpecialistRegistry;
}

export async function loadCoachRestoration(
  userId: string,
  dependencies: RestorationDependencies,
  enabled = true,
): Promise<CoachRestoration> {
  if (!enabled) {
    const [messages] = await Promise.all([
      dependencies.history.latest(userId, 50),
      dependencies.sessions.disableOpen(userId),
    ]);
    return { messages, activePersona: VITAL_PERSONA, pendingCard: null };
  }
  const [messages, session] = await Promise.all([
    dependencies.history.latest(userId, 50),
    dependencies.sessions.findOpen(userId),
  ]);
  if (!session) return { messages, activePersona: VITAL_PERSONA, pendingCard: null };

  const manifest = dependencies.manifests.get(session.manifestId);
  const specialist = specialistPersona(manifest, session.id);
  const specialistIsActive = session.status === 'active' || session.status === 'return_proposed';
  const pendingCard = session.status === 'proposed' || session.status === 'return_proposed'
    ? {
        phase: session.status,
        sessionId: session.id,
        cardOccurrenceId: session.cardOccurrenceId,
        specialist,
        objective: session.objective,
        ...(session.returnHandoff ? { returnSummary: session.returnHandoff } : {}),
      } satisfies PendingHandoffCard
    : null;
  return {
    messages,
    activePersona: specialistIsActive ? specialist : VITAL_PERSONA,
    pendingCard,
  };
}
