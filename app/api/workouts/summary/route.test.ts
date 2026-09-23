import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

interface FakeRow {
  exercise: string;
  performed_at: Date;
  reps: number;
  load_kg: number | null;
  is_warmup: boolean;
  [key: string]: unknown;
}

const state: { sets: FakeRow[] } = { sets: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.workout_sets) {
        throw new Error(`unexpected table in select().from(): ${String(table)}`);
      }
      return { where: () => ({ orderBy: async () => state.sets }) };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function req(qs: string, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request(`http://local/api/workouts/summary${qs}`, { headers });
}

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  const response = await GET(req('', {}));
  assert.equal(response.status, 401);
});

test('GET 400s on a non-integer days param', async () => {
  const { GET } = await routePromise;
  const response = await GET(req('?days=abc'));
  assert.equal(response.status, 400);
});

test('GET clamps days into [7, 365] and defaults to 84', async () => {
  const { GET } = await routePromise;
  state.sets = [];

  const responseDefault = await GET(req(''));
  assert.equal((await responseDefault.json()).days, 84);

  const responseLow = await GET(req('?days=1'));
  assert.equal((await responseLow.json()).days, 7);

  const responseHigh = await GET(req('?days=9999'));
  assert.equal((await responseHigh.json()).days, 365);
});

test('GET returns a progression summary grouped by exercise', async () => {
  const { GET } = await routePromise;
  state.sets = [
    { exercise: 'squat', performed_at: new Date('2026-09-21T10:00:00Z'), reps: 5, load_kg: 100, is_warmup: false },
    { exercise: 'squat', performed_at: new Date('2026-09-21T10:05:00Z'), reps: 5, load_kg: 105, is_warmup: false },
  ];
  const response = await GET(req('?days=30'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.exercises.squat);
  assert.equal(body.exercises.squat[0].totalSets, 2);
});
