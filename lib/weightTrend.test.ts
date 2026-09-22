import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWeightTrend, type WeightReading } from './weightTrend';

/**
 * Unit tests for lib/weightTrend.ts — pure, no DATABASE_URL required.
 */

function reading(overrides: Partial<WeightReading> = {}): WeightReading {
  return {
    measuredAt: '2026-08-01T07:00:00.000Z',
    valueKg:    80,
    source:     'manual',
    localDay:   '2026-08-01',
    ...overrides,
  };
}

test('empty input returns an empty trend, not established, null deltas', () => {
  const result = computeWeightTrend([]);
  assert.deepEqual(result.days, []);
  assert.equal(result.delta7dKgPerWeek, null);
  assert.equal(result.delta30dKgPerWeek, null);
  assert.equal(result.established, false);
});

test('a single reading: trend equals raw, no deltas, not established', () => {
  const result = computeWeightTrend([reading({ valueKg: 82.3 })]);
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].rawKg, 82.3);
  assert.equal(result.days[0].trendKg, 82.3);
  assert.equal(result.delta7dKgPerWeek, null);
  assert.equal(result.delta30dKgPerWeek, null);
  assert.equal(result.established, false);
});

test('unsorted input is sorted by localDay before smoothing', () => {
  const readings = [
    reading({ localDay: '2026-08-03', measuredAt: '2026-08-03T07:00:00.000Z', valueKg: 80.5 }),
    reading({ localDay: '2026-08-01', measuredAt: '2026-08-01T07:00:00.000Z', valueKg: 82 }),
    reading({ localDay: '2026-08-02', measuredAt: '2026-08-02T07:00:00.000Z', valueKg: 81 }),
  ];
  const result = computeWeightTrend(readings);
  assert.deepEqual(result.days.map((d) => d.day), ['2026-08-01', '2026-08-02', '2026-08-03']);
  // First day anchors the trend to raw; subsequent days pull toward their raw value.
  assert.equal(result.days[0].trendKg, 82);
  assert.ok(result.days[1].trendKg < 82 && result.days[1].trendKg > 81);
});

test('consistent daily readings trending down: trend tracks the decline smoothly', () => {
  const readings: WeightReading[] = [];
  const start = 90;
  for (let i = 0; i < 14; i++) {
    const day = `2026-08-${String(i + 1).padStart(2, '0')}`;
    readings.push(reading({ localDay: day, measuredAt: `${day}T07:00:00.000Z`, valueKg: start - i * 0.1 }));
  }
  const result = computeWeightTrend(readings);
  assert.equal(result.days.length, 14);
  // Trend should be tracking the (noise-free) raw line with a steady lag —
  // EWMA lags a constant linear slope by roughly (1-alpha)/alpha * step.
  const last = result.days[result.days.length - 1];
  assert.ok(Math.abs(last.trendKg - last.rawKg) < 1.5);
  assert.ok(result.established); // 14 days, way past the 3-readings/5-days gate
  assert.ok(result.delta7dKgPerWeek! < 0); // losing weight → negative kg/week
});

test('a gap between readings compounds alpha rather than treating it as one day', () => {
  const readings = [
    reading({ localDay: '2026-08-01', measuredAt: '2026-08-01T07:00:00.000Z', valueKg: 90 }),
    // 20-day gap, then a much lower reading.
    reading({ localDay: '2026-08-21', measuredAt: '2026-08-21T07:00:00.000Z', valueKg: 85 }),
  ];
  const result = computeWeightTrend(readings);
  // After a 20-day gap with alpha=0.1, effective alpha = 1-(0.9)^20 ≈ 0.878 —
  // the trend should land very close to the new raw value, not still be
  // anchored near 90.
  const last = result.days[result.days.length - 1];
  assert.ok(Math.abs(last.trendKg - 85) < 1);
});

test('a same-day collision between manual and healthkit readings prefers manual', () => {
  const readings = [
    reading({ source: 'healthkit', valueKg: 79.0, measuredAt: '2026-08-01T00:00:00.000Z' }),
    reading({ source: 'manual', valueKg: 80.5, measuredAt: '2026-08-01T13:00:00.000Z' }),
  ];
  const result = computeWeightTrend(readings);
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].rawKg, 80.5); // manual wins even though it's the later timestamp
});

test('a same-day collision between two manual readings prefers the earliest', () => {
  const readings = [
    reading({ source: 'manual', valueKg: 81.0, measuredAt: '2026-08-01T18:00:00.000Z' }),
    reading({ source: 'manual', valueKg: 80.2, measuredAt: '2026-08-01T07:00:00.000Z' }),
  ];
  const result = computeWeightTrend(readings);
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].rawKg, 80.2); // earliest (morning) reading wins
});

test('duplicate readings (same day, same source, same value) collapse to one day, not double-counted', () => {
  const readings = [
    reading({ measuredAt: '2026-08-01T07:00:00.000Z' }),
    reading({ measuredAt: '2026-08-01T07:00:00.000Z' }),
  ];
  const result = computeWeightTrend(readings);
  assert.equal(result.days.length, 1);
});

test('is unit-agnostic: only valueKg matters, callers convert before calling in', () => {
  // 176 lb == 79.83 kg; the function itself has no notion of "unit" at all —
  // it just consumes whatever kg number it's handed.
  const result = computeWeightTrend([reading({ valueKg: 79.83 })]);
  assert.equal(result.days[0].rawKg, 79.83);
});

test('established gates on >= 3 distinct days spanning >= 5 calendar days', () => {
  const twoClose = computeWeightTrend([
    reading({ localDay: '2026-08-01', measuredAt: '2026-08-01T07:00:00.000Z' }),
    reading({ localDay: '2026-08-02', measuredAt: '2026-08-02T07:00:00.000Z' }),
  ]);
  assert.equal(twoClose.established, false); // only 2 days

  const threeCloseTogether = computeWeightTrend([
    reading({ localDay: '2026-08-01', measuredAt: '2026-08-01T07:00:00.000Z' }),
    reading({ localDay: '2026-08-02', measuredAt: '2026-08-02T07:00:00.000Z' }),
    reading({ localDay: '2026-08-03', measuredAt: '2026-08-03T07:00:00.000Z' }),
  ]);
  assert.equal(threeCloseTogether.established, false); // 3 days but only a 2-day span

  const threeSpreadOut = computeWeightTrend([
    reading({ localDay: '2026-08-01', measuredAt: '2026-08-01T07:00:00.000Z' }),
    reading({ localDay: '2026-08-03', measuredAt: '2026-08-03T07:00:00.000Z' }),
    reading({ localDay: '2026-08-06', measuredAt: '2026-08-06T07:00:00.000Z' }),
  ]);
  assert.equal(threeSpreadOut.established, true); // 3 days, 5-day span
});

test('a custom alpha changes how fast the trend reacts', () => {
  const readings = [
    reading({ localDay: '2026-08-01', measuredAt: '2026-08-01T07:00:00.000Z', valueKg: 90 }),
    reading({ localDay: '2026-08-02', measuredAt: '2026-08-02T07:00:00.000Z', valueKg: 80 }),
  ];
  const slow = computeWeightTrend(readings, { alpha: 0.05 });
  const fast = computeWeightTrend(readings, { alpha: 0.5 });
  // A larger alpha should pull the trend further toward the new raw value.
  assert.ok(fast.days[1].trendKg < slow.days[1].trendKg);
});
