import assert from 'node:assert/strict';
import test from 'node:test';

import { mean, sd, olsSlope, studentTTwoSidedP } from './stats';

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
