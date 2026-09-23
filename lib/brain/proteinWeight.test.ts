import assert from 'node:assert/strict';
import test from 'node:test';
import {
  proteinBasisWeightKg,
  PROTEIN_GRAMS_CAP,
  OBESITY_BMI_THRESHOLD,
  ADJUSTED_BODY_WEIGHT_FACTOR,
} from './proteinWeight';

test('below BMI 30, protein basis weight is just current weight (height known)', () => {
  // 70kg / 175cm -> BMI 22.9, well under the threshold.
  const basis = proteinBasisWeightKg(70, 175, 'male');
  assert.equal(basis, 70);
});

test('no height on file always falls back to current weight, regardless of weight', () => {
  const basis = proteinBasisWeightKg(130, null, 'female');
  assert.equal(basis, 130);
});

test('BMI >= 30 with a known height uses adjusted body weight (Devine IBW + 0.4 * gap), lower than current weight', () => {
  // 130kg / 175cm -> BMI ~42.4, well over the threshold.
  const basis = proteinBasisWeightKg(130, 175, 'male');
  // Devine male IBW at 175cm: 175cm = 68.9 in; 50 + 2.3*(68.9-60) = 50 + 2.3*8.9 ≈ 70.47
  // ABW = 70.47 + 0.4*(130-70.47) = 70.47 + 23.81 ≈ 94.3
  assert.ok(basis < 130, 'adjusted weight must be lower than current weight');
  assert.ok(basis > 70, 'adjusted weight must still be above the ideal weight (0.4 correction factor)');
  assert.ok(Math.abs(basis - 94.3) < 1, `expected ~94.3kg, got ${basis}`);
});

test('unknown sex uses the lower female Devine formula for the adjusted-weight calc', () => {
  const male = proteinBasisWeightKg(130, 175, 'male');
  const unknown = proteinBasisWeightKg(130, 175, null);
  const female = proteinBasisWeightKg(130, 175, 'female');
  assert.equal(unknown, female, 'unknown sex must match the female (lower) formula exactly');
  assert.ok(unknown < male, 'the female formula gives a lower IBW, so a LOWER ABW than the male formula');
});

test('exactly BMI 30 uses the adjusted-weight path (>= is inclusive)', () => {
  // Choose weight/height so BMI is exactly 30: weight = 30 * (height_m)^2.
  const heightCm = 170;
  const heightM = heightCm / 100;
  const weightKg = 30 * heightM * heightM;
  assert.equal(OBESITY_BMI_THRESHOLD, 30);

  const basis = proteinBasisWeightKg(weightKg, heightCm, 'male');
  assert.notEqual(basis, weightKg, 'BMI exactly 30 must already use the adjusted-weight path, not current weight');
});

test('just under BMI 30 still uses current weight', () => {
  const heightCm = 170;
  const heightM = heightCm / 100;
  const weightKg = 29.9 * heightM * heightM;

  const basis = proteinBasisWeightKg(weightKg, heightCm, 'male');
  assert.ok(Math.abs(basis - weightKg) < 1e-9, 'BMI just under 30 must use current weight verbatim');
});

test('sanity: constants match the documented spec', () => {
  assert.equal(PROTEIN_GRAMS_CAP, 200);
  assert.equal(ADJUSTED_BODY_WEIGHT_FACTOR, 0.4);
});
