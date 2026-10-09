import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test, { mock, type TestContext } from 'node:test';

/**
 * Drives DELETE /api/account with the DB-deletion layer faked (no Postgres,
 * no filesystem) and Apple's endpoints faked via a mocked global fetch (no
 * network). mock.module() must run before the route's first import;
 * node:test isolates each test file in its own subprocess.
 *
 * Focus: Sign in with Apple revocation is best-effort — data deletion must
 * succeed (200) whether the body is empty/garbage, the APPLE_* secrets are
 * missing, or Apple rejects/hangs.
 */

const state: {
  deleteCalls: string[];
  deleteBehavior: 'ok' | 'fail';
  memoryDirCalls: string[];
  /** Ordered log of side effects ('delete', 'apple') to assert sequencing. */
  events: string[];
} = {
  deleteCalls: [],
  deleteBehavior: 'ok',
  memoryDirCalls: [],
  events: [],
};

mock.module('@/db', { namedExports: { db: {} } });
mock.module('@/lib/accountDeletion', {
  namedExports: {
    deleteUserData: async (_db: unknown, userId: string) => {
      state.deleteCalls.push(userId);
      state.events.push('delete');
      if (state.deleteBehavior === 'fail') throw new Error('boom');
    },
    removeLegacyMemoryDir: (userId: string) => {
      state.memoryDirCalls.push(userId);
    },
  },
});

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ORIGINAL_ENV = { ...process.env };

function setAppleEnv() {
  process.env.APPLE_TEAM_ID = 'TEAM123456';
  process.env.APPLE_KEY_ID = 'KEY1234567';
  process.env.APPLE_CLIENT_ID = 'com.example.vital';
  process.env.APPLE_PRIVATE_KEY = PRIVATE_PEM;
}

function clearAppleEnv() {
  for (const k of ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_CLIENT_ID', 'APPLE_BUNDLE_ID', 'APPLE_PRIVATE_KEY']) {
    delete process.env[k];
  }
}

function deleteRequest(body?: BodyInit | null, headers: Record<string, string> = { 'x-user-id': 'user-1' }) {
  return new Request('http://local/api/account', {
    method: 'DELETE',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body,
  });
}

const withCode = (code: unknown = 'apple-code') => JSON.stringify({ appleAuthorizationCode: code });

type FetchCall = { url: string; form: URLSearchParams };

/** Mocks global fetch; `routes` maps a URL substring to its response factory. */
function mockAppleFetch(
  t: TestContext,
  routes: Record<string, () => Response | Promise<Response>>
) {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, form: new URLSearchParams(String(init?.body ?? '')) });
    for (const [needle, handler] of Object.entries(routes)) {
      if (u.includes(needle)) return handler();
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  return calls;
}

test.beforeEach((hookCtx) => {
  const t = hookCtx as TestContext;
  state.deleteCalls = [];
  state.memoryDirCalls = [];
  state.events = [];
  state.deleteBehavior = 'ok';
  clearAppleEnv();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
});

test.after(() => {
  process.env = ORIGINAL_ENV;
});

test('401s without the middleware user header and deletes nothing', async () => {
  const { DELETE } = await import('./route');
  const res = await DELETE(deleteRequest(undefined, {}));
  assert.equal(res.status, 401);
  assert.deepEqual(state.deleteCalls, []);
});

test('empty body: deletes the account and reports revocation skipped', async (t) => {
  setAppleEnv();
  const calls = mockAppleFetch(t, {});
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest());

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, appleRevocation: 'skipped' });
  assert.deepEqual(state.deleteCalls, ['user-1']);
  assert.deepEqual(state.memoryDirCalls, ['user-1']);
  assert.equal(calls.length, 0, 'no Apple traffic without an authorization code');
});

test('malformed or wrongly-typed body never blocks deletion', async (t) => {
  setAppleEnv();
  const calls = mockAppleFetch(t, {});
  const { DELETE } = await import('./route');

  for (const body of ['{not json', 'null', '[]', JSON.stringify({ appleAuthorizationCode: 42 }), withCode('   ')]) {
    state.deleteCalls = [];
    const res = await DELETE(deleteRequest(body));
    assert.equal(res.status, 200, body);
    assert.equal((await res.json()).appleRevocation, 'skipped', body);
    assert.deepEqual(state.deleteCalls, ['user-1'], body);
  }
  assert.equal(calls.length, 0);
});

test('code + configured secrets: revokes at Apple and reports revoked', async (t) => {
  setAppleEnv();
  const calls = mockAppleFetch(t, {
    '/auth/token': () => new Response(JSON.stringify({ refresh_token: 'rt-1' }), { status: 200 }),
    '/auth/revoke': () => new Response('', { status: 200 }),
  });
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest(withCode('apple-code')));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, appleRevocation: 'revoked' });
  assert.deepEqual(state.deleteCalls, ['user-1']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].form.get('code'), 'apple-code');
  assert.equal(calls[1].form.get('token'), 'rt-1');
});

test('data is deleted BEFORE Apple is contacted', async (t) => {
  setAppleEnv();
  t.mock.method(globalThis, 'fetch', async () => {
    state.events.push('apple');
    return new Response(JSON.stringify({ refresh_token: 'rt' }), { status: 200 });
  });
  const { DELETE } = await import('./route');

  await DELETE(deleteRequest(withCode()));

  assert.deepEqual(state.events, ['delete', 'apple', 'apple']);
});

test('Apple token endpoint rejecting the code still deletes (200, failed)', async (t) => {
  setAppleEnv();
  mockAppleFetch(t, {
    '/auth/token': () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
  });
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest(withCode()));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, appleRevocation: 'failed' });
  assert.deepEqual(state.deleteCalls, ['user-1']);
});

test('Apple revoke endpoint failing still deletes (200, failed)', async (t) => {
  setAppleEnv();
  mockAppleFetch(t, {
    '/auth/token': () => new Response(JSON.stringify({ refresh_token: 'rt' }), { status: 200 }),
    '/auth/revoke': () => new Response('oops', { status: 500 }),
  });
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest(withCode()));

  assert.equal(res.status, 200);
  assert.equal((await res.json()).appleRevocation, 'failed');
});

test('Apple network error still deletes (200, failed)', async (t) => {
  setAppleEnv();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest(withCode()));

  assert.equal(res.status, 200);
  assert.equal((await res.json()).appleRevocation, 'failed');
  assert.deepEqual(state.deleteCalls, ['user-1']);
});

test('missing APPLE_* secrets: deletes, skips revocation, makes no Apple calls', async (t) => {
  clearAppleEnv();
  const calls = mockAppleFetch(t, {});
  const warn = t.mock.method(console, 'warn', () => {});
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest(withCode()));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, appleRevocation: 'skipped' });
  assert.deepEqual(state.deleteCalls, ['user-1']);
  assert.equal(calls.length, 0);
  assert.match(String(warn.mock.calls[0].arguments[0]), /APPLE_\* secrets not configured/);
});

test('a failing DB deletion returns 500 and never contacts Apple', async (t) => {
  setAppleEnv();
  state.deleteBehavior = 'fail';
  const calls = mockAppleFetch(t, {});
  const { DELETE } = await import('./route');

  const res = await DELETE(deleteRequest(withCode()));

  assert.equal(res.status, 500);
  assert.equal(calls.length, 0, 'tokens must not be revoked for an account that still exists');
});
