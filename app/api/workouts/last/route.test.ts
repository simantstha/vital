import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

interface FakeRow {
  session_id: string;
  set_index: number;
  exercise: string;
  performed_at: Date;
  [key: string]: unknown;
}

const state: { sets: FakeRow[] } = { sets: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.workout_sets) {
        throw new Error(`unexpected table in select().from(): ${String(table)}`);
      }
      return {
        where: () => ({
          orderBy: () => {
            const rows = Promise.resolve(state.sets) as Promise<FakeRow[]> & { limit: (n: number) => Promise<FakeRow[]> };
            rows.limit = async (n: number) => state.sets.slice(0, n);
            return rows;
          },
        }),
      };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function req(qs: string, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request(`http://local/api/workouts/last${qs}`, { headers });
}

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  const response = await GET(req('?exercise=squat', {}));
  assert.equal(response.status, 401);
});

test('GET 400s without an exercise param', async () => {
  const { GET } = await routePromise;
  const response = await GET(req(''));
  assert.equal(response.status, 400);
});

test('GET returns [] when the exercise has never been logged', async () => {
  const { GET } = await routePromise;
  state.sets = [];
  const response = await GET(req('?exercise=squat'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.sets, []);
});

test('GET returns the mocked last session', async () => {
  const { GET } = await routePromise;
  state.sets = [
    {
      id: '1', user_id: 'user-1', session_id: 's1', set_index: 1, exercise: 'squat',
      exercise_display: 'Squat', reps: 5, load_kg: 100, rpe: null, is_warmup: false,
      source: 'manual', workout_id: null, local_day: '2026-09-22',
      performed_at: new Date('2026-09-22T18:00:00Z'), created_at: new Date(),
    } as unknown as FakeRow,
  ];
  const response = await GET(req('?exercise=squat'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sets.length, 1);
  assert.equal(body.sets[0].exercise, 'squat');
  assert.equal(body.sets[0].reps, 5);
});
