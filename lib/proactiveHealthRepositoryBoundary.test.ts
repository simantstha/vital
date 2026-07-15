import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnalysisHttpHandler,
  createNotificationPreferencesHttpHandlers,
  createPushDevicesHttpHandlers,
  type AnalysisKind,
  type AnalysisRecord,
  type NotificationPreferences,
  type ProactiveHealthRepository,
  type PushDeviceRegistration,
} from './proactiveHealthHttp';
import {
  reconcilePushDeviceRegistration,
  type PushDeviceRow,
  type PushDeviceTransaction,
} from './pushDeviceReconciliation';

class StatefulRepository implements ProactiveHealthRepository, PushDeviceTransaction {
  devices: PushDeviceRow[] = [];
  preferences = new Map<string, NotificationPreferences>();
  analyses: AnalysisRecord[] = [];

  async registerPushDevice(userId: string, registration: PushDeviceRegistration) {
    return reconcilePushDeviceRegistration(this, userId, registration, new Date('2026-07-12T12:00:00Z'));
  }
  async findByInstallationId(id: string) { return this.devices.find((row) => row.installationId === id) ?? null; }
  async findByToken(token: string, environment: string) { return this.devices.find((row) => row.token === token && row.environment === environment) ?? null; }
  async retire(row: PushDeviceRow, token: string, now: Date) { Object.assign(row, { token, invalidatedAt: now, updatedAt: now }); }
  async update(row: PushDeviceRow, token: string, environment: 'sandbox' | 'production', now: Date) { Object.assign(row, { token, environment, invalidatedAt: null, updatedAt: now }); }
  async insert(userId: string, installationId: string, token: string, environment: 'sandbox' | 'production', now: Date) {
    this.devices.push({ id: `device-${this.devices.length + 1}`, userId, installationId, token, environment, invalidatedAt: null, updatedAt: now });
  }
  async invalidatePushDevice(userId: string, installationId: string) {
    const device = this.devices.find((row) => row.userId === userId && row.installationId === installationId && !row.invalidatedAt);
    if (!device) return false;
    device.invalidatedAt = new Date('2026-07-12T13:00:00Z');
    return true;
  }
  async getNotificationPreferences(userId: string) { return this.preferences.get(userId) ?? null; }
  async putNotificationPreferences(userId: string, preferences: NotificationPreferences) {
    this.preferences.set(userId, preferences);
    return preferences;
  }
  async getAnalysis(_kind: AnalysisKind, userId: string, id: string) {
    return this.analyses.find((row) => row.id === id && row.userId === userId && row.status === 'ready' && row.deletedAt === null) ?? null;
  }
}

const authenticate = (request: Request) => {
  const userId = request.headers.get('x-user-id');
  if (!userId) throw new Error('private auth detail');
  return userId;
};
const installationId = '11111111-1111-4111-8111-111111111111';
const analysisId = '22222222-2222-4222-8222-222222222222';

function request(path: string, method: string, userId?: string, body?: unknown) {
  return new Request(`http://local${path}`, {
    method,
    headers: { ...(userId ? { 'x-user-id': userId } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('stateful boundary preserves cross-user device ownership and scopes invalidation', async () => {
  const repository = new StatefulRepository();
  const handlers = createPushDevicesHttpHandlers({ authenticate, repository });
  const registration = { installationId, token: 'a'.repeat(64), environment: 'sandbox' };
  assert.equal((await handlers.POST(request('/api/push-devices', 'POST', 'user-a', registration))).status, 200);
  assert.equal((await handlers.POST(request('/api/push-devices', 'POST', 'user-b', { ...registration, token: 'b'.repeat(64) }))).status, 409);
  assert.equal(repository.devices.length, 1);
  assert.equal(repository.devices[0].userId, 'user-a');
  await handlers.DELETE(request('/api/push-devices', 'DELETE', 'user-b', { installationId }));
  assert.equal(repository.devices[0].invalidatedAt, null);
  await handlers.DELETE(request('/api/push-devices', 'DELETE', 'user-a', { installationId }));
  assert.ok(repository.devices[0].invalidatedAt);
  const unauthorized = await handlers.POST(request('/api/push-devices', 'POST', undefined, registration));
  assert.deepEqual(await unauthorized.json(), { error: 'Unauthorized.' });
});

test('stateful boundary upserts preferences independently per authenticated user', async () => {
  const repository = new StatefulRepository();
  const handlers = createNotificationPreferencesHttpHandlers({ authenticate, repository });
  const preferences = {
    morningBriefEnabled: false, morningBriefTimeMinutes: 510,
    workoutNotificationsEnabled: true, sleepNotificationsEnabled: false,
    mealsEnabled: true, mealBreakfastTimeMinutes: 480,
    mealLunchTimeMinutes: 765, mealSnackTimeMinutes: 960, mealDinnerTimeMinutes: 1170,
    timezone: 'America/Chicago',
  };
  await handlers.PUT(request('/api/notification-preferences', 'PUT', 'user-a', preferences));
  await handlers.PUT(request('/api/notification-preferences', 'PUT', 'user-a', { ...preferences, morningBriefTimeMinutes: 600 }));
  const response = await handlers.GET(request('/api/notification-preferences', 'GET', 'user-a'));
  assert.equal((await response.json()).morningBriefTimeMinutes, 600);
  assert.equal(repository.preferences.size, 1);
});

test('stateful boundary filters analyses by owner, readiness, and deletion', async () => {
  const repository = new StatefulRepository();
  const base: AnalysisRecord = {
    id: analysisId, userId: 'user-a', status: 'ready', deletedAt: null,
    date: '2026-07-12', input: { type: 'running', durationMin: 42, kcal: 380 },
    result: { summary: 'ready' }, createdAt: new Date('2026-07-12T12:00:00Z'),
  };
  const handler = createAnalysisHttpHandler({ authenticate, repository, kind: 'workout' });
  repository.analyses = [{ ...base, userId: 'user-b' }];
  assert.equal((await handler.GET(request(`/api/workout-analyses/${analysisId}`, 'GET', 'user-a'), { params: Promise.resolve({ id: analysisId }) })).status, 404);
  repository.analyses = [{ ...base, status: 'processing' }];
  assert.equal((await handler.GET(request(`/api/workout-analyses/${analysisId}`, 'GET', 'user-a'), { params: Promise.resolve({ id: analysisId }) })).status, 404);
  repository.analyses = [{ ...base, deletedAt: new Date() }];
  assert.equal((await handler.GET(request(`/api/workout-analyses/${analysisId}`, 'GET', 'user-a'), { params: Promise.resolve({ id: analysisId }) })).status, 404);
  repository.analyses = [base];
  assert.equal((await handler.GET(request(`/api/workout-analyses/${analysisId}`, 'GET', 'user-a'), { params: Promise.resolve({ id: analysisId }) })).status, 200);
});
