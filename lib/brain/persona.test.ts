import assert from 'node:assert/strict';
import test from 'node:test';
import { assemblePersona, safetyBlock, unitsInstructionBlock } from './persona';

test('assemblePersona defaults to metric units when unitSystem is omitted', () => {
  const system = assemblePersona([]);
  assert.match(system, /chosen metric units/);
  assert.match(system, /kilometres/);
  assert.match(system, /kilograms/);
  assert.doesNotMatch(system, /chosen imperial units/);
});

test('assemblePersona threads an imperial unitSystem into the units instruction block', () => {
  const system = assemblePersona([], undefined, false, undefined, 'imperial');
  assert.match(system, /chosen imperial units/);
  assert.match(system, /miles/);
  assert.match(system, /pounds/);
});

test('the units block never tells the model to convert the protein g\\/kg dosing ratio', () => {
  const system = assemblePersona([], undefined, false, undefined, 'imperial');
  assert.match(system, /never convert that "\/kg" to "\/lb"/);
  // The nutritionist lens's ≥1.6g/kg ratio must survive untouched.
  assert.match(system, /≥1\.6g\/kg/);
});

test('hard constraints are still the final block, shadowing the units instruction', () => {
  const system = assemblePersona(
    [{ id: 'n1', user_id: 'u1', type: 'Allergy', label: 'Peanuts', weight: 1, properties: {} } as never],
    undefined,
    false,
    undefined,
    'imperial',
  );
  const unitsIdx = system.indexOf('## Units');
  const constraintsIdx = system.indexOf('## Hard constraints');
  assert.ok(unitsIdx > -1 && constraintsIdx > -1);
  assert.ok(unitsIdx < constraintsIdx, 'units block must come before hard constraints so constraints shadow it');
});

test('unitsInstructionBlock is a pure function of unitSystem', () => {
  assert.match(unitsInstructionBlock('metric'), /kilometres/);
  assert.match(unitsInstructionBlock('imperial'), /miles/);
});

test('onboarding block asks about allergies via propose_fact, not remember_fact, and keeps the original 3 questions', () => {
  const system = assemblePersona([], undefined, true, undefined, 'metric', ['propose_fact', 'remember_fact']);

  // The three original questions survive.
  assert.match(system, /what's motivating them right now/);
  assert.match(system, /schedule constraints/);
  assert.match(system, /coaching history/);

  // The new 4th question is present and the count updated.
  assert.match(system, /at most 4 short questions/);
  assert.match(system, /food allergies or intolerances/);

  // It must name propose_fact for allergy items...
  assert.match(system, /propose_fact/);
  // ...and explicitly rule out remember_fact for this purpose.
  assert.match(system, /never remember_fact/);

  // Allergy-vs-dislike distinction must be present.
  assert.match(system, /allergy and a dislike/);
  assert.match(system, /hate mushrooms/i);
});

test('onboarding block does not instruct remember_fact for allergies even when remember_fact is unavailable', () => {
  const system = assemblePersona([], undefined, true, undefined, 'metric', ['propose_fact']);
  assert.match(system, /never remember_fact/);
});

test('safetyBlock is present in normal mode', () => {
  const system = assemblePersona([]);
  assert.match(system, /## Safety/);
});

test('safetyBlock is present in onboarding mode', () => {
  const system = assemblePersona([], undefined, true);
  assert.match(system, /## Safety/);
});

test('safetyBlock is present in calibrating mode', () => {
  const calibration = {
    status: 'calibrating' as const,
    metrics: {
      hrv_sdnn: { dataDays: 3, established: false },
      resting_hr: { dataDays: 3, established: false },
      sleep_minutes: { dataDays: 3, established: false },
    },
  };
  const system = assemblePersona([], undefined, false, calibration);
  assert.match(system, /## Safety/);
});

test('safetyBlock comes after the grounding guardrail and before hard constraints', () => {
  const system = assemblePersona([]);
  const groundingIdx = system.indexOf('## Grounding');
  const safetyIdx = system.indexOf('## Safety');
  const constraintsIdx = system.indexOf('## Hard constraints');
  assert.ok(groundingIdx > -1 && safetyIdx > -1 && constraintsIdx > -1);
  assert.ok(
    groundingIdx < safetyIdx && safetyIdx < constraintsIdx,
    'expected order: grounding guardrail, then safety, then hard constraints (last, so it can shadow safety)',
  );
});

test('safetyBlock covers the 988 crisis line and the diet budget low-energy floor', () => {
  const block = safetyBlock();
  assert.match(block, /988/);
  assert.match(block, /low-energy-availability floor/);
  // Never invent a phone number other than 988.
  assert.doesNotMatch(block, /\b1-?800\b/);
});

test('safetyBlock covers scope, urgent red flags, and deferring to a clinician for pregnancy/minors/medical conditions', () => {
  const block = safetyBlock();
  assert.match(block, /non-clinical/);
  assert.match(block, /[Nn]ever diagnose/);
  assert.match(block, /chest pain/);
  assert.match(block, /Pregnancy/);
  assert.match(block, /under-18/);
});

test('assemblePersona always includes the same safetyBlock() text verbatim', () => {
  const system = assemblePersona([]);
  assert.ok(system.includes(safetyBlock()));
});
