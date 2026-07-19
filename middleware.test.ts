import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

/**
 * Proves the WHOOP OAuth-callback and webhook routes are excluded from the
 * session-JWT gate (both are unauthenticated-by-design — see middleware.ts's
 * doc comment) while a neighboring /api/whoop/* route (status) still
 * requires a Bearer token, so the exclusion is scoped to exactly those two
 * paths rather than the whole /api/whoop/* prefix.
 */

process.env.SESSION_JWT_SECRET = 'test-session-secret-at-least-32-bytes-long';

test('middleware lets /api/whoop/callback through without an Authorization header', async () => {
  const req = new NextRequest('http://local/api/whoop/callback?code=abc&state=xyz');
  const res = await middleware(req);
  assert.equal(res.status, 200); // NextResponse.next() defaults to 200 (not a 401/503)
});

test('middleware lets /api/whoop/webhook through without an Authorization header', async () => {
  const req = new NextRequest('http://local/api/whoop/webhook', { method: 'POST' });
  const res = await middleware(req);
  assert.equal(res.status, 200);
});

test('middleware still 401s /api/whoop/status without an Authorization header', async () => {
  const req = new NextRequest('http://local/api/whoop/status');
  const res = await middleware(req);
  assert.equal(res.status, 401);
});
