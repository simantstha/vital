import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * These tests only exercise request-body validation, which the route rejects
 * with a 400 before ever touching the database — but the route (and
 * lib/brain/baselines, which it imports) still import `@/db` at module
 * scope, so a fake is required just to load the module. Same pattern as
 * app/api/whoop/status/route.test.ts.
 */
const fakeDb = {
  transaction: async () => { throw new Error('not exercised — validation tests never reach the DB'); },
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function request(body: unknown, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request('http://local/api/ingest/daily', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({ days: [] }, {}));
  assert.equal(res.status, 401);
});

test('POST accepts a workout with a valid hrSeries and running block (validation only, no DB reached in this fake)', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{
      date: '2026-09-20',
      workouts: [{
        hkUuid: 'hk-1',
        startTime: '2026-09-20T06:00:00.000Z',
        durationMin: 30,
        hrSeries: [120, 130, 140, 150],
        running: { cadenceSpm: 170, groundContactMs: 240, powerW: 280, strideM: 1.1 },
      }],
    }],
  }));
  // Reaches the DB transaction (which the fake throws inside) rather than
  // being rejected at the 400 validation stage — proves hrSeries/running
  // passed the whitelist check.
  assert.equal(res.status, 500);
});

test('POST rejects a workout whose hrSeries is not an array of finite numbers', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', hrSeries: 'not-an-array' }] }],
  }));
  assert.equal(res.status, 400);
});

test('POST rejects a workout whose hrSeries contains a non-numeric value', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', hrSeries: [120, 'x', 140] }] }],
  }));
  assert.equal(res.status, 400);
});

test('POST rejects a workout whose hrSeries exceeds 120 points', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', hrSeries: new Array(121).fill(100) }] }],
  }));
  assert.equal(res.status, 400);
});

test('POST rejects a workout whose running block has a non-numeric field', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', running: { cadenceSpm: 'fast' } }] }],
  }));
  assert.equal(res.status, 400);
});

test('POST rejects a workout whose running block is an array, not an object', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', running: [1, 2, 3] }] }],
  }));
  assert.equal(res.status, 400);
});

test('POST accepts a workout with neither hrSeries nor running (both optional)', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', startTime: '2026-09-20T06:00:00.000Z', durationMin: 30 }] }],
  }));
  assert.equal(res.status, 500); // reaches the DB stage — validation passed
});

test('POST accepts a running block with only some fields present', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({
    days: [{ date: '2026-09-20', workouts: [{ hkUuid: 'hk-1', running: { cadenceSpm: 170 } }] }],
  }));
  assert.equal(res.status, 500); // reaches the DB stage — validation passed
});
