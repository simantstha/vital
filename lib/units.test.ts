import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';

/**
 * `@/db` must be mocked before `./units` is first imported in this process
 * (getUserUnitSystem queries it), so this lives in its own file — node:test
 * runs each test file in its own subprocess, keeping the module registry
 * clean (same pattern as lib/proactiveHealthWorkerRepository.test.ts).
 */

const state: { userRow: Array<{ unit_system: string | null }> } = {
  userRow: [{ unit_system: null }],
};

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.userRow }) };
      }
      throw new Error(`unexpected select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const unitsPromise = import('./units');

test('parseUnitSystem accepts exactly "metric" and "imperial"', async () => {
  const { parseUnitSystem } = await unitsPromise;
  assert.equal(parseUnitSystem('metric'), 'metric');
  assert.equal(parseUnitSystem('imperial'), 'imperial');
});

test('parseUnitSystem normalizes case and surrounding whitespace', async () => {
  const { parseUnitSystem } = await unitsPromise;
  assert.equal(parseUnitSystem('METRIC'), 'metric');
  assert.equal(parseUnitSystem('  Imperial  '), 'imperial');
  assert.equal(parseUnitSystem('MeTriC'), 'metric');
});

test('parseUnitSystem rejects anything that is not exactly metric/imperial', async () => {
  const { parseUnitSystem } = await unitsPromise;
  assert.equal(parseUnitSystem('us'), null);
  assert.equal(parseUnitSystem('metricish'), null);
  assert.equal(parseUnitSystem(''), null);
  assert.equal(parseUnitSystem('   '), null);
  assert.equal(parseUnitSystem(null), null);
  assert.equal(parseUnitSystem(undefined), null);
  assert.equal(parseUnitSystem(1), null);
  assert.equal(parseUnitSystem({}), null);
  assert.equal(parseUnitSystem(['metric']), null);
});

test('resolveUnitSystem falls back to metric for null/garbage, passes through valid values', async () => {
  const { resolveUnitSystem } = await unitsPromise;
  assert.equal(resolveUnitSystem(null), 'metric');
  assert.equal(resolveUnitSystem(undefined), 'metric');
  assert.equal(resolveUnitSystem('nonsense'), 'metric');
  assert.equal(resolveUnitSystem('imperial'), 'imperial');
  assert.equal(resolveUnitSystem('Metric'), 'metric');
});

test('getUserUnitSystem resolves the stored preference, defaulting an unset column to metric', async () => {
  const { getUserUnitSystem } = await unitsPromise;

  state.userRow = [{ unit_system: null }];
  assert.equal(await getUserUnitSystem('user-1'), 'metric');

  state.userRow = [{ unit_system: 'imperial' }];
  assert.equal(await getUserUnitSystem('user-1'), 'imperial');
});
