import assert from 'node:assert/strict';
import test from 'node:test';
import { searchByGtin, searchFoods } from './usda';

function hit(overrides: Record<string, unknown> = {}) {
  return {
    fdcId: 1,
    description: 'Food Item',
    dataType: 'Branded',
    foodNutrients: [],
    ...overrides,
  };
}

/** Builds a fetch mock that inspects the request body's dataType to route
 * between the branded and generic (Foundation/SR Legacy) responses. */
function routedFetch(branded: unknown[], generic: unknown[]) {
  return async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { dataType: string[] };
    const foods = body.dataType.includes('Branded') ? branded : generic;
    return { ok: true, status: 200, json: async () => ({ foods }) } as Response;
  };
}

test('maps nutrient ids to kcal/p/c/f, missing nutrient stays null, skips hits without description', async (t) => {
  process.env.USDA_FDC_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', routedFetch(
    [
      hit({
        fdcId: 111,
        description: 'Chicken Breast',
        brandOwner: 'Acme',
        gtinUpc: '123456',
        servingSize: 100,
        servingSizeUnit: 'g',
        householdServingFullText: '1 breast',
        foodNutrients: [
          { nutrientId: 1008, value: 165 },
          { nutrientId: 1003, value: 31 },
          { nutrientId: 1004, value: 3.6 },
          // 1005 (carbs) intentionally omitted
        ],
      }),
      hit({ fdcId: 222, description: undefined }),
    ],
    [],
  ));

  const results = await searchFoods('chicken');
  assert.equal(results.length, 1);
  const [food] = results;
  assert.equal(food.fdcId, 111);
  assert.equal(food.name, 'Chicken Breast');
  assert.equal(food.brand, 'Acme');
  assert.equal(food.barcode, '123456');
  assert.equal(food.servingGrams, 100);
  assert.equal(food.servingDesc, '1 breast');
  assert.deepEqual(food.per100g, { kcal: 165, p: 31, c: null, f: 3.6 });
});

test('interleaves branded-first then remainder, capped at 10', async (t) => {
  process.env.USDA_FDC_API_KEY = 'test-key';
  const branded = Array.from({ length: 6 }, (_, i) => hit({ fdcId: 100 + i, description: `Branded ${i}` }));
  const generic = Array.from({ length: 6 }, (_, i) => hit({ fdcId: 200 + i, description: `Generic ${i}`, dataType: 'Foundation' }));
  t.mock.method(globalThis, 'fetch', routedFetch(branded, generic));

  const results = await searchFoods('food');
  assert.equal(results.length, 10);
  assert.deepEqual(results.map((f) => f.fdcId), [100, 200, 101, 201, 102, 202, 103, 203, 104, 204]);
});

test('searchByGtin matches with leading zeros stripped, returns null on mismatch', async (t) => {
  process.env.USDA_FDC_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ foods: [hit({ fdcId: 5, description: 'Soda', gtinUpc: '12345678905' })] }),
  } as Response));

  const match = await searchByGtin('012345678905');
  assert.equal(match?.fdcId, 5);

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ foods: [hit({ fdcId: 5, description: 'Soda', gtinUpc: '99999999999' })] }),
  } as Response));
  const noMatch = await searchByGtin('012345678905');
  assert.equal(noMatch, null);
});

test('missing API key short-circuits without fetching', async (t) => {
  delete process.env.USDA_FDC_API_KEY;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not be called');
  });

  assert.deepEqual(await searchFoods('anything'), []);
  assert.equal(await searchByGtin('123'), null);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('non-OK response and thrown/timeout errors both resolve to empty results', async (t) => {
  process.env.USDA_FDC_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({}) } as Response));
  assert.deepEqual(await searchFoods('food'), []);
  assert.equal(await searchByGtin('123'), null);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await searchFoods('food'), []);
  assert.equal(await searchByGtin('123'), null);
});
