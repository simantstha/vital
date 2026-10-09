import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

const state: { sets: Record<string, unknown>[] } = { sets: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.workout_sets) {
        throw new Error(`unexpected table in select().from(): ${String(table)}`);
      }
      return {
        where: () => ({
          orderBy: () => ({ limit: async (n: number) => state.sets.slice(0, n) }),
        }),
      };
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function req(qs: string, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request(`http://local/api/workouts/sessions${qs}`, { headers });
}

function row(session: string, day: string, exercise: string, index: number, reps: number, load: number | null, warm = false) {
  return {
    session_id: session, local_day: day, performed_at: new Date(`${day}T18:00:00Z`),
    exercise, exercise_display: exercise.toUpperCase(), set_index: index, reps, load_kg: load, is_warmup: warm,
  };
}

test('GET 401s without an x-user-id header', async () => {
  const { GET } = await routePromise;
  assert.equal((await GET(req('', {}))).status, 401);
});

test('GET returns [] when nothing is logged', async () => {
  const { GET } = await routePromise;
  state.sets = [];
  const response = await GET(req(''));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sessions, []);
});

test('GET groups sets into sessions, newest first, ignoring warm-ups', async () => {
  const { GET } = await routePromise;
  state.sets = [
    row('a', '2026-10-05', 'bench', 1, 8, 60, true),
    row('a', '2026-10-05', 'bench', 2, 5, 80),
    row('a', '2026-10-05', 'bench', 3, 5, 85),
    row('a', '2026-10-05', 'ohp', 4, 8, 40),
    row('b', '2026-10-06', 'row', 1, 10, 70),
  ];
  const body = await (await GET(req('?limit=8'))).json();
  assert.equal(body.sessions.length, 2);
  assert.equal(body.sessions[0].sessionId, 'b');
  const a = body.sessions[1];
  assert.equal(a.localDay, '2026-10-05');
  assert.deepEqual(a.exercises.map((e: { exercise: string }) => e.exercise), ['bench', 'ohp']);
  assert.equal(a.exercises[0].sets, 2);
  assert.deepEqual(a.exercises[0].topSet, { reps: 5, loadKg: 85 });
  assert.deepEqual(a.exercises[0].setDetails, [
    { reps: 5, loadKg: 80, rpe: null },
    { reps: 5, loadKg: 85, rpe: null },
  ]);
});

test('GET honours limit', async () => {
  const { GET } = await routePromise;
  state.sets = [
    row('a', '2026-10-05', 'bench', 1, 5, 80),
    row('b', '2026-10-06', 'row', 1, 10, 70),
  ];
  const body = await (await GET(req('?limit=1'))).json();
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].sessionId, 'b');
});
