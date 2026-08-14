import assert from 'node:assert/strict';
import test from 'node:test';
import { METRIC_CATALOG, toDisplay, toDisplayStats, type MetricSpec } from './metricCatalog';
import type { BaselineStats } from './brain/baselines';

/**
 * Unit tests for lib/metricCatalog.ts — pure, no DATABASE_URL required (this
 * file, like lib/brain/recovery.test.ts, never imports anything that pulls
 * in @/db).
 */

// Frozen copy of the switch statement app/api/trends/route.ts used to carry
// before this PR (legacy Trends key -> transform), kept here only as a
// reference to prove toDisplay() reproduces it byte-identically. NOT
// exported from production code anymore — route.ts now calls toDisplay().
function legacyTransform(metric: string, value: number): number {
  switch (metric) {
    case 'sleep':    return Math.round((value / 60) * 10) / 10;
    case 'weight':   return Math.round(value * 10) / 10;
    case 'hrv':      return Math.round(value);
    case 'steps':    return Math.round(value);
    case 'vo2':      return Math.round(value * 10) / 10;
    case 'distance': return Math.round((value / 1000) * 100) / 100;
    case 'rhr':      return Math.round(value);
    default:         return value;
  }
}

// legacy key -> raw daily_metrics metric name (app/api/trends/route.ts's DAILY_METRIC)
const LEGACY_TO_RAW: Record<string, string> = {
  hrv:      'hrv_sdnn',
  sleep:    'sleep_minutes',
  weight:   'body_mass_kg',
  steps:    'steps',
  vo2:      'vo2_max',
  distance: 'distance_m',
  rhr:      'resting_hr',
};

test('golden table: toDisplay reproduces the old transform() for all 7 legacy metrics, byte-identically', () => {
  const samples = [47.6, 683.333, 72.34, 8234.7, 41.27, 5321, 58.6, 0, 1, 999.999];
  for (const [legacyKey, rawMetric] of Object.entries(LEGACY_TO_RAW)) {
    for (const raw of samples) {
      const expected = legacyTransform(legacyKey, raw);
      const actual = toDisplay(rawMetric, raw);
      assert.equal(actual, expected, `${legacyKey}/${rawMetric} @ raw=${raw}: expected ${expected}, got ${actual}`);
    }
  }
});

test('sleep sd30 of 48 raw minutes -> 0.8 h (the numeric proof the 60x band bug is dead)', () => {
  assert.equal(toDisplay('sleep_minutes', 48), 0.8);
});

test('toDisplayStats scales sd30 exactly like every other field, for sleep_minutes', () => {
  const stats: BaselineStats = { mean7: 420, mean30: 450, mean60: 440, sd30: 48, p25: 400, p50: 450, p75: 500 };
  const display = toDisplayStats('sleep_minutes', stats);
  assert.deepEqual(display, {
    mean7:  7,
    mean30: 7.5,
    mean60: 7.3,
    sd30:   0.8,
    p25:    6.7,
    p50:    7.5,
    p75:    8.3,
  });
});

test('toDisplayStats preserves independent nullability of each field', () => {
  const stats: BaselineStats = { mean7: 48, mean30: null, mean60: null, sd30: null, p25: null, p50: null, p75: null };
  const display = toDisplayStats('hrv_sdnn', stats);
  assert.equal(display.mean7, 48);
  assert.equal(display.mean30, null);
  assert.equal(display.sd30, null);
});

test('no spec in METRIC_CATALOG has an offset key', () => {
  for (const [metric, spec] of Object.entries(METRIC_CATALOG)) {
    assert.ok(!('offset' in (spec as MetricSpec)), `${metric} spec must not carry an offset key`);
  }
});

test('every metric in SCALAR_METRICS ∪ {sleep_minutes} ∪ whoop_* has a catalog spec', () => {
  // app/api/ingest/daily/route.ts:42-54
  const SCALAR_METRICS = [
    'hrv_sdnn', 'resting_hr', 'hr_avg', 'steps', 'active_energy_kcal',
    'body_mass_kg', 'vo2_max', 'distance_m', 'exercise_min', 'flights',
    'basal_energy_kcal',
  ];
  // lib/whoop/mapping.ts:76-119
  const WHOOP_METRICS = [
    'whoop_day_strain', 'whoop_recovery', 'whoop_hrv_rmssd', 'whoop_resting_hr',
    'whoop_spo2', 'whoop_skin_temp', 'whoop_sleep_min',
  ];
  const required = new Set([...SCALAR_METRICS, 'sleep_minutes', ...WHOOP_METRICS]);
  for (const metric of required) {
    assert.ok(METRIC_CATALOG[metric], `METRIC_CATALOG is missing a spec for "${metric}"`);
  }
  assert.equal(required.size, 19);
});

test('toDisplay throws on an unknown metric rather than silently passing the value through', () => {
  assert.throws(() => toDisplay('not_a_real_metric', 42));
});

test('distance_m scale is exactly 1/1000 (m -> km), everything else stays 1 except sleep_minutes', () => {
  for (const [metric, spec] of Object.entries(METRIC_CATALOG)) {
    if (metric === 'sleep_minutes') { assert.equal(spec.scale, 1 / 60); continue; }
    if (metric === 'distance_m')    { assert.equal(spec.scale, 1 / 1000); continue; }
    assert.equal(spec.scale, 1, `${metric} should have scale 1`);
  }
});
