import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real GET handler against a fake `@/db` select chain (no
 * Postgres), covering auth and the payload→RecentEventRow→aggregateRecents
 * wiring. aggregateRecents itself is exercised in
 * lib/nutrition/candidates.test.ts (pure); this file proves the route reads
 * the right events and maps payload fields correctly. mock.module() must
 * run before the route's first import — node:test isolates each test file
 * in its own subprocess, so this lives on its own.
 */
let eventRows: (typeof realSchema.events.$inferSelect)[] = [];
let shouldThrow = false;

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => {
            if (shouldThrow) throw new Error('boom');
            return eventRows;
          },
        }),
      }),
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function eventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    user_id: 'user-1',
    timestamp: new Date('2026-07-15T12:00:00Z'),
    type: 'meal_logged',
    source: 'search',
    payload: {
      name: 'Chicken Salad',
      kcal: 400,
      c: 20,
      p: 30,
      f: 15,
      slot: 'lunch',
      imageThumb: null,
      ...overrides,
    },
  } as unknown as typeof realSchema.events.$inferSelect;
}

function request(headers: Record<string, string> = {}, qs = ''): Request {
  return new Request(`http://local/api/nutrition/recents${qs}`, { headers });
}

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  const res = await GET(request());
  assert.equal(res.status, 401);
});

test('GET 200s with items aggregated from events, tz accepted but unused', async () => {
  eventRows = [eventRow()];
  const { GET } = await routePromise;
  const res = await GET(request({ 'x-user-id': 'user-1' }, '?tz=America%2FChicago'));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].name, 'Chicken Salad');
  assert.equal(body.items[0].kcal, 400);
  assert.equal(body.items[0].slot, 'lunch');
  assert.equal(body.items[0].lastLoggedAt, '2026-07-15T12:00:00.000Z');
});

test('GET falls back to description when name is absent (coach-logged rows)', async () => {
  eventRows = [eventRow({ name: undefined, description: 'Oatmeal with berries' })];
  const { GET } = await routePromise;
  const res = await GET(request({ 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.equal(body.items[0].name, 'Oatmeal with berries');
});

test('GET returns empty items when there are no events', async () => {
  eventRows = [];
  const { GET } = await routePromise;
  const res = await GET(request({ 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.items, []);
});

test('GET 500s on a DB read error', async () => {
  shouldThrow = true;
  const { GET } = await routePromise;
  const res = await GET(request({ 'x-user-id': 'user-1' }));
  assert.equal(res.status, 500);
  shouldThrow = false;
});
