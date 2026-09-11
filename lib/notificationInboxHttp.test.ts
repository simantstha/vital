import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNotificationInboxHttpHandlers,
  createNotificationReadHttpHandlers,
  createNudgeHttpHandlers,
  type NotificationInboxRepository,
  type PendingNudgeSummary,
} from './notificationInboxHttp';
import type { InboxItem } from './notificationInbox';

function repository(overrides: Partial<NotificationInboxRepository> = {}): NotificationInboxRepository {
  return {
    async listInbox() { return { items: [], unreadCount: 0 }; },
    async markRead() { return 0; },
    async findPendingNudge() { return null; },
    ...overrides,
  };
}

const authenticate = (request: Request) => {
  const userId = request.headers.get('x-user-id');
  if (!userId) throw new Error('unauthenticated');
  return userId;
};

function request(path: string, method = 'GET', body?: unknown, userId?: string): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(userId ? { 'x-user-id': userId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'workout_analysis',
  targetId: 'analysis-1',
  title: 'Workout logged',
  body: 'Your run has been logged.',
  deepLink: 'vital://workout-analysis/analysis-1',
  createdAt: new Date('2026-09-11T12:00:00Z'),
  readAt: null,
  ...overrides,
});

test('GET /api/notifications reports unreadCount independent of the page limit', async () => {
  const handlers = createNotificationInboxHttpHandlers({
    authenticate,
    repository: repository({
      // Only one item comes back on this "page" but 5 rows are unread in
      // total — the count must not be derived from items.length.
      async listInbox(userId, limit) {
        assert.equal(userId, 'user-a');
        assert.equal(limit, 1);
        return { items: [item()], unreadCount: 5 };
      },
    }),
  });
  const response = await handlers.GET(request('/api/notifications?limit=1', 'GET', undefined, 'user-a'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.unreadCount, 5);
  assert.equal(body.items[0].createdAt, '2026-09-11T12:00:00.000Z');
});

test('GET /api/notifications clamps a non-numeric limit to the default and requires auth', async () => {
  let receivedLimit: number | undefined;
  const handlers = createNotificationInboxHttpHandlers({
    authenticate,
    repository: repository({
      async listInbox(_userId, limit) { receivedLimit = limit; return { items: [], unreadCount: 0 }; },
    }),
  });
  assert.equal((await handlers.GET(request('/api/notifications'))).status, 401);
  await handlers.GET(request('/api/notifications?limit=not-a-number', 'GET', undefined, 'user-a'));
  assert.equal(receivedLimit, 50);
  await handlers.GET(request('/api/notifications?limit=500', 'GET', undefined, 'user-a'));
  assert.equal(receivedLimit, 100);
  await handlers.GET(request('/api/notifications?limit=0', 'GET', undefined, 'user-a'));
  assert.equal(receivedLimit, 1);
});

test('POST /api/notifications/read accepts { all: true } and { ids }, rejects a malformed body', async () => {
  const calls: Array<{ userId: string; selector: unknown }> = [];
  const handlers = createNotificationReadHttpHandlers({
    authenticate,
    repository: repository({
      async markRead(userId, selector) { calls.push({ userId, selector }); return 3; },
    }),
  });

  const allResponse = await handlers.POST(request('/api/notifications/read', 'POST', { all: true }, 'user-a'));
  assert.equal(allResponse.status, 200);
  assert.deepEqual(await allResponse.json(), { updated: 3 });

  const validId = '11111111-1111-4111-8111-111111111111';
  const idsResponse = await handlers.POST(
    request('/api/notifications/read', 'POST', { ids: [validId, 'not-a-uuid'] }, 'user-a'),
  );
  assert.equal(idsResponse.status, 200);

  assert.deepEqual(calls, [
    { userId: 'user-a', selector: { all: true } },
    { userId: 'user-a', selector: { ids: [validId] } }, // the malformed entry is filtered out, not rejected
  ]);

  for (const body of [{}, { ids: 'not-an-array' }, { all: false }, null]) {
    assert.equal((await handlers.POST(request('/api/notifications/read', 'POST', body, 'user-a'))).status, 400);
  }
  assert.equal((await handlers.POST(request('/api/notifications/read', 'POST', { all: true }))).status, 401);
});

test('GET /api/nudges/[id] IDOR guard: a nudge belonging to another user 404s, not 200', async () => {
  const nudges: PendingNudgeSummary[] = [
    { id: 'nudge-1', title: 'Steps down', body: "You've walked less this week.", createdAt: new Date('2026-09-10T08:00:00Z') },
  ];
  const handlers = createNudgeHttpHandlers({
    authenticate,
    repository: repository({
      async findPendingNudge(userId) {
        // Only the owning user (`owner`) ever gets a match, mirroring the
        // (id, user_id) predicate the real repository enforces.
        return userId === 'owner' ? nudges[0] : null;
      },
    }),
  });
  const id = '11111111-1111-4111-8111-111111111111';
  const context = { params: Promise.resolve({ id }) };

  const stolen = await handlers.GET(request(`/api/nudges/${id}`, 'GET', undefined, 'attacker'), context);
  assert.equal(stolen.status, 404);

  const owned = await handlers.GET(request(`/api/nudges/${id}`, 'GET', undefined, 'owner'), { params: Promise.resolve({ id }) });
  assert.equal(owned.status, 200);
  assert.deepEqual(await owned.json(), {
    id: 'nudge-1',
    title: 'Steps down',
    body: "You've walked less this week.",
    createdAt: '2026-09-10T08:00:00.000Z',
  });

  const badId = await handlers.GET(request('/api/nudges/not-a-uuid', 'GET', undefined, 'owner'), { params: Promise.resolve({ id: 'not-a-uuid' }) });
  assert.equal(badId.status, 400);
});
