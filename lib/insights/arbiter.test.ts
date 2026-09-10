import assert from 'node:assert/strict';
import test from 'node:test';

import { shortlist } from './arbiter';
import type { CertifiedFinding } from './types';

function certified(overrides: Partial<CertifiedFinding> = {}): CertifiedFinding {
  return {
    kind: 'level_shift', signature: 'level_shift:hrv_sdnn:down', metrics: ['hrv_sdnn'],
    effect: -1.5, effectLabel: '1.5 SD below baseline', n: 35, pValue: 0.001,
    detail: {}, confirmedOnRuns: 2, ...overrides,
  };
}

const noHistory = { goal: null, recentKinds: new Map<string, number>() };

test('returns at most three findings', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    certified({ signature: `s${i}`, effect: -(1 + i / 10) }),
  );
  assert.equal(shortlist(many, noHistory).length, 3);
});

test('ranks a cadence break above a marginal statistical finding', () => {
  const ranked = shortlist(
    [certified({ signature: 'shift', effect: -0.9 }),
     certified({ kind: 'cadence_break', signature: 'cadence', effect: 5, pValue: null })],
    noHistory,
  );
  assert.equal(ranked[0].kind, 'cadence_break');
});

test('drops a kind still inside its cooldown', () => {
  const ranked = shortlist(
    [certified({ kind: 'cadence_break', signature: 'cadence', effect: 5, pValue: null })],
    { goal: null, recentKinds: new Map([['cadence_break', 3]]) },
  );
  assert.deepEqual(ranked, []);
});

test('allows a kind whose cooldown has expired', () => {
  const ranked = shortlist(
    [certified({ kind: 'cadence_break', signature: 'cadence', effect: 5, pValue: null })],
    { goal: null, recentKinds: new Map([['cadence_break', 20]]) },
  );
  assert.equal(ranked.length, 1);
});

test('prefers a larger effect within the same kind', () => {
  const ranked = shortlist(
    [certified({ signature: 'small', effect: -0.9 }), certified({ signature: 'big', effect: -2.4 })],
    noHistory,
  );
  assert.equal(ranked[0].signature, 'big');
});

test('is deterministic across repeated calls', () => {
  const findings = Array.from({ length: 6 }, (_, i) => certified({ signature: `s${i}`, effect: -(1 + i / 10) }));
  assert.deepEqual(
    shortlist(findings, noHistory).map((f) => f.signature),
    shortlist(findings, noHistory).map((f) => f.signature),
  );
});

test('breaks genuine score ties on signature, independent of input order', () => {
  // The test above uses six distinct effects, so every score differs and the
  // signature tie-break never fires — delete that half of the comparator and it
  // still passes. This one constructs a real tie (same kind, same |effect|, no
  // goal match, no history) and feeds it in both orders. Without the tie-break
  // the comparator returns 0 and the result depends on sort stability rather
  // than on a rule, so the two orders would disagree.
  const a = certified({ signature: 'aaa', effect: -1.5 });
  const b = certified({ signature: 'bbb', effect: -1.5 });
  assert.deepEqual(shortlist([b, a], noHistory).map((f) => f.signature), ['aaa', 'bbb']);
  assert.deepEqual(shortlist([a, b], noHistory).map((f) => f.signature), ['aaa', 'bbb']);
});

test('returns empty for no findings', () => {
  assert.deepEqual(shortlist([], noHistory), []);
});
