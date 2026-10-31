import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';

/**
 * lib/injuryCheckInLoader.ts reads the user's Injury facts (the same nodes the chat coach's NEVER VIOLATE block is built
 * from: type Injury, status active, not superseded, about the user themself) and hands the pure picker
 * (lib/injuryCheckIn.ts) their local logged day. Driven against a fake `@/db` (no Postgres).
 */

type Row = { label: string; status: string; superseded_by: string | null; subject_node_id: string | null; created_at: Date };
const state: { rows: Row[]; throws: boolean } = { rows: [], throws: false };

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => {
            if (state.throws) throw new Error('db down');
            return state.rows;
          },
        }),
      }),
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const loaderPromise = import('./injuryCheckInLoader');

const row = (over: Partial<Row> = {}): Row => ({
  label: 'Knee pain since Oct 20',
  status: 'active',
  superseded_by: null,
  subject_node_id: null,
  created_at: new Date('2026-10-24T18:00:00Z'),
  ...over,
});

test('an active Injury fact logged inside the window comes back as { text, since } on the user\'s local day', async () => {
  const { loadActiveInjury } = await loaderPromise;
  state.throws = false;
  state.rows = [row()];
  assert.deepEqual(await loadActiveInjury('u1', '2026-10-31', 'UTC'), { text: 'knee pain', since: '2026-10-24' });
  // 23:30 UTC on the 24th is already the 25th in Auckland: the day is the user's, not the server's.
  state.rows = [row({ created_at: new Date('2026-10-24T23:30:00Z') })];
  assert.deepEqual(await loadActiveInjury('u1', '2026-10-31', 'Pacific/Auckland'), { text: 'knee pain', since: '2026-10-25' });
});

test('no Injury facts, a resolved or superseded one, or a fact about someone else gives nothing', async () => {
  const { loadActiveInjury } = await loaderPromise;
  state.throws = false;
  state.rows = [];
  assert.equal(await loadActiveInjury('u1', '2026-10-31', 'UTC'), null);
  state.rows = [row({ status: 'resolved' })];
  assert.equal(await loadActiveInjury('u1', '2026-10-31', 'UTC'), null);
  state.rows = [row({ superseded_by: 'n2' })];
  assert.equal(await loadActiveInjury('u1', '2026-10-31', 'UTC'), null);
  state.rows = [row({ subject_node_id: 'father' })];
  assert.equal(await loadActiveInjury('u1', '2026-10-31', 'UTC'), null);
});

test('an injury logged more than 28 days ago is stale; one logged after the asked-about day does not exist yet', async () => {
  const { loadActiveInjury } = await loaderPromise;
  state.throws = false;
  state.rows = [row({ created_at: new Date('2026-09-20T10:00:00Z') })];
  assert.equal(await loadActiveInjury('u1', '2026-10-31', 'UTC'), null);
  state.rows = [row({ created_at: new Date('2026-10-26T10:00:00Z') })];
  assert.equal(await loadActiveInjury('u1', '2026-10-25', 'UTC'), null, 'as of 10-25 the fact (logged 10-26) is not there');
});

test('a failing lookup never breaks the goal card: it just carries no injury', async () => {
  const { loadActiveInjury } = await loaderPromise;
  state.throws = true;
  const errors = mock.method(console, 'error', () => {});
  try {
    assert.equal(await loadActiveInjury('u1', '2026-10-31', 'UTC'), null);
  } finally {
    errors.mock.restore();
    state.throws = false;
  }
});
