import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real POST handler against a fake `@/db` (no Postgres) and a
 * fake `@/lib/nutrition/portionMemory` (no memory-file IO). mock.module()
 * must run before ./route is first imported; node:test isolates each test
 * file in its own subprocess.
 */

interface Row { id: string; user_id: string; type: string; payload: Record<string, unknown> }

const state: { row: Row | null } = { row: null };
let updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
let portionCorrections: Array<{ userId: string; food: string; grams: number }> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.events) throw new Error(`unexpected table: ${String(table)}`);
      return { where: () => ({ limit: async () => (state.row ? [state.row] : []) }) };
    },
  }),
  update: (table: unknown) => {
    if (table !== realSchema.events) throw new Error(`unexpected table: ${String(table)}`);
    return {
      set: (vals: { payload: Record<string, unknown> }) => ({
        where: () => ({
          returning: async () => {
            if (!state.row) return [];
            updateCalls.push({ id: state.row.id, payload: vals.payload });
            state.row = { ...state.row, payload: vals.payload };
            return [state.row];
          },
        }),
      }),
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/nutrition/portionMemory', {
  namedExports: {
    recordPortionCorrection: async (userId: string, food: string, grams: number) => {
      portionCorrections.push({ userId, food, grams });
    },
  },
});

const routePromise = import('./route');

function req(body: unknown, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request('http://localhost/api/meals/scale', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function resetRow(overrides: Partial<Row['payload']> = {}) {
  state.row = {
    id: 'event-1',
    user_id: 'user-1',
    type: 'meal_logged',
    payload: {
      kcal: 500, c: 40, p: 40, f: 20, name: 'Chicken and rice', description: '200g chicken and rice',
      source: 'estimator', ...overrides,
    },
  };
}

test('POST returns 401 with no x-user-id header', async () => {
  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', factor: 1.5 }, {}));
  assert.equal(res.status, 401);
});

test('POST returns 400 for a missing id, neither/both of factor+grams, or an out-of-range factor', async () => {
  const { POST } = await routePromise;
  assert.equal((await POST(req({ factor: 1.5 }))).status, 400);
  assert.equal((await POST(req({ id: 'event-1' }))).status, 400);
  assert.equal((await POST(req({ id: 'event-1', factor: 1.5, grams: 300 }))).status, 400);
  assert.equal((await POST(req({ id: 'event-1', factor: 0 }))).status, 400);
  assert.equal((await POST(req({ id: 'event-1', factor: 10 }))).status, 400);
  assert.equal((await POST(req({ id: 'event-1', grams: -5 }))).status, 400);
});

test('POST returns 404 when no matching meal_logged row exists for this user', async () => {
  state.row = null;
  const { POST } = await routePromise;
  const res = await POST(req({ id: 'missing', factor: 1.5 }));
  assert.equal(res.status, 404);
});

test('POST scales kcal/c/p/f by factor and rounds', async () => {
  resetRow();
  updateCalls = [];
  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', factor: 1.5 }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kcal, 750);
  assert.equal(body.c, 60);
  assert.equal(body.p, 60);
  assert.equal(body.f, 30);
  assert.equal(body.name, 'Chicken and rice');
});

test('POST scales each estimatorItems entry and recomputes totalGrams, and records a portion correction per item', async () => {
  resetRow({
    estimatorItems: [
      { food: 'grilled chicken breast', grams: 200, kcal: 330, c: 0, p: 47, f: 15, source: 'usda', confidence: 'high', portionNote: '~200g' },
      { food: 'white rice, cooked', grams: 150, kcal: 213, c: 44, p: 4, f: 0, source: 'usda', confidence: 'med', portionNote: '~1 cup' },
    ],
    totalGrams: 350,
  });
  updateCalls = [];
  portionCorrections = [];

  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', factor: 2 }));
  assert.equal(res.status, 200);

  const updatedPayload = updateCalls[0].payload;
  const items = updatedPayload.estimatorItems as Array<{ food: string; grams: number; kcal: number }>;
  assert.equal(items[0].grams, 400);
  assert.equal(items[0].kcal, 660);
  assert.equal(items[1].grams, 300);
  assert.equal(updatedPayload.totalGrams, 700);
  assert.equal(updatedPayload.items, '400g grilled chicken breast, 300g white rice, cooked');

  assert.deepEqual(
    portionCorrections.sort((a, b) => a.food.localeCompare(b.food)),
    [
      { userId: 'user-1', food: 'grilled chicken breast', grams: 400 },
      { userId: 'user-1', food: 'white rice, cooked', grams: 300 },
    ].sort((a, b) => a.food.localeCompare(b.food)),
  );
});

test('POST with grams sets the total from a gram baseline and scales items proportionally', async () => {
  resetRow({
    estimatorItems: [
      { food: 'white rice, cooked', grams: 200, kcal: 260, c: 56, p: 5, f: 1, source: 'usda', confidence: 'med', portionNote: '' },
    ],
    totalGrams: 200,
  });
  updateCalls = [];
  portionCorrections = [];

  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', grams: 380 }));
  assert.equal(res.status, 200);

  const updatedPayload = updateCalls[0].payload;
  assert.equal(updatedPayload.totalGrams, 380);
  assert.equal(portionCorrections[0].grams, 380);
});

test('POST returns 422 for grams scaling when the meal has no gram baseline', async () => {
  resetRow(); // no estimatorItems / totalGrams
  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', grams: 300 }));
  assert.equal(res.status, 422);
});

test('POST with itemFood + grams scales only that item and folds the delta into totals', async () => {
  resetRow({
    estimatorItems: [
      { food: 'white rice, cooked', grams: 300, kcal: 390, c: 84, p: 8, f: 0, source: 'usda', confidence: 'med', portionNote: '' },
      { food: 'chicken curry', grams: 250, kcal: 358, c: 10, p: 32, f: 20, source: 'model', confidence: 'low', portionNote: '' },
    ],
    totalGrams: 550,
    kcal: 748, c: 94, p: 40, f: 20,
  });
  updateCalls = [];
  portionCorrections = [];

  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', itemFood: 'white rice, cooked', grams: 450 }));
  assert.equal(res.status, 200);
  const body = await res.json();

  // Item scaled by 450/300 = 1.5×: kcal 390 → 585.
  assert.equal(body.item.grams, 450);
  assert.equal(body.item.kcal, 585);
  // Meal total folds in only the rice delta (+195 kcal): 748 + 195 = 943.
  assert.equal(body.kcal, 943);

  const updatedPayload = updateCalls[0].payload;
  const items = updatedPayload.estimatorItems as Array<{ food: string; grams: number; kcal: number }>;
  assert.equal(items[0].grams, 450);
  assert.equal(items[1].grams, 250); // untouched
  assert.equal(updatedPayload.totalGrams, 700);

  // Portion memory recorded ONLY for the edited food.
  assert.deepEqual(portionCorrections, [{ userId: 'user-1', food: 'white rice, cooked', grams: 450 }]);
});

test('POST with itemFood returns 404 for an unknown item and 422 with no item breakdown', async () => {
  resetRow({
    estimatorItems: [{ food: 'white rice, cooked', grams: 300, kcal: 390, c: 84, p: 8, f: 0, source: 'usda', confidence: 'med', portionNote: '' }],
    totalGrams: 300,
  });
  const { POST } = await routePromise;
  assert.equal((await POST(req({ id: 'event-1', itemFood: 'nonexistent food', grams: 100 }))).status, 404);

  resetRow(); // no estimatorItems
  assert.equal((await POST(req({ id: 'event-1', itemFood: 'white rice, cooked', grams: 100 }))).status, 422);
});

test('POST rejects itemFood combined with factor, or itemFood with no grams', async () => {
  resetRow({ estimatorItems: [{ food: 'x', grams: 100, kcal: 10, c: 1, p: 1, f: 1, source: 'usda', confidence: 'med', portionNote: '' }] });
  const { POST } = await routePromise;
  assert.equal((await POST(req({ id: 'event-1', itemFood: 'x', factor: 1.5 }))).status, 400);
  assert.equal((await POST(req({ id: 'event-1', itemFood: 'x' }))).status, 400);
});

test('POST scales totals only (no portion memory write) for a flat log with no item breakdown', async () => {
  resetRow();
  portionCorrections = [];
  const { POST } = await routePromise;
  const res = await POST(req({ id: 'event-1', factor: 0.5 }));
  assert.equal(res.status, 200);
  assert.equal(portionCorrections.length, 0);
});
