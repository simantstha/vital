import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDeload, isLiftProgressing, isLiftStalled, liftChange4w, liftDisplayName, liftRecentEndWeek,
  type LiftWeekPoint,
} from './liftChange';

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
  assert.equal(liftChange4w([wk('2026-09-14', 100)], ANCHOR), null);
});

// ── Empty current week is skipped (Monday before training) ──────────────────
// Parity fixture (Swift: testLiftChangeSkipsAnEmptyCurrentWeek): anchor 2026-10-05
// has no sets, so end = 2026-09-28; recent = {09-28, 09-21}, baseline = {08-31, 08-24}.
test('empty current week: the recent window ends at the newest week with data', () => {
  const c = liftChange4w([wk('2026-08-24', 100), wk('2026-08-31', 101), wk('2026-09-21', 103), wk('2026-09-28', 106.4)], ANCHOR);
  assert.deepEqual(c, { baselineKg: 101, recentKg: 106.4, changeKg: 5.4 });
});

test('end week is searched only 3 weeks back (anchor, -7d, -14d)', () => {
  assert.equal(liftRecentEndWeek([wk('2026-09-21', 100)], ANCHOR), '2026-09-21');
  assert.equal(liftRecentEndWeek([wk('2026-09-14', 100)], ANCHOR), null);
  assert.equal(liftChange4w([wk('2026-09-14', 100)], ANCHOR), null);
});

test('progressing needs +1% of baseline', () => {
  assert.equal(isLiftProgressing({ baselineKg: 100, recentKg: 101, changeKg: 1 }), true);
  assert.equal(isLiftProgressing({ baselineKg: 100, recentKg: 100.5, changeKg: 0.5 }), false);
  assert.equal(isLiftProgressing({ baselineKg: 100, recentKg: 100, changeKg: 0 }), false);
  assert.equal(isLiftProgressing({ baselineKg: 100, recentKg: 98, changeKg: -2 }), false);
  // Mirrored in TrendsStrengthLogicTests.testStatusProgressThresholdIsOnePercentOfBaseline
  assert.equal(isLiftProgressing({ baselineKg: 200, recentKg: 201, changeKg: 1 }), false);
  assert.equal(isLiftProgressing({ baselineKg: 50, recentKg: 51, changeKg: 1 }), true);
});

const wv = (weekStart: string, e: number, volumeKg: number, totalSets = 5) => ({ weekStart, bestEstimatedOneRepMaxKg: e, volumeKg, totalSets });
const steady = [
  wv('2026-08-31', 100, 1000), wv('2026-09-07', 100, 1000), wv('2026-09-14', 100, 1000),
  wv('2026-09-21', 100, 1000), wv('2026-09-28', 100, 1000), wv('2026-10-05', 100, 1000),
];

test('isLiftStalled: flat lift with steady volume is a stall', () => {
  assert.equal(isLiftStalled(steady, ANCHOR), true);
});

test('isLiftStalled: not a stall when progressing, after a break, or in a deload', () => {
  assert.equal(isLiftStalled(steady.map(w => (w.weekStart >= '2026-09-28' ? { ...w, bestEstimatedOneRepMaxKg: 103 } : w)), ANCHOR), false);
  // Break: nothing in the 2 weeks before the recent window (09-14, 09-21).
  assert.equal(isLiftStalled(steady.filter(w => w.weekStart !== '2026-09-14' && w.weekStart !== '2026-09-21'), ANCHOR), false);
  // Deload: recent weeks at 40% of the prior 4-week average.
  assert.equal(isLiftStalled(steady.map(w => (w.weekStart >= '2026-09-28' ? { ...w, volumeKg: 400 } : w)), ANCHOR), false);
});

test('isDeload: recent mean under 60% of the prior 4-week mean', () => {
  const vol = { '2026-09-07': 1000, '2026-09-14': 1000, '2026-09-21': 1000, '2026-09-28': 1000, '2026-10-05': 500 };
  assert.equal(isDeload(vol, '2026-10-05', 1), true);
  assert.equal(isDeload({ ...vol, '2026-10-05': 700 }, '2026-10-05', 1), false);
  assert.equal(isDeload({ '2026-10-05': 100 }, '2026-10-05', 1), false);
});

test('liftDisplayName title-cases keys and prefers a given display name', () => {
  assert.equal(liftDisplayName('bench press'), 'Bench Press');
  assert.equal(liftDisplayName('bench press', { 'bench press': 'Flat bench' }), 'Flat bench');
});
