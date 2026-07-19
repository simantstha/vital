import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHmac } from 'node:crypto';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real POST handler against fake `@/db`, `@/lib/whoop/client`,
 * and `@/lib/whoop/sync` modules — no Postgres, no WHOOP network calls.
 * Async (fire-and-forget) processing is awaited via a short `flush()` delay
 * after each POST, since the route intentionally returns before that work
 * settles (see route.ts's doc comment on responding 200 immediately).
 */

const SECRET = 'whoop-client-secret-for-tests';
process.env.WHOOP_CLIENT_SECRET = SECRET;

let connectionRow: { id: string; user_id: string } | null = { id: 'conn-1', user_id: 'user-1' };
let usersRow: { timezone: string | null } | null = { timezone: 'America/Chicago' };

const fakeDb = {
  select: (fields: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === realSchema.whoop_connections) return connectionRow ? [connectionRow] : [];
          if (table === realSchema.users) return usersRow ? [usersRow] : [];
          void fields;
          return [];
        },
      }),
    }),
  }),
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/whoop/client', { namedExports: { createWhoopTokenStore: () => ({}) } });

const runWhoopSyncCalls: Array<{ connectionId: string; userId: string; timezone: string | null }> = [];
mock.module('@/lib/whoop/sync', {
  namedExports: {
    createWhoopSyncRepository: () => ({}),
    runWhoopSync: async (target: { connectionId: string; userId: string; timezone: string | null }) => {
      runWhoopSyncCalls.push(target);
      return { touchedMetrics: [], dailyMetricsWritten: 0, workoutEventsWritten: 0 };
    },
  },
});

const routePromise = import('./route');

function sign(timestamp: string, rawBody: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
}

function webhookRequest(body: unknown, opts: { timestamp?: string; signature?: string; skipHeaders?: boolean } = {}): Request {
  const rawBody = JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Date.now());
  const signature = opts.signature ?? sign(timestamp, rawBody);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts.skipHeaders) {
    headers['x-whoop-signature'] = signature;
    headers['x-whoop-signature-timestamp'] = timestamp;
  }
  return new Request('http://local/api/whoop/webhook', { method: 'POST', headers, body: rawBody });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('POST 401s when signature headers are missing', async () => {
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 1, id: 'x', type: 'recovery.updated', trace_id: 't1' }, { skipHeaders: true }));
  assert.equal(res.status, 401);
});

test('POST 401s on a stale timestamp (> 5 min skew)', async () => {
  const { POST } = await routePromise;
  const staleTimestamp = String(Date.now() - 10 * 60_000);
  const body = { user_id: 1, id: 'x', type: 'recovery.updated', trace_id: 't1' };
  const res = await POST(webhookRequest(body, { timestamp: staleTimestamp, signature: sign(staleTimestamp, JSON.stringify(body)) }));
  assert.equal(res.status, 401);
});

test('POST 401s on a signature mismatch', async () => {
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 1, id: 'x', type: 'recovery.updated', trace_id: 't1' }, { signature: 'bogus-signature==' }));
  assert.equal(res.status, 401);
});

test('POST returns 202 for an unknown whoop_user_id and does not sync', async () => {
  runWhoopSyncCalls.length = 0;
  connectionRow = null;
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 999, id: 'x', type: 'recovery.updated', trace_id: 't1' }));
  assert.equal(res.status, 202);
  await flush();
  assert.equal(runWhoopSyncCalls.length, 0);
});

test('POST returns 200 immediately and runs a trailing-48h sync for recovery.updated', async () => {
  runWhoopSyncCalls.length = 0;
  connectionRow = { id: 'conn-1', user_id: 'user-1' };
  usersRow = { timezone: 'America/Chicago' };
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 1, id: 'x', type: 'recovery.updated', trace_id: 't1' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  await flush();
  assert.equal(runWhoopSyncCalls.length, 1);
  assert.equal(runWhoopSyncCalls[0].connectionId, 'conn-1');
  assert.equal(runWhoopSyncCalls[0].userId, 'user-1');
  assert.equal(runWhoopSyncCalls[0].timezone, 'America/Chicago');
});

test('POST re-syncs (rather than deletes) on a *.deleted event', async () => {
  runWhoopSyncCalls.length = 0;
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 1, id: 'x', type: 'sleep.deleted', trace_id: 't2' }));
  assert.equal(res.status, 200);
  await flush();
  assert.equal(runWhoopSyncCalls.length, 1);
});

test('POST ignores an unrecognized event type without syncing', async () => {
  runWhoopSyncCalls.length = 0;
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 1, id: 'x', type: 'something.else', trace_id: 't3' }));
  assert.equal(res.status, 200);
  await flush();
  assert.equal(runWhoopSyncCalls.length, 0);
});

test('POST 400s on a malformed payload (non-numeric user_id)', async () => {
  const { POST } = await routePromise;
  const res = await POST(webhookRequest({ user_id: 'not-a-number', id: 'x', type: 'recovery.updated' }));
  assert.equal(res.status, 400);
});
