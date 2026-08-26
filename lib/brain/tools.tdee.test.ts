import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Unit tests for estimateTDEE (lib/brain/tools.ts), which used to hardcode
 * Mifflin-St Jeor for a 175cm/30yo male regardless of who was actually
 * asking — every calorie budget in the app was wrong for anyone else. This
 * pins the real per-user formula plus its fallback behavior.
 *
 * estimateTDEE is a pure function, but importing ./tools also imports `@/db`,
 * which throws at import time without DATABASE_URL set — same constraint as
 * lib/brain/tools.specialist.test.ts, so we set it before the dynamic import
 * rather than touching Postgres.
 */
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/vital_test';

async function loadTools() {
  return import('./tools');
}

test('worked example: 60kg/160cm/55yo female → BMR 1164, TDEE 1513 with no workouts', async () => {
  const { estimateTDEE } = await loadTools();
  // BMR = 10*60 + 6.25*160 - 5*55 - 161 = 600 + 1000 - 275 - 161 = 1164
  const tdee = estimateTDEE(
    { weightKg: 60, heightCm: 160, age: 55, biologicalSex: 'female' },
    [],
  );
  assert.equal(tdee, Math.round(1164 * 1.3));
  assert.equal(tdee, 1513);
});

test('70kg/175cm/30yo male → BMR 1648.75, TDEE derives from it with no workouts', async () => {
  const { estimateTDEE } = await loadTools();
  // BMR = 10*70 + 6.25*175 - 5*30 + 5 = 700 + 1093.75 - 150 + 5 = 1648.75
  const tdee = estimateTDEE(
    { weightKg: 70, heightCm: 175, age: 30, biologicalSex: 'male' },
    [],
  );
  assert.equal(tdee, Math.round(1648.75 * 1.3));
});

test('missing height/age/sex falls back to the named constants and does not throw', async () => {
  const { estimateTDEE, FALLBACK_HEIGHT_CM, FALLBACK_AGE } = await loadTools();
  assert.equal(FALLBACK_HEIGHT_CM, 170);
  assert.equal(FALLBACK_AGE, 35);

  assert.doesNotThrow(() => {
    const tdee = estimateTDEE(
      { weightKg: 70, heightCm: null, age: null, biologicalSex: null },
      [],
    );
    // BMR = 10*70 + 6.25*170 - 5*35 - 78 (sex-neutral midpoint) = 700 + 1062.5 - 175 - 78 = 1509.5
    assert.equal(tdee, Math.round(1509.5 * 1.3));
  });
});

test('normalizeBiologicalSex accepts common free-text variants, case-insensitively', async () => {
  const { normalizeBiologicalSex } = await loadTools();
  assert.equal(normalizeBiologicalSex('Male'), 'male');
  assert.equal(normalizeBiologicalSex('  m '), 'male');
  assert.equal(normalizeBiologicalSex('MAN'), 'male');
  assert.equal(normalizeBiologicalSex('Female'), 'female');
  assert.equal(normalizeBiologicalSex('f'), 'female');
  assert.equal(normalizeBiologicalSex('woman'), 'female');
  assert.equal(normalizeBiologicalSex('nonbinary'), null);
  assert.equal(normalizeBiologicalSex(''), null);
  assert.equal(normalizeBiologicalSex(null), null);
});

test('regression guard: a female and male of identical weight get different budgets', async () => {
  const { estimateTDEE, macrosForGoal } = await loadTools();
  const shared = { weightKg: 70, heightCm: 170, age: 30 };

  const tdeeFemale = estimateTDEE({ ...shared, biologicalSex: 'female' }, []);
  const tdeeMale = estimateTDEE({ ...shared, biologicalSex: 'male' }, []);

  // This is the exact bug that shipped: identical weight silently produced
  // identical budgets for every user regardless of sex, height, or age.
  assert.notEqual(tdeeFemale, tdeeMale);

  const budgetFemale = macrosForGoal('general', shared.weightKg, tdeeFemale);
  const budgetMale = macrosForGoal('general', shared.weightKg, tdeeMale);
  assert.notEqual(budgetFemale.targetCal, budgetMale.targetCal);
});
