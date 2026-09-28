import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevicesHttpHandlers, type DevicesRepository, type DevicesState } from './devicesHttp';
import type { DevicePreferences } from './devicesContext';

function authenticate(request: Request): string {
  const userId = request.headers.get('x-user-id');
  if (!userId) throw new Error('unauthorized');
  return userId;
}

class FakeRepository implements DevicesRepository {
  state: DevicesState = {
    apple: { connected: false, lastSyncAt: null },
    whoop: { connected: false, lastSyncAt: null },
    explicit: { workouts: null, sleep: null, recovery: null },
    mergedThisMonth: 0,
  };
  updateCalls: Array<{ userId: string; update: Partial<DevicePreferences> }> = [];

  async getDevicesState(): Promise<DevicesState> { return this.state; }
  async updateDevicePreferences(userId: string, update: Partial<DevicePreferences>): Promise<DevicePreferences> {
    this.updateCalls.push({ userId, update });
    this.state = { ...this.state, explicit: { ...this.state.explicit, ...update } };
    return this.state.explicit;
  }
}

function request(method: string, headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request('http://local/api/devices', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('GET 401s without auth', async () => {
  const repo = new FakeRepository();
  const { GET } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await GET(request('GET'));
  assert.equal(res.status, 401);
});

test('GET reports both devices, resolved primary, explicit preferences, and mergedThisMonth', async () => {
  const repo = new FakeRepository();
  repo.state = {
    apple: { connected: true, lastSyncAt: new Date('2026-09-01T08:00:00.000Z') },
    whoop: { connected: true, lastSyncAt: new Date('2026-09-02T09:00:00.000Z') },
    explicit: { workouts: null, sleep: null, recovery: 'apple' },
    mergedThisMonth: 3,
  };
  const { GET } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await GET(request('GET', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.devices, [
    { id: 'apple', connected: true, lastSyncAt: '2026-09-01T08:00:00.000Z' },
    { id: 'whoop', connected: true, lastSyncAt: '2026-09-02T09:00:00.000Z' },
  ]);
  // workouts null -> current order (apple); sleep null + WHOOP connected -> whoop; recovery explicit 'apple'.
  assert.deepEqual(body.primary, { workouts: 'apple', sleep: 'whoop', recovery: 'apple' });
  assert.deepEqual(body.explicit, { workouts: null, sleep: null, recovery: 'apple' });
  assert.equal(body.mergedThisMonth, 3);
});

test('GET reports a disconnected device with null lastSyncAt', async () => {
  const repo = new FakeRepository();
  const { GET } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await GET(request('GET', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.devices, [
    { id: 'apple', connected: false, lastSyncAt: null },
    { id: 'whoop', connected: false, lastSyncAt: null },
  ]);
});

test('PATCH 401s without auth', async () => {
  const repo = new FakeRepository();
  const { PATCH } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await PATCH(request('PATCH', {}, { primary: { workouts: 'whoop' } }));
  assert.equal(res.status, 401);
});

test('PATCH rejects invalid JSON', async () => {
  const repo = new FakeRepository();
  const { PATCH } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await PATCH(new Request('http://local/api/devices', {
    method: 'PATCH', headers: { 'x-user-id': 'user-1' }, body: '{not json',
  }));
  assert.equal(res.status, 400);
});

test('PATCH rejects a malformed body strictly and never calls the repository', async () => {
  const repo = new FakeRepository();
  const { PATCH } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await PATCH(request('PATCH', { 'x-user-id': 'user-1' }, { primary: { workouts: 'garmin' } }));
  assert.equal(res.status, 400);
  assert.equal(repo.updateCalls.length, 0);
});

test('PATCH updates only the given preferences and returns the fresh resolved state, scoped to the user', async () => {
  const repo = new FakeRepository();
  repo.state = { ...repo.state, whoop: { connected: true, lastSyncAt: null } };
  const { PATCH } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await PATCH(request('PATCH', { 'x-user-id': 'user-42' }, { primary: { workouts: 'whoop' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(repo.updateCalls, [{ userId: 'user-42', update: { workouts: 'whoop' } }]);
  const body = await res.json();
  assert.equal(body.primary.workouts, 'whoop');
  assert.deepEqual(body.explicit, { workouts: 'whoop', sleep: null, recovery: null });
});

test('PATCH with null resets a preference to auto', async () => {
  const repo = new FakeRepository();
  repo.state.explicit = { workouts: 'whoop', sleep: null, recovery: null };
  const { PATCH } = createDevicesHttpHandlers({ authenticate, repository: repo });
  const res = await PATCH(request('PATCH', { 'x-user-id': 'user-1' }, { primary: { workouts: null } }));
  assert.equal(res.status, 200);
  assert.deepEqual(repo.updateCalls, [{ userId: 'user-1', update: { workouts: null } }]);
});
