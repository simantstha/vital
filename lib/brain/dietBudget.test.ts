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
interface ManualWeightRow { id: string; timestamp: Date; payload: unknown; source: string; }

const state: {
  weightRows: Array<{ date: string; value: number }>;
  manualWeightRows: ManualWeightRow[];
  workoutRows: Array<{ date: string; payload: unknown }>;
  coreProfileMd: string | null;
  trainingHistoryJson: string | null;
  /** applyDietBudgetUpdate's `users` row — read via a bare `db.select()` and written via `db.update()`. */
  userRow: Record<string, unknown>;
} = {
  weightRows: [], manualWeightRows: [], workoutRows: [], coreProfileMd: null, trainingHistoryJson: null,
  userRow: {},
};

/** Builds a manual/coach `weight_logged` events row — see lib/weightRepository.ts's queryManualWeightEvents. */
function manualWeighIn(date: string, valueKg: number, source: 'manual' | 'coach' = 'manual'): ManualWeightRow {
  return {
    id: `w-${date}-${source}`,
    timestamp: new Date(`${date}T08:00:00.000Z`),
    payload: { value: valueKg, unit: 'kg', localDay: date },
    source,
  };
}

const fakeDb = {
  select: (proj?: Record<string, unknown>) => {
    if (proj === undefined) {
      // applyDietBudgetUpdate's `db.select().from(schema.users)...` whole-row lookup.
      return { from: () => ({ where: () => ({ limit: async () => [state.userRow] }) }) };
    }
    if ('source' in proj) {
      // lib/weightRepository.ts's queryManualWeightEvents (manual/coach weigh-ins).
      return { from: () => ({ where: async () => state.manualWeightRows }) };
    }
    if ('value' in proj) {
      // lib/weightRepository.ts's queryHealthKitBodyMass (body_mass_kg).
      return { from: () => ({ where: async () => state.weightRows }) };
    }
    if ('payload' in proj) {
      // queryWorkouts
      return { from: () => ({ where: () => ({ orderBy: async () => state.workoutRows }) }) };
    }
    if ('core_profile_md' in proj) {
      // lib/coreProfileStore.ts's readCoreProfile — treat state.coreProfileMd
      // as already the canonical column value so tests don't need to model
      // the file-fallback/backfill path.
      return { from: () => ({ where: () => ({ limit: async () => [{ core_profile_md: state.coreProfileMd }] }) }) };
    }
    throw new Error(`unexpected projection in select(): ${JSON.stringify(proj)}`);
  },
  update: (_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          // applyDietBudgetUpdate's `db.update(schema.users).set(update)...` —
          // merge the patch onto the fake row like a real UPDATE would.
          state.userRow = { ...state.userRow, ...patch };
          return [state.userRow];
        },
      }),
    }),
  }),
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
  state.manualWeightRows = [];
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
  state.manualWeightRows = [];
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
  state.manualWeightRows = [];
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
  state.manualWeightRows = [];
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
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 30, sex: 'male', heightCm: 175, weightKg: 70 });

  state.trainingHistoryJson = JSON.stringify({ frequency: 7 }); // -> 1.4 multiplier
  const highFreq = await computeAutoBudget('user-1', 'general');

  state.trainingHistoryJson = JSON.stringify({ frequency: 0 }); // -> 1.2 multiplier
  const lowFreq = await computeAutoBudget('user-1', 'general');

  assert.ok((highFreq.tdee ?? 0) > (lowFreq.tdee ?? 0));
});

test('4 workouts (400 kcal each) across the trailing 7 days move the auto TDEE by their average per day, not their full sum', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 80 }];
  state.manualWeightRows = [];
  state.coreProfileMd = coreProfile({ age: 35, sex: 'male', heightCm: 180, weightKg: 80 });
  state.trainingHistoryJson = null;

  state.workoutRows = [];
  const noWorkouts = await computeAutoBudget('user-1', 'general');

  // queryWorkouts(userId, 7) returns one 400 kcal workout on each of 4
  // separate days within that window — the exact 4x/week scenario from the
  // bug report (verified: 4x400 kcal sessions used to inflate a single
  // day's TDEE by the full 1,600 kcal and erase the deficit).
  state.workoutRows = [
    { date: '2026-08-01', payload: [{ type: 'run', kcal: 400 }] },
    { date: '2026-08-02', payload: [{ type: 'run', kcal: 400 }] },
    { date: '2026-08-03', payload: [{ type: 'run', kcal: 400 }] },
    { date: '2026-08-04', payload: [{ type: 'run', kcal: 400 }] },
  ];
  const withWorkouts = await computeAutoBudget('user-1', 'general');

  const tdeeDelta = (withWorkouts.tdee ?? 0) - (noWorkouts.tdee ?? 0);
  // 1,600 kcal / 7 days ≈ 228.6 kcal/day.
  assert.ok(tdeeDelta >= 220 && tdeeDelta <= 235, `expected ~228.6 kcal/day tdee delta, got ${tdeeDelta}`);
  assert.ok(tdeeDelta < 1600, 'must not add the full weekly 1,600 kcal sum to a single day\'s TDEE');
});

test('a manual weigh-in (no HealthKit data at all) drives the auto budget weight instead of the DEFAULT_WEIGHT_KG fallback', async () => {
  const { computeAutoBudget, DEFAULT_WEIGHT_KG } = await dietBudgetPromise;
  state.weightRows = []; // no HealthKit body_mass_kg
  state.manualWeightRows = [manualWeighIn('2026-08-01', 68, 'manual')];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 30, sex: 'female', heightCm: 165, weightKg: 68 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'general');

  // BMR at the manual 68kg reading = 10*68 + 6.25*165 - 5*30 - 161 = 1400.25;
  // TDEE = round(1400.25 * 1.3) = 1820. If the fallback DEFAULT_WEIGHT_KG
  // (75kg) had been used instead, BMR would be 1470.25 -> TDEE 1911.
  assert.equal(budget.tdee, 1820, 'must use the manual weigh-in, not DEFAULT_WEIGHT_KG');
  assert.notEqual(DEFAULT_WEIGHT_KG, 68);
});

test('a fresher manual weigh-in outranks a stale HealthKit body-mass reading for the auto budget weight', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-07-01', value: 90 }]; // stale HealthKit sync, 90kg
  state.manualWeightRows = [manualWeighIn('2026-08-01', 82, 'manual')]; // fresh manual weigh-in, 82kg
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 40, sex: 'male', heightCm: 178, weightKg: 82 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'general');

  // BMR at 82kg = 10*82 + 6.25*178 - 5*40 + 5 = 820 + 1112.5 - 200 + 5 = 1737.5; TDEE = round(1737.5*1.3) = 2259
  // BMR at 90kg (the stale HealthKit value) would instead give TDEE 2405.
  assert.equal(budget.tdee, 2259, 'the fresher manual reading must win over the stale HealthKit one');
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

// ── applyDietBudgetUpdate: origin-aware low-energy floor enforcement ───────
// Coach-initiated writes (update_diet_budget tool) reject a below-floor
// target outright; app-editor writes (PATCH /api/diet-goal) clamp to the
// floor instead, because the shipped iOS DietBudgetViewModel saves
// optimistically with no retry-with-acknowledgment path — see
// applyDietBudgetUpdate's DietBudgetUpdateOrigin doc comment.

test('coach-initiated custom update below the floor is rejected with a clear, relayable error', async () => {
  const { applyDietBudgetUpdate } = await dietBudgetPromise;
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });
  state.weightRows = [];
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.trainingHistoryJson = null;
  state.userRow = {
    id: 'user-1', goal: 'weight_loss',
    target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null,
  };

  await assert.rejects(
    () => applyDietBudgetUpdate('user-1', { mode: 'custom', targetKcal: 1000 }, 'coach'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /1,200/, 'error should name the safe floor so the coach can relay it');
      return true;
    },
  );
  // Nothing should have been written.
  assert.equal(state.userRow.target_kcal, null);
});

test('coach-initiated custom update at/above the floor succeeds normally', async () => {
  const { applyDietBudgetUpdate } = await dietBudgetPromise;
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });
  state.weightRows = [];
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.trainingHistoryJson = null;
  state.userRow = {
    id: 'user-1', goal: 'weight_loss',
    target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null,
  };

  const { current } = await applyDietBudgetUpdate('user-1', { mode: 'custom', targetKcal: 1500 }, 'coach');
  assert.equal(current.targetKcal, 1500);
  assert.equal(current.lowEnergyWarning, null);
});

test('app-editor custom update below the floor is clamped to the floor (not rejected) and warns', async () => {
  const { applyDietBudgetUpdate, LOW_ENERGY_KCAL_FEMALE } = await dietBudgetPromise;
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });
  state.weightRows = [];
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.trainingHistoryJson = null;
  state.userRow = {
    id: 'user-1', goal: 'weight_loss',
    target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null,
  };

  // The iOS editor always sends explicit macros alongside targetKcal.
  const { current } = await applyDietBudgetUpdate(
    'user-1',
    { mode: 'custom', targetKcal: 900, protein: 180, carbs: 40, fat: 20 },
    'app',
  );

  assert.equal(current.targetKcal, LOW_ENERGY_KCAL_FEMALE, 'must be clamped up to the floor, not rejected');
  assert.equal(current.lowEnergyWarning?.appliedFloor, true);
  assert.equal(current.lowEnergyWarning?.thresholdKcal, LOW_ENERGY_KCAL_FEMALE);
  assert.equal(state.userRow.target_kcal, LOW_ENERGY_KCAL_FEMALE, 'the floored value, not the original 900, must be stored');
  // Macros must be re-derived off the floored kcal, not left as the
  // (now-inconsistent) macros the editor sent for the original 900 kcal.
  const grams = (current.protein * 4) + (current.carbs * 4) + (current.fat * 9);
  assert.ok(Math.abs(grams - LOW_ENERGY_KCAL_FEMALE) < 60, `macros (${grams} kcal) should roughly match the floored target`);
});

test('app-editor custom update at/above the floor is stored verbatim, no clamp', async () => {
  const { applyDietBudgetUpdate } = await dietBudgetPromise;
  state.coreProfileMd = coreProfile({ age: 55, sex: 'female', heightCm: 160, weightKg: 60 });
  state.weightRows = [];
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.trainingHistoryJson = null;
  state.userRow = {
    id: 'user-1', goal: 'weight_loss',
    target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null,
  };

  const { current } = await applyDietBudgetUpdate(
    'user-1',
    { mode: 'custom', targetKcal: 1800, protein: 150, carbs: 150, fat: 60 },
    'app',
  );

  assert.equal(current.targetKcal, 1800);
  assert.equal(current.protein, 150);
  assert.equal(current.lowEnergyWarning, null);
});

// ── goalFromOnboarding ───────────────────────────────────────────────────────
// iOS onboarding's basics.goal ids -> canonical DietGoal (see the function's
// doc comment for the bug this closes: onboarding never set users.goal).

test('goalFromOnboarding maps all four onboarding ids to their canonical DietGoal', async () => {
  const { goalFromOnboarding } = await dietBudgetPromise;

  assert.equal(goalFromOnboarding('lose_fat'), 'weight_loss');
  assert.equal(goalFromOnboarding('build_muscle'), 'muscle');
  assert.equal(goalFromOnboarding('improve_endurance'), 'endurance');
  assert.equal(goalFromOnboarding('general_health'), 'general');
});

test('goalFromOnboarding passes canonical DietGoal ids through unchanged', async () => {
  const { goalFromOnboarding, DIET_GOALS } = await dietBudgetPromise;

  for (const goal of DIET_GOALS) {
    assert.equal(goalFromOnboarding(goal), goal);
  }
});

// ── Protein by adjusted body weight (BMI >= 30) ─────────────────────────────
// A registered-dietitian review found protein was dosed at 2.2 g/kg of
// CURRENT weight even for a BMI >= 30 user — 286 g/day for a 130kg user.
// splitMacrosForKcal (called via computeAutoBudget -> macrosForGoal) now
// doses protein off adjusted body weight instead — see
// lib/brain/proteinWeight.ts and its own test file for the ABW/IBW math.

test('a 130kg/175cm weight_loss user gets well under the old 286g (2.2 g/kg of current weight) figure, and capped at 200g', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 130 }];
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 40, sex: 'male', heightCm: 175, weightKg: 130 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'weight_loss');

  // Old behavior: 2.2 g/kg * 130kg = 286g (over the 200g cap either way).
  assert.ok(budget.protein < 286, `expected well under 286g, got ${budget.protein}g`);
  assert.ok(budget.protein <= 200, `expected the 200g cap to apply, got ${budget.protein}g`);
});

test('a 70kg/175cm weight_loss user (BMI ~22.9, under the obesity threshold) is unchanged — still 2.2 g/kg of current weight', async () => {
  const { computeAutoBudget } = await dietBudgetPromise;
  state.weightRows = [{ date: '2026-08-01', value: 70 }];
  state.manualWeightRows = [];
  state.workoutRows = [];
  state.coreProfileMd = coreProfile({ age: 30, sex: 'male', heightCm: 175, weightKg: 70 });
  state.trainingHistoryJson = null;

  const budget = await computeAutoBudget('user-1', 'weight_loss');

  assert.equal(budget.protein, Math.round(2.2 * 70), 'protein must be unaffected for a non-obese BMI user');
});

test('goalFromOnboarding returns null for unrecognised input', async () => {
  const { goalFromOnboarding } = await dietBudgetPromise;

  assert.equal(goalFromOnboarding('bulk'), null);
  assert.equal(goalFromOnboarding(''), null);
  assert.equal(goalFromOnboarding('Lose Fat'), null); // case-sensitive — exact ids only
});
