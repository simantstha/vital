import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Drives the real POST handler with `fetch` mocked (no real ElevenLabs
 * network call) — same `t.mock.method(globalThis, 'fetch', ...)` approach as
 * lib/nutrition/usda.test.ts. Covers auth, body validation, the missing-key
 * 503, upstream failure/error-status/bad-JSON → 502, and the success path,
 * so the logging added alongside those paths (see app/api/stt/route.ts) has
 * a real caller exercising each branch — not asserting on log output
 * itself, just that the existing response contract is unchanged.
 */

function request(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/stt', {
    method: 'POST',
    headers,
    body,
  });
}

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([1, 2, 3])));
  assert.equal(res.status, 401);
});

test('POST 400s on an empty body', async () => {
  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([]), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 400);
});

test('POST 413s on a body over 10 MB', async () => {
  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array(10 * 1024 * 1024 + 1), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 413);
});

test('POST 503s when ELEVENLABS_API_KEY is not configured', async (t) => {
  const original = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (original !== undefined) process.env.ELEVENLABS_API_KEY = original;
  });

  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([1, 2, 3]), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 503);
});

test('POST 502s when the ElevenLabs request throws', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });

  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([1, 2, 3]), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 502);
});

test('POST 502s when ElevenLabs returns a non-OK status', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 400,
    text: async () => 'bad audio',
  } as Response));

  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([1, 2, 3]), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 502);
});

test('POST 502s when ElevenLabs returns invalid JSON', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('not json'); },
  } as unknown as Response));

  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([1, 2, 3]), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 502);
});

test('POST 200s with the transcript on a successful upstream call', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ text: 'it was good but my calves were tight' }),
  } as Response));

  const { POST } = await import('./route');
  const res = await POST(request(new Uint8Array([1, 2, 3]), { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json() as { text: string };
  assert.equal(body.text, 'it was good but my calves were tight');
});
