import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWhoopOAuthState } from '../../../../lib/whoop/state';
import { GET } from './route';

process.env.SESSION_JWT_SECRET = 'test-session-secret-at-least-32-bytes-long';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/whoop/connect', { headers });
}

test('GET 401s without an x-user-id header', async () => {
  const res = await GET(request());
  assert.equal(res.status, 401);
});

test('GET 500s when WHOOP_CLIENT_ID/WHOOP_REDIRECT_URI are not configured', async () => {
  const savedId = process.env.WHOOP_CLIENT_ID;
  const savedUri = process.env.WHOOP_REDIRECT_URI;
  delete process.env.WHOOP_CLIENT_ID;
  delete process.env.WHOOP_REDIRECT_URI;
  try {
    const res = await GET(request({ 'x-user-id': 'user-1' }));
    assert.equal(res.status, 500);
  } finally {
    if (savedId !== undefined) process.env.WHOOP_CLIENT_ID = savedId;
    if (savedUri !== undefined) process.env.WHOOP_REDIRECT_URI = savedUri;
  }
});

test('GET 302s to the WHOOP authorize URL with client_id, redirect_uri, scopes, and a verifiable state', async () => {
  process.env.WHOOP_CLIENT_ID = 'client-1';
  process.env.WHOOP_REDIRECT_URI = 'https://vital.example/api/whoop/callback';

  const res = await GET(request({ 'x-user-id': 'user-1' }));

  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location);
  const url = new URL(location!);
  assert.equal(url.origin + url.pathname, 'https://api.prod.whoop.com/oauth/oauth2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://vital.example/api/whoop/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'read:recovery read:cycles read:sleep read:workout read:profile offline');

  const state = url.searchParams.get('state');
  assert.ok(state);
  const { userId } = await verifyWhoopOAuthState(state!);
  assert.equal(userId, 'user-1');
});
