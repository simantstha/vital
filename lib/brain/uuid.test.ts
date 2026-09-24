import assert from 'node:assert/strict';
import test from 'node:test';
import { isUuid } from './uuid';

test('isUuid accepts a canonical lowercase uuid', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
});

test('isUuid accepts a canonical uppercase uuid (case-insensitive)', () => {
  assert.equal(isUuid('123E4567-E89B-12D3-A456-426614174000'), true);
});

test('isUuid rejects non-uuid strings', () => {
  assert.equal(isUuid('last'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid('not-a-uuid'), false);
});

test('isUuid rejects a truncated uuid', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456'), false);
});

test('isUuid rejects a uuid with wrong segment lengths', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-42661417400'), false);  // one short
  assert.equal(isUuid('123e4567-e89b-12d3-a456-4266141740000'), false); // one long
});

test('isUuid rejects arbitrary free text, including a fact\'s own text', () => {
  assert.equal(isUuid('the user is allergic to peanuts'), false);
});

test('isUuid rejects non-string values', () => {
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(123), false);
  assert.equal(isUuid({}), false);
  assert.equal(isUuid(['123e4567-e89b-12d3-a456-426614174000']), false);
});

test('isUuid rejects a uuid-shaped string with a non-hex character', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-42661417400g'), false);
});
