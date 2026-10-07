import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalExercise } from './exerciseCanonical';

const TABLE: Array<[string, string, string]> = [
  ['bench', 'bench press', 'Bench Press'],
  ['Bench', 'bench press', 'Bench Press'],
  ['bench press', 'bench press', 'Bench Press'],
  ['Bench Presses', 'bench press', 'Bench Press'],
  ['barbell bench', 'bench press', 'Bench Press'],
  ['bb bench', 'bench press', 'Bench Press'],
  ['flat bench press', 'bench press', 'Bench Press'],
  ['db bench', 'dumbbell bench press', 'Dumbbell Bench Press'],
  ['dumbbell bench press', 'dumbbell bench press', 'Dumbbell Bench Press'],
  ['DB Bench Press', 'dumbbell bench press', 'Dumbbell Bench Press'],
  ['incline bench', 'incline bench press', 'Incline Bench Press'],
  ['incline db bench press', 'incline dumbbell bench press', 'Incline Dumbbell Bench Press'],
  ['close-grip bench press', 'close-grip bench press', 'Close-Grip Bench Press'],
  ['close grip bench', 'close-grip bench press', 'Close-Grip Bench Press'],
  ['squat', 'squat', 'Squat'],
  ['back squats', 'squat', 'Squat'],
  ['front squat', 'front squat', 'Front Squat'],
  ['bulgarian split squat', 'bulgarian split squat', 'Bulgarian Split Squat'],
  ['split squat', 'split squat', 'Split Squat'],
  ['deadlift', 'deadlift', 'Deadlift'],
  ['DL', 'deadlift', 'Deadlift'],
  ['romanian deadlift', 'romanian deadlift', 'Romanian Deadlift'],
  ['RDL', 'romanian deadlift', 'Romanian Deadlift'],
  ['sumo deadlift', 'sumo deadlift', 'Sumo Deadlift'],
  ['hammer curl', 'hammer curl', 'Hammer Curl'],
  ['curl', 'bicep curl', 'Bicep Curl'],
  ['db curl', 'dumbbell curl', 'Dumbbell Curl'],
  ['pull-ups', 'pull-up', 'Pull-Up'],
  ['chin up', 'chin-up', 'Chin-Up'],
  ['OHP', 'overhead press', 'Overhead Press'],
  ['lateral raises', 'lateral raise', 'Lateral Raise'],
  ['kb swing', 'kettlebell swing', 'Kettlebell Swing'],
  ['kettlebell swing', 'kettlebell swing', 'Kettlebell Swing'],
  ['  Cable   Fly!! ', 'cable fly', 'Cable Fly'],
  ['Zorbulate', 'zorbulate', 'Zorbulate'],
];

for (const [input, key, display] of TABLE) {
  test(`canonicalExercise(${JSON.stringify(input)}) -> ${key}`, () => {
    assert.deepEqual(canonicalExercise(input), { key, display });
  });
}

test('empty / punctuation-only names yield an empty key', () => {
  assert.equal(canonicalExercise('').key, '');
  assert.equal(canonicalExercise(' -- ').key, '');
});

test('is idempotent on its own output', () => {
  for (const [input] of TABLE) {
    const once = canonicalExercise(input);
    assert.deepEqual(canonicalExercise(once.key), once);
    assert.deepEqual(canonicalExercise(once.display), once);
  }
});
