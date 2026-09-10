import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEvidenceGate } from './evidence';
import type { Finding } from './types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: 'level_shift',
    signature: 'level_shift:hrv_sdnn:down',
    metrics: ['hrv_sdnn'],
    effect: -1.5,
    effectLabel: '1.5 SD below baseline',
    n: 35,
    pValue: 0.001,
    detail: {},
    ...overrides,
  };
}

const established = new Set(['hrv_sdnn', 'resting_hr', 'sleep_minutes', 'whoop_day_strain', 'whoop_recovery']);

test('drops findings whose metrics are not established', () => {
  const kept = applyEvidenceGate([finding({ metrics: ['vo2_max'] })], established);
  assert.deepEqual(kept, []);
});

test('drops a cross-lag finding when only one of its two metrics is established', () => {
  const kept = applyEvidenceGate(
    [finding({ kind: 'cross_lag', metrics: ['whoop_day_strain', 'vo2_max'], effect: -0.6 })],
    established,
  );
  assert.deepEqual(kept, []);
});

test('keeps a large, significant, established finding', () => {
  assert.equal(applyEvidenceGate([finding()], established).length, 1);
});

test('drops a significant but trivially small level shift', () => {
  // Significance without magnitude is what large n manufactures.
  const kept = applyEvidenceGate([finding({ effect: -0.2, pValue: 0.0001 })], established);
  assert.deepEqual(kept, []);
});

test('drops large findings whose p-values look like pure noise', () => {
  // Uniform p-values are the null distribution — the shape a sweep over
  // unrelated metrics produces. Every one of these has a big effect, and none
  // should survive.
  const noise = Array.from({ length: 40 }, (_, i) =>
    finding({ signature: `level_shift:hrv_sdnn:${i}`, effect: -1.2, pValue: (i + 1) / 40 }),
  );
  assert.deepEqual(applyEvidenceGate(noise, established), []);
});

test('cadence_break bypasses the FDR family and survives alone', () => {
  const kept = applyEvidenceGate(
    [finding({ kind: 'cadence_break', signature: 'cadence_break:exercise_min', metrics: ['whoop_day_strain'], effect: 5, pValue: null })],
    established,
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kind, 'cadence_break');
});

test('a cadence_break does not dilute the correction for real p-values', () => {
  const withRule = applyEvidenceGate(
    [finding(), finding({ kind: 'cadence_break', signature: 'c', metrics: ['whoop_day_strain'], effect: 5, pValue: null })],
    established,
  );
  const withoutRule = applyEvidenceGate([finding()], established);
  assert.equal(withRule.filter((f) => f.kind === 'level_shift').length, withoutRule.length);
});

test('an empty input yields an empty output', () => {
  assert.deepEqual(applyEvidenceGate([], established), []);
});
