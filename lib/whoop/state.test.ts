import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT } from 'jose';
import { getSessionSecret } from '../auth';
import { signWhoopOAuthState, verifyWhoopOAuthState } from './state';

process.env.SESSION_JWT_SECRET = 'test-session-secret-at-least-32-bytes-long';

test('signWhoopOAuthState round-trips through verifyWhoopOAuthState with the user id', async () => {
  const token = await signWhoopOAuthState('user-123');
  const { userId } = await verifyWhoopOAuthState(token);
  assert.equal(userId, 'user-123');
});

test('two signed states for the same user carry different nonces (different tokens)', async () => {
  const a = await signWhoopOAuthState('user-123');
  const b = await signWhoopOAuthState('user-123');
  assert.notEqual(a, b);
});

test('verifyWhoopOAuthState rejects a token signed with a different secret', async () => {
  const wrongSecretToken = await new SignJWT({ nonce: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode('a-completely-different-secret-value'));

  await assert.rejects(() => verifyWhoopOAuthState(wrongSecretToken));
});

test('verifyWhoopOAuthState rejects an expired token', async () => {
  const expired = await new SignJWT({ nonce: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
    .sign(getSessionSecret());

  await assert.rejects(() => verifyWhoopOAuthState(expired));
});

test('verifyWhoopOAuthState rejects a token missing the sub claim', async () => {
  const noSub = await new SignJWT({ nonce: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSessionSecret());

  await assert.rejects(() => verifyWhoopOAuthState(noSub));
});
