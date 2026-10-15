import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays,
  bridgedPace,
  etaDaysAhead,
  isReturning,
  meanOver,
  paceEta,
  paceLossPct,
  rawPlateau,
  relationForDays,
  tooFastLoss,
  weeksForDays,
  weighInReturn,
  weightPace,
  weightReachedRead,
  type RawWeightDay,
} from './weightPace';
import { computeWeightTrend, type WeightReading } from './weightTrend';

const END = '2026-10-06';

/** Daily raw readings for the `n` days ending `END`, kg following `kgAt(i)` with i = 0 oldest. */
function daily(n: number, kgAt: (i: number) => number): RawWeightDay[] {
  return Array.from({ length: n }, (_, i) => ({ day: addDays(END, -(n - 1 - i)), rawKg: kgAt(i) }));
}

function readingsFor(days: RawWeightDay[]): WeightReading[] {
  return days.map(d => ({ measuredAt: `${d.day}T08:00:00.000Z`, valueKg: d.rawKg, source: 'manual' as const, localDay: d.day }));
}

// ── weightPace ──────────────────────────────────────────────────────────────

test('weightPace: a straight line reads its exact slope in kg/wk, % of bodyweight and the fitted weight', () => {
  const pace = weightPace(daily(21, i => 90 - 0.1 * i), END)!;
  assert.ok(pace);
  assert.ok(Math.abs(pace.kgPerWeek + 0.7) < 1e-9, `kg/wk ${pace.kgPerWeek}`);
  assert.ok(Math.abs(pace.fittedKg - 88) < 1e-9);
  assert.ok(Math.abs(pace.pctPerWeek + (0.7 / 88) * 100) < 1e-9);
  assert.equal(pace.weighIns, 21);
  assert.equal(pace.spanDays, 20);
  assert.equal(pace.newestDay, END);
});

test('weightPace: needs 6 weigh-ins spanning 14 days in the last 21 — otherwise there is no pace', () => {
  // 5 readings over 14 days.
  const five = [0, 3, 7, 10, 14].map(o => ({ day: addDays(END, -14 + o), rawKg: 90 - o * 0.1 }));
  assert.equal(weightPace(five, END), null);
  // 6 readings over 14 days is enough.
  const six = [0, 3, 7, 10, 12, 14].map(o => ({ day: addDays(END, -14 + o), rawKg: 90 - o * 0.1 }));
  assert.ok(weightPace(six, END));
  // 8 readings over only 7 days is not.
  assert.equal(weightPace(daily(8, i => 90 - 0.3 * i), END), null);
  // 13 days of span is not.
  assert.equal(weightPace(daily(14, i => 90 - 0.1 * i), END), null);
  assert.ok(weightPace(daily(15, i => 90 - 0.1 * i), END), '15 days is a 14-day span');
});

test('weightPace: only the last 21 days count, and readings after asOf are ignored', () => {
  // 40 days: flat at 90 until 21 days ago, then falling 0.1 kg/day.
  const days = daily(40, i => (i < 19 ? 90 : 90 - 0.1 * (i - 18)));
  const pace = weightPace(days, END)!;
  assert.ok(Math.abs(pace.kgPerWeek + 0.7) < 1e-6, `the old flat stretch is outside the window: ${pace.kgPerWeek}`);
  // As of a week ago the same readings give a different (earlier) window.
  const earlier = weightPace(days, addDays(END, -7))!;
  assert.equal(earlier.newestDay, addDays(END, -7));
  assert.ok(Math.abs(earlier.kgPerWeek) < Math.abs(pace.kgPerWeek), 'the earlier window still includes the flat stretch');
});

test('weightPace: one wild reading moves a 3-week pace far less than it moves a 7-day trend slope', () => {
  const clean = daily(21, i => 90 - 0.07 * i);
  const noisy = clean.map((d, i) => (i === 20 ? { ...d, rawKg: d.rawKg + 1.5 } : d));
  const a = weightPace(clean, END)!.kgPerWeek;
  const b = weightPace(noisy, END)!.kgPerWeek;
  assert.ok(Math.abs(a - b) < 0.35, `${a} vs ${b}`);
});

test('meanOver: the mean of the readings in the 7 days up to and including the end day', () => {
  const days = daily(10, i => 90 + i); // 90..99
  const m = meanOver(days, END)!;
  assert.equal(m.n, 7);
  assert.equal(m.meanKg, 96); // 93..99
  assert.equal(meanOver([], END), null);
});

// ── pace against a target date ──────────────────────────────────────────────

test('paceEta / relationForDays / weeksForDays: one margin, whole weeks rounded, at least 1', () => {
  const pace = weightPace(daily(21, i => 90 - 0.1 * i), END)!;
  // 88 kg now, 0.7 kg/wk, target 84: 4 kg is 40 days.
  assert.equal(paceEta(pace, 84), addDays(END, 40));
  assert.equal(paceEta(pace, 84, { maxDays: 30 }), null, 'beyond the horizon');
  assert.equal(paceEta(pace, 92), null, 'wrong way');
  assert.equal(paceEta(pace, 84, { minPct: 5 }), null, 'too flat to project');
  assert.equal(etaDaysAhead('2026-10-01', '2026-10-10'), 9);
  assert.equal(relationForDays(8), 'ahead');
  assert.equal(relationForDays(7), 'on_pace');
  assert.equal(relationForDays(-7), 'on_pace');
  assert.equal(relationForDays(-8), 'behind');
  assert.equal(weeksForDays(10), 1);
  assert.equal(weeksForDays(-17), 2);
  assert.equal(weeksForDays(-24), 3);
  assert.equal(weeksForDays(8), 1);
});

// ── coming back after a gap ─────────────────────────────────────────────────

test('weighInReturn: 7+ days without a weigh-in, and how many weigh-ins are back', () => {
  const before = daily(30, i => 90 - 0.05 * i).slice(0, 15); // 15 days
  const lastBefore = before[before.length - 1];
  const gapEnd = addDays(lastBefore.day, 13); // 12 days without a weigh-in
  const back = (n: number): RawWeightDay[] => Array.from({ length: n }, (_, i) => ({ day: addDays(gapEnd, i), rawKg: lastBefore.rawKg - 1.1 }));

  assert.equal(weighInReturn(before), null);
  const one = weighInReturn([...before, ...back(1)])!;
  assert.equal(one.gapDays, 12);
  assert.equal(one.lastBeforeDay, lastBefore.day);
  assert.equal(one.lastBeforeKg, lastBefore.rawKg);
  assert.equal(one.firstBackDay, gapEnd);
  assert.equal(one.weighInsSince, 1);
  assert.equal(isReturning(one), true);
  assert.equal(isReturning(weighInReturn([...before, ...back(2)])), true);
  assert.equal(isReturning(weighInReturn([...before, ...back(3)])), false);
  // 6 days without a weigh-in is not a gap; 7 is.
  const days = (without: number): RawWeightDay[] => [{ day: '2026-09-01', rawKg: 90 }, { day: addDays('2026-09-01', without + 1), rawKg: 89 }];
  assert.equal(weighInReturn(days(6)), null);
  assert.ok(weighInReturn(days(7)));
  // A gap that starts before the goal began (an old backfilled reading) is not a return.
  assert.equal(weighInReturn(days(30), '2026-09-15'), null);
});

// ── plateau on raw data ─────────────────────────────────────────────────────

test('rawPlateau: three flat weekly means (last two within 0.2 kg of the week before them), 3+ weigh-ins a week, goal 28+ days old', () => {
  const flat = daily(21, i => 89.5 + (i % 2 === 0 ? 0.1 : -0.1));
  const p = rawPlateau(flat, END, 40)!;
  assert.ok(p);
  assert.ok(Math.abs(p.weeklyMeanKg - 89.5) < 0.05);
  assert.equal(rawPlateau(flat, END, 27), null, 'goal under 28 days old');
  assert.ok(rawPlateau(flat, END, null), 'unknown goal age: the weigh-in minimums stand alone');
  // Falling 0.3 kg a week between weekly means is not flat.
  assert.equal(rawPlateau(daily(21, i => 90 - (0.3 / 7) * i), END, 40), null);
  // 0.2 kg is inside the tolerance.
  assert.ok(rawPlateau(daily(21, i => 90 - (0.1 / 7) * i), END, 40));
  // Only two weigh-ins in the oldest week.
  const sparse = daily(21, () => 89.5).filter((d, i) => i >= 7 || i === 0 || i === 6);
  assert.equal(rawPlateau(sparse, END, 40), null);
});

// ── reached ─────────────────────────────────────────────────────────────────

function trendOf(days: RawWeightDay[]) {
  return computeWeightTrend(readingsFor(days)).days;
}

const REACH = { targetKg: 84, gain: false, lapseKg: 1, startDay: null as string | null };

test('weightReachedRead: the 7-day raw mean within 0.3 kg of the target reaches it, before the lagging trend does', () => {
  // 30 days falling 0.1 kg a day from 90 to 87.1, then 12 days at 83.8 (the user got there).
  const days = daily(42, i => (i < 30 ? 90 - 0.1 * i : 83.8));
  const t = trendOf(days);
  const r = weightReachedRead(t, REACH);
  assert.equal(r.reached, true);
  const trendDay = t.find(d => d.trendKg <= 84.1)?.day;
  assert.ok(r.reachedAt, 'reachedAt known');
  assert.ok(trendDay == null || r.reachedAt! < trendDay, `weekly mean (${r.reachedAt}) beats the trend (${trendDay})`);
  // The first day the 7-day mean (3+ weigh-ins) was within 0.3 kg of 84.
  const first = t.find((d, i) => {
    const week = t.slice(Math.max(0, i - 6), i + 1);
    return week.length >= 3 && week.reduce((a, w) => a + w.rawKg, 0) / week.length <= 84.3 + 1e-9;
  });
  assert.equal(r.reachedAt, first!.day);
});

test('weightReachedRead: once reached it stays reached — one high reading cannot flip it back', () => {
  const days = daily(45, i => (i < 30 ? 90 - 0.2 * i : 83.9));
  const spike = days.map((d, i) => (i === days.length - 1 ? { ...d, rawKg: 84.5 } : d));
  assert.equal(weightReachedRead(trendOf(days), REACH).reached, true);
  const after = weightReachedRead(trendOf(spike), REACH);
  assert.equal(after.reached, true);
  assert.equal(after.reachedAt, weightReachedRead(trendOf(days), REACH).reachedAt, 'same first day');
});

test('weightReachedRead: it lapses only when the trend later goes more than 1 kg past the target', () => {
  const reachedThenGain = (gainKg: number): RawWeightDay[] => daily(70, i => (i < 30 ? 90 - 0.2 * i : i < 40 ? 84 : 84 + (gainKg / 30) * (i - 39)));
  assert.equal(weightReachedRead(trendOf(reachedThenGain(0.6)), REACH).reached, true, 'a 0.6 kg climb is still holding');
  assert.equal(weightReachedRead(trendOf(reachedThenGain(5)), REACH).reached, false, 'a 5 kg climb ends the reached stretch');
  // ...and it can be reached again, with a new first day.
  const again = trendOf(daily(110, i => (i < 30 ? 90 - 0.2 * i : i < 40 ? 84 : i < 70 ? 84 + (5 / 30) * (i - 39) : i < 80 ? 89 : 89 - 0.5 * (i - 79))));
  const r = weightReachedRead(again, REACH);
  assert.equal(r.reached, true);
  assert.ok(r.reachedAt! > again[79].day, `a new first day after the lapse: ${r.reachedAt}`);
});

test('weightReachedRead: reachedAt is null when the crossing was not observed (first reading already there, or before the goal began)', () => {
  const alreadyThere = trendOf(daily(20, () => 83.8));
  assert.deepEqual(weightReachedRead(alreadyThere, REACH), { reached: true, reachedAt: null });
  const days = daily(40, i => (i < 20 ? 90 - 0.35 * i : 83));
  const t = trendOf(days);
  const known = weightReachedRead(t, REACH);
  assert.ok(known.reachedAt);
  assert.equal(weightReachedRead(t, { ...REACH, startDay: addDays(known.reachedAt!, 1) }).reachedAt, null, 'the stretch began before the goal');
});

test('weightReachedRead mirrors for a weight-gain target', () => {
  const days = daily(55, i => (i < 40 ? 70 + 0.2 * i : 77.9)); // 70 -> 77.8, then holding at 77.9
  const gain = { targetKg: 78, gain: true, lapseKg: 1, startDay: null };
  const t = trendOf(days);
  const r = weightReachedRead(t, gain);
  assert.equal(r.reached, true, 'weekly mean 77.9 is within 0.3 kg of 78');
  assert.ok(r.reachedAt);
  assert.equal(weightReachedRead(trendOf(daily(10, i => 70 + 0.2 * i)), gain).reached, false);
  // Lapses when the trend falls more than 1 kg under the target.
  const fell = trendOf(daily(80, i => (i < 40 ? 70 + 0.2 * i : 77.8 - 0.4 * (i - 39))));
  assert.equal(weightReachedRead(fell, gain).reached, false);
});

// ── wave 20c: a pace that survives a gap, and a too-fast call that does not flicker ──

test('bridgedPace: for 7 days after the last valid 21-day pace the line is fitted over 28 days, so a gap does not drop the pace', () => {
  // 15 daily readings (a 14-day span) from 30 to 16 days before END, then nothing.
  const pre = Array.from({ length: 15 }, (_, i) => ({ day: addDays(END, -30 + i), rawKg: 90 - 0.1 * i }));
  assert.ok(weightPace(pre, addDays(END, -10)), 'valid while the first reading is still inside the 21 days');
  assert.equal(weightPace(pre, addDays(END, -9)), null, 'the oldest reading slid out: 13 days of span');
  const bridged = bridgedPace(pre, addDays(END, -9))!;
  assert.ok(bridged, 'a valid pace existed the day before');
  assert.equal(bridged.windowDays, 28);
  assert.ok(Math.abs(bridged.kgPerWeek + 0.7) < 1e-9, `the same line: ${bridged.kgPerWeek}`);
  assert.ok(bridgedPace(pre, addDays(END, -3)), '7 days after the last valid pace is still bridged');
  assert.equal(bridgedPace(pre, addDays(END, -2)), null, 'an 8th day with no pace is no pace');
  // While the pace is directly valid nothing changes.
  const direct = bridgedPace(pre, addDays(END, -10))!;
  assert.equal(direct.windowDays, 21);
  assert.deepEqual(direct, weightPace(pre, addDays(END, -10)));
});

test('paceLossPct: the printed % of bodyweight per week lost; 0 when the scale is not falling', () => {
  assert.equal(paceLossPct(weightPace(daily(21, i => 90 - 0.1 * i), END)!), 0.8);
  assert.equal(paceLossPct(weightPace(daily(21, i => 90 + 0.1 * i), END)!), 0);
});

/** 100 kg falling `fast` kg/wk for the first `fastDays` days, then `slow` kg/wk, for `n` days ending END. */
function twoSpeeds(n: number, fastDays: number, fast: number, slow: number): RawWeightDay[] {
  let kg = 100;
  return Array.from({ length: n }, (_, i) => {
    const row = { day: addDays(END, -(n - 1 - i)), rawKg: Math.round(kg * 1000) / 1000 };
    kg -= (i < fastDays ? fast : slow) / 7;
    return row;
  });
}

test('tooFastLoss: entered only when the pace now AND a week ago are above 1%/wk', () => {
  // A week flat, then 1.6 kg/wk: 22 days in the pace is -1.4%/wk but the pace a week earlier was under 1%.
  const flatThenFast = (n: number) => daily(n, i => 100 - (1.6 / 7) * Math.max(0, i - 6));
  assert.equal(tooFastLoss(flatThenFast(22), END), false);
  assert.equal(tooFastLoss(flatThenFast(30), END), true);
  // A steady 0.9 kg/wk (about 0.95%) never is.
  assert.equal(tooFastLoss(daily(40, i => 100 - (0.9 / 7) * i), END), false);
});

test('tooFastLoss: once in, only a pace below 0.9%/wk ends it — 0.9 to 1.0 keeps the call', () => {
  const at = (n: number) => twoSpeeds(n, 28, 1.3, 0.62).slice(0, n);
  // The days are re-anchored by twoSpeeds, so ask as of each series' last day.
  const call = (n: number) => { const d = at(n); return tooFastLoss(d, d[d.length - 1].day); };
  const pctAt = (n: number) => { const d = at(n); return paceLossPct(bridgedPace(d, d[d.length - 1].day)!); };
  assert.equal(call(30), true);
  assert.ok(pctAt(40) <= 1.0 && pctAt(40) >= 0.9, `the pace eased into the 0.9-1.0 band: ${pctAt(40)}`);
  assert.equal(call(40), true, 'held between 0.9 and 1.0');
  assert.ok(pctAt(42) < 0.9, `${pctAt(42)}`);
  assert.equal(call(42), false);
});

test('tooFastLoss: a goal\'s early weeks (before settledFrom) never start the call', () => {
  const d = daily(22, i => 100 - (1.2 / 7) * i);
  assert.equal(tooFastLoss(d, END), true);
  assert.equal(tooFastLoss(d, END, { settledFrom: addDays(END, 1) }), false);
  assert.equal(tooFastLoss(d, END, { settledFrom: addDays(END, -1) }), true);
});
