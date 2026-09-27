import assert from 'node:assert/strict';
import test from 'node:test';
import {
  factOriginFromSource,
  factGroupFromType,
  validateFactLabel,
  reasonFromEvidence,
  FACT_LABEL_MAX_LENGTH,
} from './factPresentation';

// ── factOriginFromSource ─────────────────────────────────────────────────────

test('factOriginFromSource maps every known nodes.source value', () => {
  assert.equal(factOriginFromSource('coach'), 'told');
  assert.equal(factOriginFromSource('confirmed'), 'confirmed');
  assert.equal(factOriginFromSource('digest'), 'noticed');
});

test('factOriginFromSource falls back to "told" for an unknown source', () => {
  assert.equal(factOriginFromSource('mystery'), 'told');
  assert.equal(factOriginFromSource(''), 'told');
});

// ── factGroupFromType ────────────────────────────────────────────────────────

test('factGroupFromType maps every health type', () => {
  for (const type of ['Condition', 'Medication', 'Allergy', 'Intolerance', 'Injury', 'LabMarker', 'FamilyHistory']) {
    assert.equal(factGroupFromType(type), 'health', type);
  }
});

test('factGroupFromType maps goals, routines and food types', () => {
  assert.equal(factGroupFromType('Goal'), 'goals');
  assert.equal(factGroupFromType('Habit'), 'routines');
  assert.equal(factGroupFromType('FoodPreference'), 'food');
  assert.equal(factGroupFromType('Cuisine'), 'food');
  assert.equal(factGroupFromType('PantryItem'), 'food');
});

test('factGroupFromType falls back to "other" for an unrecognised type', () => {
  assert.equal(factGroupFromType('Person'), 'other');
  assert.equal(factGroupFromType('SomethingNew'), 'other');
});

// ── validateFactLabel ─────────────────────────────────────────────────────────

test('validateFactLabel trims and accepts a valid label', () => {
  const result = validateFactLabel('  Marathon runner  ');
  assert.deepEqual(result, { ok: true, label: 'Marathon runner' });
});

test('validateFactLabel rejects an empty or whitespace-only label', () => {
  assert.equal(validateFactLabel('').ok, false);
  assert.equal(validateFactLabel('   ').ok, false);
});

test('validateFactLabel rejects a non-string label', () => {
  assert.equal(validateFactLabel(undefined).ok, false);
  assert.equal(validateFactLabel(42).ok, false);
});

test('validateFactLabel accepts exactly 140 chars and rejects 141', () => {
  const ok = 'a'.repeat(FACT_LABEL_MAX_LENGTH);
  const tooLong = 'a'.repeat(FACT_LABEL_MAX_LENGTH + 1);
  assert.equal(validateFactLabel(ok).ok, true);
  assert.equal(validateFactLabel(tooLong).ok, false);
});

// ── reasonFromEvidence ────────────────────────────────────────────────────────

test('reasonFromEvidence trims and passes through short evidence', () => {
  assert.equal(reasonFromEvidence('  mentioned in chat  '), 'mentioned in chat');
});

test('reasonFromEvidence returns undefined for blank evidence', () => {
  assert.equal(reasonFromEvidence(''), undefined);
  assert.equal(reasonFromEvidence('   '), undefined);
});

test('reasonFromEvidence truncates to 140 chars', () => {
  const long = 'x'.repeat(200);
  const reason = reasonFromEvidence(long);
  assert.equal(reason?.length, 140);
  assert.equal(reason, 'x'.repeat(140));
});
