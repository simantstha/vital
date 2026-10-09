import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import {
  APPLE_AUDIENCE,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  MAX_CLIENT_SECRET_TTL_SECONDS,
  buildAppleClientSecret,
  loadAppleRevocationConfig,
  revokeAppleTokens,
  type AppleIdTokenVerifier,
  type AppleRevocationConfig,
} from './appleRevocation';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const CONFIG: AppleRevocationConfig = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  clientId: 'com.example.vital',
  privateKeyPem: PRIVATE_PEM,
};

const NOW = new Date('2026-10-01T12:00:00Z');

/** The deleted account's users.apple_sub. */
const SUB = 'apple-sub-123';

/** Stand-in for lib/auth.ts verifyAppleIdentityToken: accepts any id_token for SUB. */
const okVerifier: AppleIdTokenVerifier = async () => ({ sub: SUB });

/** revokeAppleTokens with the matching-account defaults; tests override what they exercise. */
const revoke = (
  params: Partial<Parameters<typeof revokeAppleTokens>[0]> &
    Pick<Parameters<typeof revokeAppleTokens>[0], 'authorizationCode' | 'config'>
) => revokeAppleTokens({ expectedAppleSub: SUB, verifyIdToken: okVerifier, ...params });

type Call = { url: string; form: URLSearchParams };

/** Records every call; `handlers` are consumed in order, one per fetch. */
function fakeFetch(handlers: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init.body)) });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return handler();
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test.beforeEach((hookCtx) => {
  // Silence the expected warn/error logs; individual tests can still assert.
  const t = hookCtx as TestContext;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
});

// --- client secret -----------------------------------------------------------

test('buildAppleClientSecret produces an ES256 JWT with Apple claims and kid header', async () => {
  const secret = await buildAppleClientSecret({ ...CONFIG, now: NOW });

  const header = decodeProtectedHeader(secret);
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, CONFIG.keyId);

  // Signature verifies against the matching public key (also checks aud/iss/sub).
  const { payload } = await jwtVerify(secret, await importSPKI(PUBLIC_PEM, 'ES256'), {
    issuer: CONFIG.teamId,
    audience: APPLE_AUDIENCE,
    subject: CONFIG.clientId,
    currentDate: NOW,
  });

  const iat = Math.floor(NOW.getTime() / 1000);
  assert.equal(payload.iss, CONFIG.teamId);
  assert.equal(payload.sub, CONFIG.clientId);
  assert.equal(payload.aud, 'https://appleid.apple.com');
  assert.equal(payload.iat, iat);
  assert.ok(typeof payload.exp === 'number' && payload.exp > iat);
  assert.ok(payload.exp - iat <= MAX_CLIENT_SECRET_TTL_SECONDS, 'exp must be within 6 months of iat');
});

test('buildAppleClientSecret clamps an over-long ttl to Apple\'s 6-month maximum', async () => {
  const secret = await buildAppleClientSecret({
    ...CONFIG,
    now: NOW,
    ttlSeconds: MAX_CLIENT_SECRET_TTL_SECONDS * 10,
  });
  const { iat, exp } = decodeJwt(secret);
  assert.equal(exp! - iat!, MAX_CLIENT_SECRET_TTL_SECONDS);
});

test('buildAppleClientSecret accepts a PEM with literal "\\n" escapes (Fly secret style)', async () => {
  const escaped = PRIVATE_PEM.trim().replace(/\n/g, '\\n');
  const secret = await buildAppleClientSecret({ ...CONFIG, privateKeyPem: escaped, now: NOW });
  await jwtVerify(secret, await importSPKI(PUBLIC_PEM, 'ES256'), { currentDate: NOW });
});

test('buildAppleClientSecret rejects a garbage private key', async () => {
  await assert.rejects(buildAppleClientSecret({ ...CONFIG, privateKeyPem: 'not a pem', now: NOW }));
});

// --- config ------------------------------------------------------------------

test('loadAppleRevocationConfig reads the APPLE_* env and unescapes the key', () => {
  const config = loadAppleRevocationConfig({
    APPLE_TEAM_ID: 'T',
    APPLE_KEY_ID: 'K',
    APPLE_CLIENT_ID: 'com.example.vital',
    APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  });
  assert.deepEqual(config, {
    teamId: 'T',
    keyId: 'K',
    clientId: 'com.example.vital',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  });
});

test('loadAppleRevocationConfig falls back to APPLE_BUNDLE_ID for the client id', () => {
  const config = loadAppleRevocationConfig({
    APPLE_TEAM_ID: 'T',
    APPLE_KEY_ID: 'K',
    APPLE_BUNDLE_ID: 'com.example.bundle',
    APPLE_PRIVATE_KEY: 'pem',
  });
  assert.equal(config?.clientId, 'com.example.bundle');
});

test('loadAppleRevocationConfig returns null when any value is missing', () => {
  const full = {
    APPLE_TEAM_ID: 'T',
    APPLE_KEY_ID: 'K',
    APPLE_CLIENT_ID: 'c',
    APPLE_PRIVATE_KEY: 'pem',
  };
  assert.ok(loadAppleRevocationConfig(full));
  for (const key of Object.keys(full)) {
    assert.equal(loadAppleRevocationConfig({ ...full, [key]: undefined }), null, key);
    assert.equal(loadAppleRevocationConfig({ ...full, [key]: '  ' }), null, `${key} blank`);
  }
});

// --- revoke flow -------------------------------------------------------------

test('revokeAppleTokens exchanges the code, then revokes the refresh token', async () => {
  const { calls, fetchImpl } = fakeFetch([
    () => json({ access_token: 'at-1', refresh_token: 'rt-1', id_token: 'x' }),
    () => new Response('', { status: 200 }),
  ]);

  const result = await revoke({ authorizationCode: 'code-abc', config: CONFIG, fetchImpl });

  assert.deepEqual(result, { status: 'revoked' });
  assert.equal(calls.length, 2);

  assert.equal(calls[0].url, APPLE_TOKEN_URL);
  assert.equal(calls[0].form.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].form.get('code'), 'code-abc');
  assert.equal(calls[0].form.get('client_id'), CONFIG.clientId);
  const secret = calls[0].form.get('client_secret')!;
  assert.equal(decodeProtectedHeader(secret).kid, CONFIG.keyId);
  assert.equal(decodeJwt(secret).iss, CONFIG.teamId);

  assert.equal(calls[1].url, APPLE_REVOKE_URL);
  assert.equal(calls[1].form.get('token'), 'rt-1');
  assert.equal(calls[1].form.get('token_type_hint'), 'refresh_token');
  assert.equal(calls[1].form.get('client_id'), CONFIG.clientId);
  assert.ok(calls[1].form.get('client_secret'));
});

test('revokeAppleTokens falls back to the access token when no refresh token is returned', async () => {
  const { calls, fetchImpl } = fakeFetch([
    () => json({ access_token: 'at-only', id_token: 'idt' }),
    () => new Response('', { status: 200 }),
  ]);

  const result = await revoke({ authorizationCode: 'code', config: CONFIG, fetchImpl });

  assert.equal(result.status, 'revoked');
  assert.equal(calls[1].form.get('token'), 'at-only');
  assert.equal(calls[1].form.get('token_type_hint'), 'access_token');
});

test('revokeAppleTokens reports failed (and never revokes) when the token endpoint errors', async () => {
  const { calls, fetchImpl } = fakeFetch([() => json({ error: 'invalid_grant' }, 400)]);

  const result = await revoke({ authorizationCode: 'used-code', config: CONFIG, fetchImpl });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'token-http-400:invalid_grant');
  assert.equal(calls.length, 1, 'must not call /auth/revoke without a token');
});

test('revokeAppleTokens reports failed when the token response has no usable token', async () => {
  const { fetchImpl } = fakeFetch([() => json({ token_type: 'Bearer' })]);
  const result = await revoke({ authorizationCode: 'code', config: CONFIG, fetchImpl });
  assert.deepEqual(result, { status: 'failed', reason: 'token-missing' });
});

test('revokeAppleTokens reports failed when the revoke endpoint errors', async () => {
  const { calls, fetchImpl } = fakeFetch([
    () => json({ refresh_token: 'rt', id_token: 'idt' }),
    () => json({ error: 'invalid_client' }, 401),
  ]);

  const result = await revoke({ authorizationCode: 'code', config: CONFIG, fetchImpl });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'revoke-http-401:invalid_client');
  assert.equal(calls.length, 2);
});

test('revokeAppleTokens reports failed (not throws) when fetch rejects', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const result = await revoke({ authorizationCode: 'code', config: CONFIG, fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /^token-network-error/);
});

test('revokeAppleTokens reports failed (not throws) when the private key is unusable', async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  const result = await revoke({
    authorizationCode: 'code',
    config: { ...CONFIG, privateKeyPem: 'garbage' },
    fetchImpl,
  });
  assert.deepEqual(result, { status: 'failed', reason: 'client-secret-error' });
  assert.equal(calls.length, 0);
});

test('revokeAppleTokens times out a hung Apple endpoint and reports failed', async () => {
  const fetchImpl = () => new Promise<Response>(() => {}); // never settles, ignores signal

  const started = Date.now();
  const result = await revoke({
    authorizationCode: 'code',
    config: CONFIG,
    fetchImpl,
    timeoutMs: 30,
  });

  assert.deepEqual(result, { status: 'failed', reason: 'timeout' });
  assert.ok(Date.now() - started < 2000);
});

test('revokeAppleTokens does not start /auth/revoke after the deadline has passed', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    // Token endpoint answers only after the 20ms deadline (ignoring the signal).
    await new Promise((r) => setTimeout(r, 60));
    return json({ refresh_token: 'rt', id_token: 'idt' });
  };
  const result = await revoke({
    authorizationCode: 'code',
    config: CONFIG,
    fetchImpl,
    timeoutMs: 20,
  });
  assert.equal(result.reason, 'timeout');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(calls, [APPLE_TOKEN_URL]);
});

test('revokeAppleTokens skips (with a warning, no network) when config is missing', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { calls, fetchImpl } = fakeFetch([]);

  const result = await revoke({ authorizationCode: 'code', config: null, fetchImpl });

  assert.deepEqual(result, { status: 'skipped', reason: 'not-configured' });
  assert.equal(calls.length, 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /SIWA revocation skipped: APPLE_\* secrets not configured/);
});

test('revokeAppleTokens skips when there is no authorization code', async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  for (const authorizationCode of [undefined, null, '', '   ']) {
    const result = await revoke({ authorizationCode, config: CONFIG, fetchImpl });
    assert.deepEqual(result, { status: 'skipped', reason: 'no-authorization-code' });
  }
  assert.equal(calls.length, 0);
});

test('revokeAppleTokens never logs the code, tokens, or client secret', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const warns = t.mock.method(console, 'warn', () => {});
  const { fetchImpl } = fakeFetch([
    () => json({ refresh_token: 'rt-SECRET', id_token: 'idt' }),
    () => json({ error: 'invalid_client' }, 401),
  ]);
  await revoke({ authorizationCode: 'code-SECRET', config: CONFIG, fetchImpl });
  const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls].map((c) => c.arguments));
  assert.ok(!logged.includes('code-SECRET'));
  assert.ok(!logged.includes('rt-SECRET'));
  assert.ok(!logged.includes('PRIVATE KEY'));
});

// --- wrong-account guard -----------------------------------------------------

test('revokeAppleTokens verifies the id_token against the client id and revokes when sub matches', async () => {
  const seen: Array<{ idToken: string; audience: string }> = [];
  const verifyIdToken: AppleIdTokenVerifier = async (idToken, audience) => {
    seen.push({ idToken, audience });
    return { sub: SUB };
  };
  const { calls, fetchImpl } = fakeFetch([
    () => json({ refresh_token: 'rt', id_token: 'the-id-token' }),
    () => new Response('', { status: 200 }),
  ]);

  const result = await revoke({ authorizationCode: 'code', config: CONFIG, fetchImpl, verifyIdToken });

  assert.deepEqual(result, { status: 'revoked' });
  assert.deepEqual(seen, [{ idToken: 'the-id-token', audience: CONFIG.clientId }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, APPLE_REVOKE_URL);
});

test('revokeAppleTokens does NOT revoke when the id_token sub is a different Apple ID', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { calls, fetchImpl } = fakeFetch([
    () => json({ refresh_token: 'rt-OTHER', id_token: 'idt-OTHER' }),
    () => new Response('', { status: 200 }),
  ]);

  const result = await revoke({
    authorizationCode: 'code',
    config: CONFIG,
    fetchImpl,
    verifyIdToken: async () => ({ sub: 'someone-elses-sub' }),
  });

  assert.deepEqual(result, { status: 'failed', reason: 'sub-mismatch' });
  assert.equal(calls.length, 1, '/auth/revoke must never be called');
  assert.ok(calls.every((c) => c.url !== APPLE_REVOKE_URL));
  const logged = JSON.stringify(errors.mock.calls.map((c) => c.arguments));
  for (const secret of ['rt-OTHER', 'idt-OTHER', 'someone-elses-sub', SUB]) {
    assert.ok(!logged.includes(secret), `log must not contain ${secret}`);
  }
});

test('revokeAppleTokens does NOT revoke when the token response has no id_token', async () => {
  const { calls, fetchImpl } = fakeFetch([
    () => json({ refresh_token: 'rt' }),
    () => new Response('', { status: 200 }),
  ]);
  let verifierCalled = false;

  const result = await revoke({
    authorizationCode: 'code',
    config: CONFIG,
    fetchImpl,
    verifyIdToken: async () => {
      verifierCalled = true;
      return { sub: SUB };
    },
  });

  assert.deepEqual(result, { status: 'failed', reason: 'id-token-invalid' });
  assert.equal(verifierCalled, false);
  assert.equal(calls.length, 1, '/auth/revoke must never be called');
});

test('revokeAppleTokens does NOT revoke when the id_token fails verification', async () => {
  const { calls, fetchImpl } = fakeFetch([
    () => json({ refresh_token: 'rt', id_token: 'forged' }),
    () => new Response('', { status: 200 }),
  ]);

  const result = await revoke({
    authorizationCode: 'code',
    config: CONFIG,
    fetchImpl,
    verifyIdToken: async () => {
      throw new Error('signature verification failed');
    },
  });

  assert.deepEqual(result, { status: 'failed', reason: 'id-token-invalid' });
  assert.equal(calls.length, 1, '/auth/revoke must never be called');
});

test('revokeAppleTokens skips a user with no apple_sub (dev account) without touching Apple', async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  for (const expectedAppleSub of [null, undefined, '']) {
    const result = await revoke({ authorizationCode: 'code', config: CONFIG, fetchImpl, expectedAppleSub });
    assert.deepEqual(result, { status: 'skipped', reason: 'not-apple-user' });
  }
  assert.equal(calls.length, 0);
});
