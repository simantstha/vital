import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { Candidate } from '../../../../lib/nutrition/candidates';

/**
 * Drives the real POST handler against a mocked searchCandidates (no
 * Postgres/USDA/CalorieNinjas), covering auth, validation, the 502-on-empty
 * case, and the legacy-flat-fields-mirror-candidates[0] contract. Deep
 * merge/ranking logic lives in lib/nutrition/candidates.test.ts (pure); this
 * file just proves the route wires it together and preserves the legacy
 * response shape. mock.module() must run before the route's first import —
 * node:test isolates each test file in its own subprocess, so this lives on
 * its own.
 */
let lastCall: { userId: string; query: string } | null = null;
let mockResult: { candidates: Candidate[]; estimateFoods: unknown } = { candidates: [], estimateFoods: null };

mock.module('@/lib/nutrition/candidates', {
  namedExports: {
    searchCandidates: async (userId: string, query: string) => {
      lastCall = { userId, query };
      return mockResult;
    },
  },
});

const routePromise = import('./route');

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/nutrition/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST 400s on invalid JSON', async () => {
  const { POST } = await routePromise;
  const res = await POST(new Request('http://local/api/nutrition/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
    body: '{not json',
  }));
  assert.equal(res.status, 400);
});

test('POST 400s on missing/empty query', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({ query: '   ' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 400);
});

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await routePromise;
  const res = await POST(request({ query: 'chicken' }));
  assert.equal(res.status, 401);
});

test('POST 502s when searchCandidates finds no candidates', async () => {
  mockResult = { candidates: [], estimateFoods: null };
  const { POST } = await routePromise;
  const res = await POST(request({ query: 'zzzznotfood' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(typeof body.error === 'string');
});

test('POST 200s and mirrors candidates[0] into the legacy flat fields, items = estimateFoods', async () => {
  mockResult = {
    candidates: [
      { origin: 'history', name: 'Chicken Salad', kcal: 400, c: 20, p: 30, f: 15 },
      { origin: 'estimate', name: 'chicken', kcal: 300, c: 10, p: 20, f: 10 },
    ],
    estimateFoods: [{ name: 'chicken', qty: 100, unit: 'g', kcal: 300 }],
  };

  const { POST } = await routePromise;
  const res = await POST(request({ query: 'chicken' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.name, 'Chicken Salad');
  assert.equal(body.kcal, 400);
  assert.equal(body.c, 20);
  assert.equal(body.p, 30);
  assert.equal(body.f, 15);
  assert.deepEqual(body.items, mockResult.estimateFoods);
  assert.equal(body.candidates.length, 2);
  assert.equal(lastCall?.userId, 'user-1');
  assert.equal(lastCall?.query, 'chicken');
});

test('POST 200s with items: [] when estimateFoods is null', async () => {
  mockResult = {
    candidates: [{ origin: 'cache', name: 'Oatmeal', kcal: 150, c: 27, p: 5, f: 3 }],
    estimateFoods: null,
  };

  const { POST } = await routePromise;
  const res = await POST(request({ query: 'oatmeal' }, { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.items, []);
});
