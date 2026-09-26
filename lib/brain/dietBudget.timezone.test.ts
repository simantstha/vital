import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import { localDayKey } from '../localDay';

/**
 * Verifies computeLearnedExpenditureSummary (lib/brain/dietBudget.ts) buckets
 * daily intake by the USER'S LOCAL DAY, the same way lib/brain/context.ts and
 * lib/brain/brief.ts do — not by UTC. Isolated into its own file (rather than
 * dietBudget.learnedExpenditure.test.ts) because it mocks
 * '@/lib/brain/nutritionIntake' entirely to CAPTURE the (userId, dayKeys, tz)
 * arguments resolveDailyIntake is called with, which would break that other
 * file's tests that depend on nutritionIntake's real aggregation logic
 * against fake Postgres rows.
 */
const state: {
  userTimezone: string | null;
  workoutRows: Array<{ date: string; payload: unknown }>;
  coreProfileMd: string | null;
} = { userTimezone: null, workoutRows: [], coreProfileMd: null };

let lastResolveDailyIntakeCall: { userId: string; dayKeys: string[]; tz: string } | null = null;

const fakeDb = {
  select: (proj?: Record<string, unknown>) => {
    if ('timezone' in (proj ?? {})) {
      return { from: () => ({ where: () => ({ limit: async () => [{ timezone: state.userTimezone }] }) }) };
    }
    if (proj && 'payload' in proj) {
      // lib/brain/tools.ts's queryWorkouts: {date, payload}.
      return { from: () => ({ where: () => ({ orderBy: async () => state.workoutRows }) }) };
    }
    if (proj && 'core_profile_md' in proj) {
      return { from: () => ({ where: () => ({ limit: async () => [{ core_profile_md: state.coreProfileMd }] }) }) };
    }
    throw new Error(`unexpected projection in select(): ${JSON.stringify(proj)}`);
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/memory', { namedExports: { readMemoryFile: async () => null, writeMemoryFile: async () => {} } });
mock.module('@/lib/weightRepository', { namedExports: { getWeightReadings: async () => [] } });
mock.module('@/lib/brain/nutritionIntake', {
  namedExports: {
    resolveDailyIntake: async (userId: string, dayKeys: string[], tz: string) => {
      lastResolveDailyIntakeCall = { userId, dayKeys: [...dayKeys], tz };
      return new Map(); // no intake data — this test only cares about the tz/dayKeys threaded in
    },
  },
});

const dietBudgetPromise = import('./dietBudget');

test.beforeEach(() => {
  state.userTimezone = null;
  state.workoutRows = [];
  state.coreProfileMd = null;
  lastResolveDailyIntakeCall = null;
});

test('a stored non-UTC timezone is threaded into resolveDailyIntake, not hardcoded UTC', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.userTimezone = 'America/Los_Angeles';
  const now = new Date('2026-08-15T05:00:00.000Z'); // 05:00 UTC = 22:00 PDT the PREVIOUS day — a boundary-crossing instant

  await computeAutoBudget('user-tz', 'general', { now });

  assert.ok(lastResolveDailyIntakeCall, 'resolveDailyIntake should have been called');
  assert.equal(lastResolveDailyIntakeCall!.tz, 'America/Los_Angeles');
  // The last (i.e. "today") day key must be the LOCAL day, not the UTC day —
  // proving the boundary-crossing instant above is bucketed correctly.
  const expectedLocalToday = localDayKey(now, 'America/Los_Angeles');
  const expectedUtcToday = now.toISOString().slice(0, 10);
  assert.notEqual(expectedLocalToday, expectedUtcToday, 'test fixture should actually straddle a day boundary');
  assert.equal(lastResolveDailyIntakeCall!.dayKeys.at(-1), expectedLocalToday);
});

test('no stored timezone falls back to UTC, same as before', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.userTimezone = null;
  const now = new Date('2026-08-15T12:00:00.000Z');

  await computeAutoBudget('user-no-tz', 'general', { now });

  assert.ok(lastResolveDailyIntakeCall);
  assert.equal(lastResolveDailyIntakeCall!.tz, 'UTC');
  assert.equal(lastResolveDailyIntakeCall!.dayKeys.at(-1), now.toISOString().slice(0, 10));
});

test('an invalid stored timezone string falls back to UTC rather than throwing', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.userTimezone = 'Not/A/Real/Zone';
  const now = new Date('2026-08-15T12:00:00.000Z');

  await assert.doesNotReject(() => computeAutoBudget('user-bad-tz', 'general', { now }));
  assert.ok(lastResolveDailyIntakeCall);
  assert.equal(lastResolveDailyIntakeCall!.tz, 'UTC');
});
