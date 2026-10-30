import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shiftDay,
  DELOAD_CUE_HEAD, afterProactiveDeload, heavierLoadStreak, liftBaselineLabel, liftBaselineWeek, proactiveDeload,
  cuedLifts, easedLoad, findRecentBreak, headlineLeader, isDeload, isDeloadWeek, isLiftProgressing, isLiftStalled, isLowerBodyCompound, latestTopLoadKg, liftChange4w,
  furthestBehindReturn, liftDisplayChange, liftDisplayName, liftLapseMinDays, liftLastBest, liftRecentEndWeek, liftRegressed, liftReturnDisplay, liftReturnState,
  liftReturnStates, liftShortName, liftTrainedAtWorkingWeight, liftWeekChangeDisplay, liftWeekOverWeek, nextLoadCues, nextWorkingLoad, pickHeadlineLift, pickWeekOverWeek, priorTopLoadKg, rankLifts, shortWeekLoadCues, shortWeekLoadToLift, weekOverWeekWording,
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

test('liftBaselineWeek / liftBaselineLabel: "vs 4 weeks ago" only when the baseline number came from that week, else the week it came from (label only: liftChange4w is untouched) (wave 24s)', () => {
  // ANCHOR 10-05: the recent window ends 10-05, its 4-weeks-ago week is 09-07, the one before 08-31.
  const full = [wk('2026-08-31', 100), wk('2026-09-07', 102.1), wk('2026-09-28', 107.9), wk('2026-10-05', 105)];
  assert.deepEqual(liftBaselineWeek(full, ANCHOR), { weekStart: '2026-09-07', fourWeeksAgo: true });
  assert.equal(liftBaselineLabel(full, ANCHOR), 'vs 4 weeks ago');
  // 09-07 empty (an ill week): the baseline is the week of Aug 31, five weeks back, and the label says so. The number is liftChange4w's, unchanged.
  const gap = [wk('2026-08-31', 139), wk('2026-09-28', 148), wk('2026-10-05', 151)];
  assert.deepEqual(liftBaselineWeek(gap, ANCHOR), { weekStart: '2026-08-31', fourWeeksAgo: false });
  assert.equal(liftBaselineLabel(gap, ANCHOR), 'vs wk of Aug 31');
  assert.deepEqual(liftChange4w(gap, ANCHOR), { baselineKg: 139, recentKg: 151, changeKg: 12 });
  // Both weeks have an e1RM but the older one is the better, so the baseline NUMBER is from five weeks back: the label names that week (round 7, lifter_obedient bench
  // "114 → 123 kg" over an ill week whose only bench was a light volume set: "vs 4 weeks ago" was the 4-weeks-ago week's label on the Apr 6 number).
  const older = [wk('2026-08-31', 110), wk('2026-09-07', 102), wk('2026-10-05', 105)];
  assert.deepEqual(liftBaselineWeek(older, ANCHOR), { weekStart: '2026-08-31', fourWeeksAgo: false });
  assert.equal(liftBaselineLabel(older, ANCHOR), 'vs wk of Aug 31');
  assert.deepEqual(liftChange4w(older, ANCHOR), { baselineKg: 110, recentKg: 105, changeKg: -5 });
  // The same number from the 4-weeks-ago week itself (ties go to the newer week): "4 weeks ago".
  assert.equal(liftBaselineLabel([wk('2026-08-31', 102), wk('2026-09-07', 102), wk('2026-10-05', 105)], ANCHOR), 'vs 4 weeks ago');
  // The weekly review's window ends at the reviewed week, so on a Monday its number differs from the card's: it names its baseline week EVERY time (wave 25s; it read
  // "vs 4 weeks before", two near-identical labels over two numbers): "vs wk of Sep 7" for the same 4-weeks-ago baseline the card calls "vs 4 weeks ago".
  assert.equal(liftBaselineLabel(full, ANCHOR, 'week'), 'vs wk of Sep 7');
  assert.equal(liftBaselineLabel(gap, ANCHOR, 'week'), 'vs wk of Aug 31');
  assert.equal(liftBaselineLabel(older, ANCHOR, 'week'), 'vs wk of Aug 31');
  // Nothing to name: the generic wording, one per window.
  assert.equal(liftBaselineLabel([wk('2026-09-14', 100), wk('2026-10-05', 101)], ANCHOR, 'week'), 'vs 4 weeks before');
  // No comparison: nothing to name.
  assert.equal(liftBaselineWeek([wk('2026-09-14', 100), wk('2026-10-05', 101)], ANCHOR), null);
  assert.equal(liftBaselineLabel([wk('2026-09-14', 100), wk('2026-10-05', 101)], ANCHOR), 'vs 4 weeks ago');
  // A one-digit day has no leading zero.
  assert.equal(liftBaselineLabel([wk('2026-04-06', 139), wk('2026-05-11', 151)], '2026-05-11'), 'vs wk of Apr 6');
});

// Parity with ios/Vital/Tests/TrendsStrengthLogicTests.swift testChipNamesTheBaselineWeekWhenItIsNotTheFourWeeksAgoWeek (wave 25s): the same fixtures on the dense 8-week grid
// 2026-08-17 ... 2026-10-05 (the Swift `keys`), the same labels. The Trends chip and the Today line say "vs 4 wk ago" only when the baseline number came from that week, else
// "vs wk of Aug 31" - exactly what liftBaselineLabel says on the card. If you change one, change the other.
test('iOS chip parity: the label for the dense-grid fixtures the Swift tests pin (wave 25s)', () => {
  const label = (points: Record<string, number>): string => liftBaselineLabel(Object.entries(points).map(([w, e]) => wk(w, e)), ANCHOR);
  assert.equal(label({ '2026-09-07': 100, '2026-10-05': 110 }), 'vs 4 weeks ago'); // the 4-weeks-ago week only
  assert.equal(label({ '2026-08-31': 100, '2026-10-05': 110 }), 'vs wk of Aug 31'); // 4-weeks-ago week empty: the week before it
  assert.equal(label({ '2026-08-31': 110, '2026-09-07': 102, '2026-10-05': 105 }), 'vs wk of Aug 31'); // both, the older one better
  assert.equal(label({ '2026-08-31': 102, '2026-09-07': 102, '2026-10-05': 105 }), 'vs 4 weeks ago'); // a tie goes to the newer week
  assert.equal(label({ '2026-08-31': 101, '2026-08-24': 100, '2026-09-21': 103, '2026-09-28': 106.4 }), 'vs 4 weeks ago'); // empty current week: the end is 09-28, its 4-weeks-ago week 08-31
  assert.equal(label({ '2026-08-24': 100, '2026-09-28': 106 }), 'vs wk of Aug 24'); // the end is 09-28 and 08-31 is empty: 08-24
  assert.equal(label({ '2026-09-14': 100, '2026-10-05': 101 }), 'vs 4 weeks ago'); // no comparison: the generic words, never a week
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

test('liftWeekChangeDisplay: whole kg / lb rounded from the change itself, so one +2.5 kg step reads the same every week (wave 22s)', () => {
  // The squat e1RM climbs 3.1 kg a step: 130.4 -> 133.5 -> 136.6. Subtracting the rounded endpoints says +4 (130 -> 134) then +3 (134 -> 137).
  const step = (a: number, b: number) => liftWeekOverWeek([wk('2026-09-14', a), wk('2026-09-21', b)], '2026-09-21')!;
  assert.equal(liftDisplayChange({ baselineKg: 130.4, recentKg: 133.5, changeKg: 3.1 }, false).change, 4);
  assert.equal(liftDisplayChange({ baselineKg: 133.5, recentKg: 136.6, changeKg: 3.1 }, false).change, 3);
  assert.equal(liftWeekChangeDisplay(step(130.4, 133.5), false), 3);
  assert.equal(liftWeekChangeDisplay(step(133.5, 136.6), false), 3);
  // Pounds round the lb change: 3.1 kg = 6.8 lb -> 7; -0.2 kg = -0.4 lb -> 0.
  assert.equal(liftWeekChangeDisplay(step(130.4, 133.5), true), 7);
  assert.equal(liftWeekChangeDisplay(step(133.5, 133.3), true), 0);
});

test('liftTrainedAtWorkingWeight: a top set at 90%+ of the 4-week best, not a light day or an absent lift', () => {
  const top = (weekStart: string, kg: number | null, sessions = 1): LiftWeekPoint => ls(weekStart, 130, sessions, { topLoadKg: kg });
  const before = [top('2026-09-07', 100, 2), top('2026-09-14', 100, 2), top('2026-09-21', 100, 2)];
  assert.equal(liftTrainedAtWorkingWeight([...before, top('2026-09-28', 100)], '2026-09-28'), true);
  assert.equal(liftTrainedAtWorkingWeight([...before, top('2026-09-28', 90)], '2026-09-28'), true); // exactly 90%
  assert.equal(liftTrainedAtWorkingWeight([...before, top('2026-09-28', 85)], '2026-09-28'), false); // a light volume day
  assert.equal(liftTrainedAtWorkingWeight(before, '2026-09-28'), false); // not trained that week
  assert.equal(liftTrainedAtWorkingWeight([...before, top('2026-09-28', null)], '2026-09-28'), false); // bodyweight only
  assert.equal(liftTrainedAtWorkingWeight([top('2026-09-28', 60)], '2026-09-28'), true); // nothing before to compare with
});

// ── Next week's loads after a short week (wave 22s) ─────────────────────────

test('shortWeekLoadCues: a lift not trained (or only a light day) repeats its LAST load; a trained one follows the normal rule; the lead is first (wave 24s)', () => {
  const top = (weekStart: string, kg: number, sessions = 2): LiftWeekPoint => ls(weekStart, kg * 1.2, sessions, { topLoadKg: kg });
  const steady = (kg: number): LiftWeekPoint[] => [top('2026-09-07', kg), top('2026-09-14', kg), top('2026-09-21', kg)];
  const prog = {
    squat: steady(110), // not trained in the reviewed week 09-28
    'bench press': [...steady(87.5), top('2026-09-28', 75, 1)], // one light volume day: 75 < 90% of 87.5
    deadlift: [...steady(125), top('2026-09-28', 130, 1)], // trained above its best
    'lat pulldown': [top('2026-09-21', 60)], // an accessory is never cued
  };
  const cues = shortWeekLoadCues(prog, '2026-09-28', { imperial: false, leadKey: 'bench press', rebuilding: false });
  assert.deepEqual(cues.map(c => [c.key, c.kind, c.load.start, c.load.to]), [
    ['bench press', 'light', 87.5, 90], // the lead first; `from` is the last working load
    ['squat', 'skipped', 110, 112.5],
    ['deadlift', 'trained', 130, 132.5],
  ]);
  // What goes on the bar: the last load for a repeat (skipped, light), the step for a lift trained at its working load, the load itself for a hold.
  assert.deepEqual(cues.map(shortWeekLoadToLift), [87.5, 110, 132.5]);
  // Pounds: the trained lift's step is the same 5 lb grid step as everywhere, from the NEAREST grid value of the logged load ("~195 -> 200" for 193 lb; wave 24s).
  assert.deepEqual(shortWeekLoadCues(prog, '2026-09-28', { imperial: true, leadKey: null, rebuilding: false }).map(c => [c.key, c.load.start, c.load.to]), [
    ['squat', 245, 250], ['bench press', 195, 200], ['deadlift', 285, 290],
  ]);
  // A lift whose e1RM fell more than 1% holds, except while rebuilding after a break.
  const fell = { squat: [...steady(110), top('2026-09-28', 110, 2)].map(w => (w.weekStart === '2026-09-28' ? { ...w, bestEstimatedOneRepMaxKg: 120 } : w)) };
  assert.equal(shortWeekLoadCues(fell, '2026-09-28', { imperial: false, leadKey: null, rebuilding: false })[0].kind, 'hold');
  assert.equal(shortWeekLoadToLift(shortWeekLoadCues(fell, '2026-09-28', { imperial: false, leadKey: null, rebuilding: false })[0]), 110);
  assert.equal(shortWeekLoadCues(fell, '2026-09-28', { imperial: false, leadKey: null, rebuilding: true })[0].kind, 'trained');
  // No load known in the 4 weeks before: nothing to repeat.
  assert.deepEqual(shortWeekLoadCues({ squat: [top('2026-07-20', 100)] }, '2026-09-28', { imperial: false, leadKey: null, rebuilding: false }), []);
});

// ── A proactive deload (wave 24s) ───────────────────────────────────────────

/** One lift-week per top load, a week apart from `from`; the e1RM follows the load, 3000 kg of volume a week. */
const climb = (tops: number[], from = '2026-08-17'): LiftWeekPoint[] =>
  tops.map((t, i) => ls(shiftDay(from, 7 * i), t * 1.2, 2, { topLoadKg: t, volumeKg: 3000 }));
const DELOAD_OPTS = { imperial: false, leadKey: null, rebuilding: false };

test('heavierLoadStreak: consecutive weeks that stepped up; a lighter week, a gap, a lift going backwards or a comeback ends it', () => {
  const six = { squat: climb([100, 102.5, 105, 107.5, 110, 112.5]) }; // 08-17 .. 09-21
  assert.equal(heavierLoadStreak(six, '2026-09-21'), 5); // five step-ups; the first week has no week before it
  assert.equal(heavierLoadStreak(six, '2026-09-14'), 4);
  assert.equal(heavierLoadStreak(six, '2026-09-28'), 0); // nothing trained that week
  // Another lift staying put does not break the run; one stepping up is enough.
  assert.equal(heavierLoadStreak({ ...six, deadlift: climb([120, 120, 120, 120, 120, 120]) }, '2026-09-21'), 5);
  // A lighter week (a deload, an ill week) in the middle: the run restarts after it, and the week right after it is not a step up from it.
  const lighter = { squat: climb([100, 102.5, 105, 107.5, 95, 100, 102.5]) }; // 08-17 .. 09-28; 09-14 is the lighter week
  assert.equal(heavierLoadStreak(lighter, '2026-09-28'), 1); // 102.5 over 100; 100 over the light 95 does not count
  // A week without the lift breaks it.
  const gap = { squat: climb([100, 102.5, 105, 107.5, 110, 112.5]).filter(w => w.weekStart !== '2026-09-07') };
  assert.equal(heavierLoadStreak(gap, '2026-09-21'), 1); // 09-21 over 09-14; 09-14 has no week before it
  // A lift whose e1RM fell more than 1% did not "step up" (its cue is a hold): the week does not count.
  const fell = climb([100, 102.5, 105, 107.5, 110, 112.5]).map(w => (w.weekStart === '2026-09-21' ? { ...w, bestEstimatedOneRepMaxKg: 120 } : w));
  assert.equal(heavierLoadStreak({ squat: fell }, '2026-09-21'), 0);
  // Only main lifts are counted: accessories stepping up every week do not make a streak.
  assert.equal(heavierLoadStreak({ 'lat pulldown': climb([40, 42.5, 45, 47.5, 50, 52.5]) }, '2026-09-21'), 0);
});

test('proactiveDeload: after 5 straight weeks of heavier loads, with the pre-deload top loads to go back to; never while rebuilding; the week after goes back to exactly them', () => {
  const squat = climb([100, 102.5, 105, 107.5, 110, 112.5]);
  const bench = climb([80, 82.5, 85, 87.5, 90, 92.5]);
  const cue = proactiveDeload({ squat, 'bench press': bench }, '2026-09-21', DELOAD_OPTS);
  assert.equal(cue?.weeks, 5);
  assert.deepEqual(cue?.resume.map(r => [r.key, r.load.from]), [['squat', 112.5], ['bench press', 92.5]]);
  assert.equal(proactiveDeload({ squat }, '2026-09-14', DELOAD_OPTS), null); // only 4
  assert.equal(proactiveDeload({ squat }, '2026-09-21', { ...DELOAD_OPTS, rebuilding: true }), null);
  assert.equal(proactiveDeload({ squat: squat.map(w => ({ ...w, topLoadKg: null })) }, '2026-09-21', DELOAD_OPTS), null);
  assert.deepEqual(proactiveDeload({ squat }, '2026-09-21', { ...DELOAD_OPTS, imperial: true })?.resume.map(r => [r.load.from, r.load.unit]), [[248, 'lb']]);
  assert.match(DELOAD_CUE_HEAD, /^Deload week: ~85–90% of last week's loads, 2 working sets$/);
  // The deload week (09-28: 97.5 kg x 2 sets): back to the loads the cue named.
  const deload = ls('2026-09-28', 117, 2, { topLoadKg: 97.5, volumeKg: 1920 });
  const after = afterProactiveDeload({ squat: [...squat, deload] }, '2026-09-28', { imperial: false, leadKey: null });
  assert.deepEqual(after?.map(r => [r.key, r.load.from]), [['squat', 112.5]]);
  // A deload she took on her own (flat loads before it) is not asked for: no promise to keep.
  const flat = climb([107.5, 107.5, 107.5, 107.5, 107.5, 107.5]);
  assert.equal(afterProactiveDeload({ squat: [...flat, deload] }, '2026-09-28', { imperial: false, leadKey: null }), null);
  // A week that was not a deload is not "after a deload".
  assert.equal(afterProactiveDeload({ squat: [...squat, ls('2026-09-28', 140, 2, { topLoadKg: 115, volumeKg: 3000 })] }, '2026-09-28', { imperial: false, leadKey: null }), null);
});

// ── The headline lift is sticky (wave 22s) ──────────────────────────────────

/** Mondays from `from` for `count` weeks. */
const mondays = (from: string, count: number): string[] => Array.from({ length: count }, (_, i) => shiftDay(from, 7 * i));
/** One lift, one entry per Monday: `sessionsOf(i)` sessions in the i-th week (0 -> no entry). */
const series = (from: string, count: number, sessionsOf: (i: number) => number, e = 100): LiftWeekPoint[] =>
  mondays(from, count).flatMap((w, i) => (sessionsOf(i) > 0 ? [ls(w, e, sessionsOf(i))] : []));

test('rankLifts / headlineLeader: one short week does not hand the lead to another lift (lifter_short_week: squat -> bench by one session)', () => {
  // 12 weeks from 2026-07-27 to 2026-10-12: squat and bench two sessions a week; in week 8 (09-14) only one bench session happens.
  const prog = (anchor: string) => ({
    squat: series('2026-07-27', 12, i => (i === 7 ? 0 : 2)).filter(w => w.weekStart < anchor),
    'bench press': series('2026-07-27', 12, i => (i === 7 ? 1 : 2)).filter(w => w.weekStart < anchor),
  });
  // The anchor after the short week (week 8 = 09-14, anchor 09-21): bench has 1 session more, the squat keeps the lead.
  assert.deepEqual(rankLifts(prog('2026-09-21'), '2026-09-21'), ['squat', 'bench press']);
  // ... and for every Monday after it (the plain ranking said bench from then on, for good).
  for (const anchor of ['2026-09-28', '2026-10-05', '2026-10-12']) assert.equal(rankLifts(prog(anchor), anchor)[0], 'squat', anchor);
  assert.equal(headlineLeader(prog('2026-10-05'), '2026-10-05'), 'squat');
});

test('headlineLeader: the lead changes hands only at 2+ sessions ahead, and at two Mondays in a row', () => {
  // Bench two a week throughout; the squat is trained twice a week until week 6, then once a week.
  const squat = (anchor: string) => series('2026-07-27', 14, i => (i < 6 ? 2 : 1)).filter(w => w.weekStart < anchor);
  const bench = (anchor: string) => series('2026-07-27', 14, () => 2).filter(w => w.weekStart < anchor);
  const lead = (anchor: string) => rankLifts({ squat: squat(anchor), 'bench press': bench(anchor) }, anchor)[0];
  // Anchor 09-14: the weeks so far hold 13 squat sessions against 14 bench: one ahead - not enough.
  assert.equal(lead('2026-09-14'), 'squat');
  // 09-21: squat 14, bench 16 -> 2 ahead, the first Monday; 09-28: squat 13, bench 16 -> 3 ahead, the second in a row -> bench takes the lead.
  assert.equal(lead('2026-09-21'), 'squat');
  assert.equal(lead('2026-09-28'), 'bench press');
  // ... and keeps it while the squat stays behind.
  assert.equal(lead('2026-10-12'), 'bench press');
});

test('headlineLeader: a lead that left the rotation is replaced at once; a new lifter ranks on the week so far; nothing in rotation -> null', () => {
  const squat = [ls('2026-07-27', 120, 2), ls('2026-08-03', 120, 2)]; // no e1RM in the last 8 weeks at 2026-10-05: out of rotation
  const bench = [ls('2026-09-14', 100, 2), ls('2026-09-21', 100, 2), ls('2026-09-28', 100, 2)];
  assert.deepEqual(rankLifts({ squat, 'bench press': bench }, '2026-10-05'), ['bench press']);
  assert.equal(headlineLeader({ squat }, '2026-10-05'), null);
  assert.equal(headlineLeader({}, '2026-10-05'), null);
  assert.deepEqual(rankLifts({ squat: [ls('2026-10-05', 100, 1)], 'bench press': [ls('2026-10-05', 80, 2)] }, '2026-10-05'), ['bench press', 'squat']);
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

test('nextWorkingLoad: +2.5 kg / +5 lb for EVERY lift, from a start snapped to the NEAREST 2.5 kg / 5 lb grid value — a step standard plates can make (wave 21, 22s, 24s)', () => {
  assert.deepEqual(nextWorkingLoad(107.5, 'squat', false), { from: 107.5, start: 107.5, to: 110, unit: 'kg', approx: false });
  assert.deepEqual(nextWorkingLoad(125, 'romanian deadlift', false), { from: 125, start: 125, to: 127.5, unit: 'kg', approx: false });
  // Upper body used to step +1.25 (rounded to 0.5): "bench 80 -> 81.5 kg" needs 0.75 kg a side.
  assert.deepEqual(nextWorkingLoad(80, 'bench press', false), { from: 80, start: 80, to: 82.5, unit: 'kg', approx: false });
  assert.deepEqual(nextWorkingLoad(82.5, 'bench press', false), { from: 82.5, start: 82.5, to: 85, unit: 'kg', approx: false });
  assert.deepEqual(nextWorkingLoad(57.5, 'overhead press', false), { from: 57.5, start: 57.5, to: 60, unit: 'kg', approx: false });
  assert.deepEqual(nextWorkingLoad(100, 'squat', true), { from: 220, start: 220, to: 225, unit: 'lb', approx: false });
  assert.deepEqual(nextWorkingLoad(100, 'bench press', true), { from: 220, start: 220, to: 225, unit: 'lb', approx: false }); // was 223: not a plate
  // A load logged off the grid starts the step from the NEAREST grid value (wave 24s: rounding down printed "Squat ~255 -> 260 lb" after a 259 lb set,
  // a +1, and "bench ~190 -> 195" after 193, a +2) and says "~" whenever the start moved. The real step from the logged load is 1.25-3.75 kg (2.5-7.5 lb).
  assert.deepEqual(nextWorkingLoad(81, 'bench press', false), { from: 81, start: 80, to: 82.5, unit: 'kg', approx: true }); // +1.5
  assert.deepEqual(nextWorkingLoad(80.5, 'bench press', false), { from: 80.5, start: 80, to: 82.5, unit: 'kg', approx: true }); // +2
  assert.deepEqual(nextWorkingLoad(81.5, 'bench press', false), { from: 81.5, start: 82.5, to: 85, unit: 'kg', approx: true }); // +3.5 (it was a +1)
  assert.deepEqual(nextWorkingLoad(82, 'bench press', false), { from: 82, start: 82.5, to: 85, unit: 'kg', approx: true }); // +3 (it was a +0.5)
  // Pounds: 87.5 kg = 192.9 lb -> logged 193 -> "~195 -> 200" (+7, it was "~190 -> 195", +2); 117.5 kg = 259 lb -> "~260 -> 265" (+6, it was "~255 -> 260", +1).
  assert.deepEqual(nextWorkingLoad(87.5, 'bench press', true), { from: 193, start: 195, to: 200, unit: 'lb', approx: true });
  assert.deepEqual(nextWorkingLoad(117.5, 'squat', true), { from: 259, start: 260, to: 265, unit: 'lb', approx: true });
  assert.deepEqual(nextWorkingLoad(110, 'squat', true), { from: 243, start: 245, to: 250, unit: 'lb', approx: true }); // 242.5 lb logged as 243
  assert.deepEqual(nextWorkingLoad(80, 'bench press', true), { from: 176, start: 175, to: 180, unit: 'lb', approx: true }); // 1 lb off the grid still moved the start
  assert.deepEqual(nextWorkingLoad(82.5, 'bench press', true), { from: 182, start: 180, to: 185, unit: 'lb', approx: true });
  // Every start is on the grid and every target is exactly one step above it (below the cap), whatever the lift and the load; the start is the NEAREST grid value,
  // so the real step from today's load is 1.25-3.75 kg (2.5-7.5 lb).
  for (let kg = 20; kg <= 250; kg += 0.5) {
    for (const key of ['squat', 'bench press', 'overhead press', 'deadlift']) {
      const m = nextWorkingLoad(kg, key, false);
      assert.equal(m.start % 2.5, 0, `${key} ${kg} kg -> start ${m.start}`);
      assert.equal(m.to - m.start, 2.5, `${key} ${kg} kg -> ${m.start} -> ${m.to}`);
      assert.ok(m.to - m.from >= 1.25 - 1e-9 && m.to - m.from <= 3.75 + 1e-9, `${key} ${kg} kg -> ${m.to}: the real step from the logged load is 1.25-3.75 kg`);
      assert.ok(Math.abs(m.start - m.from) <= 1.25 + 1e-9, `${key} ${kg} kg -> start ${m.start} is the nearest grid value`);
      assert.equal(m.approx, m.start !== m.from, `${key} ${kg} kg approx`);
      const lb = nextWorkingLoad(kg, key, true);
      assert.equal(lb.start % 5, 0, `${key} ${kg} kg -> start ${lb.start} lb`);
      assert.equal(lb.to - lb.start, 5, `${key} ${kg} kg -> ${lb.start} -> ${lb.to} lb`);
      assert.ok(lb.to - lb.from >= 2.5 - 1e-9 && lb.to - lb.from <= 7.5 + 1e-9, `${key} ${kg} kg -> ${lb.to} lb: the real step from the logged load is 2.5-7.5 lb`);
      assert.ok(Math.abs(lb.start - lb.from) <= 2.5 + 1e-9, `${key} ${kg} kg -> start ${lb.start} lb is the nearest grid value`);
      assert.equal(lb.approx, lb.start !== lb.from, `${key} ${kg} kg approx lb`);
    }
  }
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

test('liftReturnStates: every lift with a pre-break best and a session since, the headline lift first, then the other MAIN lifts (wave 21)', () => {
  const squat = [...preBreak, ...afterBreak]; // 142 pre-break, 138 since
  const deadlift = [ls('2026-08-24', 158, 2), ls('2026-09-07', 160, 2), ls('2026-09-28', 150, 2), ls('2026-10-05', 157, 2)]; // 157 of 160
  const bench = [ls('2026-08-31', 100, 2), ls('2026-09-07', 106, 2), ls('2026-10-05', 106, 2)]; // back at 106
  const latPulldown = [ls('2026-09-07', 90, 2), ls('2026-10-05', 70, 2)]; // an accessory, 78%
  const states = liftReturnStates({ squat, deadlift, 'bench press': bench, 'lat pulldown': latPulldown }, DAYS_WITH_BREAK, '2026-10-06');
  // Most-trained first (squat 6 weeks, deadlift 4, bench 3); the accessory never joins.
  assert.deepEqual(states.map(r => [r.exercise, r.preBreakKg, r.recentKg, r.regained]), [
    ['squat', 142, 138, false], ['deadlift', 160, 157, false], ['bench press', 106, 106, true],
  ]);
  // The first entry IS what `liftReturnState` returns (the payload's `liftReturn`).
  assert.deepEqual(states[0], liftReturnState({ squat, deadlift, 'bench press': bench, 'lat pulldown': latPulldown }, DAYS_WITH_BREAK, '2026-10-06'));
  // An accessory can be the headline lift (the most-trained lift with both numbers) but then it is alone with the main lifts.
  const busy = [...trainedWeeks.map(w => ls(w, 90, 4)), ls('2026-09-28', 70, 4), ls('2026-10-05', 70, 4)];
  const withAccessory = liftReturnStates({ squat, 'lat pulldown': busy }, DAYS_WITH_BREAK, '2026-10-06');
  assert.deepEqual(withAccessory.map(r => r.exercise), ['lat pulldown', 'squat']);
  // A main lift with no pre-break best, or no session since, has no state; no break, no states.
  assert.deepEqual(liftReturnStates({ squat, deadlift: afterBreak }, DAYS_WITH_BREAK, '2026-10-06').map(r => r.exercise), ['squat']);
  assert.deepEqual(liftReturnStates({ squat, deadlift: preBreak }, DAYS_WITH_BREAK, '2026-10-06').map(r => r.exercise), ['squat']);
  assert.deepEqual(liftReturnStates({ squat }, ['2026-10-05'], '2026-10-06'), []);
});

test('furthestBehindReturn: the lowest share of the pre-break best among the lifts not back; null when every lift is', () => {
  const r = (exercise: string, preBreakKg: number, recentKg: number, regained = false) => ({ exercise, preBreakKg, recentKg, regained });
  assert.equal(furthestBehindReturn([r('squat', 142, 138), r('deadlift', 160, 150), r('bench press', 100, 99)])!.exercise, 'deadlift');
  assert.equal(furthestBehindReturn([r('squat', 142, 145, true), r('deadlift', 160, 157)])!.exercise, 'deadlift');
  assert.equal(furthestBehindReturn([r('squat', 142, 145, true), r('deadlift', 160, 160, true)]), null);
  assert.equal(furthestBehindReturn([]), null);
  // A tie keeps the order given (the headline lift first).
  assert.equal(furthestBehindReturn([r('squat', 100, 90), r('deadlift', 200, 180)])!.exercise, 'squat');
});

test('liftLapseMinDays: clamp(ceil(14 / weekly target), 4, 7) — 4 days for 4 a week, a week for 2 or no target (wave 21)', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(liftLapseMinDays), [7, 7, 5, 4, 4, 4, 4]);
  assert.equal(liftLapseMinDays(null), 7);
  assert.equal(liftLapseMinDays(undefined), 7);
  assert.equal(liftLapseMinDays(0), 7);
});

test('weekOverWeekWording: the window it is about and what it is measured against (wave 21)', () => {
  const change = (previousWeekStart: string) => ({ previousWeekStart, previousKg: 100, currentKg: 104, changeKg: 4 });
  // Anchor Monday 09-28: 09-21 is last week, 09-28 this week.
  assert.deepEqual(weekOverWeekWording(change('2026-09-14'), '2026-09-21', '2026-09-28'), { window: 'Last week', vs: 'vs the week before' });
  assert.deepEqual(weekOverWeekWording(change('2026-09-21'), '2026-09-28', '2026-09-28'), { window: 'This week', vs: 'vs last week' });
  // A skipped week in between: it is the last TRAINED week, not the week before.
  assert.deepEqual(weekOverWeekWording(change('2026-09-07'), '2026-09-21', '2026-09-28'), { window: 'Last week', vs: 'vs last trained week' });
  assert.deepEqual(weekOverWeekWording(change('2026-09-07'), '2026-09-28', '2026-09-28'), { window: 'This week', vs: 'vs last trained week' });
  // Any other end week has no window.
  assert.equal(weekOverWeekWording(change('2026-08-31'), '2026-09-07', '2026-09-28').window, null);
});

// ── Wave 20b: week over week, a lapse, the return as shown, every main lift's next load ──

const lt = (weekStart: string, e: number | null, top: number | null = null, sessions = 2): LiftWeekPoint => ({
  weekStart, bestEstimatedOneRepMaxKg: e, topLoadKg: top, sessions, totalSets: sessions * 3, volumeKg: 3000,
});

test('liftWeekOverWeek: the end week against the newest earlier week with an e1RM (a gap week in between is skipped)', () => {
  const weeks = [lt('2026-09-07', 130), lt('2026-09-14', null), lt('2026-09-28', 133.4)];
  assert.deepEqual(liftWeekOverWeek(weeks, '2026-09-28'), { previousWeekStart: '2026-09-07', previousKg: 130, currentKg: 133.4, changeKg: 3.4 });
  assert.equal(liftWeekOverWeek(weeks, '2026-09-21'), null, 'no e1RM in the end week');
  assert.equal(liftWeekOverWeek([lt('2026-09-28', 133.4)], '2026-09-28'), null, 'nothing earlier');
});

test('pickWeekOverWeek: the most-trained lift that can use the first end week; the card falls through to the week in progress', () => {
  const squat = [lt('2026-09-14', 100, 80, 3), lt('2026-09-21', 103, 82.5, 3)];
  const bench = [lt('2026-09-14', 80, 60, 1), lt('2026-09-21', 82, 62.5, 1)];
  const anchor = '2026-09-28';
  assert.equal(pickWeekOverWeek({ squat, bench }, anchor, ['2026-09-21'])!.exercise, 'squat');
  // The review passes only the reviewed week; the card passes the last completed week first, then the one in progress.
  assert.equal(pickWeekOverWeek({ squat }, anchor, ['2026-09-21'])!.end, '2026-09-21');
  const early = { squat: [lt('2026-09-21', 100, 80, 3), lt('2026-09-28', 104, 82.5, 1)] };
  assert.equal(pickWeekOverWeek(early, anchor, ['2026-09-21']), null, 'week 1 has nothing before it');
  assert.equal(pickWeekOverWeek(early, anchor, ['2026-09-21', anchor])!.end, anchor);
});

test('liftLastBest: the recent-window best before a lapse and the Monday it was set; the newest e1RM when the lift is out of the look-back', () => {
  const weeks = [lt('2026-08-31', 133), lt('2026-09-07', 139), lt('2026-09-14', 136)];
  // anchor 09-21 looks back to 09-14 (end): recent = best(09-14: 136, 09-07: 139) = 139 from the week of 09-07.
  assert.deepEqual(liftLastBest(weeks, '2026-09-21'), { kg: 139, weekStart: '2026-09-07' });
  // Ties go to the newer week.
  assert.deepEqual(liftLastBest([lt('2026-09-07', 139), lt('2026-09-14', 139)], '2026-09-21'), { kg: 139, weekStart: '2026-09-14' });
  // Anchor far past the last week: the newest week with an e1RM stands in.
  assert.deepEqual(liftLastBest(weeks, '2026-11-02'), { kg: 139, weekStart: '2026-09-07' });
  assert.equal(liftLastBest([lt('2026-09-07', null)], '2026-09-21'), null);
});

test('liftReturnDisplay: whole numbers as shown, the percentage from those numbers, never "142 of 142" before it is regained', () => {
  // 136.5 -> 137 shown, 142.4 -> 142: 137/142 = 96%, where the unrounded 136.5/142.4 would say 95%.
  assert.deepEqual(liftReturnDisplay({ preBreakKg: 142.4, recentKg: 136.5, regained: false }, false), { pre: 142, recent: 137, pct: 96, unit: 'kg' });
  // Rounds up to the pre-break number while still under it: shown one under.
  assert.deepEqual(liftReturnDisplay({ preBreakKg: 142.4, recentKg: 141.6, regained: false }, false), { pre: 142, recent: 141, pct: 99, unit: 'kg' });
  // Regained: rounded to the nearest percent, may reach 100+.
  assert.deepEqual(liftReturnDisplay({ preBreakKg: 142, recentKg: 145, regained: true }, false), { pre: 142, recent: 145, pct: 102, unit: 'kg' });
  // Pounds: the shown lb numbers drive the percentage (130 kg = 287 lb, 140 kg = 309 lb): 287 / 309 = 92.9%.
  assert.deepEqual(liftReturnDisplay({ preBreakKg: 140, recentKg: 130, regained: false }, true), { pre: 309, recent: 287, pct: 93, unit: 'lb' });
  // Rounded the normal way (wave 21): 139 of 142 is 97.9% -> 98, where it was floored to "97%".
  assert.equal(liftReturnDisplay({ preBreakKg: 142, recentKg: 139, regained: false }, false).pct, 98);
  assert.equal(liftReturnDisplay({ preBreakKg: 142, recentKg: 136, regained: false }, false).pct, 96); // 95.8
  assert.equal(liftReturnDisplay({ preBreakKg: 142, recentKg: 135, regained: false }, false).pct, 95); // 95.07
  // ... but 99.67% still never reads 100% while under the best.
  assert.deepEqual(liftReturnDisplay({ preBreakKg: 300, recentKg: 299.4, regained: false }, false), { pre: 300, recent: 299, pct: 99, unit: 'kg' });
});

test('liftRegressed: more than 1% under the previous trained week; nothing to compare is not a regression', () => {
  const w = (e: number) => [lt('2026-09-07', 100), lt('2026-09-14', e)];
  assert.equal(liftRegressed(w(98), '2026-09-14'), true);
  assert.equal(liftRegressed(w(99.5), '2026-09-14'), false, 'within 1%');
  assert.equal(liftRegressed(w(104), '2026-09-14'), false);
  assert.equal(liftRegressed([lt('2026-09-14', 90)], '2026-09-14'), false);
});

test('cuedLifts: the lead lift first, then the main lifts trained that week (most-trained first); accessories and untrained lifts are left out', () => {
  const wkStart = '2026-09-28';
  const prog = {
    squat: [lt(wkStart, 140, 110, 2)],
    'bench press': [lt(wkStart, 100, 80, 3)],
    deadlift: [lt('2026-09-21', 160, 130, 2)], // not trained in the reviewed week
    'leg extension': [lt(wkStart, 90, 60, 5)], // an accessory, however much it was trained
    'overhead press': [lt(wkStart, 70, 50, 1)],
  };
  assert.deepEqual(cuedLifts(prog, wkStart, 'squat'), ['squat', 'bench press', 'overhead press']);
  assert.deepEqual(cuedLifts(prog, wkStart, null), ['bench press', 'squat', 'overhead press']);
  // A non-main headline lift still leads when it was trained; at most three lifts.
  assert.deepEqual(cuedLifts(prog, wkStart, 'leg extension'), ['leg extension', 'bench press', 'squat']);
  assert.deepEqual(cuedLifts({ deadlift: prog.deadlift }, wkStart, 'deadlift'), []);
});

test('nextLoadCues: the same next-load rule per lift; a lift that went backwards holds; a rebuild never holds', () => {
  const wkStart = '2026-09-28';
  const prog = {
    squat: [lt('2026-09-21', 140, 107.5), lt(wkStart, 142, 110)],
    'bench press': [lt('2026-09-21', 100, 87.5), lt(wkStart, 100.4, 87.5)],
    deadlift: [lt('2026-09-21', 160, 132.5), lt(wkStart, 150, 130)],
  };
  const cues = nextLoadCues(prog, wkStart, { imperial: false, leadKey: 'squat', rebuilding: false });
  assert.deepEqual(cues.map(c => [c.key, c.load.from, c.load.to, c.hold]), [
    ['squat', 110, 112.5, false],
    ['bench press', 87.5, 90, false], // +2.5 for every lift: 88.75 is not a plate load
    ['deadlift', 130, 132.5, true], // e1RM fell 6%: hold at 130
  ]);
  assert.equal(nextLoadCues(prog, wkStart, { imperial: false, leadKey: 'squat', rebuilding: true }).some(c => c.hold), false);
});

test('liftShortName: bench press is "bench"; others are the display name, lower-cased', () => {
  assert.equal(liftShortName('bench press'), 'bench');
  assert.equal(liftShortName('deadlift'), 'deadlift');
  assert.equal(liftShortName('overhead press', { 'overhead press': 'Overhead Press' }), 'overhead press');
  assert.equal(liftDisplayName('squat'), 'Squat');
});
