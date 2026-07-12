import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnalysisHttpHandler,
  createNotificationPreferencesHttpHandlers,
  createPushDevicesHttpHandlers,
  type AnalysisRecord,
  type NotificationPreferences,
  type ProactiveHealthRepository,
} from './proactiveHealthHttp';

function repository(overrides: Partial<ProactiveHealthRepository> = {}): ProactiveHealthRepository {
  return {
    async registerPushDevice() {},
    async invalidatePushDevice() { return false; },
    async getNotificationPreferences() { return null; },
    async putNotificationPreferences(_userId, preferences) { return preferences; },
    async getAnalysis() { return null; },
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

test('push registration is authenticated, validated, idempotent, and never returns a token', async () => {
  const registrations: Array<{ userId: string; installationId: string; token: string; environment: string }> = [];
  const handlers = createPushDevicesHttpHandlers({
    authenticate,
    repository: repository({
      async registerPushDevice(userId, device) { registrations.push({ userId, ...device }); },
    }),
  });
  assert.equal((await handlers.POST(request('/api/push-devices', 'POST', {}))).status, 401);
  for (const body of [
    { installationId: '', token: 'token', environment: 'sandbox' },
    { installationId: 'install', token: '', environment: 'sandbox' },
    { installationId: 'install', token: 'token', environment: 'other' },
  ]) assert.equal((await handlers.POST(request('/api/push-devices', 'POST', body, 'user-a'))).status, 400);

  const valid = { installationId: ' install-1 ', token: ' token-secret ', environment: 'sandbox' };
  const first = await handlers.POST(request('/api/push-devices', 'POST', valid, 'user-a'));
  const second = await handlers.POST(request('/api/push-devices', 'POST', valid, 'user-a'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(registrations, [
    { userId: 'user-a', installationId: 'install-1', token: 'token-secret', environment: 'sandbox' },
    { userId: 'user-a', installationId: 'install-1', token: 'token-secret', environment: 'sandbox' },
  ]);
  assert.deepEqual(await first.json(), { installationId: 'install-1', environment: 'sandbox' });
});

test('push invalidation scopes the installation to the authenticated user', async () => {
  const calls: string[][] = [];
  const handlers = createPushDevicesHttpHandlers({
    authenticate,
    repository: repository({
      async invalidatePushDevice(userId, installationId) { calls.push([userId, installationId]); return true; },
    }),
  });
  const response = await handlers.DELETE(request('/api/push-devices', 'DELETE', { installationId: 'install-1' }, 'user-b'));
  assert.equal(response.status, 204);
  assert.deepEqual(calls, [['user-b', 'install-1']]);
  assert.equal((await handlers.DELETE(request('/api/push-devices', 'DELETE', {}, 'user-b'))).status, 400);
});

test('notification preferences return defaults and PUT validates all fields and IANA timezone', async () => {
  let saved: NotificationPreferences | undefined;
  const handlers = createNotificationPreferencesHttpHandlers({
    authenticate,
    repository: repository({
      async putNotificationPreferences(_userId, preferences) { saved = preferences; return preferences; },
    }),
  });
  const get = await handlers.GET(request('/api/notification-preferences', 'GET', undefined, 'user-a'));
  assert.deepEqual(await get.json(), {
    morningBriefEnabled: true,
    morningBriefTimeMinutes: 450,
    workoutNotificationsEnabled: true,
    sleepNotificationsEnabled: true,
    timezone: 'UTC',
  });
  const valid = {
    morningBriefEnabled: false, morningBriefTimeMinutes: 0,
    workoutNotificationsEnabled: false, sleepNotificationsEnabled: true,
    timezone: 'America/Chicago',
  };
  assert.equal((await handlers.PUT(request('/api/notification-preferences', 'PUT', valid, 'user-a'))).status, 200);
  assert.deepEqual(saved, valid);
  for (const invalid of [
    { ...valid, morningBriefTimeMinutes: -1 },
    { ...valid, morningBriefTimeMinutes: 1440 },
    { ...valid, morningBriefEnabled: 'yes' },
    { ...valid, timezone: 'Not/A_Zone' },
    { ...valid, sleepNotificationsEnabled: undefined },
  ]) assert.equal((await handlers.PUT(request('/api/notification-preferences', 'PUT', invalid, 'user-a'))).status, 400);
});

test('analysis GET returns only an authenticated user ready non-deleted public DTO', async () => {
  const record: AnalysisRecord = {
    id: 'analysis-1', userId: 'user-a', status: 'ready', deletedAt: null,
    date: '2026-07-12', result: { summary: 'Good run' }, createdAt: new Date('2026-07-12T12:00:00Z'),
  };
  const seen: string[][] = [];
  const handler = createAnalysisHttpHandler({
    authenticate,
    kind: 'workout',
    repository: repository({
      async getAnalysis(kind, userId, id) { seen.push([kind, userId, id]); return record; },
    }),
  });
  assert.equal((await handler.GET(request('/api/workout-analyses/analysis-1'), { params: Promise.resolve({ id: 'analysis-1' }) })).status, 401);
  const response = await handler.GET(request('/api/workout-analyses/analysis-1', 'GET', undefined, 'user-a'), { params: Promise.resolve({ id: 'analysis-1' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [['workout', 'user-a', 'analysis-1']]);
  assert.deepEqual(await response.json(), {
    id: 'analysis-1', date: '2026-07-12', result: { summary: 'Good run' }, createdAt: '2026-07-12T12:00:00.000Z',
  });

  for (const hidden of [null, { ...record, userId: 'user-b' }, { ...record, status: 'processing' }, { ...record, deletedAt: new Date() }]) {
    const hiddenHandler = createAnalysisHttpHandler({ authenticate, kind: 'sleep', repository: repository({ async getAnalysis() { return hidden; } }) });
    assert.equal((await hiddenHandler.GET(request('/api/sleep-analyses/x', 'GET', undefined, 'user-a'), { params: Promise.resolve({ id: 'x' }) })).status, 404);
  }
});
