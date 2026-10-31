import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAP_NOTE_EVERY_WEEKS,
  RACE_EVE_CONSERVATIVE_LINE,
  RACE_EVE_LINE,
  STRIDES_COPY,
  addDayKey,
  breakThreshold,
  enduranceWeekPlan,
  comebackCapRead,
  findRaceRun,
  formatRaceTime,
  formatTargetLongRun,
  gradeEnduranceWeek,
  overUpToCap,
  isLongRun,
  isSpikeWeek,
  isWindDownPhase,
  lightWeekLine,
  longRunAtPeak,
  longRunCapNote,
  longRunPeakTarget,
  longRunStepKm,
  LONG_RUN_STEP_10_TO_16_KM,
  LONG_RUN_STEP_UNDER_10_KM,
  mondayOfDay,
  overCapPhrase,
  peakWeekKmBeforeTaper,
  planWeekKm,
  raceClass,
  racePaceReps,
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

test('longRunStepKm: the graded step at most, never past the peak target, held at the peak', () => {
  assert.equal(longRunStepKm(14, 18), 14 + LONG_RUN_STEP_10_TO_16_KM); // 10 to under 16 km: +1.5
  assert.equal(longRunStepKm(16, 18), 18); // from 16 km: +2 (the peak is 2 km away)
  assert.equal(longRunStepKm(17, 18), 18); // only 1 km of room
  assert.equal(longRunStepKm(18, 18), 18); // at the peak: hold
  assert.equal(longRunStepKm(20, 18), 18); // past the peak: back to it
  assert.equal(longRunStepKm(14, null), 14 + LONG_RUN_STEP_10_TO_16_KM); // no peak target: the graded step
  assert.equal(longRunStepKm(14.3, undefined), 15.8);
  assert.equal(longRunStepKm(8, null), 8 + LONG_RUN_STEP_UNDER_10_KM); // under 10 km: +1
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
  // A recovery ceiling of 11.6 km (7.2 mi) is never "7.2": it rounds UP to a half mile (wave 21e, so km and mi ceilings agree).
  assert.ok(Math.abs(target(-3, 29, { unitsPerKm: MI_PER_KM })! * MI_PER_KM - 7.5) < 0.05);
  assert.equal(target(-3, 29), 12); // 11.6 km
  assert.equal(target(-3, 28), 12); // 11.2 km: up to 12, not rounded down to 11
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

test('peakWeekKmBeforeTaper: the biggest 7-day block in the 28 days ending on the peak long run (wave 24e: the taper\'s first day, not the day before it)', () => {
  const windowEnd = addDays(RACE, -21); // a marathon's peak long run: 21 days out, the day its taper begins
  const run = (before: number, km: number) => ({ day: addDays(windowEnd, -(before - 1)), km });
  // Blocks (days back from the window's last day): 1-7, 8-14, 15-21, 22-28.
  const runs = [run(1, 10), run(5, 8), run(9, 20), run(14, 15), run(16, 12), run(25, 30)];
  // block1 = 18, block2 = 35, block3 = 12, block4 = 30.
  assert.equal(peakWeekKmBeforeTaper(runs, RACE), 35);
  // Runs after the window and older than 28 days do not count.
  assert.equal(peakWeekKmBeforeTaper([{ day: addDays(windowEnd, 1), km: 99 }, run(29, 99), run(2, 12)], RACE), 12);
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
  // Half (wave 24e: the window ends on the peak long run's day, 14 days out - the taper's first day): runs 13 days out and closer are taper-time runs.
  assert.equal(peakWeekKmBeforeTaper([runAt(14, 10), runAt(15, 5), runAt(30, 12), runAt(13, 99)], RACE, 21.1), 15);
  // A marathon's taper began a week earlier: the run 15 days out is a taper-time run, not part of the peak window.
  assert.equal(peakWeekKmBeforeTaper([runAt(15, 10), runAt(22, 12), runAt(14, 99)], RACE, 42.2), 12);
  // 10K: race week starts 7 days out, the window ends 8 days out.
  assert.equal(peakWeekKmBeforeTaper([runAt(8, 9), runAt(7, 99)], RACE, 10), 9);
});

test('peakWeekKmBeforeTaper (wave 24e, round 7): the peak week is the 7 days ENDING on the peak long run - the half\'s peak run 14 days out is the taper\'s first day and still belongs to it', () => {
  const runAt = (daysOut: number, km: number): PlanRun => ({ day: addDays(RACE, -daysOut), km });
  // The week of Mon..Sun ending 14 days out: 5 + 5 + 4 + the 14 km peak long run = 28. The week before it: 12 + 4 + 4 + 4 = 24.
  const runs = [runAt(14, 14), runAt(16, 5), runAt(18, 5), runAt(20, 4), runAt(21, 12), runAt(23, 4), runAt(25, 4), runAt(27, 4)];
  // (Seen from the day before the taper began, the 7 days were 16..22 days out: the peak run was dropped and the previous Sunday's counted - 26, "Taper: ~18 km" after a 28 km week.)
  assert.equal(peakWeekKmBeforeTaper(runs, RACE, 21.1), 28);
  // A marathon's peak long run is 21 days out, also its taper's first day.
  const marathon = [runAt(21, 32), runAt(23, 5), runAt(25, 5), runAt(27, 6), runAt(28, 20), runAt(30, 5), runAt(32, 5), runAt(34, 5)];
  assert.equal(peakWeekKmBeforeTaper(marathon, RACE, 42.2), 48);
  // A 10K has no taper: its peak long run (10 days out) is before race week, so the window still ends the day before it (8 days out).
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

test('build: ~10% over last week (at least +1), the long run + the graded step and never past 60% of the week', () => {
  const runs = runsFor([15, 17, 19]);
  const plan = planFor(runs, 4);
  assert.equal(plan.kind, 'build');
  assert.equal(plan.targetKm, 21);
  // Last long run 7.6 km (40% of 19): +1 (under 10 km) -> 8.6, rounded to the half km.
  assert.equal(plan.longRun.lastKm, 7.6);
  assert.equal(plan.longRunKm, roundLongRunKm(7.6 + LONG_RUN_STEP_UNDER_10_KM));
  assert.equal(plan.longRunKm, 8.5);
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
  // Weeks 2-5 on plan (15..21), week 6 the calendar's cutback week run as planned (18 km), week 7 a 40 km spike over a ~23 km step, week 8
  // held at 25, week 9 back on the build. (Week 6 is a cutback week of the calendar, see the cutback tests: running it at 23 km would be a
  // skipped cutback, wave 22e.)
  const runs = runsFor([15, 17, 19, 21, 18, 40, 28, 28], 2);
  const spikeWeek = planFor(runs, 7);
  assert.equal(spikeWeek.kind, 'build');
  assert.equal(spikeWeek.targetKm, 23); // from the 21 km week before the cutback
  assert.deepEqual(gradeEnduranceWeek(spikeWeek, 40), { level: 'mixed', gap: 'spike' });
  assert.deepEqual(gradeEnduranceWeek(spikeWeek, 27), { level: 'good', gap: null });
  const hold = planFor(runs, 8);
  assert.equal(hold.kind, 'hold');
  assert.equal(hold.targetKm, 25); // one step up from the 23 km step, never from the 40 km jump
  assert.deepEqual(hold.hold, { spikeKm: 40, spikeStepKm: 23 });
  assert.equal(hold.longRunKm, 16); // the hold week keeps the long run it had
  assert.deepEqual(gradeEnduranceWeek(hold, 28), { level: 'good', gap: null }); // holding as advised is good
  assert.deepEqual(gradeEnduranceWeek(hold, 40), { level: 'mixed', gap: 'spike' }); // not holding is the same mistake again
  const back = planFor(runs, 9);
  assert.equal(back.kind, 'maintain'); // 28 x 1.10 reaches the 30 km goal (the hold week ran 28)
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
  // median, never less than the 10% step): 80% of 26.5 = 21 km - but wave 21e caps a rung at 1.25x the week just run
  // (15 km -> 18), so "~21 km (+40%)" after a 15 km week no longer contradicts the review's "then add ~10% a week".
  const next = planFor(runsFor([15, 17, 19, 21, 23, 25, 28, 30, 6, 15]), 11);
  assert.equal(next.kind, 'build');
  assert.equal(next.targetKm, 18);
  assert.equal(next.upTo, true); // lifted above the plain 10% step (17): a ceiling, "up to ~18 km"
  assert.deepEqual(next.comeback, { medianKm: 26.5, fraction: 0.8, weeksSince: 1 });
});

test('a 2-week gap (0 km weeks) restarts at ~55% of the median that counts the zero weeks (a gap over 14 days); a 0-run week is "light"', () => {
  const runs = runsFor([15, 17, 19, 21, 23, 25]); // weeks 1-6, then nothing in weeks 7-8
  const w7 = planFor(runs, 7);
  assert.equal(w7.kind, 'hold'); // week 7 itself was planned before anyone knew (week 6 was a skipped cutback: 25 km against ~20, so week 7 holds at 25)
  assert.equal(w7.targetKm, 25);
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
  assert.equal(atDay(4).kind, 'hold');
  assert.equal(atDay(4).targetKm, 25);
  assert.equal(atDay(4).onBreak, false);
  assert.equal(atDay(5).kind, 'hold'); // six days
  // The seventh day without a run is when the gap reaches into the week; up to 7 days is one skipped step: last week's
  // target (25 km) stands - wave 21e: but never above 0.75 x the pre-break median (22 -> 17 km), and on the week's last
  // day (this Sunday) the number is NEXT week's restart number, the 8-day gap Monday will read.
  const midGap = atDay(6);
  assert.equal(midGap.kind, 'restart');
  assert.equal(midGap.daysSinceRun, 7);
  assert.equal(midGap.onBreak, true);
  assert.equal(midGap.targetKm, 17);
  assert.equal(midGap.restart?.gapDays, 8);
  assert.equal(midGap.targetKm, planFor(runs, 8).targetKm); // Sunday and Monday quote the same restart
  // The week still ENDED with 5+ days off a day earlier: a short week like that is a lighter week, not a failure.
  assert.equal(atDay(4).endedOff, true);
  assert.equal(gradeEnduranceWeek(atDay(4), 6).level, 'light');
});

test('the restart cut scales with the gap: up to 7 days holds last week\'s target, 8-14 days ~75% of the median, over 14 days ~55%', () => {
  // Median of the 4 weeks before the break: 22 km (weeks 3-6 of 19..25).
  const runs = runsFor([15, 17, 19, 21, 23, 25]);
  const at = (days: number) => enduranceWeekPlan({ runs, weekStart: weekOf(7), goalKm: 30, today: addDayKey(weekOf(7), days - 1) }); // days without a run, counted from the Sunday of week 6
  assert.equal(at(7).targetKm, 17); // last week's 25 km held, but never above 0.75 x the 22 km median (wave 21e)
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
  assert.equal(w10.targetKm, 15); // 80% of 22 = 17.6, capped at 1.25 x the 12 km just run (wave 21e); not the 13 km step over 12
  assert.equal(w10.upTo, true); // "up to ~15 km" - a ceiling for a careful comeback
  assert.deepEqual(w10.comeback, { medianKm: 22, fraction: 0.8, weeksSince: 1 });
  const w11 = planFor(withWeeks([12, 15]), 11); // the 15 km ceiling, run
  assert.equal(w11.targetKm, 18); // 100% of the median is 22, capped at 1.25 x the 15 km just run
  assert.equal(w11.comeback?.fraction, 1);
  const w12 = planFor(withWeeks([12, 15, 18]), 12);
  assert.equal(w12.targetKm, 22); // 100% of the median
  assert.equal(w12.comeback?.weeksSince, 3);
  // A week that did not grade good (it shrank: 12 -> 10 km) repeats the rung instead of climbing; the ceiling is 1.25 x 10.
  const repeat = planFor(withWeeks([12, 10]), 11);
  assert.equal(repeat.targetKm, 12);
  assert.equal(repeat.comeback?.fraction, 0.8);
  // The climb is over after three weeks: the plain step again.
  const w13 = planFor(withWeeks([12, 15, 18, 22]), 13);
  assert.equal(w13.comeback, null);
  assert.equal(w13.targetKm, 24); // 22 x 1.10
  // A week more than 10% over its "up to" ceiling (wave 22e): "a touch over" (fine, said once) up to 25% over it, "well over" (a spike) past
  // that or past the pre-break median. Either way the next ceiling climbs from the CEILING, never from the overshoot.
  assert.equal(overUpToCap(w10, 16.5), false); // exactly 10% over: within the ceiling's slack
  assert.equal(overUpToCap(w10, 16.6), true);
  assert.equal(overUpToCap(w11, 19.8), false); // the 18 km ceiling
  assert.equal(overUpToCap(w11, 20), true); // "20 of up to ~18 km"
  assert.equal(overUpToCap(planFor(withWeeks([12, 15, 18, 22]), 13), 30), false); // a plain week has no ceiling
  assert.equal(comebackCapRead(w10, 16.5), 'within');
  assert.equal(comebackCapRead(w10, 17), 'touch'); // 13% over, 2 km: a touch
  assert.equal(comebackCapRead(w11, 20), 'touch'); // 20 of up to ~18: 11% over, still under the 22 km median
  assert.equal(comebackCapRead(w11, 21.9), 'touch'); // 21.7% over, under the 22 km median
  assert.equal(comebackCapRead(w11, 22.1), 'well'); // past the 22 km pre-break median
  assert.equal(comebackCapRead({ ...w10, targetKm: 8 }, 10.5), 'touch'); // +31% but only 2.5 km over (a spike needs 3 km)
  assert.equal(comebackCapRead(w11, 23), 'well'); // past the 22 km pre-break median as well
  assert.equal(comebackCapRead({ ...w11, comeback: { medianKm: 25 } }, 22.6), 'well'); // more than 25% over: well, below the median too
  assert.equal(overCapPhrase('touch'), 'a touch over, fine');
  assert.equal(overCapPhrase('well'), 'well over the ceiling');
  const within = planFor(withWeeks([12, 16.5]), 11);
  assert.equal(within.last?.overCap, false);
  assert.equal(within.last?.capRead, null);
  assert.equal(within.targetKm, 20); // the ladder climbs: 1.25 x 16.5, floored
  const over = planFor(withWeeks([12, 18]), 11); // ran 18 of up to ~15: a touch over
  assert.equal(over.last?.overCap, true);
  assert.equal(over.last?.capRead, 'touch');
  assert.equal(over.targetKm, 18); // 1.25 x the 15 km CEILING (18.75, floored), and never below the 18 km run
  assert.equal(over.upTo, true);
  assert.deepEqual(over.comeback, { medianKm: 22, fraction: 1, weeksSince: 2 }); // a touch over still grades good: the rung climbs
  assert.equal(nbsp(over.purpose).split(':')[0], 'Up to ~18~km this week'); // no "Hold here"
  // Rule 2 never steps the ceiling up from the overshoot: 20 of up to ~18 km (messy week 11) -> 22, not 1.25 x 20.
  const messy = enduranceWeekPlan({ runs: [...runsFor([15, 17, 19, 21, 23, 25, 28, 30, 6]), ...runsFor([15, 20], 10)], weekStart: weekOf(12), goalKm: 30, today: weekOf(12) });
  assert.equal(messy.last?.capRead, 'touch');
  assert.ok(messy.targetKm != null && messy.targetKm <= 1.25 * (messy.last?.targetKm ?? 0) + 1e-9, `ceiling ${messy.targetKm} after ${messy.last?.km} of ${messy.last?.targetKm}`);
  assert.equal(planFor(withWeeks([12, 18, 22]), 12).targetKm, 22); // the next ceiling, from the 18 km ceiling (22.5 floored)
  // Rule 3: far past the ceiling (a 15 -> 29 km style jump) is a spike even below the pre-break median; next week stays AT the ceiling.
  const far = planFor(withWeeks([12, 21]), 11); // 21 of up to ~15: 40% over, 6 km over
  assert.equal(far.last?.capRead, 'well');
  assert.equal(far.kind, 'hold');
  assert.equal(far.targetKm, 15); // the ceiling, not the 21 km run and not a step from it
  assert.equal(far.hold?.ceiling, true);
  assert.deepEqual(far.hold?.ladder, { medianKm: 22, fraction: 0.8, weeksSince: 1 }); // the climb back is kept alive
  assert.deepEqual(gradeEnduranceWeek(w10, 21), { level: 'mixed', gap: 'spike' });
  assert.ok(far.longRunKm != null && far.longRunKm <= 7.5 + 1e-9, `the hold's long run ${far.longRunKm} km is at most half of 15 km`);
  // ... and the week after the hold resumes the ladder from the ceiling (rule 1), not from the 21 km jump.
  const resumed = planFor(withWeeks([12, 21, 15]), 12);
  assert.equal(resumed.kind, 'build');
  assert.equal(resumed.comeback?.weeksSince, 2);
  assert.ok((resumed.targetKm ?? 99) <= 1.25 * 15 + 1e-9, `${resumed.targetKm}`);
  const overLast = planFor(withWeeks([12, 18, 22, 25]), 13); // 25 of up to ~22 (past the 22 km median): well over
  assert.equal(overLast.kind, 'hold');
  assert.equal(overLast.targetKm, 22);
  // A careful comeback week is graded against the week before it, not against its ceiling (wave 21e): good when it grew
  // (or held) and was not a spike, mixed only when it shrank - never "5 km short of this week's step".
  assert.equal(gradeEnduranceWeek(w10, 12).level, 'good'); // the 12 km just run
  assert.equal(gradeEnduranceWeek(w10, 13).level, 'good'); // +8%, well under the 15 km ceiling
  assert.deepEqual(gradeEnduranceWeek(w10, 11.9), { level: 'mixed', gap: 'short' }); // it shrank
  assert.equal(gradeEnduranceWeek(w10, 3).level, 'mixed'); // never tough
  // Regaining the pre-break level is no spike in a RESTART week (wave 22e: not in a comeback week - 22 of up to ~15 km is well over its
  // ceiling even though 22 km is the pre-break median); a real jump beyond it is one everywhere.
  assert.equal(gradeEnduranceWeek(restart, 12).gap, null);
  assert.equal(gradeEnduranceWeek(restart, 22).gap, null);
  assert.equal(gradeEnduranceWeek(w10, 22).gap, 'spike');
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

test('maintain: at the weekly goal the plan holds it and the long run keeps stepping (graded) toward the peak target', () => {
  const runs = runsFor([30, 30, 30, 30]);
  const race = { date: addDayKey(MON, 130), distanceKm: 21.1 };
  const plan = planFor(runs, 5, { race });
  assert.equal(plan.kind, 'maintain');
  assert.equal(plan.targetKm, 30);
  // The half's 18 km peak does not fit a 30 km week (a long run is at most half of it): the peak is what fits (wave 20).
  assert.equal(plan.longRun.targetPeakKm, 15);
  assert.equal(plan.longRun.raceTargetKm, 18);
  assert.equal(plan.longRun.lastKm, 12); // 40% of 30
  assert.equal(plan.longRunKm, 12 + LONG_RUN_STEP_10_TO_16_KM); // 12 km: +1.5
  assert.equal(plan.purpose.replace(/\u00a0/g, ' '), 'Hold 30 km this week: long run 13.5 km, the rest easy');
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
  // (The third Monday of the 10K is the week after a cutback week this 30-km-every-week runner skipped: the week it replaced WAS the goal, so (wave 24e) it is a maintain week, not a hold below the goal.)
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
  // Weeks 0-4 on plan (shifted one week so the planned week 5 is not the calendar's cutback week, which caps the long run
  // at half of its lowered week), week 4 carries a 14 km long run where 12 was planned (the one before was 10).
  const week = (n: number, longKm: number, total: number): PlanRun[] => {
    const w = weekOf(n);
    const rest = (total - longKm) / 3;
    return [
      { day: addDayKey(w, 1), km: rest }, { day: addDayKey(w, 3), km: rest }, { day: addDayKey(w, 5), km: rest }, { day: addDayKey(w, 6), km: longKm },
    ];
  };
  const runs = [...week(0, 6, 15), ...week(1, 7, 17), ...week(2, 8, 19), ...week(3, 10, 23), ...week(4, 14, 27)];
  const plan = planFor(runs, 5);
  assert.equal(plan.cutback, null);
  assert.equal(plan.longRunJump?.actualKm, 14);
  assert.equal(plan.longRunJump?.plannedKm, roundLongRunKm(10 + LONG_RUN_STEP_10_TO_16_KM)); // the plan's step from the 10 km before it: 11.5
  assert.equal(plan.longRunKm, 14); // held at 14, not 16
  assert.match(plan.purpose.replace(/ /g, ' '), /long run 14 km \(held after last week's jump\)/);
  // A +0.5 km creep is no jump; neither is a long run on plan.
  const creep = planFor([...week(0, 6, 15), ...week(1, 7, 17), ...week(2, 8, 19), ...week(3, 10, 23), ...week(4, 12, 25)], 5);
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

// ── Wave 21e: cutbacks, strides, light weeks, restart numbers, cap-note cadence, oversized long runs ──────────────────

const nbsp = (text: string): string => text.replace(/\u00a0/g, '~');
/** A digit, an ASCII space and a unit: what no display copy may contain (U+00A0 joins a number to its unit). */
const hasBreakingUnitSpace = (text: string): boolean => /\d (km|mi|kg|lb|kcal|min)\b/.test(text);

test('race eve copy: rest or a shakeout, and one neutral line for a week that ran 1.5x the plan', () => {
  assert.equal(RACE_EVE_LINE, 'Race tomorrow — rest or a 15-min shakeout; lay out your kit');
  assert.equal(RACE_EVE_CONSERVATIVE_LINE, 'Start conservatively — the first few km easy');
  assert.equal(hasBreakingUnitSpace(`${RACE_EVE_LINE} ${RACE_EVE_CONSERVATIVE_LINE}`), false);
});

test('cutback: every 4th calendar week, after 3 plain build weeks, is ~80% of the week it replaces with the long run held', () => {
  // Weeks 1 (baseline) and 2-5 build; week 6 is the calendar's cutback week.
  for (const w of [2, 3, 4, 5]) assert.equal(planFor(runsFor([15, 17, 19, 21, 23].slice(0, w - 1)), w).cutback, null, `week ${w}`);
  const cut = planFor(runsFor([15, 17, 19, 21, 23]), 6);
  assert.equal(cut.kind, 'build');
  assert.deepEqual(cut.cutback, { normalKm: 25 });
  assert.equal(cut.targetKm, 20); // 80% of the 25 km step
  assert.equal(cut.longRunKm, 9); // the long run just run (40% of 23, rounded), held - not stepped up
  assert.equal(cut.longRun.held, true);
  assert.equal(nbsp(cut.purpose), 'Cutback week: ~20~km, long run 9~km — absorb the last three weeks');
  assert.equal(cut.buildWeeks, 0);
  // Graded as its own target and never "short": any running is a good cutback. The week's target is the cutback number, so a jump is
  // measured against it (30% and 3 km over ~20 km); the normal 25 km week it replaced is 25% over it, no spike. A week with no run is a rest week.
  assert.deepEqual(gradeEnduranceWeek(cut, 8), { level: 'good', gap: null });
  assert.deepEqual(gradeEnduranceWeek(cut, 22), { level: 'good', gap: null }); // inside the 10% ceiling slack
  // More than 10% over the lowered number is a cutback that became a normal week (wave 22e "skipped": mixed; wave 23e: a good week, no failure, but the gap 'over'
  // stays so the next week holds and the cutback is still owed).
  assert.deepEqual(gradeEnduranceWeek(cut, 22.1), { level: 'good', gap: 'over' });
  assert.deepEqual(gradeEnduranceWeek(cut, 25), { level: 'good', gap: 'over' });
  assert.deepEqual(gradeEnduranceWeek(cut, 26), { level: 'good', gap: 'over' });
  assert.deepEqual(gradeEnduranceWeek(cut, 27), { level: 'mixed', gap: 'spike' });
  assert.deepEqual(gradeEnduranceWeek(cut, 40), { level: 'mixed', gap: 'spike' });
  assert.equal(gradeEnduranceWeek(cut, 0).level, 'light');
  // The hold after a jump in a cutback week: the target that week's cards showed (~20 km) is what it was graded against, and the
  // hold steps up from the 25 km week the cutback replaced (28 km), not from the cutback's own low or the jump.
  const spiked = planFor(runsFor([15, 17, 19, 21, 23, 40]), 7);
  assert.equal(spiked.kind, 'hold');
  assert.deepEqual(spiked.hold, { spikeKm: 40, spikeStepKm: 20 });
  assert.equal(spiked.targetKm, 28);
  // A skipped cutback (25 km run against ~20): no +10% build on the skip - the next week holds at the 25 km week the cutback replaced.
  const skipped = planFor(runsFor([15, 17, 19, 21, 23, 25]), 7);
  assert.equal(skipped.kind, 'hold');
  assert.equal(skipped.targetKm, 25);
  assert.deepEqual(skipped.hold, { spikeKm: 25, spikeStepKm: 20, skippedCutback: true });
  assert.equal(nbsp(skipped.purpose), 'Your cutback became a normal week. Hold ~25~km this week, long run 10~km — no 10% step on top of it');
  assert.equal(skipped.last?.cutback, true);
  assert.equal(skipped.last?.grade?.gap, 'over'); // (wave 23e: a good week - no failure - that still owes the cutback)
  assert.equal(skipped.last?.grade?.level, 'good');
  // ... and the week after the hold builds on the held week (25 -> 28), as any hold.
  assert.equal(planFor(runsFor([15, 17, 19, 21, 23, 25, 25]), 8).targetKm, 28);
  // A cutback week that ended in days off short of its lowered number is a rest week, not a good cutback.
  assert.equal(gradeEnduranceWeek({ ...cut, endedOff: true }, 5).level, 'light');
  // The week after returns to the progression: ~10% over the bigger of the two weeks before the cutback, never over the cutback's own low.
  const after = planFor(runsFor([15, 17, 19, 21, 23, 20]), 7);
  assert.equal(after.cutback, null);
  assert.equal(after.targetKm, 25); // 23 x 1.10, not 20 x 1.10
  assert.equal(after.buildWeeks, 1);
  assert.equal(after.stepPct, 9); // against the 23 km base, not the 20 km cutback
  // The next cutback is 4 weeks later (weeks 7, 8, 9 plain first).
  const next = runsFor([15, 17, 19, 21, 23, 20, 25, 28, 30, 30]);
  assert.equal(planFor(next, 10).cutback?.normalKm, 30);
  assert.equal(planFor(next, 9).cutback, null);
});

test('cutback at the weekly goal: ~24 km of 30, long run held at what it was (never past the peak target); not before 3 plain weeks, not in a comeback, not the week before a taper', () => {
  const race = { date: addDayKey(MON, 7 * 30), distanceKm: 21.1 };
  const atGoal = planFor(runsFor([30, 30, 30, 30, 30]), 6, { race });
  assert.equal(atGoal.kind, 'maintain');
  assert.equal(atGoal.targetKm, 24);
  assert.deepEqual(atGoal.cutback, { normalKm: 30 });
  assert.equal(atGoal.longRunKm, 12);
  // A long run already past the peak target is held at the target, not at the oversized one - and a cutback never
  // carries a long run past half of its lowered week (15 km of a 24 km week would be 62%): 12 km, the half.
  const big: PlanRun[] = [...runsFor([30, 30, 30, 30]), { day: addDayKey(weekOf(5), 1), km: 4 }, { day: addDayKey(weekOf(5), 3), km: 4 }, { day: addDayKey(weekOf(5), 5), km: 4 }, { day: addDayKey(weekOf(5), 6), km: 18 }];
  assert.equal(planFor(big, 6, { race }).longRunKm, 12); // peak target 15 km at a 30 km goal, capped at 50% of the 24 km cutback
  // Three plain weeks must precede it: a restart in week 4 pushes the cutback out (week 6 is a rung of the comeback).
  const afterBreak = planFor(runsFor([15, 17, 19, 0, 0, 14]), 6);
  assert.equal(afterBreak.cutback, null);
  // The last build week before a taper is not a cutback (the taper is the easing off); one more week out, it is.
  const raceEndWeek8 = { date: addDayKey(weekOf(8), 6), distanceKm: 21.1 }; // a half: week 7 is the taper, week 6 the last build week
  assert.equal(planFor(runsFor([15, 17, 19, 21, 23]), 6, { race: raceEndWeek8 }).cutback, null);
  const raceEndWeek9 = { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 };
  assert.equal(planFor(runsFor([15, 17, 19, 21, 23]), 6, { race: raceEndWeek9 }).cutback?.normalKm, 25);
});

test('strides: the last 2 build weeks before a taper carry "plus 4–6 strides after one easy run"; no taper, no strides', () => {
  const race = { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 }; // half: taper week 8, race week 9
  const runs = runsFor([15, 17, 19, 21, 23, 25, 28, 30]);
  const at = (w: number) => planFor(runs.filter(r => r.day < weekOf(w)), w, { race });
  assert.equal(at(5).strides, false);
  assert.equal(at(6).strides, true);
  assert.equal(at(7).strides, true);
  assert.equal(at(8).strides, false); // the taper itself
  assert.match(nbsp(at(7).purpose), new RegExp(`${STRIDES_COPY}$`));
  assert.match(nbsp(at(6).purpose), /Cutback week: ~\d+~km, long run [\d.]+~km — absorb the last three weeks; plus 4–6 strides after one easy run$/);
  assert.equal(STRIDES_COPY, 'plus 4–6 strides after one easy run');
  // A 10K has no taper: nothing to prepare for.
  const tenK = { date: addDayKey(weekOf(9), 6), distanceKm: 10 };
  assert.equal(planFor(runs.filter(r => r.day < weekOf(7)), 7, { race: tenK }).strides, false);
  // Not on a plan without a race.
  assert.equal(planFor(runs.filter(r => r.day < weekOf(7)), 7).strides, false);
});

test('light week: 4+ days without a run in the week (or, from Friday, well behind the runner\'s own pace with the rest out of reach) says "don\'t make it up", with a capped long run', () => {
  const runs = runsFor([15, 17, 19, 21, 23, 25, 28, 30], 1);
  // Week 9 (Mon weekOf(9)): one 6 km run on Tuesday, then nothing.
  const week9 = [...runs, { day: addDayKey(weekOf(9), 1), km: 6 }];
  const at = (offset: number) => enduranceWeekPlan({ runs: week9.filter(r => r.day <= addDayKey(weekOf(9), offset)), weekStart: weekOf(9), goalKm: 30, today: addDayKey(weekOf(9), offset) });
  assert.equal(at(2).lightWeek, null); // Wednesday: too early to say
  // Thursday (wave 23e): the Thursday run is still to come - a runner who did exactly what the plan said on Tuesday has the same week so far. Not light yet.
  assert.equal(at(3).lightWeek, null);
  // Friday (wave 22e): 6 km against ~10.8 km by Thursday in the weeks before, and the ~24 km left cannot fit in Saturday and Sunday.
  const fri = at(4);
  assert.equal(fri.lightWeek?.reason, 'late_week'); // Friday, 6 km of ~33... well behind the usual pace
  const sat = at(5);
  assert.equal(sat.lightWeek?.reason, 'days_off'); // Wednesday to Saturday: 4 days
  assert.equal(sat.lightWeek?.daysOff, 4);
  // The cap: ~40% of a realistic (70%) week, or the last long run, whichever is less - rounded down to half a km.
  assert.equal(sat.lightWeek?.longRunCapKm, 8); // 0.4 x (0.7 x 30) = 8.4, down to the half km
  assert.equal(nbsp(sat.purpose), "Light week — don't make it up; long run ≤ ~8~km easy, or skip it if you were ill");
  assert.equal(sat.longRunKm, 8);
  assert.equal(nbsp(lightWeekLine({ reason: 'days_off', daysOff: 4, longRunCapKm: null })), "Light week — don't make it up; keep the runs short and easy, or skip them if you were ill");
});

test('light week: a plan-perfect runner is never "light" on a Friday (the long run is still to come), a week with a normal rhythm of days off is not either', () => {
  // 4 runs a week: Tue / Thu / Sat / Sun long run. By Friday that is under half the week - and exactly the runner's own pace.
  const runs = runsFor([15, 17, 19, 21, 23, 25, 28, 30]);
  const week9 = runsFor([30], 9);
  for (let offset = 0; offset <= 6; offset++) {
    const today = addDayKey(weekOf(9), offset);
    const p = enduranceWeekPlan({ runs: [...runs, ...week9].filter(r => r.day <= today), weekStart: weekOf(9), goalKm: 30, today });
    assert.equal(p.lightWeek, null, `weekday ${offset}`);
  }
  // A weekend-only runner (Fri / Sat / Sun) has 4 days off every week: Thursday with nothing yet is the usual rhythm.
  const weekend: PlanRun[] = [];
  for (let w = 1; w <= 8; w++) weekend.push({ day: addDayKey(weekOf(w), 4), km: 6 }, { day: addDayKey(weekOf(w), 5), km: 6 }, { day: addDayKey(weekOf(w), 6), km: 12 });
  const thursday = enduranceWeekPlan({ runs: weekend, weekStart: weekOf(9), goalKm: 24, today: addDayKey(weekOf(9), 3) });
  assert.equal(thursday.lightWeek, null);
  // Miles: the cap rounds down to half a mile.
  const MI = 1 / 1.609344;
  const sick = [...runs, { day: addDayKey(weekOf(9), 1), km: 6 }];
  const sat = enduranceWeekPlan({ runs: sick.filter(r => r.day <= addDayKey(weekOf(9), 5)), weekStart: weekOf(9), goalKm: 30, today: addDayKey(weekOf(9), 5), unitsPerKm: MI });
  assert.equal(sat.lightWeek?.reason, 'days_off');
  assert.ok(Math.abs((sat.lightWeek?.longRunCapKm as number) * MI * 2 - Math.round((sat.lightWeek?.longRunCapKm as number) * MI * 2)) < 0.05);
  assert.match(nbsp(sat.purpose), /^Light week — don't make it up; long run ≤ ~5(\.5)?~mi easy, or skip it if you were ill$/);
  assert.equal(hasBreakingUnitSpace(sat.purpose), false);
  // Never in a taper / race / recovery / restart week, nor a week still being planned (the review's next-week read on its Monday).
  const race = { date: addDayKey(weekOf(10), 6), distanceKm: 21.1 };
  const taperDays = enduranceWeekPlan({ runs: sick.filter(r => r.day <= addDayKey(weekOf(9), 5)), weekStart: weekOf(9), goalKm: 30, today: addDayKey(weekOf(9), 5), race });
  assert.equal(taperDays.kind, 'taper');
  assert.equal(taperDays.lightWeek, null);
  assert.equal(planFor(runs, 9).lightWeek, null);
});

test('light week (wave 22e): with one finished week the pace is that week by the same weekday; the long run still to come is not "behind"', () => {
  // Week 1: 15 km, Tue 3 / Thu 3 / Sat 3 / Sun 6. Week 2 by Friday: Tue 3.4 + Thu 3.3 = 6.7 km of ~17 - exactly on pace, the long run is Sunday.
  const week1 = runsFor([15]);
  const week2 = [{ day: addDayKey(weekOf(2), 1), km: 3.4 }, { day: addDayKey(weekOf(2), 3), km: 3.3 }];
  const fri = enduranceWeekPlan({ runs: [...week1, ...week2], weekStart: weekOf(2), goalKm: 30, today: addDayKey(weekOf(2), 4) });
  assert.equal(fri.kind, 'build');
  assert.equal(fri.lightWeek, null);
  assert.equal(fri.easingOff, null);
  // The same runner who only ran 2 km in week 2 by Friday IS behind: under 75% of week 1's 6 km by then, and 15 km cannot fit in Sat + Sun.
  const slow = enduranceWeekPlan({ runs: [...week1, { day: addDayKey(weekOf(2), 1), km: 2 }], weekStart: weekOf(2), goalKm: 30, today: addDayKey(weekOf(2), 4) });
  assert.equal(slow.lightWeek?.reason, 'late_week');
});

test('pre-taper week (wave 22e): the light-week rule does not apply - it reads "easing off before your taper", with the long run range', () => {
  // A half on weekOf(10)'s Sunday: week 8 is the last build week (week 9 is the taper). Weeks 1-7 plan-perfect, week 8 Tue 3 + Thu 3 only.
  const race = { date: addDayKey(weekOf(10), 6), distanceKm: 21.1 };
  const runs = [...runsFor([15, 17, 19, 21, 23, 25, 28]), { day: addDayKey(weekOf(8), 1), km: 3 }, { day: addDayKey(weekOf(8), 3), km: 3 }];
  const sat = enduranceWeekPlan({ runs: runs.filter(r => r.day <= addDayKey(weekOf(8), 5)), weekStart: weekOf(8), goalKm: 30, today: addDayKey(weekOf(8), 5), race, racePeakWeekKm: 28 });
  assert.deepEqual(sat.preTaper, { nextPhase: 'taper', taperLongRunKm: 7.5 }); // (wave 23e P3-j: the taper's long run as Monday's plan will show it: 65% of the 12 km peak)
  assert.equal(sat.lightWeek, null);
  assert.equal(sat.easingOff?.reason, 'late_week');
  assert.ok(sat.easingOff?.longRunKm != null && sat.easingOff.taperLongRunKm != null && sat.easingOff.taperLongRunKm < sat.easingOff.longRunKm);
  assert.match(nbsp(sat.purpose), /^Easing off before your taper — fine; keep Sunday's long run ~\d+(\.5)?–\d+(\.5)?~km easy$/);
  // The cap is never lower than the taper's own long run: the planned long run is kept as the upper end.
  assert.equal(sat.longRunKm, sat.easingOff?.longRunKm);
  // A week before race week of a 10K says so; the week before that is plain building.
  const tenK = { date: addDayKey(weekOf(10), 6), distanceKm: 10 };
  const full = runsFor([15, 17, 19, 21, 23, 25, 28, 30]);
  const tenKWeek = enduranceWeekPlan({ runs: full, weekStart: weekOf(9), goalKm: 30, today: addDayKey(weekOf(9), 3), race: tenK });
  assert.deepEqual(tenKWeek.preTaper, { nextPhase: 'race_week' });
  assert.equal(enduranceWeekPlan({ runs: full.filter(r => r.day < weekOf(8)), weekStart: weekOf(8), goalKm: 30, today: addDayKey(weekOf(8), 2), race: tenK }).preTaper, null);
  // Not in the taper itself.
  assert.equal(planFor(runs, 9, { race }).preTaper, null);
});

test('the week\'s plan does not change from day to day, nor as the oldest weeks of the 77-day history window slide away', () => {
  // 14 plan-perfect weeks (the cutback weeks 6 and 10 run as planned). The loader hands over the last 77 days: the partial first week at the
  // window's edge must never reach today's plan.
  const runs = runsFor([15, 17, 19, 21, 23, 20, 25, 28, 30, 24, 30, 30, 30, 30]);
  for (const week of [12, 13, 14]) {
    const monday = weekOf(week);
    const monPlan = enduranceWeekPlan({ runs: runs.filter(r => r.day <= monday && r.day >= addDayKey(monday, -77)), weekStart: monday, goalKm: 30, today: monday });
    for (let offset = 0; offset <= 6; offset++) {
      const today = addDayKey(monday, offset);
      const p = enduranceWeekPlan({ runs: runs.filter(r => r.day <= today && r.day >= addDayKey(today, -77)), weekStart: monday, goalKm: 30, today });
      assert.equal(p.kind, monPlan.kind, `week ${week} day ${offset}`);
      assert.equal(p.targetKm, monPlan.targetKm, `week ${week} day ${offset}`);
      assert.equal(p.cutback?.normalKm ?? null, monPlan.cutback?.normalKm ?? null, `week ${week} day ${offset}`);
    }
  }
  // Cutbacks fall on the same calendar weeks (6, 10, 14) however the window is cut.
  const cutWeeks = [8, 9, 10, 11, 12, 13, 14].filter(w => planFor(runs.filter(r => r.day < weekOf(w)), w).cutback != null);
  assert.deepEqual(cutWeeks, [10, 14]);
});

test('cap note cadence: the goal\'s first week, then every 4th build week; never in a taper, race, recovery or rebuild week', () => {
  assert.equal(CAP_NOTE_EVERY_WEEKS, 4);
  const race = { date: addDayKey(MON, 7 * 20), distanceKm: 21.1 }; // a half: the 18 km peak does not fit a 30 km goal -> a cap note exists
  const due = (w: number, over: Partial<EnduranceWeekPlanInput> = {}) => planFor(runsFor([20, 22, 24, 26, 28, 30, 30, 30, 30, 30, 30, 30].slice(0, w - 1)), w, { race, goalStartDay: MON, ...over });
  const weeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13].map(w => [w, due(w).longRun.capNoteDue] as const);
  assert.deepEqual(weeks.filter(([, d]) => d).map(([w]) => w), [1, 5, 9, 13]);
  assert.equal(due(2).longRun.raceTargetKm, 18); // the note exists every week; it is only SAID in some of them
  // No cap, no note.
  assert.equal(due(5, { goalKm: 40 }).longRun.capNoteDue, false);
  // Wind-down and rebuild weeks never.
  const closeRace = { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 };
  const runs = runsFor([20, 22, 24, 26, 28, 30, 30, 30]);
  for (const w of [8, 9, 10]) assert.equal(planFor(runs, w, { race: closeRace, goalStartDay: MON, racePeakWeekKm: 30 }).longRun.capNoteDue, false, `week ${w}`);
  const rebuild = planFor([...runs, ...runsFor([12, 20, 22], 10)], 13, { race: closeRace, goalStartDay: MON, racePeakWeekKm: 30 });
  assert.equal(rebuild.kind, 'rebuild');
  assert.equal(rebuild.longRun.capNoteDue, false);
});

test('cap note (wave 22e): not in a comeback, restart or light week, and only when the raised goal is reachable at +10% a week before the taper', () => {
  const race = { date: addDayKey(MON, 7 * 20), distanceKm: 21.1 }; // a half: the 18 km peak needs a 36 km goal; the taper starts in week 19
  const steady = (kms: number) => runsFor(new Array<number>(16).fill(kms));
  // A runner at 30 km in week 9 (due: the goal's first week, then every 4th) can raise the goal: 30 x 1.1^10 is far past 36 km.
  assert.equal(planFor(steady(30).filter(r => r.day < weekOf(9)), 9, { race, goalStartDay: MON }).longRun.capNoteDue, true);
  // The same due week at 20 km with 2 build weeks left (week 17): 20 x 1.1^2 = 24 km cannot reach 36 km, so the note stays quiet.
  assert.equal(planFor(steady(20).filter(r => r.day < weekOf(17)), 17, { race, goalStartDay: MON }).longRun.capNoteDue, false);
  // A comeback week after a break never carries it, even in its due week (week 13).
  const afterBreak = planFor(runsFor([30, 30, 30, 30, 30, 30, 30, 30, 0, 0, 12, 15]), 13, { race, goalStartDay: MON });
  assert.notEqual(afterBreak.comeback, null);
  assert.equal(afterBreak.longRun.capNoteDue, false);
  assert.equal(planFor(steady(30).filter(r => r.day < weekOf(13)), 13, { race, goalStartDay: MON }).longRun.capNoteDue, true);
});

test('a long run that was most of its week: one note for the most recent such week, and its peak is never a good peak', () => {
  const week = (n: number, longKm: number, total: number): PlanRun[] => {
    const w = weekOf(n);
    const rest = (total - longKm) / 3;
    return [{ day: addDayKey(w, 1), km: rest }, { day: addDayKey(w, 3), km: rest }, { day: addDayKey(w, 5), km: rest }, { day: addDayKey(w, 6), km: longKm }];
  };
  const race = { date: addDayKey(MON, 7 * 20), distanceKm: 21.1 };
  // Week 5: an 18 km long run in a 30 km week (60%); week 4 was 14 of 30 (47%).
  const runs = [...runsFor([30, 30, 30]), ...week(4, 14, 30), ...week(5, 18, 30)];
  const next = planFor(runs, 6, { race });
  assert.deepEqual(next.longRun.share, { weekStart: weekOf(5), longKm: 18, weekKm: 30, sharePct: 60 });
  assert.equal(next.longRun.peakOversized, true);
  // The watch note is said once (wave 22e): on the Monday after the oversized week, not on the days after it.
  assert.equal(next.longRun.shareDue, true);
  const wednesday = enduranceWeekPlan({ runs, weekStart: weekOf(6), goalKm: 30, today: addDayKey(weekOf(6), 2), race });
  assert.equal(wednesday.longRun.share?.weekStart, weekOf(5)); // still known (the peak is not praised) ...
  assert.equal(wednesday.longRun.shareDue, false); // ... but not said again
  // Read on the Sunday of the week itself the same week is named (the long run is done).
  const sunday = enduranceWeekPlan({ runs, weekStart: weekOf(5), goalKm: 30, today: addDayKey(weekOf(5), 6), race });
  assert.equal(sunday.longRun.share?.weekStart, weekOf(5));
  // Read mid-week with the long run already in, the denominator is the larger of what is run and the week's target.
  const tuesday = enduranceWeekPlan({ runs: [...runsFor([30, 30, 30]), ...week(4, 14, 30), { day: addDayKey(weekOf(5), 1), km: 18 }], weekStart: weekOf(5), goalKm: 30, today: addDayKey(weekOf(5), 1), race });
  assert.equal(tuesday.longRun.share, null); // one run day: not a week with a rhythm to judge
  // An ordinary long run (47%) says nothing, a 2-run week has a long run that is most of it by nature, and a taper week carries no note.
  assert.equal(planFor([...runsFor([30, 30, 30]), ...week(4, 14, 30)], 5, { race }).longRun.share, null);
  assert.equal(planFor([...runsFor([30, 30, 30]), { day: addDayKey(weekOf(4), 3), km: 6 }, { day: addDayKey(weekOf(4), 6), km: 14 }], 5, { race }).longRun.share, null);
  const taperRace = { date: addDayKey(weekOf(7), 6), distanceKm: 21.1 };
  const taper = planFor(runs, 6, { race: taperRace, racePeakWeekKm: 30 });
  assert.equal(taper.kind, 'taper');
  assert.equal(taper.longRun.share, null);
  assert.equal(taper.longRun.peakOversized, true); // ... but its "peak long run - done" is not praised
});

test('the race-pace reps and every new line of plan copy join numbers to units with U+00A0 (no ASCII space between a digit and km / mi)', () => {
  const MI = 1 / 1.609344;
  assert.equal(racePaceReps(), '3×1 km');
  assert.equal(racePaceReps(MI), '3×0.5 mi');
  const race = { date: addDayKey(weekOf(9), 6), distanceKm: 21.1 };
  const runs = runsFor([15, 17, 19, 21, 23, 25, 28, 30]);
  const copies: string[] = [];
  for (const unitsPerKm of [1, MI]) {
    for (let w = 2; w <= 10; w++) {
      const p = planFor(runs.filter(r => r.day < weekOf(w)), w, { race, racePeakWeekKm: 40, unitsPerKm });
      copies.push(p.purpose);
    }
    // Light, cutback and strides lines too.
    copies.push(planFor(runsFor([15, 17, 19, 21, 23]), 6, { unitsPerKm }).purpose);
    copies.push(planFor(runs.filter(r => r.day < weekOf(7)), 7, { race, unitsPerKm }).purpose);
    copies.push(lightWeekLine({ reason: 'days_off', daysOff: 4, longRunCapKm: 8 }, unitsPerKm));
  }
  assert.ok(copies.some(c => c.startsWith('Taper:')), 'a taper line was produced');
  assert.ok(copies.some(c => c.startsWith('Cutback week:')), 'a cutback line was produced');
  assert.ok(copies.some(c => c.includes(STRIDES_COPY)), 'a strides line was produced');
  for (const c of copies) assert.equal(hasBreakingUnitSpace(c), false, c);
  // The taper line itself reads "3×1<NBSP>km at race pace midweek" / "3×0.5<NBSP>mi".
  assert.ok(copies.some(c => c.includes('3×1 km at race pace midweek')));
  assert.ok(copies.some(c => c.includes('3×0.5 mi at race pace midweek')));
});
