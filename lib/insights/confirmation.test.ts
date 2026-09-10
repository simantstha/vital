import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmAgainstPreviousRun } from './confirmation';
import type { Finding } from './types';

function finding(signature: string): Finding {
  return {
    kind: 'level_shift', signature, metrics: ['hrv_sdnn'], effect: -1.5,
    effectLabel: '1.5 SD below baseline', n: 35, pValue: 0.001, detail: {},
  };
}

test('confirms a finding that also appeared on the previous run', () => {
  const confirmed = confirmAgainstPreviousRun([finding('a')], new Set(['a']));
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].confirmedOnRuns, 2);
});

test('drops a finding seen for the first time today', () => {
  assert.deepEqual(confirmAgainstPreviousRun([finding('a')], new Set(['b'])), []);
});

test('drops everything when there was no previous run', () => {
  assert.deepEqual(confirmAgainstPreviousRun([finding('a')], new Set()), []);
});

test('confirms only the overlapping subset', () => {
  const confirmed = confirmAgainstPreviousRun(
    [finding('a'), finding('b'), finding('c')],
    new Set(['b', 'c', 'z']),
  );
  assert.deepEqual(confirmed.map((f) => f.signature), ['b', 'c']);
});
