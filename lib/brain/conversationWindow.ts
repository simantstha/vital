/**
 * Vital Brain — conversation window boundary
 *
 * Computes the start of the "current conversation" for a user: the point
 * after which messages count as live context for coach restore
 * (lib/specialists/restoration.ts) and LLM prompt assembly
 * (lib/brain/context.ts assembleContext). Two independent triggers can move
 * this boundary forward:
 *
 *  1. Automatic inactivity reset — a gap of more than CONVERSATION_GAP_MS
 *     between two consecutive messages (or between now and the latest
 *     message) means the earlier side is a "different conversation."
 *  2. Manual reset — the user tapped "New chat", stamping users.chat_reset_at.
 *
 * The effective boundary is the LATER of the two (whichever moves the
 * cutoff further forward wins). A null result means no boundary applies —
 * callers should include full history.
 */

import { desc, eq } from 'drizzle-orm';
import type { db as applicationDb } from '@/db';
import * as schema from '@/db/schema';

type DrizzleDatabase = typeof applicationDb;

export const CONVERSATION_GAP_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Pure function: given a user's message timestamps (newest first), an
 * optional manual reset timestamp, and "now", determine where the current
 * conversation starts.
 *
 * Walks the sequence [now, t0, t1, ...] newest-first. At the first adjacent
 * pair whose gap exceeds CONVERSATION_GAP_MS, the conversation starts at the
 * NEWER element of that pair (which is `now` itself when the latest message
 * is already more than 4h old — i.e. all prior history is excluded).
 *
 * The gap-derived boundary and `resetAt` are combined by taking the later
 * (max) of the two, since either one moving the cutoff forward should win.
 * Returns null only when neither a gap boundary nor a reset applies.
 *
 * Callers filter messages with `timestamp >= result` (inclusive), so a
 * boundary that IS exactly a message's timestamp still includes that
 * message.
 */
export function computeConversationStart(
  timestampsDesc: Date[],
  resetAt: Date | null,
  now: Date,
): Date | null {
  const sequence = [now, ...timestampsDesc];

  let gapStart: Date | null = null;
  for (let i = 0; i < sequence.length - 1; i++) {
    const gapMs = sequence[i].getTime() - sequence[i + 1].getTime();
    if (gapMs > CONVERSATION_GAP_MS) {
      gapStart = sequence[i];
      break;
    }
  }

  if (gapStart === null) return resetAt;
  if (resetAt === null) return gapStart;
  return gapStart.getTime() >= resetAt.getTime() ? gapStart : resetAt;
}

/**
 * Loads the inputs computeConversationStart needs for `userId` — the most
 * recent message timestamps and the user's manual reset stamp — and
 * delegates to the pure function. 51 timestamps (one more than the 50-message
 * restore/context window) is enough to detect a gap boundary that falls
 * anywhere within that window.
 */
export async function getConversationStart(
  db: DrizzleDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const [recentMessages, [usersRow]] = await Promise.all([
    db.select({ timestamp: schema.messages.timestamp })
      .from(schema.messages)
      .where(eq(schema.messages.user_id, userId))
      .orderBy(desc(schema.messages.timestamp), desc(schema.messages.id))
      .limit(51),
    db.select({ chat_reset_at: schema.users.chat_reset_at })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1),
  ]);

  const timestampsDesc = recentMessages.map((row) => row.timestamp);
  const resetAt = usersRow?.chat_reset_at ?? null;
  return computeConversationStart(timestampsDesc, resetAt, now);
}
