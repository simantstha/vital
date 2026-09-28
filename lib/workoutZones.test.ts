import assert from 'node:assert/strict';
import test from 'node:test';
import { zonesFromHrSeries } from './workoutZones';

test('zonesFromHrSeries: buckets a flat series entirely into one zone', () => {
  // restingHr 50, maxHr 190 -> reserve range 140. HR 120 -> (120-50)/140 = 0.50 -> zone 0 (<60%).
  const series = new Array(10).fill(120);
  const zones = zonesFromHrSeries(series, 600, 50, 190);
  assert.deepEqual(zones, [600, 0, 0, 0, 0]);
});

test('zonesFromHrSeries: splits time across zones proportionally to sample count', () => {
  // 4 samples over 400s -> 100s/sample. reserve range = 140.
  // hr=90 -> (90-50)/140=0.286 -> zone0; hr=134 -> 0.60 exactly -> zone1 (lower-inclusive);
  // hr=162 -> 0.80 exactly -> zone3 (lower-inclusive, i.e. NOT the 70-80% zone2); hr=189 -> 0.993 -> zone4.
  const series = [90, 134, 162, 189];
  const zones = zonesFromHrSeries(series, 400, 50, 190);
  assert.deepEqual(zones, [100, 100, 0, 100, 100]);
});

test('zonesFromHrSeries: zone boundaries are inclusive-lower, exclusive-upper', () => {
  // reserve exactly 0.60 -> zone1 (60-70%), not zone0.
  const hrAt60Pct = 50 + 0.60 * 140; // 134
  const zones = zonesFromHrSeries([hrAt60Pct], 60, 50, 190);
  assert.deepEqual(zones, [0, 60, 0, 0, 0]);
});

test('zonesFromHrSeries: clamps reserve outside [0,1] (a resting-below-baseline or supra-max reading)', () => {
  const zonesLow = zonesFromHrSeries([40], 60, 50, 190); // below resting -> clamp to 0
  assert.deepEqual(zonesLow, [60, 0, 0, 0, 0]);
  const zonesHigh = zonesFromHrSeries([220], 60, 50, 190); // above max -> clamp to 1
  assert.deepEqual(zonesHigh, [0, 0, 0, 0, 60]);
});

test('zonesFromHrSeries: empty series returns undefined', () => {
  assert.equal(zonesFromHrSeries([], 600, 50, 190), undefined);
});

test('zonesFromHrSeries: non-positive duration returns undefined', () => {
  assert.equal(zonesFromHrSeries([120], 0, 50, 190), undefined);
  assert.equal(zonesFromHrSeries([120], -10, 50, 190), undefined);
});

test('zonesFromHrSeries: maxHr <= restingHr returns undefined (no effort, no zones)', () => {
  assert.equal(zonesFromHrSeries([120], 600, 150, 150), undefined);
  assert.equal(zonesFromHrSeries([120], 600, 160, 150), undefined);
});

test('zonesFromHrSeries: non-finite samples are skipped rather than corrupting the total', () => {
  const zones = zonesFromHrSeries([120, NaN, 120], 300, 50, 190);
  // 3 samples over 300s -> 100s/sample; the NaN sample contributes 0 total seconds
  // (skipped), so only 200s of the 300s window is accounted for.
  assert.deepEqual(zones, [200, 0, 0, 0, 0]);
});
