import assert from 'node:assert/strict';
import test from 'node:test';
import { lbToKg, parseWorkoutPhrase } from './workoutParse';

test('"3 by 5 squat at 225" — "by" sets pattern, bare load resolved against defaultUnit: lb', () => {
  const result = parseWorkoutPhrase('3 by 5 squat at 225', { defaultUnit: 'lb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'squat');
  assert.equal(result.sets.length, 3);
  for (const set of result.sets) {
    assert.equal(set.reps, 5);
    assert.equal(Math.round((set.loadKg ?? 0) * 100) / 100, Math.round(lbToKg(225) * 100) / 100);
    assert.equal(set.rpe, null);
  }
});

test('bare-load default unit is NOT hardcoded to lb: a metric user\'s bare number stays in kg', () => {
  const imperial = parseWorkoutPhrase('3x5 squat at 100', { defaultUnit: 'lb' });
  const metric = parseWorkoutPhrase('3x5 squat at 100', { defaultUnit: 'kg' });
  assert.equal(imperial.ok, true);
  assert.equal(metric.ok, true);
  if (!imperial.ok || !metric.ok) return;
  assert.equal(metric.sets[0].loadKg, 100); // no conversion — already kg
  assert.equal(Math.round((imperial.sets[0].loadKg ?? 0) * 100) / 100, Math.round(lbToKg(100) * 100) / 100);
  assert.notEqual(imperial.sets[0].loadKg, metric.sets[0].loadKg);
});

test('an explicit unit in the text always overrides defaultUnit', () => {
  // Text says kg explicitly; defaultUnit is lb — the explicit unit must win.
  const result = parseWorkoutPhrase('3x5 squat at 100 kg', { defaultUnit: 'lb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sets[0].loadKg, 100);

  // Text says lb explicitly; defaultUnit is kg — the explicit unit must still win.
  const result2 = parseWorkoutPhrase('3x5 squat at 100 lb', { defaultUnit: 'kg' });
  assert.equal(result2.ok, true);
  if (!result2.ok) return;
  assert.equal(Math.round((result2.sets[0].loadKg ?? 0) * 100) / 100, Math.round(lbToKg(100) * 100) / 100);
});

test('"3x5 squats 225 lb" — "x" sets pattern, explicit lb unit (defaultUnit irrelevant)', () => {
  const result = parseWorkoutPhrase('3x5 squats 225 lb', { defaultUnit: 'kg' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'squat');
  assert.equal(result.sets.length, 3);
  assert.equal(result.sets[0].reps, 5);
  assert.equal(Math.round((result.sets[0].loadKg ?? 0) * 100) / 100, Math.round(lbToKg(225) * 100) / 100);
});

test('"bench 5 sets of 5 at 100 kg" — "sets of" pattern, explicit kg unit, alias "bench"', () => {
  const result = parseWorkoutPhrase('bench 5 sets of 5 at 100 kg', { defaultUnit: 'lb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'bench press');
  assert.equal(result.sets.length, 5);
  assert.equal(result.sets[0].reps, 5);
  assert.equal(result.sets[0].loadKg, 100);
});

test('"deadlift 1x5 @ 140kg rpe 8" — RPE + no-space kg unit + alias "dl" family', () => {
  const result = parseWorkoutPhrase('deadlift 1x5 @ 140kg rpe 8', { defaultUnit: 'lb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'deadlift');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].reps, 5);
  assert.equal(result.sets[0].loadKg, 140);
  assert.equal(result.sets[0].rpe, 8);
});

test('"dl 1x5 @ 140kg" — "dl" alias resolves to deadlift', () => {
  const result = parseWorkoutPhrase('dl 1x5 @ 140kg', { defaultUnit: 'lb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'deadlift');
});

test('"20 pushups" — bare rep count, bodyweight (no load, defaultUnit unused)', () => {
  const result = parseWorkoutPhrase('20 pushups', { defaultUnit: 'kg' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'push-up');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].reps, 20);
  assert.equal(result.sets[0].loadKg, null);
});

test('"3x10 pull-ups" — bodyweight multi-set, hyphenated exercise name', () => {
  const result = parseWorkoutPhrase('3x10 pull-ups', { defaultUnit: 'kg' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'pull-up');
  assert.equal(result.sets.length, 3);
  assert.equal(result.sets[0].reps, 10);
  assert.equal(result.sets[0].loadKg, null);
});

test('pull-up and chin-up stay distinct canonical exercises (never merged)', () => {
  const pullups = parseWorkoutPhrase('3x8 pull-ups', { defaultUnit: 'kg' });
  const chinups = parseWorkoutPhrase('3x8 chin-ups', { defaultUnit: 'kg' });
  assert.equal(pullups.ok, true);
  assert.equal(chinups.ok, true);
  if (!pullups.ok || !chinups.ok) return;
  assert.equal(pullups.exercise, 'pull-up');
  assert.equal(chinups.exercise, 'chin-up');
  assert.notEqual(pullups.exercise, chinups.exercise);
});

test('squat and front squat stay distinct canonical exercises', () => {
  const squat = parseWorkoutPhrase('3x5 squat at 225', { defaultUnit: 'lb' });
  const frontSquat = parseWorkoutPhrase('3x5 front squat at 185', { defaultUnit: 'lb' });
  assert.equal(squat.ok, true);
  assert.equal(frontSquat.ok, true);
  if (!squat.ok || !frontSquat.ok) return;
  assert.equal(squat.exercise, 'squat');
  assert.equal(frontSquat.exercise, 'front squat');
});

test('"ohp" alias resolves to overhead press', () => {
  const result = parseWorkoutPhrase('ohp 3x5 at 95', { defaultUnit: 'lb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'overhead press');
});

test('ambiguous bare "press" asks for clarification instead of guessing', () => {
  const result = parseWorkoutPhrase('3x5 press at 135', { defaultUnit: 'lb' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'ambiguous');
  assert.ok(result.candidates.includes('bench press'));
  assert.ok(result.candidates.includes('overhead press'));
});

test('unrecognized exercise name returns a no-guess miss, not a made-up exercise', () => {
  const result = parseWorkoutPhrase('3x5 zorbulate at 100kg', { defaultUnit: 'kg' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_exercise');
});

test('missing rep count returns a no-guess miss', () => {
  const result = parseWorkoutPhrase('squat at 225', { defaultUnit: 'lb' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_reps');
});

test('empty input is rejected', () => {
  const result = parseWorkoutPhrase('   ', { defaultUnit: 'kg' });
  assert.equal(result.ok, false);
});

test('"squats" (plural, no set count) still resolves via bare-rep fallback', () => {
  const result = parseWorkoutPhrase('squats 12', { defaultUnit: 'kg' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'squat');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].reps, 12);
});

test('lbToKg matches the standard conversion factor', () => {
  assert.equal(Math.round(lbToKg(225) * 1000) / 1000, 102.058);
});
