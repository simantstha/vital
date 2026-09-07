import assert from 'node:assert/strict';
import test from 'node:test';

import { mean, sd, olsSlope, studentTTwoSidedP, ranks, spearman, kruskalWallisSevenGroups, benjaminiHochberg } from './stats';

test('mean and sd match hand-computed values', () => {
  assert.equal(mean([2, 4, 6]), 4);
  // sample sd (n-1 denominator) of [2,4,6] is 2
  assert.equal(sd([2, 4, 6]), 2);
});

test('sd of a constant series is zero', () => {
  assert.equal(sd([5, 5, 5, 5]), 0);
});

test('two-sided t p-value matches known reference values', () => {
  // t=2.228, df=10 is the classic 0.05 two-sided critical value
  assert.ok(Math.abs(studentTTwoSidedP(2.228, 10) - 0.05) < 0.001);
  // t=0 is maximally unsurprising
  assert.equal(studentTTwoSidedP(0, 10), 1);
  // large t is vanishingly unlikely
  assert.ok(studentTTwoSidedP(10, 10) < 1e-5);
});

test('t p-values are correct at realistic degrees of freedom, not just df=10', () => {
  // The perfect-fit tests short-circuit before studentTTwoSidedP is ever
  // called, so without these the safety-critical tail behaviour is exercised at
  // exactly one point. Reference values from the standard incomplete beta.
  assert.ok(Math.abs(studentTTwoSidedP(1, 1) - 0.5) < 0.001);        // Cauchy, exact 0.5
  assert.ok(Math.abs(studentTTwoSidedP(2, 20) - 0.0593) < 0.001);
  assert.ok(Math.abs(studentTTwoSidedP(4, 100) - 0.000121) < 0.00002);
  assert.ok(Math.abs(studentTTwoSidedP(50, 1) - 0.0127) < 0.001);
});

test('olsSlope recovers a planted slope and calls it significant', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i);
  const ys = xs.map((x) => 3 * x + 10);
  const result = olsSlope(xs, ys);
  assert.ok(Math.abs(result.slope - 3) < 1e-9);
  assert.ok(result.pValue < 0.001);
  assert.equal(result.n, 30);
});

test('olsSlope on a flat series reports no significant trend', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i);
  const ys = xs.map(() => 42);
  const result = olsSlope(xs, ys);
  assert.equal(result.slope, 0);
  assert.equal(result.pValue, 1);
});

test('ranks assign average ranks to ties', () => {
  assert.deepEqual(ranks([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('spearman is 1 for a monotonic relationship even when nonlinear', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = xs.map((x) => x ** 3);
  const result = spearman(xs, ys);
  assert.ok(Math.abs(result.rho - 1) < 1e-9);
  assert.ok(result.pValue < 0.01);
});

test('spearman is near zero and insignificant for unrelated series', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [5, 1, 8, 2, 7, 3, 6, 4];
  const result = spearman(xs, ys);
  assert.ok(Math.abs(result.rho) < 0.5);
  assert.ok(result.pValue > 0.1);
});

test('kruskal-wallis requires exactly seven non-empty groups', () => {
  const six = Array.from({ length: 6 }, () => [1, 2, 3]);
  assert.equal(kruskalWallisSevenGroups(six).pValue, 1);
  const withEmpty = Array.from({ length: 7 }, (_, i) => (i === 3 ? [] : [1, 2, 3]));
  assert.equal(kruskalWallisSevenGroups(withEmpty).pValue, 1);
});

test('kruskal-wallis finds a planted weekday effect and ignores a flat one', () => {
  const flat = Array.from({ length: 7 }, () => [10, 11, 12, 13, 14, 15, 16, 17]);
  assert.ok(kruskalWallisSevenGroups(flat).pValue > 0.2);

  const shifted = Array.from({ length: 7 }, (_, day) =>
    day === 0 ? [90, 91, 92, 93, 94, 95, 96, 97] : [10, 11, 12, 13, 14, 15, 16, 17],
  );
  assert.ok(kruskalWallisSevenGroups(shifted).pValue < 0.01);
});

test('benjamini-hochberg rejects the clearly significant and keeps noise out', () => {
  const pValues = [0.001, 0.002, 0.2, 0.5, 0.9];
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), [true, true, false, false, false]);
});

test('benjamini-hochberg rejects nothing in a uniform (pure noise) family', () => {
  // Under the null, p-values are uniform on [0,1]. This is the shape a noise
  // sweep actually produces, and nothing in it should be called a discovery.
  const pValues = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), Array.from({ length: 20 }, () => false));
});

test('benjamini-hochberg is stricter than an uncorrected threshold', () => {
  // A lone p = 0.04 clears an uncorrected 0.05 but must NOT clear BH at m = 20.
  const pValues = [0.04, ...Array.from({ length: 19 }, (_, i) => 0.5 + i / 100)];
  assert.equal(benjaminiHochberg(pValues, 0.1)[0], false);
});

test('benjamini-hochberg does reject when the whole family is implausible', () => {
  // Twenty p-values at 0.04 when ~1 is expected IS collective evidence, and BH
  // correctly rejects them. Pinned so nobody "fixes" the procedure toward
  // always-reject or always-abstain.
  const pValues = Array.from({ length: 20 }, () => 0.04);
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), Array.from({ length: 20 }, () => true));
});

test('benjamini-hochberg preserves input order in its output', () => {
  const pValues = [0.9, 0.001, 0.5];
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), [false, true, false]);
});

test('benjamini-hochberg on an empty family returns an empty array', () => {
  assert.deepEqual(benjaminiHochberg([], 0.1), []);
});
