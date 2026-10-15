import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RACE_EVE_LINE,
  addDayKey,
  breakThreshold,
  enduranceWeekPlan,
  findRaceRun,
  formatRaceTime,
  formatTargetLongRun,
  gradeEnduranceWeek,
  isLongRun,
  isSpikeWeek,
  isWindDownPhase,
  longRunAtPeak,
  longRunCapNote,
  longRunPeakTarget,
  longRunStepKm,
  mondayOfDay,
  peakWeekKmBeforeTaper,
  planWeekKm,
  raceClass,
  racePhase,
  racePhaseInfo,
  racePhaseTargetKm,
  raceRules,
  recoveryWeek,
  roundLongRunKm,
  roundWeekTargetKm,
  type EnduranceWeekPlanInput,
  type PlanRun,
  weekStepTarget,
  weekStepTargetKm,
  windDownBand,
} from './enduranceProgression';

test('weekStepTarget: ~10% over last week, at least +1, never past the target', () => {
  assert.equal(weekStepTarget(24.5, 30), 27); // round(26.95)
  assert.equal(weekStepTarget(18, 30), 20); // round(19.8)
  assert.equal(weekStepTarget(12, 30), 13); // round(13.2)
  assert.equal(weekStepTarget(5, 30), 6); // round(5.5) = 6
  assert.equal(weekStepTarget(2.2, 30), 3); // round(2.42) = 2 -> floor(2.2) + 1 = 3 so a small week still moves
  assert.equal(weekStepTarget(27, 30), 30); // 29.7 -> 30, the target itself
  assert.equal(weekStepTarget(28, 30), 30); // 30.8 -> capped at the target
  assert.equal(weekStepTarget(45, 30), 30); // above the target: the target, never more
});

test('weekStepTarget: no base to grow from (under 1 unit, not finite, unusable target) is null', () => {
  assert.equal(weekStepTarget(0, 30), null);
  assert.equal(weekStepTarget(0.9, 30), null);
  assert.equal(weekStepTarget(Number.NaN, 30), null);
  assert.equal(weekStepTarget(10, 0), null);
  assert.equal(weekStepTarget(10, Number.POSITIVE_INFINITY), null);
});

test('weekStepTargetKm: km in, km out; the step is rounded in the display unit', () => {
  assert.equal(weekStepTargetKm(24.5, 30), 27);
  assert.equal(weekStepTargetKm(0.5, 30), null);
  // Miles: 24.5 km = 15.2 mi -> 17 mi = 27.36 km; the 30 km target = 18.64 mi is not reached.
  const MI_PER_KM = 1 / 1.609344;
  const step = weekStepTargetKm(24.5, 30, MI_PER_KM)!;
  assert.ok(Math.abs(step * MI_PER_KM - 17) < 1e-9, `${step}`);
  // Reaching the target returns the target exactly (no float round trip).
  assert.equal(weekStepTargetKm(28, 30, MI_PER_KM), 30);
  assert.equal(weekStepTargetKm(10, 30, 0), null);
});

test('longRunStepKm: +2 km at most, never past the peak target, held at the peak', () => {
  assert.equal(longRunStepKm(14, 18), 16);
  assert.equal(longRunStepKm(17, 18), 18); // only 1 km of room
  assert.equal(longRunStepKm(18, 18), 18); // at the peak: hold
  assert.equal(longRunStepKm(20, 18), 18); // past the peak: back to it
  assert.equal(longRunStepKm(14, null), 16); // no peak target: +2 km
  assert.equal(longRunStepKm(14.3, undefined), 16.3);
  assert.equal(longRunAtPeak(18, 18), true);
  assert.equal(longRunAtPeak(17, 18), false);
  assert.equal(longRunAtPeak(30, null), false);
});

// ── Race lifecycle ──────────────────────────────────────────────────────────

const RACE = '2026-12-31';

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The phase when the race is `daysOut` days away (negative = days since). */
function phaseAt(daysOut: number): ReturnType<typeof racePhase> {
  return racePhase(RACE, addDays(RACE, -daysOut));
}

test('racePhase: boundaries at 22 / 21 / 8 / 7 / 0 / -1 / -14 / -15 days', () => {
  assert.equal(phaseAt(22), 'build');
  assert.equal(phaseAt(21), 'taper');
  assert.equal(phaseAt(8), 'taper');
  assert.equal(phaseAt(7), 'race_week');
  assert.equal(phaseAt(0), 'race_week'); // race day itself
  assert.equal(phaseAt(-1), 'recovery');
  assert.equal(phaseAt(-14), 'recovery');
  assert.equal(phaseAt(-15), null);
  assert.equal(phaseAt(400), 'build');
  assert.equal(phaseAt(-400), null);
});

test('racePhase: no date, malformed date and malformed today are null', () => {
  assert.equal(racePhase(null, '2026-10-06'), null);
  assert.equal(racePhase(undefined, '2026-10-06'), null);
  assert.equal(racePhase('', '2026-10-06'), null);
  assert.equal(racePhase('soon', '2026-10-06'), null);
  assert.equal(racePhase('2026-12-31', 'today'), null);
});

test('racePhaseInfo carries the signed day count; helpers classify phases', () => {
  // No race distance keeps the marathon rules.
  assert.deepEqual(racePhaseInfo(RACE, addDays(RACE, -10)), { phase: 'taper', daysToRace: 10, raceClass: 'long' });
  assert.deepEqual(racePhaseInfo(RACE, addDays(RACE, 3)), { phase: 'recovery', daysToRace: -3, raceClass: 'long' });
  assert.equal(racePhaseInfo(RACE, addDays(RACE, -10), 21.1)?.raceClass, 'half');
  assert.equal(isWindDownPhase('taper'), true);
  assert.equal(isWindDownPhase('race_week'), true);
  assert.equal(isWindDownPhase('recovery'), true);
  assert.equal(isWindDownPhase('build'), false);
  assert.equal(isWindDownPhase(null), false);
  assert.equal(recoveryWeek(1), 1);
  assert.equal(recoveryWeek(7), 1);
  assert.equal(recoveryWeek(8), 2);
  assert.equal(recoveryWeek(14), 2);
});

function target(daysOut: number, peak: number, opts: Parameters<typeof racePhaseTargetKm>[2] = {}): number | null {
  const info = racePhaseInfo(RACE, addDays(RACE, -daysOut));
  return info ? racePhaseTargetKm(info, peak, opts) : null;
}

test('racePhaseTargetKm: taper x0.75 for 14-21 days out, x0.6 for 8-13', () => {
  assert.equal(target(21, 40), 30);
  assert.equal(target(14, 40), 30);
  assert.equal(target(13, 40), 24);
  assert.equal(target(8, 40), 24);
  assert.equal(target(14, 33), 25); // round(24.75)
  assert.equal(target(8, 33), 20); // round(19.8)
});

test('racePhaseTargetKm: race week x0.4 (race excluded); recovery week 1 x0.4, week 2 x0.6', () => {
  assert.equal(target(7, 40), 16);
  assert.equal(target(0, 40), 16);
  assert.equal(target(-1, 40), 16); // recovery week 1
  assert.equal(target(-7, 40), 16);
  assert.equal(target(-8, 40), 24); // recovery week 2
  assert.equal(target(-14, 40), 24);
});

test('racePhaseTargetKm: none in build or after recovery; unusable peaks are null; never below 1 unit', () => {
  assert.equal(target(22, 40), null);
  assert.equal(target(-15, 40), null);
  assert.equal(target(10, 0), null);
  assert.equal(target(10, Number.NaN), null);
  assert.equal(target(10, -5), null);
  assert.equal(target(0, 1), 1); // round(0.4) = 0 -> at least 1 km
});

test('racePhaseTargetKm: capped at the weekly goal; imperial rounds to the nearest half mile', () => {
  assert.equal(target(14, 60, { weeklyGoalKm: 30 }), 30); // 45 km capped at the 30 km goal
  assert.equal(target(14, 40, { weeklyGoalKm: 30 }), 30);
  assert.equal(target(14, 40, { weeklyGoalKm: 50 }), 30);
  assert.equal(target(14, 40, { weeklyGoalKm: null }), 30);
  // 40 km = 24.85 mi; x0.75 = 18.64 -> 18.5 mi = 29.8 km (wave 20: imperial ceilings and targets are multiples of 0.5 mi).
  const MI_PER_KM = 1 / 1.609344;
  const km = target(14, 40, { unitsPerKm: MI_PER_KM })!;
  assert.ok(Math.abs(km * MI_PER_KM - 18.5) < 0.05, `${km}`);
  // A recovery ceiling of 11.6 km (7.2 mi) is 7 mi, never "7.2".
  assert.ok(Math.abs(target(-3, 29, { unitsPerKm: MI_PER_KM })! * MI_PER_KM - 7) < 0.05);
  assert.equal(target(14, 40, { unitsPerKm: 0 }), null);
});

test('windDownBand: taper 60%..125% of the target (and 3 km / 2 mi over); race week / recovery are ceilings with 10% slack', () => {
  // Taper, 30 km target.
  assert.equal(windDownBand('taper', 17.9, 30), 'under'); // < 18 km
  assert.equal(windDownBand('taper', 18, 30), 'within');
  assert.equal(windDownBand('taper', 37.5, 30), 'within'); // exactly 125%
  assert.equal(windDownBand('taper', 37.6, 30), 'over');
  assert.equal(windDownBand('taper', 4, 3), 'within'); // 133% but under 3 km over: not over
  assert.equal(windDownBand('taper', 6.6, 5, { unitsPerKm: 0.621371 }), 'within'); // 1.6 km = ~1 mi over: under the 2 mi minimum
  // The lower bound is pro-rated for a week still under way; the upper never is.
  assert.equal(windDownBand('taper', 8, 30, { weekFraction: 0.5 }), 'under'); // < 9 km
  assert.equal(windDownBand('taper', 9, 30, { weekFraction: 0.5 }), 'within');
  assert.equal(windDownBand('taper', 0, 30, { weekFraction: 0 }), 'within');
  assert.equal(windDownBand('taper', 38, 30, { weekFraction: 0.1 }), 'over');
  // Race week and recovery: a ceiling, never "under".
  assert.equal(windDownBand('race_week', 0, 16), 'within');
  assert.equal(windDownBand('race_week', 17.6, 16), 'within');
  assert.equal(windDownBand('race_week', 17.7, 16), 'over');
  assert.equal(windDownBand('recovery', 12.2, 12), 'within');
  assert.equal(windDownBand('recovery', 24, 16), 'over');
});

test('peakWeekKmBeforeTaper: the biggest 7-day block in the 28 days before the taper began', () => {
  const taperStart = addDays(RACE, -21);
  const run = (before: number, km: number) => ({ day: addDays(taperStart, -before), km });
  // Blocks (days before the taper began): 1-7, 8-14, 15-21, 22-28.
  const runs = [run(1, 10), run(5, 8), run(9, 20), run(14, 15), run(16, 12), run(25, 30)];
  // block1 = 18, block2 = 35, block3 = 12, block4 = 30.
  assert.equal(peakWeekKmBeforeTaper(runs, RACE), 35);
  // Runs on/after the taper start and older than 28 days do not count.
  assert.equal(peakWeekKmBeforeTaper([{ day: taperStart, km: 99 }, run(29, 99), run(2, 12)], RACE), 12);
});

test('peakWeekKmBeforeTaper: null without runs in the window, under 1 km, or with a bad date', () => {
  assert.equal(peakWeekKmBeforeTaper([], RACE), null);
  assert.equal(peakWeekKmBeforeTaper([{ day: addDays(RACE, -30), km: 0.5 }], RACE), null);
  assert.equal(peakWeekKmBeforeTaper([{ day: addDays(RACE, -30), km: 10 }], 'soon'), null);
  assert.equal(peakWeekKmBeforeTaper([{ day: addDays(RACE, -30), km: Number.NaN }], RACE), null);
});

// ── Race classes: where the phases fall depends on the race distance ────────

test('raceClass: 10K or shorter / half marathon / longer; no distance keeps the marathon rules', () => {
  assert.equal(raceClass(5), 'short');
  assert.equal(raceClass(10), 'short');
  assert.equal(raceClass(10.5), 'half');
  assert.equal(raceClass(16.1), 'half'); // a 10-mile race
  assert.equal(raceClass(21.0975), 'half');
  assert.equal(raceClass(21.1), 'half');
  assert.equal(raceClass(25), 'long');
  assert.equal(raceClass(42.2), 'long');
  assert.equal(raceClass(null), 'long');
  assert.equal(raceClass(Number.NaN), 'long');
  assert.deepEqual(
    [raceRules(10), raceRules(21.1), raceRules(42.2)].map(r => [r.taperStartDays, r.recoveryDays, r.peakLongRunLeadDays]),
    [[7, 7, 10], [14, 14, 14], [21, 14, 21]],
  );
});

/** The phase of a race `daysOut` days away for a race of `km`. */
const phaseFor = (km: number | null, daysOut: number): ReturnType<typeof racePhase> => racePhase(RACE, addDays(RACE, -daysOut), km);

test('race phases by distance: 10K has no taper, a half tapers days 8-14, a marathon days 8-21; recovery 7 / 14 / 14 days', () => {
  // 10K or shorter
  assert.deepEqual([40, 8, 7, 0, -1, -7, -8].map(d => phaseFor(10, d)), ['build', 'build', 'race_week', 'race_week', 'recovery', 'recovery', null]);
  // Half marathon
  assert.deepEqual([15, 14, 8, 7, 0, -1, -14, -15].map(d => phaseFor(21.1, d)), ['build', 'taper', 'taper', 'race_week', 'race_week', 'recovery', 'recovery', null]);
  // Marathon: unchanged
  assert.deepEqual([22, 21, 8, 7, 0, -1, -14, -15].map(d => phaseFor(42.2, d)), ['build', 'taper', 'taper', 'race_week', 'race_week', 'recovery', 'recovery', null]);
  assert.equal(racePhaseInfo(RACE, addDays(RACE, -10), 21.1)?.raceClass, 'half');
});

test('race phase targets by distance (shares of the peak week): half x0.75 / x0.5 / x0.4 / x0.7, 10K none / x0.6 / x0.5', () => {
  const at = (km: number | null, daysOut: number, opts: Parameters<typeof racePhaseTargetKm>[2] = {}): number | null => {
    const info = racePhaseInfo(RACE, addDays(RACE, -daysOut), km);
    return info ? racePhaseTargetKm(info, 40, opts) : null;
  };
  // Half marathon: ONE taper level, race week x0.5, recovery 1-7 x0.4, 8-14 x0.7.
  assert.deepEqual([14, 8].map(d => at(21.1, d)), [30, 30]);
  assert.deepEqual([7, 0].map(d => at(21.1, d)), [20, 20]);
  assert.deepEqual([-1, -7].map(d => at(21.1, d)), [16, 16]);
  assert.deepEqual([-8, -14].map(d => at(21.1, d)), [28, 28]);
  // 10K or shorter: no taper phase at all, race week x0.6, 7 days of recovery at most x0.5.
  assert.equal(at(10, 10), null);
  assert.deepEqual([7, 0].map(d => at(10, d)), [24, 24]);
  assert.deepEqual([-1, -7].map(d => at(10, d)), [20, 20]);
  assert.equal(at(10, -8), null);
  // Marathon: the wave-18 column, unchanged.
  assert.deepEqual([21, 14, 13, 8, 7, -1, -8].map(d => at(42.2, d)), [30, 30, 24, 24, 16, 16, 24]);
});

test('peakWeekKmBeforeTaper: the window moves with the taper start (a half: 14 days out, a 10K: 7)', () => {
  const runAt = (daysOut: number, km: number): PlanRun => ({ day: addDays(RACE, -daysOut), km });
  // Half: the window ends the day before the taper began (15 days out).
  assert.equal(peakWeekKmBeforeTaper([runAt(15, 10), runAt(16, 5), runAt(30, 12), runAt(14, 99)], RACE, 21.1), 15);
  // A marathon's taper began a week earlier: the run 15 days out is a taper-time run, not part of the peak window.
  assert.equal(peakWeekKmBeforeTaper([runAt(15, 10), runAt(22, 12), runAt(14, 99)], RACE, 42.2), 12);
  // 10K: race week starts 7 days out, the window ends 8 days out.
  assert.equal(peakWeekKmBeforeTaper([runAt(8, 9), runAt(7, 99)], RACE, 10), 9);
});

// ── The week plan ───────────────────────────────────────────────────────────

const MON = '2026-03-02'; // week 1 starts Monday 2026-03-02
const weekOf = (n: number): string => addDayKey(MON, 7 * (n - 1)); // n = 1 ...

/** `kms[n-1]` km in week n as four runs (Tue / Thu / Sat and a Sunday long run of 40%). */
function runsFor(kms: number[], from = 1): PlanRun[] {
  const out: PlanRun[] = [];
  kms.forEach((km, i) => {
    if (km <= 0) return;
    const w = weekOf(from + i);
    out.push(
      { day: addDayKey(w, 1), km: km * 0.2 },
      { day: addDayKey(w, 3), km: km * 0.2 },
      { day: addDayKey(w, 5), km: km * 0.2 },
      { day: addDayKey(w, 6), km: km * 0.4 },
    );
  });
  return out;
}

/** The plan for week `week` read on its Monday (what the card shows first thing, what the review calls "next week"). */
function planFor(runs: PlanRun[], week: number, over: Partial<EnduranceWeekPlanInput> = {}) {
  const weekStart = weekOf(week);
  return enduranceWeekPlan({ runs, weekStart, goalKm: 30, today: weekStart, ...over });
}

test('baseline: no earlier run at all — no target, rated on consistency (3+ runs good, never tough)', () => {
  const runs = runsFor([15]);
  const plan = planFor(runs, 1);
  assert.equal(plan.kind, 'baseline');
  assert.equal(plan.targetKm, null);
  assert.equal(plan.last, null);
  assert.equal(plan.longRunKm, null);
  assert.equal(gradeEnduranceWeek(plan, 15, { runDays: 4 }).level, 'good');
  assert.deepEqual(gradeEnduranceWeek(plan, 7, { runDays: 2 }), { level: 'mixed', gap: 'short' });
  assert.deepEqual(gradeEnduranceWeek(plan, 3, { runDays: 1 }), { level: 'mixed', gap: 'short' }); // never tough
  assert.equal(gradeEnduranceWeek(plan, 0, { runDays: 0 }).level, 'light');
  // Week 2 builds its first step from week 1's total.
  const second = planFor(runs, 2);
  assert.equal(second.kind, 'build');
  assert.equal(second.targetKm, 17);
  assert.equal(second.last?.km, 15);
  assert.equal(second.last?.kind, 'baseline');
});

test('build: ~10% over last week (at least +1), the long run +2 km and never past 60% of the week', () => {
  const runs = runsFor([15, 17, 19]);
  const plan = planFor(runs, 4);
  assert.equal(plan.kind, 'build');
  assert.equal(plan.targetKm, 21);
  // Last long run 7.6 km (40% of 19): +2 -> 9.6, rounded to the half km.
  assert.equal(plan.longRun.lastKm, 7.6);
  assert.equal(plan.longRunKm, 9.5);
  assert.equal(plan.last?.changePct, 12); // 17 -> 19 km: the one growth number, finished weeks only
  assert.equal(plan.last?.grade?.level, 'good');
  assert.ok(plan.band.goodFromKm <= 19 && plan.band.mixedFromKm < plan.band.goodFromKm);
  assert.ok(plan.band.overKm != null && plan.band.overKm > 21);
  // On a 12 km week the long run may not outgrow 60% of it.
  const small = planFor(runsFor([10, 11]), 3);
  assert.equal(small.targetKm, 12);
  assert.ok((small.longRunKm as number) <= 7.5, `${small.longRunKm}`);
});

test('the growth number is only quoted against a real week: under 5 km (3 mi) there is no percentage', () => {
  assert.equal(planFor(runsFor([4, 5]), 3).last?.changePct, null);
  assert.equal(planFor(runsFor([5, 5]), 3).last?.changePct, 0);
  assert.equal(planFor(runsFor([20, 22.2]), 3).last?.changePct, 11);
  // Miles: 3 mi = 4.8 km is the floor.
  const MI = 1 / 1.609344;
  assert.equal(planFor(runsFor([4.5, 5]), 3, { unitsPerKm: MI }).last?.changePct, null);
  assert.equal(planFor(runsFor([5, 5.5]), 3, { unitsPerKm: MI }).last?.changePct, 10);
});

test('spike -> hold -> held: a jump is graded mixed, the next week holds one step up from the STEP, then it builds again', () => {
  // Weeks 1-5 on plan (15..23), week 6 a 40 km spike over a ~25 km step, week 7 held at 28, week 8 back on the build.
  const runs = runsFor([15, 17, 19, 21, 23, 40, 28, 30]);
  const spikeWeek = planFor(runs, 6);
  assert.equal(spikeWeek.kind, 'build');
  assert.equal(spikeWeek.targetKm, 25);
  assert.deepEqual(gradeEnduranceWeek(spikeWeek, 40), { level: 'mixed', gap: 'spike' });
  assert.deepEqual(gradeEnduranceWeek(spikeWeek, 27), { level: 'good', gap: null });
  const hold = planFor(runs, 7);
  assert.equal(hold.kind, 'hold');
  assert.equal(hold.targetKm, 28); // one step up from the 25 km step, never from the 40 km jump
  assert.deepEqual(hold.hold, { spikeKm: 40, spikeStepKm: 25 });
  assert.equal(hold.longRunKm, 16); // the hold week keeps the long run it had
  assert.deepEqual(gradeEnduranceWeek(hold, 28), { level: 'good', gap: null }); // holding as advised is good
  assert.deepEqual(gradeEnduranceWeek(hold, 40), { level: 'mixed', gap: 'spike' }); // not holding is the same mistake again
  const back = planFor(runs, 8);
  assert.equal(back.kind, 'maintain'); // 28 x 1.10 reaches the 30 km goal
  assert.equal(back.targetKm, 30);
  assert.equal(back.last?.km, 28);
  // The spike rule itself: >30% over the step AND at least 3 km (2 mi), only below the goal.
  assert.equal(isSpikeWeek(40, 25, 30), true);
  assert.equal(isSpikeWeek(10.5, 8, 30), false); // +31% but only 2.5 km
  assert.equal(isSpikeWeek(19, 15, 30), false); // 4 km over but +27%
  assert.equal(isSpikeWeek(45, 30, 30), false); // the step IS the goal
  assert.equal(isSpikeWeek(11.5 / 0.621371, 5 / 0.621371, 18.6, 0.621371), true); // miles: 2.2 mi over a 5 mi step
});

test('illness restart: a week under half the median of the 4 before it restarts at ~60% of that median, not the goal', () => {
  // Weeks 1-8: 15, 17, 19, 21, 23, 25, 28, 30; week 9 only 6 km (sick), week 10 comes back.
  const runs = runsFor([15, 17, 19, 21, 23, 25, 28, 30, 6]);
  const plan = planFor(runs, 10);
  assert.equal(plan.kind, 'restart');
  assert.equal(plan.restart?.reason, 'low_week');
  assert.equal(plan.restart?.medianKm, 26.5); // median of 21, 25, 28, 30... of the 4 weeks before the sick week: 23, 25, 28, 30
  assert.equal(plan.targetKm, 16); // 60% of 26.5
  assert.ok((plan.targetKm as number) < 30);
  // Regaining volume up to that median is never a spike; a good comeback is good, a tiny one mixed, not tough.
  assert.deepEqual(gradeEnduranceWeek(plan, 15), { level: 'good', gap: null });
  assert.deepEqual(gradeEnduranceWeek(plan, 26), { level: 'good', gap: null });
  assert.equal(gradeEnduranceWeek(plan, 8).level, 'mixed');
  // The long run restarts from the recent longest run, never past 60% of the restart week.
  assert.ok((plan.longRunKm as number) <= 9.5, `${plan.longRunKm}`);
  // The week after a good comeback week climbs back toward the pre-break median (wave 20: restart -> 80% -> 100% of the
  // median, never less than the 10% step): 80% of 26.5 = 21 km, not the 17 km step over the 15 km comeback.
  const next = planFor(runsFor([15, 17, 19, 21, 23, 25, 28, 30, 6, 15]), 11);
  assert.equal(next.kind, 'build');
  assert.equal(next.targetKm, 21);
  assert.deepEqual(next.comeback, { medianKm: 26.5, fraction: 0.8, weeksSince: 1 });
});

test('a 2-week gap (0 km weeks) restarts at ~55% of the median that counts the zero weeks (a gap over 14 days); a 0-run week is "light"', () => {
  const runs = runsFor([15, 17, 19, 21, 23, 25]); // weeks 1-6, then nothing in weeks 7-8
  const w7 = planFor(runs, 7);
  assert.equal(w7.kind, 'build'); // week 7 itself was planned before anyone knew
  assert.equal(gradeEnduranceWeek(w7, 0).level, 'light');
  const w9 = planFor(runs, 9);
  assert.equal(w9.kind, 'restart');
  assert.equal(w9.restart?.reason, 'no_runs');
  assert.equal(w9.restart?.medianKm, 22); // the 4 weeks before the empty one: 0, 25, 23, 21 -> the median counts the zero week
  assert.equal(w9.targetKm, 12); // 55% of 22 (wave 20: a gap of more than 14 days; 8-14 days is 75%)
  assert.ok((w9.targetKm as number) < 22);
  // On a break: 7+ days without a run (more for a runner who runs less often) — wave 20, it was 5.
  const atDay = (offset: number) => enduranceWeekPlan({ runs, weekStart: weekOf(7), goalKm: 30, today: addDayKey(weekOf(7), offset) });
  // Five days without a run (the Friday) is no break: the week's target does not drop mid-week.
  assert.equal(atDay(4).kind, 'build');
  assert.equal(atDay(4).targetKm, 28);
  assert.equal(atDay(4).onBreak, false);
  assert.equal(atDay(5).kind, 'build'); // six days
  // The seventh day without a run is when the gap reaches into the week; up to 7 days is one skipped step: last week's
  // target (25 km) stands, no cut to a share of the median.
  const midGap = atDay(6);
  assert.equal(midGap.kind, 'restart');
  assert.equal(midGap.daysSinceRun, 7);
  assert.equal(midGap.onBreak, true);
  assert.equal(midGap.targetKm, 25);
  assert.equal(midGap.restart?.gapDays, 7);
  // The week still ENDED with 5+ days off a day earlier: a short week like that is a lighter week, not a failure.
  assert.equal(atDay(4).endedOff, true);
  assert.equal(gradeEnduranceWeek(atDay(4), 6).level, 'light');
});

test('the restart cut scales with the gap: up to 7 days holds last week\'s target, 8-14 days ~75% of the median, over 14 days ~55%', () => {
  // Median of the 4 weeks before the break: 22 km (weeks 3-6 of 19..25).
  const runs = runsFor([15, 17, 19, 21, 23, 25]);
  const at = (days: number) => enduranceWeekPlan({ runs, weekStart: weekOf(7), goalKm: 30, today: addDayKey(weekOf(7), days - 1) }); // days without a run, counted from the Sunday of week 6
  assert.equal(at(7).targetKm, 25);
  const mid = enduranceWeekPlan({ runs, weekStart: weekOf(8), goalKm: 30, today: weekOf(8) }); // 8 days off
  assert.equal(mid.restart?.reason, 'no_runs');
  assert.equal(mid.restart?.gapDays, 8);
  assert.equal(mid.restart?.fraction, 0.75);
  assert.equal(mid.targetKm, 17); // 75% of 22 = 16.5
  const long = enduranceWeekPlan({ runs, weekStart: weekOf(9), goalKm: 30, today: weekOf(9) }); // 15 days off
  assert.equal(long.restart?.fraction, 0.55);
  assert.equal(long.targetKm, 12);
  // A very light week without a long gap in it keeps the plain 60% (the illness restart).
  const light = planFor(runsFor([15, 17, 19, 21, 23, 25, 28, 30, 6]), 10);
  assert.equal(light.restart?.fraction, 0.6);
  assert.equal(light.restart?.gapDays, null);
  // The restart week's long run is at most 40% of it.
  assert.ok((mid.longRunKm ?? 0) <= 17 * 0.4 + 0.25, `${mid.longRunKm}`);
  // Imperial restart targets are halves of a mile.
  const MI = 1 / 1.609344;
  const mi = enduranceWeekPlan({ runs, weekStart: weekOf(8), goalKm: 30, today: weekOf(8), unitsPerKm: MI });
  assert.ok(Math.abs((mi.targetKm as number) * MI * 2 - Math.round((mi.targetKm as number) * MI * 2)) < 0.05, `${mi.targetKm}`);
});

test('a break noticed mid-week never shrinks the week\'s target below what the week has already run', () => {
  // Last run Sunday of week 6; the first run back is a 14 km long run on the Sunday of week 7: a 7 day gap, restart share 13 km.
  const runs = [...runsFor([15, 17, 19, 21, 23, 25]), { day: addDayKey(weekOf(7), 6), km: 14 }];
  const plan = enduranceWeekPlan({ runs, weekStart: weekOf(7), goalKm: 30, today: addDayKey(weekOf(7), 6) });
  assert.equal(plan.kind, 'restart');
  assert.ok((plan.targetKm as number) >= 14, `${plan.targetKm}`);
});

test('comeback: for up to three weeks after a restart the target climbs restart -> 80% -> 100% of the pre-break median, a rung only after a good week', () => {
  // Weeks 1-6 build (15..25), nothing in weeks 7-8, week 9 restarts (55% of 22 = 12 km), then weeks of 12, 18, 22, 25.
  const base = runsFor([15, 17, 19, 21, 23, 25, 0, 0]);
  const withWeeks = (kms: number[]) => [...base, ...runsFor(kms, 9)];
  const restart = planFor(withWeeks([12]), 9);
  assert.equal(restart.kind, 'restart');
  assert.equal(restart.targetKm, 12);
  const w10 = planFor(withWeeks([12]), 10);
  assert.equal(w10.kind, 'build');
  assert.equal(w10.targetKm, 18); // 80% of 22 = 17.6, not the 13 km step over 12
  assert.deepEqual(w10.comeback, { medianKm: 22, fraction: 0.8, weeksSince: 1 });
  const w11 = planFor(withWeeks([12, 18]), 11);
  assert.equal(w11.targetKm, 22); // 100% of the median
  assert.equal(w11.comeback?.fraction, 1);
  const w12 = planFor(withWeeks([12, 18, 22]), 12);
  assert.equal(w12.targetKm, 24); // 10% over 22 once the median is regained
  assert.equal(w12.comeback?.weeksSince, 3);
  // A week that did not grade good repeats the rung instead of climbing: 18 km target, only 10 km run.
  const repeat = planFor(withWeeks([12, 10]), 11);
  assert.equal(repeat.targetKm, 18);
  assert.equal(repeat.comeback?.fraction, 0.8);
  // The climb is over after three weeks: the plain step again.
  const w13 = planFor(withWeeks([12, 18, 22, 25]), 13);
  assert.equal(w13.comeback, null);
  assert.equal(w13.targetKm, 28); // 25 x 1.10
  // Comeback (and rebuild) weeks are graded gentler: 80% is good, not 90%.
  assert.equal(gradeEnduranceWeek(w10, 14.4).level, 'good'); // 80% of 18
  assert.equal(gradeEnduranceWeek(w10, 14.3).level, 'mixed');
  // Regaining the pre-break level is no spike; a real jump beyond it still is.
  assert.equal(gradeEnduranceWeek(w10, 22).gap, null);
  assert.equal(gradeEnduranceWeek(w10, 26).gap, 'spike');
});

test('the break rule follows the runner\'s own rhythm: a once-a-week runner is not "on a break" every Friday', () => {
  const weekly: PlanRun[] = [0, 1, 2, 3, 4].map(i => ({ day: addDayKey(addDayKey(MON, 5), 7 * i), km: 12 })); // every Saturday
  assert.equal(breakThreshold(weekly, addDayKey(MON, 35)), 11); // ceil(1.5 x 7)
  assert.equal(breakThreshold(runsFor([20, 20, 20, 20]), weekOf(5)), 7); // wave 20: it was 5
  const friday = enduranceWeekPlan({ runs: weekly, weekStart: weekOf(5), goalKm: 30, today: addDayKey(weekOf(5), 4) });
  assert.equal(friday.onBreak, false);
  assert.notEqual(friday.kind, 'restart');
});

test('maintain: at the weekly goal the plan holds it and the long run keeps stepping +2 km toward the peak target', () => {
  const runs = runsFor([30, 30, 30, 30]);
  const race = { date: addDayKey(MON, 130), distanceKm: 21.1 };
  const plan = planFor(runs, 5, { race });
  assert.equal(plan.kind, 'maintain');
  assert.equal(plan.targetKm, 30);
  // The half's 18 km peak does not fit a 30 km week (a long run is at most half of it): the peak is what fits (wave 20).
  assert.equal(plan.longRun.targetPeakKm, 15);
  assert.equal(plan.longRun.raceTargetKm, 18);
  assert.equal(plan.longRun.lastKm, 12); // 40% of 30
  assert.equal(plan.longRunKm, 14);
  assert.equal(plan.purpose.replace(/\u00a0/g, ' '), 'Hold 30 km this week: long run 14 km, the rest easy');
  assert.equal(plan.band.overKm, null); // at the goal, going past it is just a hit target
  // The peak target caps the long run; "no race" has no peak but is capped at half of the week (a longer one already run is held).
  // Week 4: a 17 km long run in an otherwise ordinary 30 km week.
  const week4: PlanRun[] = [{ day: addDayKey(weekOf(4), 1), km: 4 }, { day: addDayKey(weekOf(4), 3), km: 4 }, { day: addDayKey(weekOf(4), 5), km: 5 }, { day: addDayKey(weekOf(4), 6), km: 17 }];
  const peak = enduranceWeekPlan({
    runs: [...runsFor([30, 30, 30]), ...week4],
    weekStart: weekOf(5), goalKm: 30, today: weekOf(5), race,
  });
  assert.equal(peak.longRunKm, 15); // back to the 15 km peak that fits
  const noRace = planFor([...runsFor([30, 30, 30]), ...week4], 5);
  assert.equal(noRace.longRunKm, 17); // min(19, max(50% of 30, the 17 km already run))
});

test('race phases on the Mondays of a SUNDAY race: build, taper, race week, recovery 1, recovery 2, rebuild — per distance', () => {
  const sunday = '2026-06-21';
  const monday = (offset: number): string => addDayKey(sunday, offset); // -27 = the Monday 27 days out
  const kinds = (km: number | null): string[] => [-27, -20, -13, -6, 1, 8, 15, 36, 43].map(off => {
    const weekStart = monday(off);
    return enduranceWeekPlan({
      runs: runsFor([30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], 1).map(r => ({ ...r, day: addDayKey(r.day, 7 * 7) })),
      weekStart, goalKm: 30, race: { date: sunday, distanceKm: km }, today: addDayKey(weekStart, 6),
    }).kind;
  });
  assert.deepEqual(kinds(21.1), ['maintain', 'maintain', 'taper', 'race_week', 'recovery', 'recovery', 'rebuild', 'rebuild', 'maintain']);
  assert.deepEqual(kinds(42.2), ['maintain', 'taper', 'taper', 'race_week', 'recovery', 'recovery', 'rebuild', 'rebuild', 'maintain']);
  // 10K: no taper, one recovery week.
  assert.deepEqual(kinds(10), ['maintain', 'maintain', 'maintain', 'race_week', 'recovery', 'rebuild', 'rebuild', 'rebuild', 'maintain']);
});

test('taper, race week and recovery targets come from the peak week; a half taper week spells out the intensity', () => {
  const runs = runsFor([30, 30, 30, 30, 30, 30]);
  const race = { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 }; // Sunday ending week 9
  const taper = planFor(runs, 8, { race, racePeakWeekKm: 40 });
  assert.equal(taper.kind, 'taper');
  assert.equal(taper.targetKm, 30);
  assert.match(taper.purpose.replace(/\u00a0/g, ' '), /^Taper: ~30 km this week, cut the volume; long run [\d.]+ km easy, plus 3×1 km at race pace midweek$/);
  const raceWeek = planFor(runs, 9, { race, racePeakWeekKm: 40 });
  assert.equal(raceWeek.kind, 'race_week');
  assert.equal(raceWeek.targetKm, 20);
  assert.equal(raceWeek.purpose, 'Race week: short easy runs, rest 1–2 days before the race');
  assert.equal(planFor(runs, 10, { race, racePeakWeekKm: 40 }).targetKm, 16);
  assert.equal(planFor(runs, 11, { race, racePeakWeekKm: 40 }).targetKm, 28);
  // Without a measured peak the weekly goal stands in.
  assert.equal(planFor(runs, 8, { race }).targetKm, 23);
  // Imperial: the 3x1 km becomes 3x0.5 mi.
  assert.match(planFor(runs, 8, { race, racePeakWeekKm: 40, unitsPerKm: 1 / 1.609344 }).purpose.replace(/\u00a0/g, ' '), /3×0\.5 mi at race pace midweek$/);
});

test('wind-down weeks are graded with the shared band: within or under is on plan, over the ceiling is not', () => {
  const runs = runsFor([30, 30, 30, 30, 30, 30]);
  const race = { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 };
  const taper = planFor(runs, 8, { race, racePeakWeekKm: 40 }); // 30 km
  assert.deepEqual(gradeEnduranceWeek(taper, 30), { level: 'good', gap: null });
  assert.deepEqual(gradeEnduranceWeek(taper, 10), { level: 'mixed', gap: 'under' });
  assert.deepEqual(gradeEnduranceWeek(taper, 42), { level: 'mixed', gap: 'over' });
  const recovery = planFor(runs, 10, { race, racePeakWeekKm: 40 });
  assert.deepEqual(gradeEnduranceWeek(recovery, 0), { level: 'good', gap: null }); // resting through recovery is the plan
  assert.deepEqual(gradeEnduranceWeek(recovery, 24), { level: 'mixed', gap: 'over' });
});

test('rebuild: weeks 15-42 after the race are graded against their own step from recovery volume; race and recovery weeks leave the average', () => {
  const sunday = addDayKey(weekOf(9), 6);
  const race = { date: sunday, distanceKm: 21.1 };
  const runs = [
    ...runsFor([30, 30, 30, 30, 30, 30, 30, 30]), // weeks 1-8
    ...runsFor([12], 10), // recovery week 1
    ...runsFor([20], 11), // recovery week 2
    ...runsFor([22], 12), // first rebuild week
  ];
  const first = planFor(runs, 12, { race, racePeakWeekKm: 40 });
  assert.equal(first.kind, 'rebuild');
  assert.equal(first.rebuild?.daysSince, 15);
  assert.equal(first.targetKm, 22); // 20 x 1.10 from recovery week 2
  assert.equal(first.avg4wKm, 30); // the average is the 4 weeks before the taper, not the race and recovery weeks
  const second = planFor(runs, 13, { race, racePeakWeekKm: 40 });
  assert.equal(second.kind, 'rebuild');
  assert.equal(second.targetKm, 24); // 22 x 1.10
  assert.equal(second.last?.kind, 'rebuild');
  // The rebuild is over 42 days after the race, and a goal set after the race ends it too.
  assert.equal(planFor(runs, 15, { race }).kind, 'rebuild'); // 36 days after
  assert.notEqual(planFor(runs, 16, { race }).kind, 'rebuild'); // 43 days after
  assert.notEqual(planFor(runs, 12, { race, goalStartDay: addDayKey(sunday, 5) }).kind, 'rebuild');
  // A full rest after the race restarts gently from the training median instead of stepping from 0.
  const rested = planFor(runsFor([30, 30, 30, 30, 30, 30, 30, 30]), 12, { race, racePeakWeekKm: 40 });
  assert.equal(rested.kind, 'rebuild');
  assert.equal(rested.restart?.reason, 'no_runs');
  assert.ok((rested.targetKm as number) < 30);
});

test('race done: a run of at least 90% of the race distance on race day (or a day either side) is the race', () => {
  const race = { date: '2026-06-21', distanceKm: 21.1 };
  const runs: PlanRun[] = [{ day: '2026-06-21', km: 21.1, durationMin: 121 }, { day: '2026-06-20', km: 5 }];
  assert.deepEqual(findRaceRun(runs, race), { day: '2026-06-21', km: 21.1, durationMin: 121 });
  assert.equal(findRaceRun([{ day: '2026-06-22', km: 19.1 }], race)?.km, 19.1); // the day after, 90.5%
  assert.equal(findRaceRun([{ day: '2026-06-21', km: 18 }], race), null); // too short
  assert.equal(findRaceRun([{ day: '2026-06-18', km: 21.1 }], race), null); // three days before is a training run
  assert.equal(findRaceRun(runs, { date: '2026-06-21', distanceKm: null }), null);
  assert.equal(findRaceRun(runs, null), null);
  // The race run is not training volume or a training long run.
  assert.equal(planWeekKm(runs, '2026-06-15', '2026-06-21').km, 5);
  assert.equal(formatRaceTime(121), '2:01');
  assert.equal(formatRaceTime(45), `45${String.fromCharCode(160)}min`);
  assert.equal(formatRaceTime(null), null);
});

test('long runs: only 5 km (3 mi) and up are a "long run"; imperial targets round to the nearest half mile', () => {
  assert.equal(isLongRun(5), true);
  assert.equal(isLongRun(4.9), false);
  assert.equal(isLongRun(4.83, 1 / 1.609344), true); // 3 mi
  assert.equal(isLongRun(4.5, 1 / 1.609344), false);
  const MI = 1 / 1.609344;
  assert.equal(formatTargetLongRun(18, MI), `11${String.fromCharCode(160)}mi`); // 11.2 mi -> 11
  assert.equal(formatTargetLongRun(17.7, 1), `17.5${String.fromCharCode(160)}km`);
  assert.equal(formatTargetLongRun(9.6, MI), `6${String.fromCharCode(160)}mi`);
  assert.equal(formatTargetLongRun(10.5, MI), `6.5${String.fromCharCode(160)}mi`);
  assert.equal(roundLongRunKm(18, MI), 17.7); // back in km: exactly 11 mi
  assert.equal(mondayOfDay('2026-06-21'), '2026-06-15');
});

// ── Wave 20a ────────────────────────────────────────────────────────────────

test('long run cap: half of the week (40% in a restart week); the race peak that does not fit is "what fits", said once', () => {
  assert.deepEqual(longRunPeakTarget(21.1, 30), { peakKm: 15, raceTargetKm: 18 });
  assert.deepEqual(longRunPeakTarget(21.1, 36), { peakKm: 18, raceTargetKm: null });
  assert.deepEqual(longRunPeakTarget(21.1, 50), { peakKm: 18, raceTargetKm: null });
  assert.deepEqual(longRunPeakTarget(21.1, null), { peakKm: 18, raceTargetKm: null });
  assert.equal(longRunPeakTarget(null, 30), null);
  assert.equal(
    longRunCapNote(longRunPeakTarget(21.1, 30), 30)?.replace(/ /g, ' '),
    'Your 30 km weeks fit a 15 km long run; for an 18 km peak, raise the goal to ~36 km',
  );
  assert.equal(longRunCapNote(longRunPeakTarget(21.1, 40), 40), null);
  // Miles: 30 km = 18.6 mi fits 9 mi; the 18 km peak is 11 mi and needs a ~22.5 mi week.
  const MI = 1 / 1.609344;
  assert.equal(
    longRunCapNote(longRunPeakTarget(21.1, 30, MI), 30, MI)?.replace(/ /g, ' '),
    'Your 18.6 mi weeks fit a 9 mi long run; for an 11 mi peak, raise the goal to ~22.5 mi',
  );
  // The plan: a normal week's long run is at most half of it, a restart week's at most 40%.
  const runs = runsFor([20, 22, 24, 26, 28, 30, 30, 30]);
  const race = { date: addDayKey(MON, 7 * 20), distanceKm: 21.1 };
  const maintain = planFor(runs, 9, { race });
  assert.equal(maintain.kind, 'maintain');
  assert.equal(maintain.longRun.targetPeakKm, 15);
  assert.ok((maintain.longRunKm as number) <= 15, `${maintain.longRunKm}`);
  const restart = planFor(runsFor([20, 22, 24, 26, 28, 30, 6]), 8, { race });
  assert.equal(restart.kind, 'restart');
  assert.ok((restart.longRunKm as number) <= (restart.targetKm as number) * 0.4 + 0.25, `${restart.longRunKm} of ${restart.targetKm}`);
});

test('a long run that jumped 2+ km over its plan (and 2+ km over the one before) is held, not grown', () => {
  // Weeks 1-5 on plan, week 5 carries a 14 km long run where 12 was planned (the one before was 10).
  const week = (n: number, longKm: number, total: number): PlanRun[] => {
    const w = weekOf(n);
    const rest = (total - longKm) / 3;
    return [
      { day: addDayKey(w, 1), km: rest }, { day: addDayKey(w, 3), km: rest }, { day: addDayKey(w, 5), km: rest }, { day: addDayKey(w, 6), km: longKm },
    ];
  };
  const runs = [...week(1, 6, 15), ...week(2, 7, 17), ...week(3, 8, 19), ...week(4, 10, 23), ...week(5, 14, 27)];
  const plan = planFor(runs, 6);
  assert.equal(plan.longRunJump?.actualKm, 14);
  assert.equal(plan.longRunJump?.plannedKm, 12);
  assert.equal(plan.longRunKm, 14); // held at 14, not 16
  assert.match(plan.purpose.replace(/ /g, ' '), /long run 14 km \(held after last week's jump\)/);
  // A +1 km creep is no jump; neither is a long run on plan.
  const creep = planFor([...week(1, 6, 15), ...week(2, 7, 17), ...week(3, 8, 19), ...week(4, 10, 23), ...week(5, 12, 25)], 6);
  assert.equal(creep.longRunJump, null);
});

test('race eve and race day: the purpose follows TODAY\'s distance to the race, not Monday\'s', () => {
  const race = { date: '2026-06-21', distanceKm: 21.1 };
  const monday = '2026-06-15';
  const runs: PlanRun[] = [{ day: '2026-06-02', km: 12 }, { day: '2026-06-04', km: 12 }, { day: '2026-06-06', km: 12 }, { day: '2026-06-09', km: 10 }, { day: '2026-06-11', km: 10 }];
  const at = (today: string) => enduranceWeekPlan({ runs, weekStart: monday, goalKm: 30, today, race, racePeakWeekKm: 30 });
  assert.equal(at('2026-06-17').purpose, 'Race week: short easy runs, rest 1–2 days before the race');
  assert.equal(at('2026-06-20').purpose, RACE_EVE_LINE);
  assert.equal(at('2026-06-20').raceDaysToGo, 1);
  assert.equal(at('2026-06-21').purpose, 'Race day: warm up easy and start relaxed');
  assert.equal(RACE_EVE_LINE, 'Race tomorrow — rest or a 15-min shakeout; lay out your kit');
  // The Monday read is not race day (the old branch tested the Monday's distance).
  assert.equal(at(monday).raceDaysToGo, 6);
});

test('maintain is "Build to" until the weekly goal has been run once; no "then add about 10%" at the goal; the actual step is on the plan', () => {
  // 28 km last week, never 30: the step reaches the goal, but he has not run it yet.
  const first = planFor(runsFor([22, 24, 26, 28]), 5);
  assert.equal(first.kind, 'maintain');
  assert.equal(first.goalReachedBefore, false);
  assert.match(first.purpose.replace(/ /g, ' '), /^Build to 30 km this week/);
  const again = planFor(runsFor([22, 24, 30, 30]), 5);
  assert.equal(again.goalReachedBefore, true);
  assert.match(again.purpose.replace(/ /g, ' '), /^Hold 30 km this week/);
  // The step is read off the plan: 17 -> 19 is +12%... and a week at the goal has none of the "10%" copy.
  const build = planFor(runsFor([15, 17, 19]), 4);
  assert.equal(build.stepPct, Math.round(((build.targetKm as number) - 19) / 19 * 100));
  assert.equal(planFor(runsFor([4, 4]), 3).stepPct, null); // under 5 km there is no percentage
  const rebuilt = planFor(runsFor([30, 30, 30, 30, 30, 30, 30, 30, 20, 30, 30, 30]), 12, { race: { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 }, racePeakWeekKm: 40 });
  assert.equal(rebuilt.kind, 'rebuild');
  assert.doesNotMatch(rebuilt.purpose, /add about 10%/);
});

test('rebuild weeks are graded gentler than a normal build: 80% of the step is good, 50% mixed', () => {
  const sunday = addDayKey(weekOf(9), 6);
  const race = { date: sunday, distanceKm: 21.1 };
  const runs = [...runsFor([30, 30, 30, 30, 30, 30, 30, 30]), ...runsFor([12], 10), ...runsFor([20], 11)];
  const first = planFor(runs, 12, { race, racePeakWeekKm: 40 });
  assert.equal(first.kind, 'rebuild');
  assert.equal(first.targetKm, 22);
  assert.equal(gradeEnduranceWeek(first, 17.6).level, 'good'); // 80% (a normal build needs 90%): "15 of ~17 km — 2 km short" is good now
  assert.equal(gradeEnduranceWeek(first, 17.5).level, 'mixed');
  assert.equal(gradeEnduranceWeek(first, 11).level, 'mixed'); // 50%
  assert.equal(gradeEnduranceWeek(first, 10.9).level, 'tough');
});

test('roundWeekTargetKm: whole km, or the nearest half mile', () => {
  const MI = 1 / 1.609344;
  assert.equal(roundWeekTargetKm(11.6), 12);
  assert.equal(roundWeekTargetKm(0.2), 1);
  assert.ok(Math.abs(roundWeekTargetKm(11.6, MI) * MI - 7) < 0.05); // 7.2 mi -> 7 mi
  assert.ok(Math.abs(roundWeekTargetKm(12.2, MI) * MI - 7.5) < 0.05); // 7.58 mi -> 7.5 mi
  assert.ok(Math.abs(roundWeekTargetKm(0.5, MI) * MI - 1) < 0.05); // at least one unit
});
