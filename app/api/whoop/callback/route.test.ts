import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';
import { signWhoopOAuthState } from '../../../../lib/whoop/state';

/**
 * Drives the real GET handler against fake `@/db`, `@/lib/whoop/client`, and
 * `@/lib/whoop/sync` modules (no Postgres, no WHOOP network calls) — same
 * approach as app/api/ingest/calendar/route.test.ts. `state` tokens are
 * signed with the REAL lib/whoop/state.ts (only client/sync/db are faked),
 * so this also exercises the actual state-verification path end to end.
 *
 * mock.module() can only be called once per specifier per process, so each
 * fake exposes mutable state the tests configure/reset per-case rather than
 * re-mocking.
 */

process.env.SESSION_JWT_SECRET = 'test-session-secret-at-least-32-bytes-long';

let usersRow: { timezone: string | null } | null = { timezone: 'America/Chicago' };
let dbThrows = false;
let insertedValues: Record<string, unknown> = {};

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          if (dbThrows) throw new Error('db select failed');
          return usersRow ? [usersRow] : [];
        },
      }),
    }),
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      insertedValues = values;
      return {
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (dbThrows) throw new Error('db insert failed');
            return [{ id: 'conn-1' }];
          },
        }),
      };
    },
  }),
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

let exchangeCodeImpl: (code: string) => Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }> =
  async (code) => ({ access_token: `access-for-${code}`, refresh_token: 'refresh-1', expires_in: 3600, scope: 'offline', token_type: 'bearer' });
let getProfileImpl: (accessToken: string) => Promise<{ user_id: number; email: string; first_name: string; last_name: string }> =
  async () => ({ user_id: 42, email: 'a@b.com', first_name: 'A', last_name: 'B' });

mock.module('@/lib/whoop/client', {
  namedExports: {
    exchangeCode: (code: string) => exchangeCodeImpl(code),
    getProfile: (accessToken: string) => getProfileImpl(accessToken),
    createWhoopTokenStore: () => ({}),
  },
});

const runWhoopSyncCalls: Array<{ connectionId: string; userId: string; timezone: string | null; windowStart: Date; windowEnd: Date }> = [];
mock.module('@/lib/whoop/sync', {
  namedExports: {
    createWhoopSyncRepository: () => ({}),
    runWhoopSync: async (target: { connectionId: string; userId: string; timezone: string | null }, _tokenStore: unknown, _repo: unknown, windowStart: Date, windowEnd: Date) => {
      runWhoopSyncCalls.push({ ...target, windowStart, windowEnd });
      return { touchedMetrics: [], dailyMetricsWritten: 0, workoutEventsWritten: 0 };
    },
  },
});

const routePromise = import('./route');

function callbackRequest(query: string): Request {
  return new Request(`http://local/api/whoop/callback${query}`);
}

function locationOf(res: Response): string | null {
  return res.headers.get('location');
}

test('GET redirects to the error deep link when WHOOP returns an error param', async () => {
  const { GET } = await routePromise;
  const res = await GET(callbackRequest('?error=access_denied'));
  assert.equal(res.status, 302);
  assert.equal(locationOf(res), 'vital://whoop?status=error');
});

test('GET redirects to the error deep link when code or state is missing', async () => {
  const { GET } = await routePromise;
  const res = await GET(callbackRequest(''));
  assert.equal(res.status, 302);
  assert.equal(locationOf(res), 'vital://whoop?status=error');
});

test('GET redirects to the error deep link on an invalid/garbage state', async () => {
  const { GET } = await routePromise;
  const res = await GET(callbackRequest('?code=abc&state=not-a-real-jwt'));
  assert.equal(res.status, 302);
  assert.equal(locationOf(res), 'vital://whoop?status=error');
});

test('GET redirects to the error deep link when token exchange fails', async () => {
  const { GET } = await routePromise;
  const state = await signWhoopOAuthState('user-1');
  exchangeCodeImpl = async () => { throw new Error('whoop token endpoint down'); };
  try {
    const res = await GET(callbackRequest(`?code=abc&state=${encodeURIComponent(state)}`));
    assert.equal(res.status, 302);
    assert.equal(locationOf(res), 'vital://whoop?status=error');
  } finally {
    exchangeCodeImpl = async (code) => ({ access_token: `access-for-${code}`, refresh_token: 'refresh-1', expires_in: 3600, scope: 'offline', token_type: 'bearer' });
  }
});

test('GET redirects to the error deep link when the profile fetch fails', async () => {
  const { GET } = await routePromise;
  const state = await signWhoopOAuthState('user-1');
  getProfileImpl = async () => { throw new Error('whoop profile endpoint down'); };
  try {
    const res = await GET(callbackRequest(`?code=abc&state=${encodeURIComponent(state)}`));
    assert.equal(res.status, 302);
    assert.equal(locationOf(res), 'vital://whoop?status=error');
  } finally {
    getProfileImpl = async () => ({ user_id: 42, email: 'a@b.com', first_name: 'A', last_name: 'B' });
  }
});

test('GET redirects to the error deep link when the DB upsert fails', async () => {
  const { GET } = await routePromise;
  const state = await signWhoopOAuthState('user-1');
  dbThrows = true;
  try {
    const res = await GET(callbackRequest(`?code=abc&state=${encodeURIComponent(state)}`));
    assert.equal(res.status, 302);
    assert.equal(locationOf(res), 'vital://whoop?status=error');
  } finally {
    dbThrows = false;
  }
});

test('GET upserts the connection, fires a 30-day backfill, and redirects to the connected deep link', async () => {
  runWhoopSyncCalls.length = 0;
  insertedValues = {};
  usersRow = { timezone: 'America/Chicago' };
  const { GET } = await routePromise;
  const state = await signWhoopOAuthState('user-1');

  const res = await GET(callbackRequest(`?code=auth-code-1&state=${encodeURIComponent(state)}`));

  assert.equal(res.status, 302);
  assert.equal(locationOf(res), 'vital://whoop?status=connected');

  assert.equal(insertedValues.user_id, 'user-1');
  assert.equal(insertedValues.whoop_user_id, 42);
  assert.equal(insertedValues.access_token, 'access-for-auth-code-1');

  assert.equal(runWhoopSyncCalls.length, 1);
  const call = runWhoopSyncCalls[0];
  assert.equal(call.connectionId, 'conn-1');
  assert.equal(call.userId, 'user-1');
  assert.equal(call.timezone, 'America/Chicago');
  const windowDays = Math.round((call.windowEnd.getTime() - call.windowStart.getTime()) / (24 * 3_600_000));
  assert.equal(windowDays, 30);
});

test('GET falls back to a null timezone when the user row has none set', async () => {
  runWhoopSyncCalls.length = 0;
  usersRow = { timezone: null };
  const { GET } = await routePromise;
  const state = await signWhoopOAuthState('user-1');

  await GET(callbackRequest(`?code=auth-code-2&state=${encodeURIComponent(state)}`));

  assert.equal(runWhoopSyncCalls[0].timezone, null);
});
