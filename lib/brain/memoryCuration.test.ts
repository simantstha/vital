import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCurationBlock } from './memoryCuration';
import { assemblePersona } from './persona';

test('memoryCurationBlock returns empty string when no memory tool is available', () => {
  assert.equal(memoryCurationBlock([]), '');
  assert.equal(memoryCurationBlock(['calculate_macros', 'log_meal']), '');
});

test('a specialist allowlist emits the confirmation-threshold rule but never mentions tools it cannot call', () => {
  const block = memoryCurationBlock(['propose_fact', 'confirm_fact']);
  assert.notEqual(block, '');
  assert.match(block, /confirmation threshold/i);
  assert.doesNotMatch(block, /remember_fact/);
  assert.doesNotMatch(block, /resolve_fact/);
  assert.doesNotMatch(block, /query_ontology/);
});

test('the full coach allowlist emits all six memory-curation rules', () => {
  const block = memoryCurationBlock([
    'query_ontology',
    'propose_fact',
    'remember_fact',
    'confirm_fact',
    'resolve_fact',
  ]);
  assert.match(block, /durable facts/i); // 1. salience
  assert.match(block, /query_ontology/); // 2. check before write
  assert.match(block, /resolve_fact/); // 3. retract, don't duplicate
  assert.match(block, /confirmation threshold/i); // 4. confirmation thresholds
  assert.match(block, /remember_fact/); // 4. mentions remember_fact once both tools are present
  assert.match(block, /verbatim quote/i); // 5. evidence discipline
  assert.match(block, /family members/i); // 6. third-party health data
});

test('assemblePersona keeps hard constraints as the final block even with a memory curation block present', () => {
  const system = assemblePersona(
    [{ id: 'n1', user_id: 'u1', type: 'Allergy', label: 'Peanuts', weight: 1, properties: {} } as never],
    undefined,
    false,
    undefined,
    'metric',
    ['query_ontology', 'propose_fact', 'remember_fact', 'confirm_fact', 'resolve_fact'],
  );
  const curationIdx = system.indexOf('## Memory curation');
  const constraintsIdx = system.indexOf('## Hard constraints');
  assert.ok(curationIdx > -1 && constraintsIdx > -1);
  assert.ok(curationIdx < constraintsIdx, 'hard constraints must come last so they shadow the curation block');
});

test('baseCoachVoice no longer duplicates the memory rules moved into memoryCurationBlock', () => {
  const system = assemblePersona([], undefined, false, undefined, 'metric', [
    'query_ontology',
    'propose_fact',
    'remember_fact',
    'confirm_fact',
    'resolve_fact',
  ]);
  const matches = system.match(/Retract, don't duplicate/g) ?? [];
  assert.equal(matches.length, 1, 'the retraction rule should appear exactly once in the assembled prompt');
});
