import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { EstimateResult } from '@/lib/nutrition/estimator';

/**
 * Drives the real POST handler against a fake `@/lib/nutrition/estimator`
 * (no network, no sharp-decoded real image, no DB). mock.module() must run
 * before ./route is first imported; node:test isolates each test file in
 * its own subprocess.
 *
 * `sharp` itself is real — normalizeImage still runs — so a 1x1 PNG fixture
 * is used as the "photo" (small, fast to decode, exercises the real resize/
 * JPEG-reencode path without a network fetch).
 */

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const state: { estimateResult: EstimateResult; throwError: Error | null } = {
  estimateResult: { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] },
  throwError: null,
};

let estimateMealCalls: Array<{ userId: string; hasImage: boolean }> = [];

mock.module('@/lib/nutrition/estimator', {
  namedExports: {
    estimateMeal: async (input: { userId: string; imageB64?: string }) => {
      estimateMealCalls.push({ userId: input.userId, hasImage: !!input.imageB64 });
      if (state.throwError) throw state.throwError;
      return state.estimateResult;
    },
  },
});

const routePromise = import('./route');

function req(body: unknown, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request('http://localhost/api/nutrition/photo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST returns 401 with no x-user-id header (estimator never called)', async () => {
  estimateMealCalls = [];
  const { POST } = await routePromise;
  const res = await POST(req({ imageBase64: TINY_PNG_B64 }, {}));
  assert.equal(res.status, 401);
  assert.equal(estimateMealCalls.length, 0);
});

test('POST returns 400 for missing/empty imageBase64', async () => {
  const { POST } = await routePromise;
  const res1 = await POST(req({}));
  assert.equal(res1.status, 400);

  const res2 = await POST(req({ imageBase64: '   ' }));
  assert.equal(res2.status, 400);
});

test('POST returns 400 for unparsable image data', async () => {
  const { POST } = await routePromise;
  const res = await POST(req({ imageBase64: 'not-actually-an-image' }));
  assert.equal(res.status, 400);
});

test('POST strips a data-URL prefix, calls estimateMeal with the authenticated userId, and returns the grounded shape', async () => {
  estimateMealCalls = [];
  state.estimateResult = {
    name: 'grilled chicken breast, white rice, cooked',
    kcal: 543, c: 44, p: 51, f: 15,
    items: [
      { food: 'grilled chicken breast', grams: 200, kcal: 330, c: 0, p: 47, f: 15, source: 'usda', confidence: 'high', portionNote: '~200g' },
      { food: 'white rice, cooked', grams: 150, kcal: 213, c: 44, p: 4, f: 0, source: 'usda', confidence: 'med', portionNote: '~1 cup' },
    ],
  };

  const { POST } = await routePromise;
  const res = await POST(req({ imageBase64: `data:image/png;base64,${TINY_PNG_B64}` }, { 'x-user-id': 'user-42' }));
  assert.equal(res.status, 200);

  assert.equal(estimateMealCalls.length, 1);
  assert.equal(estimateMealCalls[0].userId, 'user-42');
  assert.equal(estimateMealCalls[0].hasImage, true);

  const body = await res.json();
  assert.equal(body.name, 'grilled chicken breast, white rice, cooked');
  assert.equal(body.kcal, 543);
  // Response items must keep the pre-v2 { name, qty, unit, kcal } shape the
  // iOS NutritionResult/RecentFood-style decoders already expect.
  assert.deepEqual(body.items, [
    { name: 'grilled chicken breast', qty: 200, unit: 'g', kcal: 330 },
    { name: 'white rice, cooked', qty: 150, unit: 'g', kcal: 213 },
  ]);
  // Additive — the full grounded breakdown, ignored by older clients.
  assert.deepEqual(body.estimatorItems, state.estimateResult.items);
});

test('POST returns 422 when the estimator finds no food in the photo', async () => {
  state.estimateResult = { name: '', kcal: 0, c: 0, p: 0, f: 0, items: [] };

  const { POST } = await routePromise;
  const res = await POST(req({ imageBase64: TINY_PNG_B64 }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /Could not identify food/);
});

test('POST returns 502 when estimateMeal throws', async () => {
  state.throwError = new Error('upstream boom');
  try {
    const { POST } = await routePromise;
    const res = await POST(req({ imageBase64: TINY_PNG_B64 }));
    assert.equal(res.status, 502);
  } finally {
    state.throwError = null;
  }
});
