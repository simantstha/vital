import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoachViz } from './coachViz';

test('get_metric_trend defaults to metric — body_mass_kg points/mean/baseline stay in kg with unit "kg"', () => {
  const viz = buildCoachViz('get_metric_trend', {
    metric: 'body_mass_kg',
    points: [{ date: '2026-08-01', value: 81.2 }, { date: '2026-08-02', value: 81.0 }],
    stats: { mean: 81.1 },
    baseline: { mean30: 80.5 },
  });
  assert.equal(viz?.kind, 'trend');
  assert.equal((viz as { unit: string }).unit, 'kg');
  // points[].value is deliberately unrounded (chart granularity) — mean/baseline are.
  assert.deepEqual((viz as { points: Array<{ value: number }> }).points.map((p) => p.value), [81.2, 81.0]);
  assert.equal((viz as { mean: number | null }).mean, 81);
  assert.equal((viz as { baseline: number | null }).baseline, 81); // Math.round(80.5) -> 81
});

test('get_metric_trend converts body_mass_kg to lb for an imperial user, and reports unit "lb"', () => {
  const viz = buildCoachViz('get_metric_trend', {
    metric: 'body_mass_kg',
    points: [{ date: '2026-08-01', value: 81.2 }],
    stats: { mean: 81.2 },
    baseline: { mean30: 80.0 },
  }, 'imperial') as { unit: string; points: Array<{ value: number }>; mean: number | null; baseline: number | null };

  assert.equal(viz.unit, 'lb');
  // points[].value is deliberately unrounded (chart granularity) — mean/baseline are.
  assert.ok(Math.abs(viz.points[0].value - 81.2 * 2.2046226218) < 1e-9);
  assert.equal(viz.mean, Math.round(81.2 * 2.2046226218)); // 179
  assert.equal(viz.baseline, Math.round(80.0 * 2.2046226218)); // 176
});

test('get_metric_trend leaves a non-weight metric (e.g. hrv_sdnn) untouched under imperial', () => {
  const viz = buildCoachViz('get_metric_trend', {
    metric: 'hrv_sdnn',
    points: [{ date: '2026-08-01', value: 45.7 }],
    stats: { mean: 45.7 },
    baseline: { mean30: 44.0 },
  }, 'imperial') as { unit: string; points: Array<{ value: number }>; mean: number | null };

  assert.equal(viz.unit, 'ms');
  assert.equal(viz.points[0].value, 45.7);
  assert.equal(viz.mean, 46);
});

test('compare_periods converts body_mass_kg currentMean/previousMean/delta to lb under imperial', () => {
  const viz = buildCoachViz('compare_periods', {
    metric: 'body_mass_kg',
    current: { mean: 81.2 },
    previous: { mean: 80.0 },
    delta: 1.2,
    deltaPct: 1.5,
  }, 'imperial') as { unit: string; currentMean: number | null; previousMean: number | null; delta: number | null };

  assert.equal(viz.unit, 'lb');
  assert.equal(viz.currentMean, Math.round(81.2 * 2.2046226218));
  assert.equal(viz.previousMean, Math.round(80.0 * 2.2046226218));
  assert.equal(viz.delta, Math.round(1.2 * 2.2046226218));
});

test('compare_periods keeps body_mass_kg metric-labeled and unconverted by default', () => {
  const viz = buildCoachViz('compare_periods', {
    metric: 'body_mass_kg',
    current: { mean: 81.2 },
    previous: { mean: 80.0 },
    delta: 1.2,
  }) as { unit: string; currentMean: number | null; previousMean: number | null; delta: number | null };

  assert.equal(viz.unit, 'kg');
  assert.equal(viz.currentMean, 81);
  assert.equal(viz.previousMean, 80);
  assert.equal(viz.delta, 1);
});

test('get_sleep_summary is unaffected by unitSystem', () => {
  const viz = buildCoachViz('get_sleep_summary', {
    nights: [{ date: '2026-08-01', minutes: 410 }],
    meanMinutes: 410,
    consistency: 'stable',
  }, 'imperial');
  assert.equal(viz?.kind, 'sleep');
});
