import assert from 'node:assert/strict';
import test from 'node:test';
import {
  easedLoad, findRecentBreak, isDeload, isDeloadWeek, isLiftProgressing, isLiftStalled, isLowerBodyCompound, latestTopLoadKg, liftChange4w,
  liftDisplayChange, liftDisplayName, liftRecentEndWeek, liftReturnState, nextWorkingLoad, pickHeadlineLift, priorTopLoadKg, rankLifts,
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

// ── Headline lift + whole-unit display (parity: TrendsStrengthLogicTests) ───

// ── Headline lift: the most-trained lift, stable day to day (wave 19b) ──────

/** A lift-week with `sessions` sessions (3 sets each) and the given best e1RM. */
const ls = (weekStart: string, e: number | null, sessions: number, extra: Partial<LiftWeekPoint> = {}): LiftWeekPoint => ({
  weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: sessions * 1000, totalSets: sessions * 3, sessions, ...extra,
});

test('pickHeadlineLift: the most-trained lift over the last 8 completed weeks wins, not the biggest change', () => {
  const prog = {
    bench: [ls('2026-09-07', 99.2, 3), ls('2026-09-14', 99.2, 3), ls('2026-10-05', 107.9, 3)], // +8.7, 6 sessions
    squat: [ls('2026-09-07', 120, 1), ls('2026-09-14', 120, 1), ls('2026-10-05', 140.4, 1)], // +20.4, 2 sessions
  };
  assert.equal(pickHeadlineLift(prog, ANCHOR)!.exercise, 'bench');
  assert.deepEqual(pickHeadlineLift(prog, ANCHOR)!.change, { baselineKg: 99.2, recentKg: 107.9, changeKg: 8.7 });
  assert.deepEqual(rankLifts(prog, ANCHOR), ['bench', 'squat']);
});

test('rankLifts: equally trained lifts follow the fixed order (squat, bench press, deadlift, overhead press, then A-Z)', () => {
  const same = (e: number) => [ls('2026-09-07', e, 2), ls('2026-09-14', e, 2)];
  const prog = { curl: same(40), 'overhead press': same(60), deadlift: same(150), 'bench press': same(100), squat: same(130), 'Back-Squat': same(120) };
  // "Back-Squat" is not the main squat: it follows the four main lifts, A-Z among the others.
  assert.deepEqual(rankLifts(prog, ANCHOR), ['squat', 'bench press', 'deadlift', 'overhead press', 'Back-Squat', 'curl']);
});

test('pickHeadlineLift: the same lift leads while every lift drops, whichever dropped most', () => {
  const week = (bench: number, deadlift: number) => ({
    'bench press': [ls('2026-09-07', 100, 2), ls('2026-09-14', 100, 2), ls('2026-10-05', bench, 2)],
    deadlift: [ls('2026-09-07', 150, 2), ls('2026-09-14', 150, 2), ls('2026-10-05', deadlift, 2)],
  });
  // Bench -3 / deadlift -6, then bench -3 / deadlift -3, then bench -4 / deadlift -2: always bench.
  for (const [bench, deadlift] of [[97, 144], [97, 147], [96, 148]]) {
    assert.equal(pickHeadlineLift(week(bench, deadlift), ANCHOR)!.exercise, 'bench press');
  }
});

test('rankLifts: the week being trained does not swing the ranking (only completed weeks count)', () => {
  const prog = {
    squat: [ls('2026-09-14', 130, 2), ls('2026-09-21', 130, 2), ls('2026-10-05', 130, 1)],
    'bench press': [ls('2026-09-14', 100, 2), ls('2026-09-21', 100, 2), ls('2026-10-05', 100, 2)], // two bench sessions already this week
  };
  assert.deepEqual(rankLifts(prog, ANCHOR), ['squat', 'bench press']);
  // A brand-new lifter (no completed week yet) is ranked on the week so far.
  assert.deepEqual(rankLifts({ squat: [ls('2026-10-05', 100, 1)], 'bench press': [ls('2026-10-05', 80, 2)] }, ANCHOR), ['bench press', 'squat']);
});

test('pickHeadlineLift: a most-trained lift without a comparison is skipped; none comparable → null', () => {
  const prog = {
    squat: [ls('2026-09-14', 130, 3), ls('2026-09-21', 130, 3), ls('2026-10-05', 135, 3)], // no 4-weeks-ago week
    deadlift: [ls('2026-09-07', 150, 1), ls('2026-10-05', 140, 1)],
  };
  assert.equal(pickHeadlineLift(prog, ANCHOR)!.exercise, 'deadlift');
  assert.equal(pickHeadlineLift({ bench: [wk('2026-10-05', 100)] }, ANCHOR), null);
  assert.equal(pickHeadlineLift({}, ANCHOR), null);
});

// ── One stall rule: a break or a return is never a stall ────────────────────

// Squat trained steadily until Sat 09-12, 15 days off (09-13 .. 09-27), back on Mon 09-28 lighter.
const preBreak = [ls('2026-08-17', 130, 2), ls('2026-08-24', 133, 2), ls('2026-08-31', 136, 2), ls('2026-09-07', 142, 2)];
const afterBreak = [ls('2026-09-28', 136, 2), ls('2026-10-05', 138, 2)];

test('isLiftStalled: a lift back from a break is not stalled; the same numbers with steady training are', () => {
  assert.equal(liftChange4w([...preBreak, ...afterBreak], ANCHOR)!.changeKg, -4);
  assert.equal(isLiftStalled([...preBreak, ...afterBreak], ANCHOR), false);
  // Return week itself (end = 09-28): the weeks just before it are empty -> still a break.
  assert.equal(isLiftStalled([...preBreak, ls('2026-09-28', 136, 2)], '2026-09-28'), false);
  // Control: no break (the two "missed" weeks were trained at the same level) -> a real stall.
  const steadyWeeks = [...preBreak, ls('2026-09-14', 138, 2), ls('2026-09-21', 138, 2), ...afterBreak];
  assert.equal(isLiftStalled(steadyWeeks, ANCHOR), true);
});

// ── Returning from a break ──────────────────────────────────────────────────

const sessionDays = (...weekStartsAndOffsets: Array<[string, number[]]>): string[] =>
  weekStartsAndOffsets.flatMap(([monday, offsets]) => offsets.map(o => {
    const [y, m, d] = monday.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + o)).toISOString().slice(0, 10);
  }));
const trainedWeeks = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
const DAYS_WITH_BREAK = [
  ...sessionDays(...trainedWeeks.map(w => [w, [0, 2, 5]] as [string, number[]])), // last session Sat 09-12
  ...sessionDays(['2026-09-28', [0, 2, 5]], ['2026-10-05', [0, 1]]),
];

test('findRecentBreak: 10+ days in a row without a session, followed by a session, ended within 35 days', () => {
  const brk = findRecentBreak(DAYS_WITH_BREAK, '2026-10-06')!;
  assert.deepEqual(brk, { breakDays: 15, breakEnd: '2026-09-27', returnDay: '2026-09-28', lastBeforeDay: '2026-09-12' });
  // Still in the break (no session yet): not a return.
  assert.equal(findRecentBreak(DAYS_WITH_BREAK.filter(d => d <= '2026-09-12'), '2026-09-25'), null);
  // 35 days after the break ended it is still on; one more day and it is over.
  assert.notEqual(findRecentBreak(DAYS_WITH_BREAK, '2026-11-01'), null);
  assert.equal(findRecentBreak(DAYS_WITH_BREAK, '2026-11-02'), null);
  // 9 days off is a rest week, not a break.
  assert.equal(findRecentBreak(['2026-09-01', '2026-09-11'], '2026-09-14'), null);
  assert.equal(findRecentBreak(['2026-09-01', '2026-09-12'], '2026-09-14')!.breakDays, 10);
});

test('liftReturnState: under the pre-break best → building (percent rounded down); at or above it → regained', () => {
  const prog = { squat: [...preBreak, ...afterBreak] };
  const building = liftReturnState(prog, DAYS_WITH_BREAK, '2026-10-06')!;
  assert.equal(building.exercise, 'squat');
  assert.equal(building.preBreakKg, 142);
  assert.equal(building.recentKg, 138);
  assert.equal(building.pct, 97); // 138 / 142 = 97.18%
  assert.equal(building.regained, false);
  assert.equal(building.breakDays, 15);
  assert.equal(building.breakEnd, '2026-09-27');
  // 99.9% never reads 100% while still under the best.
  const almost = liftReturnState({ squat: [...preBreak, ls('2026-10-05', 141.9, 2)] }, DAYS_WITH_BREAK, '2026-10-06')!;
  assert.equal(almost.pct, 99);
  assert.equal(almost.regained, false);
  // Regained: best since the return reaches the pre-break best.
  const back = liftReturnState({ squat: [...preBreak, ls('2026-09-28', 136, 2), ls('2026-10-05', 145, 2)] }, DAYS_WITH_BREAK, '2026-10-06')!;
  assert.equal(back.regained, true);
  assert.equal(back.recentKg, 145);
  // The pre-break best is the best of the 4 weeks before the break only (a PR from 6 weeks earlier does not count).
  const olderPr = { squat: [ls('2026-07-27', 160, 2), ...preBreak, ...afterBreak] };
  assert.equal(liftReturnState(olderPr, DAYS_WITH_BREAK, '2026-10-06')!.preBreakKg, 142);
});

test('liftReturnState: no break, no pre-break best, or no session since → null', () => {
  const steady = sessionDays(...['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'].map(w => [w, [0, 3]] as [string, number[]]));
  assert.equal(liftReturnState({ squat: [...preBreak, ...afterBreak] }, steady, '2026-10-06'), null);
  assert.equal(liftReturnState({ squat: afterBreak }, DAYS_WITH_BREAK, '2026-10-06'), null); // never lifted squat before the break
  assert.equal(liftReturnState({ squat: preBreak }, DAYS_WITH_BREAK, '2026-10-06'), null); // not squatting since
});

// ── Deload week ─────────────────────────────────────────────────────────────

const normalWeeks = (squatTop = 100): LiftWeekPoint[] => ['2026-09-07', '2026-09-14', '2026-09-21'].map(w =>
  ls(w, squatTop * 1.2333, 2, { volumeKg: 3000, topLoadKg: squatTop }));

test('isDeloadWeek: volume under 75% of the prior 3 weeks counts (a textbook 64% deload)', () => {
  const prog = { squat: [...normalWeeks(), ls('2026-09-28', 100 * 1.2333, 2, { volumeKg: 1920, topLoadKg: 100 })] };
  assert.equal(isDeloadWeek(prog, '2026-09-28'), true);
  assert.equal(isDeloadWeek({ squat: [...normalWeeks(), ls('2026-09-28', 123, 2, { volumeKg: 2400, topLoadKg: 100 })] }, '2026-09-28'), false); // 80%
});

test('isDeloadWeek: every top set at or under 90% of its 4-week best counts, even at normal volume', () => {
  const lighter = { squat: [...normalWeeks(), ls('2026-09-28', 85 * 1.2333, 2, { volumeKg: 3000, topLoadKg: 85 })] };
  assert.equal(isDeloadWeek(lighter, '2026-09-28'), true);
  // 95% (a restart after time off) is not a deload; neither is one lift dropping while another holds.
  assert.equal(isDeloadWeek({ squat: [...normalWeeks(), ls('2026-09-28', 95 * 1.2333, 2, { volumeKg: 3000, topLoadKg: 95 })] }, '2026-09-28'), false);
  const mixed = {
    squat: [...normalWeeks(), ls('2026-09-28', 85 * 1.2333, 2, { volumeKg: 3000, topLoadKg: 85 })],
    bench: [...normalWeeks(80), ls('2026-09-28', 80 * 1.2333, 2, { volumeKg: 3000, topLoadKg: 80 })],
  };
  assert.equal(isDeloadWeek(mixed, '2026-09-28'), false);
  // Without top loads (older payloads) the best e1RM stands in.
  const noLoads = { squat: ['2026-09-07', '2026-09-14', '2026-09-21'].map(w => ls(w, 123, 2)).concat([ls('2026-09-28', 104, 2)]) };
  assert.equal(isDeloadWeek(noLoads, '2026-09-28'), true);
});

test('isDeloadWeek: needs a session that week and earlier weeks to compare with', () => {
  assert.equal(isDeloadWeek({ squat: normalWeeks() }, '2026-09-28'), false); // nothing logged that week
  assert.equal(isDeloadWeek({ squat: [ls('2026-09-28', 100, 2, { volumeKg: 1000, topLoadKg: 80 })] }, '2026-09-28'), false); // first week
});

// ── Working loads and the next load (the lift logger's next-weight rule) ────

test('nextWorkingLoad: +2.5 kg / +5 lb for lower-body compounds, +1.25 kg / +2.5 lb otherwise, rounded to 0.5 kg / 1 lb', () => {
  assert.deepEqual(nextWorkingLoad(107.5, 'squat', false), { from: 107.5, to: 110, unit: 'kg' });
  assert.deepEqual(nextWorkingLoad(125, 'romanian deadlift', false), { from: 125, to: 127.5, unit: 'kg' });
  assert.deepEqual(nextWorkingLoad(82.5, 'bench press', false), { from: 82.5, to: 84, unit: 'kg' }); // 83.75 -> 84
  assert.deepEqual(nextWorkingLoad(100, 'squat', true), { from: 220, to: 225, unit: 'lb' });
  assert.deepEqual(nextWorkingLoad(100, 'bench press', true), { from: 220, to: 223, unit: 'lb' }); // 222.5 -> 223
  assert.equal(nextWorkingLoad(999.5, 'squat', false).to, 1000); // the logger's maximum
  assert.equal(isLowerBodyCompound('Hip-Thrust'), true);
  assert.equal(isLowerBodyCompound('overhead press'), false);
});

test('easedLoad / working-load lookups', () => {
  assert.deepEqual(easedLoad(115, 0.9, false), { value: 102.5, unit: 'kg' }); // 103.5 -> nearest 2.5
  assert.deepEqual(easedLoad(115, 0.9, true), { value: 230, unit: 'lb' }); // 228.2 -> nearest 5
  const weeks = [ls('2026-09-07', 130, 2, { topLoadKg: 105 }), ls('2026-09-14', 133, 2, { topLoadKg: 107.5 }), ls('2026-09-21', 120, 2, { topLoadKg: 92.5 })];
  assert.equal(priorTopLoadKg(weeks, '2026-09-21'), 107.5); // best of the weeks before
  assert.equal(latestTopLoadKg(weeks, '2026-09-21'), 92.5);
  assert.equal(latestTopLoadKg(weeks, '2026-09-14'), 107.5);
  assert.equal(latestTopLoadKg([ls('2026-09-07', 130, 2)], '2026-09-21'), null);
});

test('liftDisplayChange: parity fixtures with TrendsStrengthLogicTests (bench 102.1 -> 107.9 = +6; 101 -> 106.4 = +5)', () => {
  assert.deepEqual(liftDisplayChange({ baselineKg: 102.1, recentKg: 107.9, changeKg: 5.8 }, false), { baseline: 102, recent: 108, change: 6 });
  assert.deepEqual(liftDisplayChange({ baselineKg: 101, recentKg: 106.4, changeKg: 5.4 }, false), { baseline: 101, recent: 106, change: 5 });
  assert.deepEqual(liftDisplayChange({ baselineKg: 100, recentKg: 110, changeKg: 10 }, true), { baseline: 220, recent: 243, change: 23 });
});

test('liftDisplayChange: whole units; the change is computed from the rounded endpoints', () => {
  assert.deepEqual(liftDisplayChange({ baselineKg: 99.2, recentKg: 107.9, changeKg: 8.7 }, false), { baseline: 99, recent: 108, change: 9 });
  // 100 kg = 220.46 lb -> 220; 105 kg = 231.5 lb -> 231
  assert.deepEqual(liftDisplayChange({ baselineKg: 100, recentKg: 105, changeKg: 5 }, true), { baseline: 220, recent: 231, change: 11 });
});
