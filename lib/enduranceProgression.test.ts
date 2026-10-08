import assert from 'node:assert/strict';
import test from 'node:test';
import { longRunAtPeak, longRunStepKm, weekStepTarget, weekStepTargetKm } from './enduranceProgression';

test('weekStepTarget: ~10% over last week, at least +1, never past the target', () => {
  assert.equal(weekStepTarget(24.5, 30), 27); // round(26.95)
  assert.equal(weekStepTarget(18, 30), 20); // round(19.8)
  assert.equal(weekStepTarget(12, 30), 13); // round(13.2)
  assert.equal(weekStepTarget(5, 30), 6); // round(5.5) = 6
  assert.equal(weekStepTarget(2.2, 30), 3); // round(2.42) = 2 -> floor(2.2) + 1 = 3 so a small week still moves
  assert.equal(weekStepTarget(27, 30), 30); // 29.7 -> 30, the target itself
  assert.equal(weekStepTarget(28, 30), 30); // 30.8 -> capped at the target
  assert.equal(weekStepTarget(45, 30), 30); // above the target: the target, never more
});

test('weekStepTarget: no base to grow from (under 1 unit, not finite, unusable target) is null', () => {
  assert.equal(weekStepTarget(0, 30), null);
  assert.equal(weekStepTarget(0.9, 30), null);
  assert.equal(weekStepTarget(Number.NaN, 30), null);
  assert.equal(weekStepTarget(10, 0), null);
  assert.equal(weekStepTarget(10, Number.POSITIVE_INFINITY), null);
});

test('weekStepTargetKm: km in, km out; the step is rounded in the display unit', () => {
  assert.equal(weekStepTargetKm(24.5, 30), 27);
  assert.equal(weekStepTargetKm(0.5, 30), null);
  // Miles: 24.5 km = 15.2 mi -> 17 mi = 27.36 km; the 30 km target = 18.64 mi is not reached.
  const MI_PER_KM = 1 / 1.609344;
  const step = weekStepTargetKm(24.5, 30, MI_PER_KM)!;
  assert.ok(Math.abs(step * MI_PER_KM - 17) < 1e-9, `${step}`);
  // Reaching the target returns the target exactly (no float round trip).
  assert.equal(weekStepTargetKm(28, 30, MI_PER_KM), 30);
  assert.equal(weekStepTargetKm(10, 30, 0), null);
});

test('longRunStepKm: +2 km at most, never past the peak target, held at the peak', () => {
  assert.equal(longRunStepKm(14, 18), 16);
  assert.equal(longRunStepKm(17, 18), 18); // only 1 km of room
  assert.equal(longRunStepKm(18, 18), 18); // at the peak: hold
  assert.equal(longRunStepKm(20, 18), 18); // past the peak: back to it
  assert.equal(longRunStepKm(14, null), 16); // no peak target: +2 km
  assert.equal(longRunStepKm(14.3, undefined), 16.3);
  assert.equal(longRunAtPeak(18, 18), true);
  assert.equal(longRunAtPeak(17, 18), false);
  assert.equal(longRunAtPeak(30, null), false);
});
