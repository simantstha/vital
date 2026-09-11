/**
 * Notification inbox — the user-facing delivery record.
 *
 * Distinct from push_attempts (delivery telemetry: per-attempt APNs status,
 * latency, never shown to the user), notification_inbox is what the app
 * shows as notification history. Rows are recorded independently of the APNs
 * delivery outcome, so a failed send or retired device token still leaves a
 * row in the inbox. Note: the coach-nudge path records inside the per-device
 * push callback, so a user with zero registered devices gets no nudge row—
 * unlike the analysis and morning-brief paths, which record before iterating
 * devices.
 *
 * Recording is deliberately best-effort: a failed inbox write must never
 * break an otherwise-successful push, so recordDelivery swallows its own
 * errors (see workerErrorEvent in lib/proactiveHealthWorkerSupport.ts for
 * the same never-throw-into-the-caller posture).
 */

import { db, schema } from '@/db';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';

export type NotificationType = 'workout_analysis' | 'sleep_analysis' | 'morning_brief' | 'coach_nudge';

export interface InboxItem {
  id: string;
  type: NotificationType;
  targetId: string;
  title: string;
  body: string;
  deepLink: string;
  createdAt: Date;
  readAt: Date | null;
}

function toInboxItem(row: typeof schema.notification_inbox.$inferSelect): InboxItem {
  return {
    id: row.id,
    type: row.type as NotificationType,
    targetId: row.target_id,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/**
 * Records one delivery. onConflictDoNothing on (user_id, type, target_id)
 * makes this idempotent across push retries — a retried notification for
 * the same job never produces a second inbox row.
 */
export async function recordDelivery(
  userId: string,
  type: NotificationType,
  targetId: string,
  alert: { title: string; body: string },
  deepLink: string,
): Promise<void> {
  try {
    await db.insert(schema.notification_inbox).values({
      user_id: userId,
      type,
      target_id: targetId,
      title: alert.title,
      body: alert.body,
      deep_link: deepLink,
    }).onConflictDoNothing();
  } catch (error) {
    console.error(JSON.stringify({ event: 'notification_inbox_record_failed', userId, type, targetId, errorName: error instanceof Error ? error.name : 'UnknownError' }));
  }
}

/**
 * Newest-first page of a user's inbox, plus a total unread count that is
 * independent of `limit` — the badge must reflect every unread row, not
 * just the ones on the current page.
 */
export async function listInbox(userId: string, limit: number): Promise<{ items: InboxItem[]; unreadCount: number }> {
  const [rows, [unread]] = await Promise.all([
    db.select().from(schema.notification_inbox)
      .where(eq(schema.notification_inbox.user_id, userId))
      .orderBy(desc(schema.notification_inbox.created_at))
      .limit(limit),
    db.select({ value: count() }).from(schema.notification_inbox)
      .where(and(eq(schema.notification_inbox.user_id, userId), isNull(schema.notification_inbox.read_at))),
  ]);
  return { items: rows.map(toInboxItem), unreadCount: unread?.value ?? 0 };
}

/**
 * Marks rows read for the given user. Always scoped by user_id in addition
 * to the selector, so one user can never mark another user's rows read even
 * if `ids` leaks a foreign id. Returns the number of rows actually flipped
 * (already-read rows don't count again).
 */
export async function markRead(userId: string, selector: { ids: string[] } | { all: true }): Promise<number> {
  if ('ids' in selector && selector.ids.length === 0) return 0;
  const predicate = 'all' in selector
    ? and(eq(schema.notification_inbox.user_id, userId), isNull(schema.notification_inbox.read_at))
    : and(
      eq(schema.notification_inbox.user_id, userId),
      isNull(schema.notification_inbox.read_at),
      inArray(schema.notification_inbox.id, selector.ids),
    );
  const rows = await db.update(schema.notification_inbox)
    .set({ read_at: new Date() })
    .where(predicate)
    .returning({ id: schema.notification_inbox.id });
  return rows.length;
}
