import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * Drives the real get_schedule executeToolCall branch (timezone lookup +
 * queryScheduleWindow + rendering) against a fake `@/db`, so it never
 * touches Postgres. `@/db` must be mocked before ./tools is first imported
 * in this process — node:test runs each test file in its own subprocess,
 * so this lives in its own file (same constraint documented in
 * lib/proactiveHealthWorkerRepository.test.ts).
 *
 * mock.module() can only be called once per specifier per process, so the
 * fake reads its answers from mutable `state` that each test sets before
 * calling the tool, rather than re-mocking per test.
 */
const state: {
  usersRow: Array<{ timezone: string | null }>;
  blockRows: Array<{ id: string; startAt: Date; endAt: Date; allDay: boolean; title: string | null }>;
} = { usersRow: [], blockRows: [] };

let usersQueried = false;
let calendarBlocksQueried = false;

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        usersQueried = true;
        return { where: () => ({ limit: async () => state.usersRow }) };
      }
      if (table === realSchema.calendar_blocks) {
        calendarBlocksQueried = true;
        return { where: () => ({ orderBy: async () => state.blockRows }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const toolsPromise = import('./tools');

test('get_schedule fetches the user\'s timezone, queries the window, and renders busy blocks', async () => {
  usersQueried = false;
  calendarBlocksQueried = false;
  state.usersRow = [{ timezone: 'America/Chicago' }];
  state.blockRows = [{
    id: 'block-1',
    startAt: new Date('2026-07-16T19:00:00.000Z'),
    endAt: new Date('2026-07-16T19:30:00.000Z'),
    allDay: false,
    title: 'Standup',
  }];

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('get_schedule', { days: 3 }, 'user-1'));

  assert.equal(usersQueried, true);
  assert.equal(calendarBlocksQueried, true);
  assert.equal(result.timezone, 'America/Chicago');
  assert.equal(result.busy.length, 1);
  assert.equal(result.busy[0].title, 'Standup');
  assert.equal(result.busy[0].allDay, false);
  assert.match(result.busy[0].start, /Jul 16/);
  assert.match(result.busy[0].start, /2:00\s?PM/);
});

test('get_schedule returns an empty busy array when the user has no synced blocks', async () => {
  state.usersRow = [{ timezone: 'UTC' }];
  state.blockRows = [];

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('get_schedule', {}, 'user-1'));

  assert.equal(result.timezone, 'UTC');
  assert.deepEqual(result.busy, []);
});

test('get_schedule falls back to UTC when the user has no timezone row', async () => {
  state.usersRow = []; // no user row found
  state.blockRows = [];

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('get_schedule', {}, 'user-1'));
  assert.equal(result.timezone, 'UTC');
});
