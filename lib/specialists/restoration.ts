import { and, asc, desc, eq, gte } from 'drizzle-orm';
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

// A meal_logged receipt derived at restore time for one restored assistant
// message — see attachMealReceipts below. Field names mirror the live
// `meal_logged` SSE event (lib/brain/coach.ts) so iOS can reuse the same
// decode/receipt-row shape for both.
export interface MealReceipt {
  id:   string;
  name: string;
  kcal: number;
  p:    number;
  c:    number;
  f:    number;
}

export interface RestoredCoachMessage {
  id: string;
  role: string;
  speaker: string;
  content: string;
  timestamp: Date;
  specialistSessionId: string | null;
  specialistMetadata: SpecialistMessageAttribution['specialist_metadata'] | null;
  // Meal receipts logged by the coach during this message's turn — see
  // attachMealReceipts. Undefined (never an empty array) when there are
  // none, so JSON.stringify drops the key and older app builds see nothing
  // different.
  mealReceipts?: MealReceipt[];
}

export interface CoachHistoryRepository {
  latest(userId: string, limit: number): Promise<RestoredCoachMessage[]>;
}

// A raw meal_logged event row, as read back for receipt derivation.
export interface MealLoggedEventRow {
  id: string;
  timestamp: Date;
  payload: unknown;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

function eventToReceipt(row: MealLoggedEventRow): MealReceipt {
  const p = payloadRecord(row.payload);
  const name = typeof p.name === 'string' && p.name
    ? p.name
    : (typeof p.description === 'string' && p.description ? p.description : 'Meal');
  return { id: row.id, name, kcal: num(p.kcal), p: num(p.p), c: num(p.c), f: num(p.f) };
}

/**
 * Derives `mealReceipts` for each restored assistant message WITHOUT a
 * schema change: the `messages` table only ever persisted `tool_calls`
 * inputs (lib/brain/coach.ts's `toolCallLog`), never a tool's result, so
 * there is no stored meal id to read back directly. Instead, each
 * `meal_logged` event (source = 'coach', still present — a deleted meal
 * simply produces no card, which is both simpler and honest: the meal really
 * is gone) is bucketed into the turn window of the assistant message that
 * would have logged it: `(previous user message's timestamp, this
 * message's timestamp]`. `events` must be sorted ascending by timestamp;
 * `messages` must already be in chronological (ascending) order — both true
 * of `DrizzleCoachHistoryRepository.latest`'s output. Additive: a message
 * with no meals in its window gets no `mealReceipts` key at all.
 */
export function attachMealReceipts(
  messages: RestoredCoachMessage[],
  events: MealLoggedEventRow[],
): RestoredCoachMessage[] {
  if (events.length === 0) return messages;

  let windowStart = new Date(0);
  let cursor = 0;
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      if (message.role === 'user') windowStart = message.timestamp;
      return message;
    }

    const receipts: MealReceipt[] = [];
    while (cursor < events.length && events[cursor].timestamp.getTime() <= message.timestamp.getTime()) {
      if (events[cursor].timestamp.getTime() > windowStart.getTime()) {
        receipts.push(eventToReceipt(events[cursor]));
      }
      cursor++;
    }
    windowStart = message.timestamp;
    return receipts.length > 0 ? { ...message, mealReceipts: receipts } : message;
  });
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
    const messages: RestoredCoachMessage[] = rows.reverse().map((row) => ({
      ...row,
      specialistMetadata: row.specialistMetadata as SpecialistMessageAttribution['specialist_metadata'] | null,
    }));
    if (messages.length === 0) return messages;

    // Only ever look back to the oldest restored message's timestamp — never
    // further, so this can't accidentally attach a meal from before the
    // restored window (e.g. a prior conversation) to the first message here.
    const events = await this.database.select({
      id: schema.events.id,
      timestamp: schema.events.timestamp,
      payload: schema.events.payload,
    })
      .from(schema.events)
      .where(and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'meal_logged'),
        eq(schema.events.source, 'coach'),
        gte(schema.events.timestamp, messages[0].timestamp),
      ))
      .orderBy(asc(schema.events.timestamp));

    return attachMealReceipts(messages, events);
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
