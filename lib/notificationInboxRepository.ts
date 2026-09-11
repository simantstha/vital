import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { listInbox, markRead } from './notificationInbox';
import type { NotificationInboxRepository, PendingNudgeSummary } from './notificationInboxHttp';

export const notificationInboxRepository: NotificationInboxRepository = {
  listInbox,
  markRead,

  async findPendingNudge(userId: string, id: string): Promise<PendingNudgeSummary | null> {
    // THE SECURITY-CRITICAL PREDICATE: scoped by user_id, not id alone —
    // mirrors drizzleNudgeFindingLookup.findPendingNudge in lib/brain/context.ts.
    const [row] = await db
      .select({ id: schema.pending_nudges.id, payload: schema.pending_nudges.payload, scheduledFor: schema.pending_nudges.scheduled_for })
      .from(schema.pending_nudges)
      .where(and(eq(schema.pending_nudges.id, id), eq(schema.pending_nudges.user_id, userId)))
      .limit(1);
    if (!row) return null;
    const payload = row.payload as { title?: unknown; body?: unknown } | null;
    const title = typeof payload?.title === 'string' ? payload.title : null;
    const body = typeof payload?.body === 'string' ? payload.body : null;
    // openingMessage and signature deliberately never leave this function —
    // they're internal coach-voice state, not user-facing content.
    if (title === null || body === null) return null;
    return { id: row.id, title, body, createdAt: row.scheduledFor };
  },
};
