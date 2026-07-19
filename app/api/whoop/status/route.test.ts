import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real GET handler against a fake `@/db` (no Postgres) — same
 * pattern as app/api/ingest/calendar/route.test.ts.
 */
let row: { status: string; last_synced_at: Date | null } | null = null;
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => (row ? [row] : []),
      }),
    }),
  }),
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/whoop/status', { headers });
}

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  const res = await GET(request());
  assert.equal(res.status, 401);
});

test('GET reports connected: false when there is no connection row', async () => {
  row = null;
  const { GET } = await routePromise;
  const res = await GET(request({ 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { connected: false, status: null, last_synced_at: null });
});

test('GET reports the connection status and last_synced_at when a row exists', async () => {
  const syncedAt = new Date('2026-07-19T08:00:00.000Z');
  row = { status: 'active', last_synced_at: syncedAt };
  const { GET } = await routePromise;
  const res = await GET(request({ 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.connected, true);
  assert.equal(body.status, 'active');
  assert.equal(body.last_synced_at, syncedAt.toISOString());
});
