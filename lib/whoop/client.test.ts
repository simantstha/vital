import assert from 'node:assert/strict';
import test from 'node:test';
import * as schema from '../../db/schema';
import {
  createWhoopTokenStore,
  exchangeCode,
  getBodyMeasurement,
  getCycles,
  getProfile,
  refreshTokens,
  withValidToken,
  WhoopConnectionInactiveError,
  WhoopTokenError,
  type WhoopConnectionSnapshot,
  type WhoopTokenStore,
  type WhoopTokenStoreTx,
} from './client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

test('exchangeCode posts the authorization_code grant with client credentials', async (t) => {
  process.env.WHOOP_CLIENT_ID = 'client-1';
  process.env.WHOOP_CLIENT_SECRET = 'secret-1';
  process.env.WHOOP_REDIRECT_URI = 'https://vital.example/api/whoop/callback';

  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(200, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'read:recovery offline',
      token_type: 'bearer',
    });
  });

  const tokens = await exchangeCode('auth-code-1');

  assert.equal(capturedUrl, 'https://api.prod.whoop.com/oauth/oauth2/token');
  assert.equal(capturedInit?.method, 'POST');
  const body = new URLSearchParams(capturedInit?.body as string);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code-1');
  assert.equal(body.get('client_id'), 'client-1');
  assert.equal(body.get('client_secret'), 'secret-1');
  assert.equal(body.get('redirect_uri'), 'https://vital.example/api/whoop/callback');
  assert.equal(tokens.access_token, 'access-1');
  assert.equal(tokens.refresh_token, 'refresh-1');
});

test('refreshTokens throws WhoopTokenError with the invalid_grant code on a 400', async (t) => {
  process.env.WHOOP_CLIENT_ID = 'client-1';
  process.env.WHOOP_CLIENT_SECRET = 'secret-1';
  process.env.WHOOP_REDIRECT_URI = 'https://vital.example/api/whoop/callback';

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, {
    error: 'invalid_grant',
    error_description: 'refresh token already used',
  }));

  await assert.rejects(
    () => refreshTokens('stale-refresh-token'),
    (err: unknown) => {
      assert.ok(err instanceof WhoopTokenError);
      assert.equal(err.code, 'invalid_grant');
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('getProfile / getBodyMeasurement send a bearer token to the right v2 path', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer access-token');
    if (url.includes('/user/profile/basic')) {
      return jsonResponse(200, { user_id: 42, email: 'a@b.com', first_name: 'A', last_name: 'B' });
    }
    return jsonResponse(200, { height_meter: 1.8, weight_kilogram: 80, max_heart_rate: 190 });
  });

  const profile = await getProfile('access-token');
  const body = await getBodyMeasurement('access-token');

  assert.equal(profile.user_id, 42);
  assert.equal(body.weight_kilogram, 80);
  assert.equal(calls[0], 'https://api.prod.whoop.com/developer/v2/user/profile/basic');
  assert.equal(calls[1], 'https://api.prod.whoop.com/developer/v2/user/measurement/body');
});

test('getCycles pages with limit<=25 + start/end, follows nextToken, and caps at 10 pages', async (t) => {
  const start = new Date('2026-07-01T00:00:00.000Z');
  const end = new Date('2026-07-19T00:00:00.000Z');
  const seenUrls: string[] = [];

  t.mock.method(globalThis, 'fetch', async (url: string) => {
    seenUrls.push(url);
    // Always return a next_token so we can prove the defensive page cap.
    return jsonResponse(200, {
      records: [{ id: seenUrls.length, score_state: 'SCORED', score: { strain: 10 } }],
      next_token: 'more',
    });
  });

  const cycles = await getCycles('access-token', start, end);

  assert.equal(cycles.length, 10); // capped at MAX_PAGES, one record per page
  assert.equal(seenUrls.length, 10);

  const firstUrl = new URL(seenUrls[0]);
  assert.equal(firstUrl.pathname, '/developer/v2/cycle');
  assert.equal(firstUrl.searchParams.get('limit'), '25');
  assert.equal(firstUrl.searchParams.get('start'), start.toISOString());
  assert.equal(firstUrl.searchParams.get('end'), end.toISOString());
  assert.equal(firstUrl.searchParams.has('nextToken'), false);

  const secondUrl = new URL(seenUrls[1]);
  assert.equal(secondUrl.searchParams.get('nextToken'), 'more');
});

test('getCycles stops as soon as next_token is null', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return jsonResponse(200, { records: [{ id: calls }], next_token: null });
  });

  const cycles = await getCycles('access-token', new Date(), new Date());

  assert.equal(calls, 1);
  assert.equal(cycles.length, 1);
});

// ─── withValidToken ───────────────────────────────────────────────────────────

class FakeTokenStore implements WhoopTokenStore, WhoopTokenStoreTx {
  saved: Array<{ id: string; tokens: { access_token: string; refresh_token: string; expires_at: Date } }> = [];
  errored: string[] = [];
  constructor(private row: WhoopConnectionSnapshot | null) {}

  async transaction<T>(fn: (tx: WhoopTokenStoreTx) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async lockConnection(): Promise<WhoopConnectionSnapshot | null> {
    return this.row;
  }
  async saveTokens(id: string, tokens: { access_token: string; refresh_token: string; expires_at: Date }): Promise<void> {
    this.saved.push({ id, tokens });
    if (this.row) this.row = { ...this.row, ...tokens, status: 'active' };
  }
  async markError(id: string): Promise<void> {
    this.errored.push(id);
    if (this.row) this.row = { ...this.row, status: 'error' };
  }
}

test('withValidToken reuses the stored access token when far from expiry', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not be called — token is not near expiry');
  });

  const store = new FakeTokenStore({
    id: 'conn-1',
    access_token: 'still-valid',
    refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 60 * 60_000),
    status: 'active',
  });

  const result = await withValidToken({ id: 'conn-1', store }, async (accessToken) => {
    assert.equal(accessToken, 'still-valid');
    return 'fn-result';
  });

  assert.equal(result, 'fn-result');
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(store.saved.length, 0);
});

test('withValidToken refreshes near-expiry tokens and saves the rotated pair before calling fn', async (t) => {
  process.env.WHOOP_CLIENT_ID = 'client-1';
  process.env.WHOOP_CLIENT_SECRET = 'secret-1';
  process.env.WHOOP_REDIRECT_URI = 'https://vital.example/api/whoop/callback';

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    scope: 'offline',
    token_type: 'bearer',
  }));

  const store = new FakeTokenStore({
    id: 'conn-1',
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: new Date(Date.now() + 30_000), // inside the refresh margin
    status: 'active',
  });

  const usedToken = await withValidToken({ id: 'conn-1', store }, async (accessToken) => accessToken);

  assert.equal(usedToken, 'new-access');
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].tokens.access_token, 'new-access');
  assert.equal(store.saved[0].tokens.refresh_token, 'new-refresh');
  assert.equal(store.errored.length, 0);
});

test('withValidToken marks the connection status=error on invalid_grant and never calls fn', async (t) => {
  process.env.WHOOP_CLIENT_ID = 'client-1';
  process.env.WHOOP_CLIENT_SECRET = 'secret-1';
  process.env.WHOOP_REDIRECT_URI = 'https://vital.example/api/whoop/callback';

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(400, { error: 'invalid_grant' }));

  const store = new FakeTokenStore({
    id: 'conn-1',
    access_token: 'old-access',
    refresh_token: 'already-used-refresh',
    expires_at: new Date(Date.now() + 1000),
    status: 'active',
  });

  let fnCalled = false;
  await assert.rejects(
    () => withValidToken({ id: 'conn-1', store }, async () => { fnCalled = true; return null; }),
    WhoopTokenError,
  );

  assert.equal(fnCalled, false);
  assert.deepEqual(store.errored, ['conn-1']);
  assert.equal(store.saved.length, 0);
});

test('withValidToken rejects a non-active connection without attempting a refresh', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not be called — connection is not active');
  });

  const store = new FakeTokenStore({
    id: 'conn-1',
    access_token: 'old-access',
    refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 1000), // near expiry — would trigger a refresh if active
    status: 'error',
  });

  await assert.rejects(
    () => withValidToken({ id: 'conn-1', store }, async () => 'unreachable'),
    WhoopConnectionInactiveError,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

// ─── createWhoopTokenStore (Drizzle plumbing) ────────────────────────────────

test('createWhoopTokenStore locks the row with SELECT ... FOR UPDATE and updates on saveTokens/markError', async () => {
  const selectCalls: Array<{ table: unknown }> = [];
  const updateCalls: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const row: WhoopConnectionSnapshot = {
    id: 'conn-1',
    access_token: 'a',
    refresh_token: 'r',
    expires_at: new Date('2026-07-19T00:00:00.000Z'),
    status: 'active',
  };

  const fakeTx = {
    select: () => ({
      from: (table: unknown) => {
        selectCalls.push({ table });
        return {
          where: () => ({
            for: async (mode: string) => {
              assert.equal(mode, 'update');
              return [row];
            },
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        return { where: async () => {} };
      },
    }),
  };
  const fakeDb = { transaction: async <T>(fn: (tx: typeof fakeTx) => Promise<T>) => fn(fakeTx) };

  const store = createWhoopTokenStore(fakeDb, schema);

  const locked = await store.transaction(async (tx) => tx.lockConnection('conn-1'));
  assert.deepEqual(locked, row);
  assert.equal(selectCalls[0].table, schema.whoop_connections);

  await store.transaction(async (tx) => tx.saveTokens('conn-1', {
    access_token: 'new-a', refresh_token: 'new-r', expires_at: new Date('2026-07-20T00:00:00.000Z'),
  }));
  assert.equal(updateCalls[0].table, schema.whoop_connections);
  assert.equal(updateCalls[0].set.access_token, 'new-a');
  assert.equal(updateCalls[0].set.status, 'active');

  await store.transaction(async (tx) => tx.markError('conn-1'));
  assert.equal(updateCalls[1].set.status, 'error');
});
