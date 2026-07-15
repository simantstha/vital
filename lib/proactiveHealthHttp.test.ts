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
    async registerPushDevice() { return 'registered'; },
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
      async registerPushDevice(userId, device) { registrations.push({ userId, ...device }); return 'registered'; },
    }),
  });
  assert.equal((await handlers.POST(request('/api/push-devices', 'POST', {}))).status, 401);
  for (const body of [
    { installationId: '', token: 'token', environment: 'sandbox' },
    { installationId: '11111111-1111-4111-8111-111111111111', token: '', environment: 'sandbox' },
    { installationId: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), environment: 'other' },
    { installationId: 'not-a-uuid', token: 'a'.repeat(64), environment: 'sandbox' },
    { installationId: '11111111-1111-4111-8111-111111111111', token: 'not-hex', environment: 'sandbox' },
  ]) assert.equal((await handlers.POST(request('/api/push-devices', 'POST', body, 'user-a'))).status, 400);

  const valid = { installationId: '11111111-1111-4111-8111-111111111111', token: 'A'.repeat(64), environment: 'sandbox' };
  const first = await handlers.POST(request('/api/push-devices', 'POST', valid, 'user-a'));
  const second = await handlers.POST(request('/api/push-devices', 'POST', valid, 'user-a'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(registrations, [
    { userId: 'user-a', installationId: valid.installationId, token: 'a'.repeat(64), environment: 'sandbox' },
    { userId: 'user-a', installationId: valid.installationId, token: 'a'.repeat(64), environment: 'sandbox' },
  ]);
  assert.deepEqual(await first.json(), { installationId: valid.installationId, environment: 'sandbox' });
});

test('push registration maps ownership conflicts to a fixed public 409', async () => {
  const handlers = createPushDevicesHttpHandlers({
    authenticate,
    repository: repository({ async registerPushDevice() { return 'conflict'; } }),
  });
  const response = await handlers.POST(request('/api/push-devices', 'POST', {
    installationId: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), environment: 'sandbox',
  }, 'user-b'));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Device registration conflicts with another account.' });
});

test('push invalidation scopes the installation to the authenticated user', async () => {
  const calls: string[][] = [];
  const handlers = createPushDevicesHttpHandlers({
    authenticate,
    repository: repository({
      async invalidatePushDevice(userId, installationId) { calls.push([userId, installationId]); return true; },
    }),
  });
  const installationId = '11111111-1111-4111-8111-111111111111';
  const response = await handlers.DELETE(request('/api/push-devices', 'DELETE', { installationId }, 'user-b'));
  assert.equal(response.status, 204);
  assert.deepEqual(calls, [['user-b', installationId]]);
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
    id: '11111111-1111-4111-8111-111111111111', userId: 'user-a', status: 'ready', deletedAt: null,
    date: '2026-07-12',
    input: { type: 'running', durationMin: 59, kcal: 97, distanceM: 10200, avgHr: 151, maxHr: 176, paceMinPerKm: 5.78, startTime: '2026-07-12T11:00:00Z' },
    result: { summary: 'Good run' }, createdAt: new Date('2026-07-12T12:00:00Z'),
  };
  const seen: string[][] = [];
  const handler = createAnalysisHttpHandler({
    authenticate,
    kind: 'workout',
    repository: repository({
      async getAnalysis(kind, userId, id) { seen.push([kind, userId, id]); return record; },
    }),
  });
  assert.equal((await handler.GET(request('/api/workout-analyses/x'), { params: Promise.resolve({ id: 'x' }) })).status, 401);
  const invalid = await handler.GET(request('/api/workout-analyses/x', 'GET', undefined, 'user-a'), { params: Promise.resolve({ id: 'x' }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(seen, []);
  const response = await handler.GET(request(`/api/workout-analyses/${record.id}`, 'GET', undefined, 'user-a'), { params: Promise.resolve({ id: record.id }) });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [['workout', 'user-a', record.id]]);
  assert.deepEqual(await response.json(), {
    id: record.id, date: '2026-07-12', result: { summary: 'Good run' },
    metrics: { type: 'running', durationMin: 59, kcal: 97, distanceM: 10200, avgHr: 151, maxHr: 176, paceMinPerKm: 5.78, startTime: '2026-07-12T11:00:00Z' },
    createdAt: '2026-07-12T12:00:00.000Z',
  });

  for (const hidden of [null, { ...record, userId: 'user-b' }, { ...record, status: 'processing' }, { ...record, deletedAt: new Date() }]) {
    const hiddenHandler = createAnalysisHttpHandler({ authenticate, kind: 'sleep', repository: repository({ async getAnalysis() { return hidden; } }) });
    assert.equal((await hiddenHandler.GET(request(`/api/sleep-analyses/${record.id}`, 'GET', undefined, 'user-a'), { params: Promise.resolve({ id: record.id }) })).status, 404);
  }
});

test('analysis GET echoes the sleep input payload as metrics', async () => {
  const record: AnalysisRecord = {
    id: '22222222-2222-4222-8222-222222222222', userId: 'user-a', status: 'ready', deletedAt: null,
    date: '2026-07-13',
    input: { minutes: 431, stages: { core: 312, deep: 55, rem: 64, awake: 12 } },
    result: { summary: 'Solid night' }, createdAt: new Date('2026-07-13T08:00:00Z'),
  };
  const handler = createAnalysisHttpHandler({
    authenticate,
    kind: 'sleep',
    repository: repository({ async getAnalysis() { return record; } }),
  });
  const response = await handler.GET(request(`/api/sleep-analyses/${record.id}`, 'GET', undefined, 'user-a'), { params: Promise.resolve({ id: record.id }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).metrics, { minutes: 431, stages: { core: 312, deep: 55, rem: 64, awake: 12 } });
});

test('analysis GET passes one canonical UUID to the repository', async () => {
  let repositoryId = '';
  const handler = createAnalysisHttpHandler({
    authenticate,
    kind: 'workout',
    repository: repository({ async getAnalysis(_kind, _userId, id) { repositoryId = id; return null; } }),
  });
  const rawId = '  AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA  ';
  const response = await handler.GET(request('/api/workout-analyses/id', 'GET', undefined, 'user-a'), {
    params: Promise.resolve({ id: rawId }),
  });
  assert.equal(response.status, 404);
  assert.equal(repositoryId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});
