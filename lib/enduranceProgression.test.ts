import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWindDownPhase,
  longRunAtPeak,
  longRunStepKm,
  peakWeekKmBeforeTaper,
  racePhase,
  racePhaseInfo,
  racePhaseTargetKm,
  recoveryWeek,
  weekStepTarget,
  weekStepTargetKm,
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
  assert.deepEqual(racePhaseInfo(RACE, addDays(RACE, -10)), { phase: 'taper', daysToRace: 10 });
  assert.deepEqual(racePhaseInfo(RACE, addDays(RACE, 3)), { phase: 'recovery', daysToRace: -3 });
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

test('racePhaseTargetKm: capped at the weekly goal; imperial rounds in whole miles', () => {
  assert.equal(target(14, 60, { weeklyGoalKm: 30 }), 30); // 45 km capped at the 30 km goal
  assert.equal(target(14, 40, { weeklyGoalKm: 30 }), 30);
  assert.equal(target(14, 40, { weeklyGoalKm: 50 }), 30);
  assert.equal(target(14, 40, { weeklyGoalKm: null }), 30);
  // 40 km = 24.85 mi; x0.75 = 18.64 -> 19 mi = 30.6 km (one decimal).
  const MI_PER_KM = 1 / 1.609344;
  const km = target(14, 40, { unitsPerKm: MI_PER_KM })!;
  assert.ok(Math.abs(km * MI_PER_KM - 19) < 0.05, `${km}`);
  assert.equal(target(14, 40, { unitsPerKm: 0 }), null);
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
