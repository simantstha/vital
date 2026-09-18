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

test('the retract-guidance rule is absent when resolve_fact is not in the allowlist', () => {
  const block = memoryCurationBlock(['propose_fact', 'confirm_fact', 'remember_fact', 'query_ontology']);
  assert.doesNotMatch(block, /resolve_fact/);
  assert.doesNotMatch(block, /Retract, don't duplicate/);
  assert.doesNotMatch(block, /do it this turn/i);
  assert.doesNotMatch(block, /NEVER VIOLATE constraint/);
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
  assert.match(block, /do it this turn/i); // 3. turn-bound obligation
  assert.match(block, /NEVER VIOLATE constraint/); // 3. consequence of leaving a fact active
  assert.match(block, /grounding standard/i); // 3. tied to the grounding guardrail
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

test('hardConstraintsInjector filters out a third-party fact even if the caller forgot to (defense in depth)', () => {
  const system = assemblePersona([
    { id: 'n1', user_id: 'u1', type: 'Allergy', label: 'Peanuts', weight: 1, properties: {}, subject_node_id: null } as never,
    { id: 'n2', user_id: 'u1', type: 'Condition', label: 'Type 2 diabetes', weight: 0.6, properties: {}, subject_node_id: 'father-entity' } as never,
  ]);
  const hardBlock = system.slice(system.indexOf('## Hard constraints'));

  assert.match(hardBlock, /Peanuts/);
  assert.doesNotMatch(hardBlock, /Type 2 diabetes/);
});

test('memoryCurationBlock emits entity-filing rules only when remember_fact is available', () => {
  const specialistBlock = memoryCurationBlock(['propose_fact', 'confirm_fact']);
  assert.doesNotMatch(specialistBlock, /Entity filing/);
  assert.doesNotMatch(specialistBlock, /Instances, not structure/);
  assert.match(specialistBlock, /isn't the user's memory to keep/);

  const coachBlock = memoryCurationBlock(['query_ontology', 'propose_fact', 'remember_fact', 'confirm_fact', 'resolve_fact']);
  assert.match(coachBlock, /Entity filing/);
  assert.match(coachBlock, /Instances, not structure/);
  assert.match(coachBlock, /belongs to them, not the user/);
  assert.doesNotMatch(coachBlock, /isn't the user's memory to keep/);
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

test('memoryCurationBlock emits read_entity rule only when read_entity tool is available', () => {
  const withoutReadEntity = memoryCurationBlock(['propose_fact', 'confirm_fact']);
  assert.doesNotMatch(withoutReadEntity, /read_entity/);

  const withReadEntity = memoryCurationBlock([
    'query_ontology',
    'propose_fact',
    'remember_fact',
    'confirm_fact',
    'resolve_fact',
    'read_entity',
  ]);
  assert.match(withReadEntity, /read_entity/);
  assert.match(withReadEntity, /answering a question about a specific person/i);
  assert.match(withReadEntity, /full picture/i);
});

test('read_entity rule warns against inferring from roster line alone', () => {
  const block = memoryCurationBlock(['read_entity']);
  assert.match(block, /Never infer detail from the entity roster line alone/i);
});
