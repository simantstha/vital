import assert from 'node:assert/strict';
import test from 'node:test';
import { liftChange4w, type LiftWeekPoint } from './liftChange';

// Parity fixture — the SAME inputs and expectations are pinned in
// ios/Vital/Tests/TrendsStrengthLogicTests.swift (testLiftChangeParity...).
// Anchor Monday 2026-10-05: recent = {10-05, 09-28}, baseline = {09-07, 08-31}.
const ANCHOR = '2026-10-05';
const wk = (weekStart: string, e: number | null): LiftWeekPoint => ({ weekStart, bestEstimatedOneRepMaxKg: e });

test('bench: best of last 2 weeks vs best of the 2 weeks ending 4 weeks ago', () => {
  const c = liftChange4w([wk('2026-08-31', 100), wk('2026-09-07', 102.1), wk('2026-09-28', 107.9), wk('2026-10-05', 105)], ANCHOR);
  assert.deepEqual(c, { baselineKg: 102.1, recentKg: 107.9, changeKg: 5.8 });
});

test('squat: a decline is reported as a negative change', () => {
  const c = liftChange4w([wk('2026-09-07', 140), wk('2026-10-05', 138.2)], ANCHOR);
  assert.deepEqual(c, { baselineKg: 140, recentKg: 138.2, changeKg: -1.8 });
});

test('deadlift: weeks outside both windows (09-14, 09-21) do not count → null', () => {
  assert.equal(liftChange4w([wk('2026-09-14', 180), wk('2026-10-05', 190)], ANCHOR), null);
});

test('null e1RM weeks are ignored; empty windows → null', () => {
  assert.equal(liftChange4w([wk('2026-09-07', null), wk('2026-10-05', 100)], ANCHOR), null);
  assert.equal(liftChange4w([wk('2026-09-07', 100)], ANCHOR), null);
});
