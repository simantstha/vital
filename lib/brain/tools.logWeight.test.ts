import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * Drives the real log_weight and get_weight_trend executeToolCall branches
 * against a fake `@/db` and a fake `@/lib/weightRepository`, so neither
 * touches Postgres. Both must be mocked before ./tools is first imported in
 * this process — node:test runs each test file in its own subprocess, so
 * this lives in its own file (same constraint as tools.logMeal.test.ts and
 * tools.getSchedule.test.ts).
 */

const state: {
  usersRow: Array<{ timezone: string | null }>;
  logResult: { id: string; localDay: string; deduped: boolean };
  readings: Array<{ measuredAt: string; valueKg: number; source: 'manual' | 'healthkit' | 'coach'; localDay: string }>;
} = {
  usersRow: [{ timezone: 'America/Chicago' }],
  logResult: { id: 'event-1', localDay: '2026-08-01', deduped: false },
  readings: [],
};

let usersQueried = false;
let logWeightEntryCalls: Array<Record<string, unknown>> = [];
let getWeightReadingsCalls: Array<{ userId: string; days: number; timezone: unknown }> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        usersQueried = true;
        return { where: () => ({ limit: async () => state.usersRow }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/weightRepository', {
  namedExports: {
    logWeightEntry: async (userId: string, input: Record<string, unknown>) => {
      logWeightEntryCalls.push({ userId, ...input });
      return state.logResult;
    },
    getWeightReadings: async (userId: string, days: number, timezone: unknown) => {
      getWeightReadingsCalls.push({ userId, days, timezone });
      return state.readings;
    },
  },
});

const toolsPromise = import('./tools');

test('log_weight converts lb to kg (default unit) and writes via logWeightEntry with source "coach"', async () => {
  usersQueried = false;
  logWeightEntryCalls = [];
  state.usersRow = [{ timezone: 'America/Chicago' }];
  state.logResult = { id: 'event-1', localDay: '2026-08-01', deduped: false };

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('log_weight', { value: 182 }, 'user-1'));

  assert.equal(usersQueried, true);
  assert.equal(logWeightEntryCalls.length, 1);
  assert.equal(logWeightEntryCalls[0].userId, 'user-1');
  assert.equal(logWeightEntryCalls[0].source, 'coach');
  assert.equal(logWeightEntryCalls[0].timezone, 'America/Chicago');
  assert.ok(Math.abs((logWeightEntryCalls[0].valueKg as number) - 82.55) < 0.05); // 182 lb -> kg

  assert.equal(result.ok, true);
  assert.equal(result.localDay, '2026-08-01');
  assert.equal(result.deduped, false);
});

test('log_weight with unit "kg" passes the value through unconverted', async () => {
  logWeightEntryCalls = [];

  const tools = await toolsPromise;
  await tools.executeToolCall('log_weight', { value: 81.5, unit: 'kg' }, 'user-1');

  assert.equal(logWeightEntryCalls[0].valueKg, 81.5);
});

test('log_weight accepts an explicit measuredAt timestamp', async () => {
  logWeightEntryCalls = [];

  const tools = await toolsPromise;
  await tools.executeToolCall('log_weight', { value: 81, unit: 'kg', measuredAt: '2026-07-15T06:00:00.000Z' }, 'user-1');

  assert.equal((logWeightEntryCalls[0].measuredAt as Date).toISOString(), '2026-07-15T06:00:00.000Z');
});

test('log_weight falls back to now() on an unparseable measuredAt rather than failing', async () => {
  logWeightEntryCalls = [];

  const tools = await toolsPromise;
  await tools.executeToolCall('log_weight', { value: 81, unit: 'kg', measuredAt: 'not-a-date' }, 'user-1');

  assert.equal(logWeightEntryCalls.length, 1);
  assert.ok(logWeightEntryCalls[0].measuredAt instanceof Date);
  assert.ok(!Number.isNaN((logWeightEntryCalls[0].measuredAt as Date).getTime()));
});

test('log_weight returns an error string and writes nothing when value is missing/non-numeric', async () => {
  logWeightEntryCalls = [];

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('log_weight', {}, 'user-1');

  assert.match(result, /Error: value is required/);
  assert.equal(logWeightEntryCalls.length, 0);
});

test('log_weight returns an error string and writes nothing on an invalid unit', async () => {
  logWeightEntryCalls = [];

  const tools = await toolsPromise;
  const result = await tools.executeToolCall('log_weight', { value: 80, unit: 'stone' }, 'user-1');

  assert.match(result, /Error: unit must be "kg" or "lb"/);
  assert.equal(logWeightEntryCalls.length, 0);
});

test('get_weight_trend fetches the user\'s timezone and returns the computed trend for their readings', async () => {
  getWeightReadingsCalls = [];
  state.usersRow = [{ timezone: 'UTC' }];
  state.readings = [
    { measuredAt: '2026-08-01T07:00:00.000Z', valueKg: 80, source: 'manual', localDay: '2026-08-01' },
    { measuredAt: '2026-08-02T07:00:00.000Z', valueKg: 79.8, source: 'manual', localDay: '2026-08-02' },
  ];

  const tools = await toolsPromise;
  const result = JSON.parse(await tools.executeToolCall('get_weight_trend', { days: 30 }, 'user-1'));

  assert.equal(getWeightReadingsCalls.length, 1);
  assert.equal(getWeightReadingsCalls[0].userId, 'user-1');
  assert.equal(getWeightReadingsCalls[0].days, 30);
  assert.equal(getWeightReadingsCalls[0].timezone, 'UTC');
  assert.equal(result.days.length, 2);
  assert.equal(result.days[0].rawKg, 80);
});

test('get_weight_trend defaults and clamps days to [1, 180]', async () => {
  getWeightReadingsCalls = [];
  state.readings = [];

  const tools = await toolsPromise;
  await tools.executeToolCall('get_weight_trend', { days: 9999 }, 'user-1');
  assert.equal(getWeightReadingsCalls[0].days, 180);

  await tools.executeToolCall('get_weight_trend', {}, 'user-1');
  assert.equal(getWeightReadingsCalls[1].days, 90); // default
});
