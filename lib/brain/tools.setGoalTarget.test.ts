import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * Drives the real set_goal_target executeToolCall branch against a fake `@/db`
 * and a fake `@/lib/goalStart` (no Postgres). Same constraints as
 * tools.logWeight.test.ts: mocks must be installed before ./tools is first
 * imported, so this lives in its own file.
 */

const state: {
  usersRow: Array<{ timezone: string | null; unit_system: string | null; target_weight_kg: number | null }>;
} = {
  usersRow: [{ timezone: 'UTC', unit_system: 'metric', target_weight_kg: null }],
};

let updates: Array<Record<string, unknown>> = [];
let restartCalls = 0;

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) return { where: () => ({ limit: async () => state.usersRow }) };
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
  update: (table: unknown) => {
    assert.equal(table, realSchema.users);
    return { set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/goalStart', {
  namedExports: {
    buildGoalRestart: async () => {
      restartCalls += 1;
      return { goal_started_at: new Date('2026-10-06T00:00:00Z'), goal_start_weight_kg: 82.1 };
    },
  },
});

const toolsPromise = import('./tools');

function reset(over: Partial<(typeof state.usersRow)[number]> = {}) {
  updates = [];
  restartCalls = 0;
  state.usersRow = [{ timezone: 'UTC', unit_system: 'metric', target_weight_kg: null, ...over }];
}

function futureDay(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

test('set_goal_target is registered as a coach tool', async () => {
  const tools = await toolsPromise;
  assert.ok(tools.BRAIN_TOOLS.find((t: { name: string }) => t.name === 'set_goal_target'));
});

test('sets weight, date and sessions together and re-anchors when the target weight changes', async () => {
  reset();
  const date = futureDay(80);
  const tools = await toolsPromise;
  const result = JSON.parse(
    await tools.executeToolCall('set_goal_target', { targetWeight: 76, unit: 'kg', targetDate: date, weeklySessions: 4 }, 'user-1'),
  );

  assert.equal(result.ok, true);
  assert.equal(result.targetWeightKg, 76);
  assert.equal(result.targetDate, date);
  assert.equal(result.weeklySessionsTarget, 4);
  assert.equal(result.reanchored, true);
  assert.equal(restartCalls, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].target_weight_kg, 76);
  assert.equal(updates[0].target_date, date);
  assert.equal(updates[0].weekly_sessions_target, 4);
  assert.equal(updates[0].goal_start_weight_kg, 82.1);
  assert.ok(updates[0].goal_started_at instanceof Date);
});

test('an imperial user\'s bare number is read in lb and stored in kg, rounded to 0.1', async () => {
  reset({ unit_system: 'imperial' });
  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('set_goal_target', { targetWeight: 170 }, 'user-1'));

  assert.equal(result.ok, true);
  assert.equal(result.unitSystem, 'imperial');
  assert.equal(updates[0].target_weight_kg, 77.1); // 170 lb
});

test('an unchanged target weight does NOT re-anchor', async () => {
  reset({ target_weight_kg: 76 });
  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('set_goal_target', { targetWeight: 76, unit: 'kg' }, 'user-1'));

  assert.equal(result.reanchored, false);
  assert.equal(restartCalls, 0);
  assert.equal(updates[0].goal_started_at, undefined);
});

test('sessions-only updates never touch the weight target or re-anchor', async () => {
  reset({ target_weight_kg: 80 });
  const tools = await toolsPromise;
  await tools.executeToolCall('set_goal_target', { weeklySessions: 3 }, 'user-1');

  assert.deepEqual(updates[0], { weekly_sessions_target: 3 });
  assert.equal(restartCalls, 0);
});

test('validation matches PATCH /api/profile and writes nothing on failure', async () => {
  reset();
  const tools = await toolsPromise;

  assert.match(await tools.executeToolCall('set_goal_target', {}, 'user-1'), /Error: provide at least one/);
  assert.match(await tools.executeToolCall('set_goal_target', { targetWeight: 20, unit: 'kg' }, 'user-1'), /Error: targetWeightKg must be a number between 30 and 300/);
  assert.match(await tools.executeToolCall('set_goal_target', { targetWeight: 70, unit: 'stone' }, 'user-1'), /Error: unit must be "kg" or "lb"/);
  assert.match(await tools.executeToolCall('set_goal_target', { targetDate: '2020-01-01' }, 'user-1'), /Error: targetDate must be a YYYY-MM-DD date in the future/);
  assert.match(await tools.executeToolCall('set_goal_target', { targetDate: futureDay(365 * 4) }, 'user-1'), /Error: targetDate/);
  assert.match(await tools.executeToolCall('set_goal_target', { weeklySessions: 20 }, 'user-1'), /Error: weeklySessionsTarget must be an integer between 1 and 14/);
  assert.match(await tools.executeToolCall('set_goal_target', { weeklySessions: 3.5 }, 'user-1'), /Error: weeklySessionsTarget/);

  assert.equal(updates.length, 0);
  assert.equal(restartCalls, 0);
});
