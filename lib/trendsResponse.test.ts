import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTrendsBatch } from './trendsResponse';
import type { MetricPointRow, MetricDataDaysRow, BaselineSnapshot } from './brain/tools';
import type { BaselineStats } from './brain/baselines';

/**
 * Unit tests for lib/trendsResponse.ts — pure, no DATABASE_URL required.
 * buildTrendsBatch() takes already-fetched rows (as app/api/trends/route.ts
 * would produce them) and does zero I/O itself.
 */

function stats(overrides: Partial<BaselineStats> = {}): BaselineStats {
  return { mean7: 47, mean30: 46, mean60: 45, sd30: 5, p25: 42, p50: 46, p75: 50, ...overrides };
}

test('every requested-and-known metric gets a key even with zero points', () => {
  const result = buildTrendsBatch({
    requested: ['vo2_max'],
    points: [],
    baselines: [],
    dayCounts: [],
  });
  assert.ok('vo2_max' in result.series);
  assert.deepEqual(result.series.vo2_max.points, []);
  assert.equal(result.series.vo2_max.baseline, null);
  assert.equal(result.series.vo2_max.dataDays, 0);
  assert.equal(result.series.vo2_max.established, false);
  assert.equal(result.series.vo2_max.lastDate, null);
  assert.deepEqual(result.unknownMetrics, []);
});

test('unknown metric names are dropped from series and echoed in unknownMetrics, never thrown', () => {
  const points: MetricPointRow[] = [{ metric: 'hrv_sdnn', date: '2026-08-01', value: 48 }];
  const result = buildTrendsBatch({
    requested: ['hrv_sdnn', 'not_a_real_metric'],
    points,
    baselines: [],
    dayCounts: [],
  });
  assert.ok('hrv_sdnn' in result.series);
  assert.ok(!('not_a_real_metric' in result.series));
  assert.deepEqual(result.unknownMetrics, ['not_a_real_metric']);
});

test('manual weight overlay wins per-day over the daily_metrics point for body_mass_kg', () => {
  const points: MetricPointRow[] = [
    { metric: 'body_mass_kg', date: '2026-08-01', value: 80.0 },
    { metric: 'body_mass_kg', date: '2026-08-02', value: 80.2 },
  ];
  const manualWeight = new Map([['2026-08-01', 79.1]]); // manual entry overrides HealthKit for this date
  const result = buildTrendsBatch({
    requested: ['body_mass_kg'],
    points,
    baselines: [],
    dayCounts: [],
    manualWeight,
  });
  const byDate = new Map(result.series.body_mass_kg.points.map((p) => [p.date, p.value]));
  assert.equal(byDate.get('2026-08-01'), 79.1); // manual wins
  assert.equal(byDate.get('2026-08-02'), 80.2); // untouched HealthKit day stays
});

test('points are sorted oldest -> newest regardless of input order', () => {
  const points: MetricPointRow[] = [
    { metric: 'steps', date: '2026-08-03', value: 9000 },
    { metric: 'steps', date: '2026-08-01', value: 8000 },
    { metric: 'steps', date: '2026-08-02', value: 8500 },
  ];
  const result = buildTrendsBatch({ requested: ['steps'], points, baselines: [], dayCounts: [] });
  assert.deepEqual(result.series.steps.points.map((p) => p.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('established is recomputed from fresh dataDays, overriding a stale baselines.established snapshot', () => {
  const baselines: BaselineSnapshot[] = [
    { metric: 'hrv_sdnn', stats: stats(), established: false, dataDays: 3 }, // stale/false in the snapshot
  ];
  const dayCounts: MetricDataDaysRow[] = [
    { metric: 'hrv_sdnn', dataDays: 20, lastDate: '2026-08-13' }, // fresh count says established
  ];
  const result = buildTrendsBatch({ requested: ['hrv_sdnn'], points: [], baselines, dayCounts });
  assert.equal(result.series.hrv_sdnn.established, true);
  assert.equal(result.series.hrv_sdnn.dataDays, 20);
});

test('baseline stats are converted to display units and stay independently nullable', () => {
  const baselines: BaselineSnapshot[] = [
    {
      metric: 'sleep_minutes',
      stats: { mean7: 420, mean30: 450, mean60: null, sd30: 48, p25: null, p50: 450, p75: null },
      established: true,
      dataDays: 62,
    },
  ];
  const dayCounts: MetricDataDaysRow[] = [{ metric: 'sleep_minutes', dataDays: 62, lastDate: '2026-08-13' }];
  const result = buildTrendsBatch({ requested: ['sleep_minutes'], points: [], baselines, dayCounts });
  assert.deepEqual(result.series.sleep_minutes.baseline, {
    mean7: 7, mean30: 7.5, mean60: null, sd30: 0.8, p25: null, p50: 7.5, p75: null,
  });
});

test('baseline is null when no baselines row exists for the metric', () => {
  const result = buildTrendsBatch({ requested: ['resting_hr'], points: [], baselines: [], dayCounts: [] });
  assert.equal(result.series.resting_hr.baseline, null);
});

test('a duplicate requested metric is only keyed once', () => {
  const result = buildTrendsBatch({
    requested: ['hrv_sdnn', 'hrv_sdnn'],
    points: [{ metric: 'hrv_sdnn', date: '2026-08-01', value: 48 }],
    baselines: [],
    dayCounts: [],
  });
  assert.deepEqual(Object.keys(result.series), ['hrv_sdnn']);
});

test('multiple metrics assemble independently in one call', () => {
  const points: MetricPointRow[] = [
    { metric: 'hrv_sdnn', date: '2026-08-01', value: 48 },
    { metric: 'steps', date: '2026-08-01', value: 8234.7 },
  ];
  const dayCounts: MetricDataDaysRow[] = [
    { metric: 'hrv_sdnn', dataDays: 30, lastDate: '2026-08-01' },
    { metric: 'steps', dataDays: 5, lastDate: '2026-08-01' },
  ];
  const result = buildTrendsBatch({ requested: ['hrv_sdnn', 'steps'], points, baselines: [], dayCounts });
  assert.equal(result.series.hrv_sdnn.points[0].value, 48);
  assert.equal(result.series.hrv_sdnn.established, true);
  assert.equal(result.series.steps.points[0].value, 8235); // Math.round(8234.7)
  assert.equal(result.series.steps.established, false);
});
