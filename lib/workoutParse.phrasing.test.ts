import assert from 'node:assert/strict';
import test from 'node:test';
import { lbToKg, parseWorkoutPhrase } from './workoutParse';

function p(text: string, unit: 'kg' | 'lb' = 'lb') {
  const r = parseWorkoutPhrase(text, { defaultUnit: unit });
  assert.equal(r.ok, true, text);
  if (!r.ok) throw new Error('unreachable');
  return r;
}

const kg225 = Math.round(lbToKg(225) * 100) / 100;

test('"bench 225x5" is load x reps (one set), not 225 sets', () => {
  const r = p('bench 225x5');
  assert.equal(r.exercise, 'bench press');
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].reps, 5);
  assert.equal(r.sets[0].loadKg, kg225);
});

test('"bench 225 for 5" is load for reps', () => {
  const r = p('bench 225 for 5');
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].reps, 5);
  assert.equal(r.sets[0].loadKg, kg225);
});

test('"squat 225 x 5 x 3" is load x reps x sets', () => {
  const r = p('squat 225 x 5 x 3');
  assert.equal(r.sets.length, 3);
  assert.equal(r.sets[0].reps, 5);
  assert.equal(r.sets[0].loadKg, kg225);
});

test('explicit unit makes the leading number a load even when small', () => {
  const r = p('squat 15 kg x 8');
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].reps, 8);
  assert.equal(r.sets[0].loadKg, 15);
});

test('small N x M stays sets x reps: "3x10 at 60"', () => {
  const r = p('squat 3x10 at 60', 'kg');
  assert.equal(r.sets.length, 3);
  assert.equal(r.sets[0].reps, 10);
  assert.equal(r.sets[0].loadKg, 60);
});

test('"DB bench 3x10 at 60" keeps dumbbell bench distinct', () => {
  const r = p('DB bench 3x10 at 60', 'kg');
  assert.equal(r.exercise, 'dumbbell bench press');
  assert.equal(r.exerciseDisplay, 'Dumbbell Bench Press');
  assert.equal(r.sets.length, 3);
});

test('"lateral raise 3x12 at 20" parses', () => {
  const r = p('lateral raise 3x12 at 20', 'kg');
  assert.equal(r.exercise, 'lateral raise');
  assert.equal(r.sets.length, 3);
  assert.equal(r.sets[0].loadKg, 20);
});

test('descriptive words still fold into the base lift', () => {
  assert.equal(p('heavy bench press 5x5').exercise, 'bench press');
});

test('qualified unknown phrase does not fold into base lift', () => {
  assert.equal(p('paused tempo bench 3x5').exercise, 'paused tempo bench');
});

test('sets are capped at 10 with a clear message', () => {
  assert.equal(p('squat 10x5 at 100', 'kg').sets.length, 10);
  const bad = parseWorkoutPhrase('squat 11x5 at 100', { defaultUnit: 'kg' });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.reason, 'too_many_sets');
  assert.match(bad.message, /10/);
});
