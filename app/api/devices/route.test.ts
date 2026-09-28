import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../db/schema';

/**
 * Drives the real GET/PATCH handlers against a fake `@/db` (no Postgres) —
 * same pattern as app/api/whoop/status/route.test.ts.
 */
let userRow: { primary_workout_device: string | null; primary_sleep_device: string | null; primary_recovery_device: string | null } | null = null;
let appleRow: { date: string; updated_at: Date } | null = null;
let whoopRow: { status: string; last_synced_at: Date | null } | null = null;
let mergedCount = 0;
let updateSetCalls: Array<Record<string, unknown>> = [];
let updatedRow: { primary_workout_device: string | null; primary_sleep_device: string | null; primary_recovery_device: string | null } = {
  primary_workout_device: null, primary_sleep_device: null, primary_recovery_device: null,
};

const fakeDb = {
  select(fields: Record<string, unknown>) {
    return {
      from(table: unknown) {
        const chain = {
          where() { return chain; },
          orderBy() { return chain; },
          limit(_n: number) {
            if (table === realSchema.users) {
              return Promise.resolve(userRow ? [{
                workouts: userRow.primary_workout_device,
                sleep: userRow.primary_sleep_device,
                recovery: userRow.primary_recovery_device,
              }] : []);
            }
            if (table === realSchema.daily_metrics) {
              return Promise.resolve(appleRow ? [{ date: appleRow.date, updatedAt: appleRow.updated_at }] : []);
            }
            if (table === realSchema.whoop_connections) {
              return Promise.resolve(whoopRow ? [{ status: whoopRow.status, lastSyncedAt: whoopRow.last_synced_at }] : []);
            }
            throw new Error(`unexpected .limit() on table for fields ${JSON.stringify(Object.keys(fields))}`);
          },
          // workout_analyses merged-count query has no .limit() call.
          then(resolve: (v: unknown) => unknown) {
            if (table === realSchema.workout_analyses) {
              return Promise.resolve(resolve([{ count: mergedCount }]));
            }
            return Promise.resolve(resolve([]));
          },
        };
        return chain;
      },
    };
  },
  update(_table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        updateSetCalls.push(values);
        updatedRow = {
          primary_workout_device: 'primary_workout_device' in values ? (values.primary_workout_device as string | null) : updatedRow.primary_workout_device,
          primary_sleep_device: 'primary_sleep_device' in values ? (values.primary_sleep_device as string | null) : updatedRow.primary_sleep_device,
          primary_recovery_device: 'primary_recovery_device' in values ? (values.primary_recovery_device as string | null) : updatedRow.primary_recovery_device,
        };
        // The PATCH handler re-reads state via a fresh GET-style select after
        // writing, so the fake's "table" must reflect the persisted update.
        userRow = { ...updatedRow };
        return {
          where() {
            return {
              returning() {
                return Promise.resolve([{
                  workouts: updatedRow.primary_workout_device,
                  sleep: updatedRow.primary_sleep_device,
                  recovery: updatedRow.primary_recovery_device,
                }]);
              },
            };
          },
        };
      },
    };
  },
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function request(method: string, headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request('http://local/api/devices', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  const res = await GET(request('GET'));
  assert.equal(res.status, 401);
});

test('GET reports disconnected devices and auto preferences by default', async () => {
  userRow = null;
  appleRow = null;
  whoopRow = null;
  mergedCount = 0;
  const { GET } = await routePromise;
  const res = await GET(request('GET', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.devices, [
    { id: 'apple', connected: false, lastSyncAt: null },
    { id: 'whoop', connected: false, lastSyncAt: null },
  ]);
  assert.deepEqual(body.primary, { workouts: 'apple', sleep: 'apple', recovery: 'apple' });
  assert.deepEqual(body.explicit, { workouts: null, sleep: null, recovery: null });
  assert.equal(body.mergedThisMonth, 0);
});

test('GET reports connected devices, explicit overrides, and merged count scoped to the user', async () => {
  userRow = { primary_workout_device: 'whoop', primary_sleep_device: null, primary_recovery_device: null };
  appleRow = { date: '2026-09-20', updated_at: new Date('2026-09-20T07:00:00.000Z') };
  whoopRow = { status: 'active', last_synced_at: new Date('2026-09-27T09:00:00.000Z') };
  mergedCount = 4;
  const { GET } = await routePromise;
  const res = await GET(request('GET', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.devices[0].connected, true);
  assert.equal(body.devices[0].lastSyncAt, '2026-09-20T07:00:00.000Z');
  assert.equal(body.devices[1].connected, true);
  assert.equal(body.devices[1].lastSyncAt, '2026-09-27T09:00:00.000Z');
  assert.deepEqual(body.primary, { workouts: 'whoop', sleep: 'whoop', recovery: 'whoop' });
  assert.equal(body.mergedThisMonth, 4);
});

test('PATCH 401s without an x-user-id header', async () => {
  const { PATCH } = await routePromise;
  const res = await PATCH(request('PATCH', {}, { primary: { workouts: 'whoop' } }));
  assert.equal(res.status, 401);
});

test('PATCH rejects an invalid body and never writes', async () => {
  updateSetCalls = [];
  const { PATCH } = await routePromise;
  const res = await PATCH(request('PATCH', { 'x-user-id': 'user-1' }, { primary: { workouts: 'garmin' } }));
  assert.equal(res.status, 400);
  assert.equal(updateSetCalls.length, 0);
});

test('PATCH writes only the given preference column(s) and returns the resolved state', async () => {
  userRow = { primary_workout_device: null, primary_sleep_device: null, primary_recovery_device: null };
  updatedRow = { primary_workout_device: null, primary_sleep_device: null, primary_recovery_device: null };
  updateSetCalls = [];
  const { PATCH } = await routePromise;
  const res = await PATCH(request('PATCH', { 'x-user-id': 'user-1' }, { primary: { sleep: 'apple' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(updateSetCalls, [{ primary_sleep_device: 'apple' }]);
  const body = await res.json();
  assert.equal(body.explicit.sleep, 'apple');
  assert.equal(body.explicit.workouts, null);
});

test('PATCH with null resets a preference to auto (writes null, not skipped)', async () => {
  updateSetCalls = [];
  const { PATCH } = await routePromise;
  const res = await PATCH(request('PATCH', { 'x-user-id': 'user-1' }, { primary: { workouts: null } }));
  assert.equal(res.status, 200);
  assert.deepEqual(updateSetCalls, [{ primary_workout_device: null }]);
});
