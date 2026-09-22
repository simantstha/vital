import assert from 'node:assert/strict';
import test from 'node:test';
import { lbToKg, parseWorkoutPhrase } from './workoutParse';

test('"3 by 5 squat at 225" — "by" sets pattern, bare (lb-default) load', () => {
  const result = parseWorkoutPhrase('3 by 5 squat at 225');
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

test('"3x5 squats 225 lb" — "x" sets pattern, explicit lb unit', () => {
  const result = parseWorkoutPhrase('3x5 squats 225 lb');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'squat');
  assert.equal(result.sets.length, 3);
  assert.equal(result.sets[0].reps, 5);
  assert.equal(Math.round((result.sets[0].loadKg ?? 0) * 100) / 100, Math.round(lbToKg(225) * 100) / 100);
});

test('"bench 5 sets of 5 at 100 kg" — "sets of" pattern, explicit kg unit, alias "bench"', () => {
  const result = parseWorkoutPhrase('bench 5 sets of 5 at 100 kg');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'bench press');
  assert.equal(result.sets.length, 5);
  assert.equal(result.sets[0].reps, 5);
  assert.equal(result.sets[0].loadKg, 100);
});

test('"deadlift 1x5 @ 140kg rpe 8" — RPE + no-space kg unit + alias "dl" family', () => {
  const result = parseWorkoutPhrase('deadlift 1x5 @ 140kg rpe 8');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'deadlift');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].reps, 5);
  assert.equal(result.sets[0].loadKg, 140);
  assert.equal(result.sets[0].rpe, 8);
});

test('"dl 1x5 @ 140kg" — "dl" alias resolves to deadlift', () => {
  const result = parseWorkoutPhrase('dl 1x5 @ 140kg');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'deadlift');
});

test('"20 pushups" — bare rep count, bodyweight (no load)', () => {
  const result = parseWorkoutPhrase('20 pushups');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'push-up');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].reps, 20);
  assert.equal(result.sets[0].loadKg, null);
});

test('"3x10 pull-ups" — bodyweight multi-set, hyphenated exercise name', () => {
  const result = parseWorkoutPhrase('3x10 pull-ups');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'pull-up');
  assert.equal(result.sets.length, 3);
  assert.equal(result.sets[0].reps, 10);
  assert.equal(result.sets[0].loadKg, null);
});

test('pull-up and chin-up stay distinct canonical exercises (never merged)', () => {
  const pullups = parseWorkoutPhrase('3x8 pull-ups');
  const chinups = parseWorkoutPhrase('3x8 chin-ups');
  assert.equal(pullups.ok, true);
  assert.equal(chinups.ok, true);
  if (!pullups.ok || !chinups.ok) return;
  assert.equal(pullups.exercise, 'pull-up');
  assert.equal(chinups.exercise, 'chin-up');
  assert.notEqual(pullups.exercise, chinups.exercise);
});

test('squat and front squat stay distinct canonical exercises', () => {
  const squat = parseWorkoutPhrase('3x5 squat at 225');
  const frontSquat = parseWorkoutPhrase('3x5 front squat at 185');
  assert.equal(squat.ok, true);
  assert.equal(frontSquat.ok, true);
  if (!squat.ok || !frontSquat.ok) return;
  assert.equal(squat.exercise, 'squat');
  assert.equal(frontSquat.exercise, 'front squat');
});

test('"ohp" alias resolves to overhead press', () => {
  const result = parseWorkoutPhrase('ohp 3x5 at 95');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'overhead press');
});

test('ambiguous bare "press" asks for clarification instead of guessing', () => {
  const result = parseWorkoutPhrase('3x5 press at 135');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'ambiguous');
  assert.ok(result.candidates.includes('bench press'));
  assert.ok(result.candidates.includes('overhead press'));
});

test('unrecognized exercise name returns a no-guess miss, not a made-up exercise', () => {
  const result = parseWorkoutPhrase('3x5 zorbulate at 100kg');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_exercise');
});

test('missing rep count returns a no-guess miss', () => {
  const result = parseWorkoutPhrase('squat at 225');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_reps');
});

test('empty input is rejected', () => {
  const result = parseWorkoutPhrase('   ');
  assert.equal(result.ok, false);
});

test('defaultLoadUnit option flips the bare-number default to kg', () => {
  const result = parseWorkoutPhrase('3x5 squat at 100', { defaultLoadUnit: 'kg' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sets[0].loadKg, 100);
});

test('"squats" (plural, no set count) still resolves via bare-rep fallback', () => {
  const result = parseWorkoutPhrase('squats 12');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exercise, 'squat');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].reps, 12);
});

test('lbToKg matches the standard conversion factor', () => {
  assert.equal(Math.round(lbToKg(225) * 1000) / 1000, 102.058);
});
