import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';

/**
 * dietBudget.ts imports `@/db` (directly, and transitively via ./tools) and
 * `@/lib/memory`'s readMemoryFile, so both must be mocked before the module
 * is first imported — same constraint documented in tools.getSchedule.test.ts
 * and lib/brain/tools.logMeal.test.ts. This drives computeAutoBudget's new
 * low-energy-availability floor and resolveDietBudget's custom-path warning
 * against fake data, never touching Postgres or the filesystem.
 *
 * mock.module() can only be called once per specifier per process, so the
 * fakes read their answers from mutable `state` that each test sets before
 * calling in.
 */
const state: {
  weightRows: Array<{ date: string; value: number }>;
  workoutRows: Array<{ date: string; payload: unknown }>;
  coreProfileMd: string | null;
  trainingHistoryJson: string | null;
} = { weightRows: [], workoutRows: [], coreProfileMd: null, trainingHistoryJson: null };

const fakeDb = {
  select: (proj: Record<string, unknown>) => {
    if ('value' in proj) {
      // queryMetricPoints (body_mass_kg)
      return { from: () => ({ where: () => ({ orderBy: async () => state.weightRows }) }) };
    }
    if ('payload' in proj) {
      // queryWorkouts
      return { from: () => ({ where: () => ({ orderBy: async () => state.workoutRows }) }) };
    }
    throw new Error(`unexpected projection in select(): ${JSON.stringify(proj)}`);
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/memory', {
  namedExports: {
    readMemoryFile: (_userId: string, filename: string): string | null => {
      if (filename === 'core-profile.md') return state.coreProfileMd;
      if (filename === 'training-history.json') return state.trainingHistoryJson;
      return null;
    },
  },
});

const dietBudgetPromise = import('./dietBudget');

function coreProfile(opts: { age: number; sex: string; heightCm: number; weightKg: number }): string {
  return [
    '## Identity',
    `- Age: ${opts.age}`,
    `- Sex: ${opts.sex}`,
    `- Height: ${opts.heightCm} cm`,
    `- Current weight: ${opts.weightKg} kg — last updated 2026-08-01`,
    '',
  ].join('\n');
}

test('60kg/160cm/55F weight_loss auto budget stays above BMR without needing the floor', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 60 }];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'weight_loss');

  assert.equal(budget.tdee, 1513);
  assert.equal(budget.targetKcal, 1286);
  assert.ok(budget.targetKcal >= 1200, 'must clear the female low-energy floor');
  assert.ok(budget.targetKcal >= 1164, 'must clear her own BMR');
  assert.equal(budget.lowEnergyWarning, null);
});

test('low-energy floor applies for a small/older female cut and reports appliedFloor: true', async () => {
  const { computeAutoBudget, LOW_ENERGY_KCAL_FEMALE } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 45 }];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 65, sex: 'female', heightCm: 150, weightKg: 45 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'weight_loss');

  assert.equal(budget.targetKcal, LOW_ENERGY_KCAL_FEMALE);
  assert.equal(budget.lowEnergyWarning?.appliedFloor, true);
  assert.equal(budget.lowEnergyWarning?.thresholdKcal, LOW_ENERGY_KCAL_FEMALE);
  assert.match(budget.lowEnergyWarning?.message ?? '', /1,200/);
});

test('low-energy floor uses the higher 1500 threshold for a male user', async () => {
  const { computeAutoBudget, LOW_ENERGY_KCAL_MALE } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 45 }];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 65, sex: 'male', heightCm: 150, weightKg: 45 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'weight_loss');

  assert.equal(budget.targetKcal, LOW_ENERGY_KCAL_MALE);
  assert.equal(budget.lowEnergyWarning?.appliedFloor, true);
  assert.equal(budget.lowEnergyWarning?.thresholdKcal, LOW_ENERGY_KCAL_MALE);
});

test('90kg/185cm/30M weight_loss auto budget stays within ~50 kcal of the old fixed-offset result', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 90 }];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 30, sex: 'male', heightCm: 185, weightKg: 90 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'weight_loss');
  const oldFixedOffsetTarget = (budget.tdee ?? 0) - 400;

  assert.equal(budget.lowEnergyWarning, null);
  assert.ok(
    Math.abs(budget.targetKcal - oldFixedOffsetTarget) <= 50,
    `expected ${budget.targetKcal} within 50 kcal of ${oldFixedOffsetTarget}`,
  );
});

test('training frequency drives the base activity multiplier into the auto TDEE', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 70 }];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 30, sex: 'male', heightCm: 175, weightKg: 70 });

  state.trainingHistoryJson = JSON.stringify({ frequency: 7 }); // -> 1.4 multiplier
  const highFreq = await computeAutoBudget('user-1', 'general');

  state.trainingHistoryJson = JSON.stringify({ frequency: 0 }); // -> 1.2 multiplier
  const lowFreq = await computeAutoBudget('user-1', 'general');

  assert.ok((highFreq.tdee ?? 0) > (lowFreq.tdee ?? 0));
});

test('custom/pinned budgets under the floor are NOT clamped — warning attached, value preserved', async () => {
  const { resolveDietBudget, LOW_ENERGY_KCAL_FEMALE } = await dietBudgetPromise;
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });

  const budget = await resolveDietBudget(
    {
      goal: 'weight_loss',
      target_kcal: 1000, // user/coach pinned this below the 1200 floor
      protein_target_g: 150,
      carbs_target_g: 80,
      fat_target_g: 30,
    },
    'user-1',
  );

  assert.equal(budget.mode, 'custom');
  assert.equal(budget.targetKcal, 1000, 'custom targetKcal must be preserved verbatim, never floored');
  assert.equal(budget.lowEnergyWarning?.appliedFloor, false);
  assert.equal(budget.lowEnergyWarning?.thresholdKcal, LOW_ENERGY_KCAL_FEMALE);
});

test('custom/pinned budgets above the floor get no warning', async () => {
  const { resolveDietBudget } = await dietBudgetPromise;
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });

  const budget = await resolveDietBudget(
    {
      goal: 'weight_loss',
      target_kcal: 1800,
      protein_target_g: 150,
      carbs_target_g: 150,
      fat_target_g: 60,
    },
    'user-1',
  );

  assert.equal(budget.targetKcal, 1800);
  assert.equal(budget.lowEnergyWarning, null);
});
