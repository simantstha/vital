import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real POST handler against a fake `@/db` (no Postgres) and
 * mocked lookupBarcode/searchByGtin (no network), covering auth, the
 * cache→OFF→USDA lookup order (stopping at the first hit with known kcal),
 * the food_cache upsert on an OFF/USDA hit, the legacy response shape
 * (null macros → 0, servingGrams/servingDesc null passthrough), and the 404
 * + offerTextSearch miss case. mock.module() must run before the route's
 * first import — node:test isolates each test file in its own subprocess,
 * so this lives on its own.
 */
let cacheRows: Partial<typeof realSchema.food_cache.$inferSelect>[] = [];
let insertedRows: Record<string, unknown>[] = [];
let offResult: { productName: string; brand?: string; per100g: { kcal: number; c: number; p: number; f: number } } | null = null;
let usdaResult: {
  fdcId: number; name: string; brand: string | null; dataType: 'Branded';
  barcode: string | null; servingGrams: number | null; servingDesc: string | null;
  per100g: { kcal: number | null; p: number | null; c: number | null; f: number | null };
} | null = null;
let offCalls = 0;
let usdaCalls = 0;

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => cacheRows,
        }),
      }),
    }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => { insertedRows.push(v); },
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/openFoodFacts', {
  namedExports: { lookupBarcode: async () => { offCalls += 1; return offResult; } },
});
mock.module('@/lib/nutrition/usda', {
  namedExports: { searchByGtin: async () => { usdaCalls += 1; return usdaResult; } },
});

const routePromise = import('./route');

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/nutrition/barcode', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function reset() {
  cacheRows = [];
  insertedRows = [];
  offResult = null;
  usdaResult = null;
  offCalls = 0;
  usdaCalls = 0;
}

test('POST 400s on missing barcode', async () => {
  reset();
  const { POST } = await routePromise;
  const res = await POST(request({}, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 400);
});

test('POST 401s without an x-user-id header', async () => {
  reset();
  const { POST } = await routePromise;
  const res = await POST(request({ barcode: '012345678905' }));
  assert.equal(res.status, 401);
});

test('POST responds from food_cache and never calls OFF/USDA', async () => {
  reset();
  cacheRows = [{
    name: 'Cached Bar', brand: 'Acme', serving_desc: '1 bar (40g)', serving_grams: 40,
    kcal_100g: 200, protein_100g: 10, carbs_100g: 20, fat_100g: 5,
  }];
  const { POST } = await routePromise;
  const res = await POST(request({ barcode: '012345678905' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.source, 'cache');
  assert.equal(body.name, 'Cached Bar');
  assert.equal(body.brand, 'Acme');
  assert.deepEqual(body.per100g, { kcal: 200, c: 20, p: 10, f: 5 });
  assert.equal(body.grams, 100);
  assert.equal(body.kcal, 200);
  assert.equal(body.servingGrams, 40);
  assert.equal(body.servingDesc, '1 bar (40g)');
  assert.equal(offCalls, 0);
  assert.equal(usdaCalls, 0);
  assert.equal(insertedRows.length, 0);
});

test('POST falls through to OFF when cache is empty, upserts food_cache, servingGrams/Desc null', async () => {
  reset();
  offResult = { productName: 'OFF Snack', brand: 'Brandy', per100g: { kcal: 150, c: 30, p: 0, f: 2 } };
  const { POST } = await routePromise;
  const res = await POST(request({ barcode: '111', grams: 50 }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.source, 'off');
  assert.equal(body.name, 'OFF Snack');
  assert.equal(body.grams, 50);
  assert.equal(body.kcal, 75); // 150 * 0.5
  assert.equal(body.servingGrams, null);
  assert.equal(body.servingDesc, null);
  assert.equal(usdaCalls, 0); // OFF hit short-circuits USDA
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].provider, 'off');
  assert.equal(insertedRows[0].provider_food_id, '111');
});

test('POST falls through to USDA when cache empty and OFF misses, null macros map to 0', async () => {
  reset();
  usdaResult = {
    fdcId: 999, name: 'USDA Item', brand: null, dataType: 'Branded',
    barcode: '222', servingGrams: 30, servingDesc: '1 pack (30g)',
    per100g: { kcal: 400, p: null, c: 50, f: null },
  };
  const { POST } = await routePromise;
  const res = await POST(request({ barcode: '222' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.source, 'usda');
  assert.deepEqual(body.per100g, { kcal: 400, c: 50, p: 0, f: 0 });
  assert.equal(body.p, 0);
  assert.equal(body.f, 0);
  assert.equal(body.servingGrams, 30);
  assert.equal(body.servingDesc, '1 pack (30g)');
  assert.equal(insertedRows[0].provider, 'usda');
  assert.equal(insertedRows[0].provider_food_id, '999');
});

test('POST 404s with offerTextSearch when USDA hit has unknown (null) kcal', async () => {
  reset();
  usdaResult = {
    fdcId: 1, name: 'Unknown Kcal Item', brand: null, dataType: 'Branded',
    barcode: '333', servingGrams: null, servingDesc: null,
    per100g: { kcal: null, p: null, c: null, f: null },
  };
  const { POST } = await routePromise;
  const res = await POST(request({ barcode: '333' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 404);

  const body = await res.json();
  assert.equal(body.offerTextSearch, true);
  assert.equal(insertedRows.length, 0);
});

test('POST 404s with offerTextSearch when no source has the product', async () => {
  reset();
  const { POST } = await routePromise;
  const res = await POST(request({ barcode: '444' }, { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Product not found.', offerTextSearch: true });
});
