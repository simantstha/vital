import assert from 'node:assert/strict';
import test from 'node:test';
import { assemblePersona, unitsInstructionBlock } from './persona';

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
