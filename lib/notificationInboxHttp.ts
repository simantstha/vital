import type { InboxItem } from './notificationInbox';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  if (raw.trim() === '') return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

export interface PendingNudgeSummary { id: string; title: string; body: string; createdAt: Date }

export interface NotificationInboxRepository {
  listInbox(userId: string, limit: number): Promise<{ items: InboxItem[]; unreadCount: number }>;
  markRead(userId: string, selector: { ids: string[] } | { all: true }): Promise<number>;
  /** Scoped by (id, userId) — see the IDOR note on the route below. */
  findPendingNudge(userId: string, id: string): Promise<PendingNudgeSummary | null>;
}

interface HttpDependencies {
  authenticate(request: Request): string;
  repository: NotificationInboxRepository;
}

function authenticate(request: Request, dependencies: HttpDependencies): string | Response {
  try {
    return dependencies.authenticate(request);
  } catch {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
}

function inboxItemDto(item: InboxItem) {
  return {
    id: item.id,
    type: item.type,
    targetId: item.targetId,
    title: item.title,
    body: item.body,
    deepLink: item.deepLink,
    createdAt: item.createdAt.toISOString(),
    readAt: item.readAt ? item.readAt.toISOString() : null,
  };
}

export function createNotificationInboxHttpHandlers(dependencies: HttpDependencies) {
  return {
    async GET(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const url = new URL(request.url);
      const limit = parseLimit(url.searchParams.get('limit'));
      const { items, unreadCount } = await dependencies.repository.listInbox(userId, limit);
      return Response.json({ items: items.map(inboxItemDto), unreadCount });
    },
  };
}

type ReadSelector = { ids: string[] } | { all: true };

function parseReadSelector(body: Record<string, unknown>): ReadSelector | null {
  if (body.all === true) return { all: true };
  if (Array.isArray(body.ids)) {
    // Non-uuid entries are dropped rather than rejecting the whole request —
    // a stale/malformed id in the client's local cache shouldn't block
    // marking the rest of the batch read.
    const ids = body.ids.filter((value): value is string => uuid(value) !== null).map((value) => uuid(value) as string);
    return { ids };
  }
  return null;
}

export function createNotificationReadHttpHandlers(dependencies: HttpDependencies) {
  return {
    async POST(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Response.json({ error: 'Invalid request body.' }, { status: 400 });
      }
      const selector = parseReadSelector(body as Record<string, unknown>);
      if (!selector) return Response.json({ error: 'Body must be { ids: string[] } or { all: true }.' }, { status: 400 });
      const updated = await dependencies.repository.markRead(userId, selector);
      return Response.json({ updated });
    },
  };
}

export function createNudgeHttpHandlers(dependencies: HttpDependencies) {
  return {
    async GET(
      request: Request,
      context: { params: Promise<{ id: string }> },
    ): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const { id } = await context.params;
      const normalizedId = uuid(id);
      if (!normalizedId) return Response.json({ error: 'Invalid nudge id.' }, { status: 400 });
      // SECURITY: findPendingNudge must scope by (id, userId) together —
      // never look up by id alone. See findPendingNudge in
      // lib/brain/context.ts:415-427 for the same predicate shape.
      const nudge = await dependencies.repository.findPendingNudge(userId, normalizedId);
      if (!nudge) return Response.json({ error: 'Nudge not found.' }, { status: 404 });
      return Response.json({
        id: nudge.id,
        title: nudge.title,
        body: nudge.body,
        createdAt: nudge.createdAt.toISOString(),
      });
    },
  };
}
