import assert from 'node:assert/strict';
import test from 'node:test';
import { applyActionAdjustment, createDailyRecommendation } from './coachWorkspace';

const readyCalibration = {
  status: 'ready' as const,
  metrics: {
    hrv_sdnn: { dataDays: 14, established: true },
    resting_hr: { dataDays: 14, established: true },
    sleep_minutes: { dataDays: 14, established: true },
  },
};

function input(overrides: Partial<Parameters<typeof createDailyRecommendation>[0]> = {}) {
  return {
    localDay: '2026-08-11',
    now: new Date('2026-08-11T15:00:00.000Z'),
    calibration: readyCalibration,
    metrics: {
      hrv: { value: 60, baseline: 60, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      restingHr: { value: 50, baseline: 50, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      sleep: { value: 480, baseline: 480, observedAt: new Date('2026-08-11T12:00:00.000Z') },
    },
    confirmedConstraints: [],
    nutritionContext: { consumedKcal: 900, targetKcal: 2200 },
    ...overrides,
  };
}

test('selects exactly one training action when calibrated, fresh, and metrics are at baseline', () => {
  const recommendation = createDailyRecommendation(input());

  assert.equal(recommendation.category, 'training');
  assert.equal(recommendation.action.kind, 'move');
  assert.match(recommendation.action.copy, /easy|comfortable/i);
  assert.equal(recommendation.evidence.fresh, true);
  assert.equal(recommendation.action.copy.includes('calorie'), false);
});

test('selects one recovery action when HRV is materially below baseline', () => {
  const recommendation = createDailyRecommendation(input({
    metrics: {
      hrv: { value: 48, baseline: 60, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      restingHr: { value: 50, baseline: 50, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      sleep: { value: 480, baseline: 480, observedAt: new Date('2026-08-11T12:00:00.000Z') },
    },
  }));

  assert.equal(recommendation.category, 'recovery');
  assert.equal(recommendation.action.kind, 'rest');
});

test('uses calibration rather than a prescription until source data is fresh and calibration is ready', () => {
  const recommendation = createDailyRecommendation(input({
    calibration: { status: 'calibrating', metrics: readyCalibration.metrics },
    metrics: {
      hrv: { value: 60, baseline: 60, observedAt: new Date('2026-08-09T12:00:00.000Z') },
      restingHr: { value: 50, baseline: 50, observedAt: new Date('2026-08-09T12:00:00.000Z') },
      sleep: { value: 480, baseline: 480, observedAt: new Date('2026-08-09T12:00:00.000Z') },
    },
  }));

  assert.equal(recommendation.category, 'calibration');
  assert.equal(recommendation.action.kind, 'other');
  assert.equal(recommendation.evidence.fresh, false);
});

test('confirmed canonical constraints gate prescriptions even with ready metrics', () => {
  const recommendation = createDailyRecommendation(input({
    confirmedConstraints: [{ id: 'constraint-knee', type: 'Injury', label: 'Right knee injury' }],
  }));

  assert.equal(recommendation.category, 'calibration');
  assert.match(recommendation.action.copy, /constraint/i);
});

test('keeps a stable material signature for the same decision inputs', () => {
  const first = createDailyRecommendation(input());
  const second = createDailyRecommendation(input());

  assert.equal(first.materialSignature, second.materialSignature);
  assert.equal(first.materialSignature.length, 64);
});

test('refreshes evidence without changing the material signature when raw metric values drift within the same action', () => {
  const first = createDailyRecommendation(input());
  const refreshed = createDailyRecommendation(input({
    metrics: {
      hrv: { value: 62, baseline: 60, observedAt: new Date('2026-08-11T14:00:00.000Z') },
      restingHr: { value: 49, baseline: 50, observedAt: new Date('2026-08-11T14:00:00.000Z') },
      sleep: { value: 475, baseline: 480, observedAt: new Date('2026-08-11T14:00:00.000Z') },
    },
  }));

  assert.equal(refreshed.category, 'training');
  assert.equal(refreshed.materialSignature, first.materialSignature);
  assert.notDeepEqual(refreshed.evidence.sources, first.evidence.sources);
});

test('calibrates instead of prescribing when a persisted metric or baseline is implausible', () => {
  const recommendation = createDailyRecommendation(input({
    metrics: {
      hrv: { value: Number.POSITIVE_INFINITY, baseline: 60, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      restingHr: { value: 50, baseline: 50, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      sleep: { value: 480, baseline: 480, observedAt: new Date('2026-08-11T12:00:00.000Z') },
    },
  }));

  assert.equal(recommendation.category, 'calibration');
  assert.equal(recommendation.evidence.fresh, false);
});

test('applies only bounded move adjustments and preserves deterministic safety copy', () => {
  const recommendation = createDailyRecommendation(input());
  const adjusted = applyActionAdjustment(recommendation.action, {
    timeMinutes: 18 * 60,
    durationMinutes: 45,
    intensity: 'moderate',
  });

  assert.deepEqual(adjusted, {
    ...recommendation.action,
    timeMinutes: 18 * 60,
    durationMinutes: 45,
    intensity: 'moderate',
  });
  assert.throws(() => applyActionAdjustment(recommendation.action, { durationMinutes: 240 }));
  assert.throws(() => applyActionAdjustment(recommendation.action, { intensity: 'hard' }));
});

test('rejects type-incompatible adjustments', () => {
  const sleep = createDailyRecommendation(input({
    metrics: {
      hrv: { value: 60, baseline: 60, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      restingHr: { value: 50, baseline: 50, observedAt: new Date('2026-08-11T12:00:00.000Z') },
      sleep: { value: 300, baseline: 480, observedAt: new Date('2026-08-11T12:00:00.000Z') },
    },
  }));

  assert.equal(sleep.category, 'sleep');
  assert.throws(
    () => applyActionAdjustment(sleep.action, { durationMinutes: 30 }),
    /not allowed/,
  );
});
