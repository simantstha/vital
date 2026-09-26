import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * Drives GET /api/health/vendors with the Anthropic client (see
 * lib/brain/anthropicClient.ts) and global fetch both mocked — no real
 * network calls to Anthropic, ElevenLabs, CalorieNinjas or USDA. fetch is
 * routed by URL since lib/health/vendors.ts calls four different endpoints
 * through the same global fetch.
 *
 * Mirrors the pattern lib/brain/coach.test.ts and lib/nutrition/usda.test.ts
 * already use: `mock.module()` for the relative/aliased specifier, and
 * `t.mock.method(globalThis, 'fetch', ...)` for HTTP.
 */

let anthropicBehavior: 'ok' | 'fail' = 'ok';
const fakeAnthropicClient = {
  messages: {
    create: async () => {
      if (anthropicBehavior === 'fail') {
        const err = new Error('overloaded_error: upstream overloaded') as Error & { status?: number };
        err.status = 529;
        throw err;
      }
      return { id: 'msg_test', content: [{ type: 'text', text: 'ok' }] };
    },
  },
};
mock.module('@/lib/brain/anthropicClient', { namedExports: { client: fakeAnthropicClient } });

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env.HEALTHCHECK_TOKEN = 'test-healthcheck-token';
  process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
  process.env.CALORIENINJAS_API_KEY = 'test-calorieninjas-key';
  process.env.USDA_FDC_API_KEY = 'test-usda-key';
  anthropicBehavior = 'ok';
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/health/vendors', { headers });
}

function okJsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Routes a fetch mock by matching a substring of the URL. */
function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    for (const [needle, handler] of Object.entries(routes)) {
      if (u.includes(needle)) return handler();
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
}

test.beforeEach(() => {
  resetEnv();
});

test.after(() => {
  process.env = ORIGINAL_ENV;
});

test('GET 401s with a missing/wrong bearer token', async () => {
  const { GET } = await import('./route');

  const resMissing = await GET(request());
  assert.equal(resMissing.status, 401);

  const resWrong = await GET(request({ authorization: 'Bearer nope' }));
  assert.equal(resWrong.status, 401);
});

test('GET 503s "not_configured" when HEALTHCHECK_TOKEN is unset', async () => {
  delete process.env.HEALTHCHECK_TOKEN;
  const { GET } = await import('./route');

  const res = await GET(request({ authorization: 'Bearer anything' }));
  assert.equal(res.status, 503);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'not_configured');
});

test('GET 200s with ok:true when every vendor probe passes', async (t) => {
  t.mock.method(globalThis, 'fetch', routedFetch({
    'speech-to-text': () => okJsonResponse({ text: '' }),
    'text-to-speech': () => new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
    'calorieninjas.com': () => okJsonResponse({ items: [{ name: 'apple', calories: 95, serving_size_g: 182, fat_total_g: 0.3, protein_g: 0.5, carbohydrates_total_g: 25 }] }),
    'nal.usda.gov': () => okJsonResponse({ foods: [] }),
  }));

  const { GET } = await import('./route');
  const res = await GET(request({ authorization: 'Bearer test-healthcheck-token' }));

  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
  assert.equal(body.ok, true);
  assert.equal(body.checks.length, 6);
  for (const check of body.checks) assert.equal(check.ok, true, `expected ${check.name} to be ok`);
});

test('GET 503s with the failing check\'s detail when one vendor probe fails', async (t) => {
  t.mock.method(globalThis, 'fetch', routedFetch({
    'speech-to-text': () => okJsonResponse({ text: '' }),
    'text-to-speech': () => new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
    'calorieninjas.com': () => okJsonResponse({ items: [] }),
    'nal.usda.gov': () => new Response(JSON.stringify({ error: { message: 'invalid api_key' } }), { status: 403 }),
  }));

  const { GET } = await import('./route');
  const res = await GET(request({ authorization: 'Bearer test-healthcheck-token' }));

  assert.equal(res.status, 503);
  const body = await res.json() as { ok: boolean; checks: Array<{ name: string; ok: boolean; status: number | null; detail?: string }> };
  assert.equal(body.ok, false);

  const usda = body.checks.find(c => c.name === 'nutrition:usda');
  assert.ok(usda);
  assert.equal(usda!.ok, false);
  assert.equal(usda!.status, 403);
  assert.ok(usda!.detail?.includes('invalid api_key'));

  // Every other check still passed — one failure doesn't fail the others.
  const others = body.checks.filter(c => c.name !== 'nutrition:usda');
  for (const check of others) assert.equal(check.ok, true, `expected ${check.name} to be ok`);
});

test('GET treats a hung upstream as a failing "timeout" check rather than hanging forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('speech-to-text')) {
      // Never resolves on its own — only rejects when lib/health/vendors.ts's
      // own AbortController fires (its 8s setTimeout, advanced below via the
      // mocked clock), exactly like a real fetch would on that abort.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (u.includes('text-to-speech')) return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
    if (u.includes('calorieninjas.com')) return okJsonResponse({ items: [] });
    if (u.includes('nal.usda.gov')) return okJsonResponse({ foods: [] });
    throw new Error(`unexpected fetch to ${u}`);
  });

  const { GET } = await import('./route');
  const resultPromise = GET(request({ authorization: 'Bearer test-healthcheck-token' }));

  // Advance the mocked clock past the 8s probe timeout so runProbe's own
  // setTimeout fires controller.abort() without this test waiting 8 real
  // seconds. lib/health/vendors.ts reads its STT fixture synchronously
  // (readFileSync), so every probe's fetch() call is already registered by
  // the time GET()'s first await yields control back here.
  await t.mock.timers.tick(8000);

  const res = await resultPromise;
  assert.equal(res.status, 503);
  const body = await res.json() as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };
  const stt = body.checks.find(c => c.name === 'elevenlabs:stt');
  assert.ok(stt);
  assert.equal(stt!.ok, false);
  assert.equal(stt!.detail, 'timeout');
});

test('GET reports a failing Anthropic model check with its upstream detail', async (t) => {
  anthropicBehavior = 'fail';
  t.mock.method(globalThis, 'fetch', routedFetch({
    'speech-to-text': () => okJsonResponse({ text: '' }),
    'text-to-speech': () => new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
    'calorieninjas.com': () => okJsonResponse({ items: [] }),
    'nal.usda.gov': () => okJsonResponse({ foods: [] }),
  }));

  const { GET } = await import('./route');
  const res = await GET(request({ authorization: 'Bearer test-healthcheck-token' }));

  assert.equal(res.status, 503);
  const body = await res.json() as { ok: boolean; checks: Array<{ name: string; ok: boolean; status: number | null; detail?: string }> };
  const sonnet = body.checks.find(c => c.name.startsWith('anthropic:'));
  assert.ok(sonnet);
  assert.equal(sonnet!.ok, false);
  assert.equal(sonnet!.status, 529);
  assert.ok(sonnet!.detail?.includes('overloaded'));
});
