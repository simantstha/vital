/**
 * Wave 26e group A - coaching arithmetic for the long run. Two caps: without a race the long run never steps above 21 km (13 mi) - a
 * general-fitness runner is not sent out for 30 km every Sunday - and a taper long run never passes its week's share (the late marathon
 * taper's Sunday, a week out, is 45% of the peak). Group B: the long-run STEP is graded by distance (+1 km under 10 km, +1.5 km to 16 km, +2 km
 * from 16 km; +0.5 mi under 6 mi, +1 mi from it) - except while a restart / comeback / rebuild regains a distance the runner ran before the break.
 * Every test here was written BEFORE the rule it locks in. (Its own file, like the wave 20 - 25 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUTBACK_FRACTION,
  LONG_RUN_MAX_WEEK_SHARE,
  NO_RACE_LONG_RUN_MAX_KM,
  STRIDES_COPY,
  TAPER_LATE_LONG_RUN_SHARE,
  addDayKey,
  enduranceWeekPlan,
  floorLongRunKm,
  gradeEnduranceWeek,
  longRunPeakReachedOn,
  longRunStepKm,
  noRaceLongRunMaxKm,
  peakWeekKmBeforeTaper,
  roundLongRunKm,
  roundWeekTargetKm,
  weekShareKm,
  type EnduranceWeekPlan,
  type PlanRun,
} from './enduranceProgression';
import { KM_PER_MILE } from './metricFormat';
import { computeGoalProgress as computeGoalProgressRaw, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { formatGoalProgressLines } from './goalPromptText';
import { plainSpaces } from './displayText';

const D0 = '2026-03-02'; // a Monday
const MI = 1 / KM_PER_MILE;

interface Sim {
  goalKm: number;
  baseKm: number;
  baseLong: number;
  /** Weekdays run (Mon = 0); the LAST one is the long-run day. */
  days: number[];
  weeks: number;
  race?: { date: string; distanceKm: number } | null;
  units?: number;
}

/** An obedient runner: every week runs exactly the plan (the target, with the plan's long run on the last run day). */
function simulate(opts: Sim): { plans: EnduranceWeekPlan[]; runs: PlanRun[] } {
  const runs: PlanRun[] = [];
  const plans: EnduranceWeekPlan[] = [];
  const add = (w: number, total: number, long: number): void => {
    const mon = addDayKey(D0, w * 7);
    const others = opts.days.length - 1;
    const rest = others > 0 ? (total - long) / others : 0;
    opts.days.forEach((dow, i) => {
      const km = i === opts.days.length - 1 ? long : rest;
      if (km > 0) runs.push({ day: addDayKey(mon, dow), km: Math.round(km * 10) / 10 });
    });
  };
  add(0, opts.baseKm, opts.baseLong);
  for (let w = 1; w < opts.weeks; w++) {
    const mon = addDayKey(D0, w * 7);
    const race = opts.race ?? null;
    const plan = enduranceWeekPlan({
      runs,
      weekStart: mon,
      goalKm: opts.goalKm,
      race,
      today: mon,
      racePeakWeekKm: race ? peakWeekKmBeforeTaper(runs, race.date, race.distanceKm) : null,
      unitsPerKm: opts.units ?? 1,
      goalStartDay: D0,
    });
    plans.push(plan);
    const t = plan.targetKm ?? opts.baseKm;
    const isRR = plan.kind === 'race_week' || plan.kind === 'recovery';
    const long = isRR ? t / opts.days.length : plan.longRunKm ?? t / opts.days.length;
    add(w, t, Math.min(long, t));
    if (race && addDayKey(mon, 6) === race.date) runs.push({ day: race.date, km: race.distanceKm });
  }
  return { plans, runs };
}

const longRuns = (plans: EnduranceWeekPlan[]): number[] => plans.map(p => p.longRunKm).filter((k): k is number => k != null);

// ── 1. Without a race the long run tops out at 21 km (13 mi) ────────────────

test('NO_RACE_LONG_RUN_MAX_KM is 21 km, 13 mi in a runner\'s imperial unit', () => {
  assert.equal(NO_RACE_LONG_RUN_MAX_KM, 21);
  assert.equal(noRaceLongRunMaxKm(1), 21);
  assert.ok(Math.abs(noRaceLongRunMaxKm(MI) * MI - 13) < 0.01, `${noRaceLongRunMaxKm(MI)}`);
});

test('no race, 60 km/week goal: the long run climbs to 21 km and stays there (it was 30 km every Sunday)', () => {
  const { plans } = simulate({ goalKm: 60, baseKm: 40, baseLong: 14, days: [0, 1, 3, 4, 6], weeks: 14 });
  const lr = longRuns(plans);
  assert.ok(lr.length >= 12, `${lr.length} long runs`);
  assert.ok(Math.max(...lr) <= 21 + 1e-9, `longest planned long run ${Math.max(...lr)} km: ${lr.join(', ')}`);
  assert.equal(Math.max(...lr), 21, `it still gets to the ceiling: ${lr.join(', ')}`);
  // The weeks still grow to the goal; only the long run is held (the rest of the week carries the growth).
  assert.ok(Math.max(...plans.map(p => p.targetKm ?? 0)) >= 55);
});

test('no race, 80 km/week goal: the long run never passes 21 km', () => {
  const { plans } = simulate({ goalKm: 80, baseKm: 60, baseLong: 20, days: [0, 1, 2, 3, 4, 6], weeks: 12 });
  const lr = longRuns(plans);
  assert.ok(Math.max(...lr) <= 21 + 1e-9, `longest planned long run ${Math.max(...lr)} km: ${lr.join(', ')}`);
  assert.ok(Math.max(...plans.map(p => p.targetKm ?? 0)) >= 70);
});

test('no race, imperial: the ceiling is 13 mi, shown to the half mile', () => {
  const { plans } = simulate({ goalKm: 40 * KM_PER_MILE, baseKm: 30 * KM_PER_MILE, baseLong: 9 * KM_PER_MILE, days: [0, 1, 3, 4, 6], weeks: 14, units: MI });
  const lr = longRuns(plans);
  const mi = lr.map(k => Math.round(k * MI * 100) / 100);
  assert.ok(Math.max(...mi) <= 13 + 1e-9, `longest planned long run ${Math.max(...mi)} mi: ${mi.join(', ')}`);
  assert.equal(Math.max(...mi), 13, `it still gets to 13 mi: ${mi.join(', ')}`);
});

test('no race, a runner whose recent long run is already above the ceiling is HELD there: never cut, never stepped up', () => {
  // Five weeks of 46 km with a 24 km Sunday, read at four consecutive Mondays (a cutback week is skipped: it is eased by its own rule).
  let checked = 0;
  for (let shift = 0; shift < 4; shift++) {
    const runs: PlanRun[] = [];
    for (let w = 0; w < 5; w++) {
      const mon = addDayKey('2026-03-02', (w + shift) * 7);
      for (const [d, km] of [[0, 6], [2, 8], [4, 8], [6, 24]] as Array<[number, number]>) runs.push({ day: addDayKey(mon, d), km });
    }
    const weekStart = addDayKey('2026-03-02', (5 + shift) * 7);
    const plan = enduranceWeekPlan({ runs, weekStart, goalKm: 60, race: null, today: weekStart, unitsPerKm: 1, goalStartDay: '2026-03-02' });
    if (plan.cutback != null || (plan.kind !== 'build' && plan.kind !== 'maintain')) continue;
    checked++;
    assert.equal(plan.longRunKm, 24, `${weekStart}: held at the 24 km they already run`);
  }
  assert.ok(checked >= 2, `${checked} plain weeks checked`);
});

test('a race with a peak target is untouched by the no-race ceiling (a marathon runner still builds past 21 km)', () => {
  const { plans } = simulate({ goalKm: 70, baseKm: 50, baseLong: 20, days: [0, 1, 3, 4, 6], weeks: 17, race: { date: '2026-06-21', distanceKm: 42.2 } });
  assert.ok(Math.max(...longRuns(plans)) > 21, longRuns(plans).join(', '));
});

// ── 2. The taper long run: at most its week's share; the late marathon taper's is 45% of the peak ──────────────────

test('TAPER_LATE_LONG_RUN_SHARE is 0.45 and the share cap is the existing half-week one', () => {
  assert.equal(TAPER_LATE_LONG_RUN_SHARE, 0.45);
  assert.equal(LONG_RUN_MAX_WEEK_SHARE, 0.5);
});

const RACE_DAY = '2026-06-21'; // a Sunday

/** Twelve weeks of `weekKm` with a `longKm` Sunday, then the plan for the Monday `mondayOffset` days before race day. */
function taperPlan(raceKm: number, weekKm: number, longKm: number, daysOut: number): EnduranceWeekPlan {
  const runs: PlanRun[] = [];
  const monday = addDayKey(RACE_DAY, -daysOut);
  for (let k = 1; k <= 12; k++) {
    const mon = addDayKey(monday, -7 * k);
    const rest = (weekKm - longKm) / 3;
    for (const [d, km] of [[0, rest], [2, rest], [4, rest], [6, longKm]] as Array<[number, number]>) runs.push({ day: addDayKey(mon, d), km });
  }
  return enduranceWeekPlan({
    runs,
    weekStart: monday,
    goalKm: weekKm,
    race: { date: RACE_DAY, distanceKm: raceKm },
    today: monday,
    racePeakWeekKm: peakWeekKmBeforeTaper(runs, RACE_DAY, raceKm),
    unitsPerKm: 1,
    goalStartDay: '2026-01-05',
  });
}

test('late marathon taper (13 days out): the long run is 0.45 x the peak long run, not 0.65', () => {
  const plan = taperPlan(42.2, 70, 32, 13);
  assert.equal(plan.kind, 'taper');
  assert.equal(plan.targetKm, 42);
  // 0.45 x 32 = 14.4 -> 14.5 (nearest half km); the week share (21) is no limit. It was 21 km, 50% of the week.
  assert.equal(plan.longRunKm, roundLongRunKm(32 * TAPER_LATE_LONG_RUN_SHARE));
  assert.equal(plan.longRunKm, 14.5);
});

test('early marathon taper (20 days out) keeps 0.65 x the peak long run', () => {
  const plan = taperPlan(42.2, 70, 32, 20);
  assert.equal(plan.kind, 'taper');
  assert.equal(plan.longRunKm, roundLongRunKm(32 * 0.65));
});

test('half marathon taper is unchanged: 0.65 x the peak long run, whichever week of the taper', () => {
  for (const daysOut of [13, 10]) {
    const plan = taperPlan(21.1, 30, 15, daysOut);
    assert.equal(plan.kind, 'taper', `${daysOut} days out`);
    assert.equal(plan.longRunKm, roundLongRunKm(15 * 0.65), `${daysOut} days out`);
  }
});

test('the taper long run never passes its week\'s share, rounded DOWN to the half km (a 24 km peak run in a 30 km peak week)', () => {
  // Late marathon taper: week 18 km -> at most 9 km (it was 0.65 x 24 = 15.5 km, 86% of the week).
  const late = taperPlan(42.2, 30, 24, 13);
  assert.equal(late.targetKm, 18);
  assert.equal(late.longRunKm, floorLongRunKm(weekShareKm(18, LONG_RUN_MAX_WEEK_SHARE)));
  assert.equal(late.longRunKm, 9);
  // Early marathon taper: week 23 km (22.5 rounds up) -> at most 11.5 km.
  const early = taperPlan(42.2, 30, 24, 20);
  assert.equal(early.targetKm, 23);
  assert.equal(early.longRunKm, 11.5);
  // Half taper: 23 km -> 11.5 km.
  const half = taperPlan(21.1, 30, 24, 13);
  assert.equal(half.targetKm, 23);
  assert.equal(half.longRunKm, 11.5);
  for (const p of [late, early, half]) assert.ok((p.longRunKm as number) <= (p.targetKm as number) * LONG_RUN_MAX_WEEK_SHARE + 1e-9);
});

test('marathon, 50 km goal, obedient: every taper long run is at most half of its week (it was 16.5 km in a 30 km week)', () => {
  const { plans } = simulate({ goalKm: 50, baseKm: 30, baseLong: 12, days: [1, 3, 5, 6], weeks: 17, race: { date: RACE_DAY, distanceKm: 42.2 } });
  const taper = plans.filter(p => p.kind === 'taper');
  assert.ok(taper.length >= 2, `${taper.length} taper weeks`);
  for (const p of taper) {
    assert.ok(p.longRunKm != null && p.targetKm != null);
    assert.ok((p.longRunKm as number) <= (p.targetKm as number) * LONG_RUN_MAX_WEEK_SHARE + 1e-9, `${p.weekStart}: long run ${p.longRunKm} of ${p.targetKm}`);
  }
});

test('the pre-taper card and the coach quote the taper long run the taper week itself will plan (one function, three places)', () => {
  // 27 days out is the last build week: its preTaper line quotes the long run of the early taper that follows it.
  const buildWeek = taperPlan(42.2, 70, 32, 27);
  assert.equal(buildWeek.preTaper?.nextPhase, 'taper');
  const early = taperPlan(42.2, 70, 32, 20);
  assert.equal(buildWeek.preTaper?.taperLongRunKm, early.longRunKm);
});

// ── 3. The surfaces agree for a runner held at the ceiling ──────────────────────────────────────────────────────────

const TODAY = '2026-10-06'; // Tuesday

type Run = { day: string; durationMin: number; distanceKm: number; type: string };
const run = (day: string, km: number): Run => ({ day, durationMin: Math.round(km * 6), distanceKm: km, type: 'Running' });

function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  return JSON.parse(plainSpaces(JSON.stringify(computeGoalProgressRaw(input)))) as GoalProgress;
}

function noRaceInput(runs: Run[]): GoalProgressInput {
  return {
    goal: 'endurance',
    todayKey: TODAY,
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 60 },
    start: { weightKg: null, startedAt: null },
    weightReadings: [],
    intakeDays: [],
    budget: null,
    progression: {},
    trainingDays: runs.map(r => r.day),
    workouts: runs,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
  };
}

test('a no-race runner held at the ceiling: the card and the coach name the same long run and neither promises growth', () => {
  // Five weeks of 46 km with a 24 km Sunday (already above 21 km), today a Tuesday, the week not yet run.
  const runs: Run[] = [];
  const monday = addDayKey(TODAY, -1);
  for (let w = 1; w <= 5; w++) {
    for (const [d, km] of [[0, 6], [2, 8], [4, 8], [6, 24]] as Array<[number, number]>) runs.push(run(addDayKey(monday, -7 * w + d), km));
  }
  const gp = computeGoalProgress(noRaceInput(runs));
  const plan = gp.distance?.plan;
  assert.ok(plan != null, 'a plan');
  assert.equal(plan.longRunKm, 24);
  assert.match(plan.purpose, /long run 24 km/);
  const text = formatGoalProgressLines(gp, 'metric').join('\n');
  const target = text.split('\n').find(l => l.startsWith("- This week's target")) ?? '';
  assert.match(target, /long run 24 km/);
  assert.doesNotMatch(target, /keeps growing|toward its peak|a week toward/);
  assert.match(target, /long run 24 km — already past the ~21 km a long run needs without a race, so hold it here rather than add more/);
  assert.doesNotMatch(target, /stops growing there/);
  // The same long run everywhere it is named: no 26 km (24 + 2) and no 30 km (half of the goal) anywhere on the card or in the coach lines.
  const card = JSON.stringify(gp);
  assert.doesNotMatch(card + text, /\b(26|27|30) km/);
});

test('the long-run share watch note keeps a no-race runner at the ceiling too ("keep long runs ~21 km", not ~30 km on 60 km weeks)', () => {
  const monday = '2026-10-05';
  const runs: Run[] = [];
  for (let w = 1; w <= 4; w++) {
    for (const [d, km] of [[0, 4], [2, 4], [4, 4], [6, 20]] as Array<[number, number]>) runs.push(run(addDayKey(monday, -7 * w + d), km));
  }
  const gp = computeGoalProgress({ ...noRaceInput(runs), todayKey: monday });
  const note = gp.reasons.find(r => r.kind === 'long_run');
  assert.ok(note != null, JSON.stringify(gp.reasons));
  assert.match(note.text, /keep long runs ~21 km on 60 km weeks/);
  assert.doesNotMatch(note.text, /~30 km/);
});

test('coach wording: AT the ceiling "it stops growing there"; ABOVE it "already past the ~21 km … hold it here" (13 mi in imperial)', () => {
  const build = (long: number, others: number[]): Run[] => {
    const runs: Run[] = [];
    const monday = addDayKey(TODAY, -1);
    for (let w = 1; w <= 5; w++) {
      [0, 2, 4].forEach((d, i) => runs.push(run(addDayKey(monday, -7 * w + d), others[i])));
      runs.push(run(addDayKey(monday, -7 * w + 6), long));
    }
    return runs;
  };
  const targetOf = (gp: GoalProgress, units: 'metric' | 'imperial'): string => formatGoalProgressLines(gp, units).join('\n').split('\n').find(l => l.startsWith("- This week's target")) ?? '';
  // Exactly at the ceiling: the plan's 21 km long run is where growth stops.
  const at = targetOf(computeGoalProgress(noRaceInput(build(21, [6, 8, 8]))), 'metric');
  assert.match(at, /long run 21 km — the most a long run needs without a race, so it stops growing there/);
  assert.doesNotMatch(at, /already past/);
  // Above it: held, and the copy does not present 24 km as the cap.
  const above = targetOf(computeGoalProgress(noRaceInput(build(24, [6, 8, 8]))), 'metric');
  assert.match(above, /long run 24 km — already past the ~21 km a long run needs without a race, so hold it here rather than add more/);
  // Imperial: the ceiling is named in the runner's unit (~13 mi), the long run is 15 mi (24.1 km).
  const mi = targetOf(computeGoalProgress(noRaceInput(build(24.1, [6, 8, 8]))), 'imperial');
  assert.match(mi, /already past the ~13 mi a long run needs without a race/);
});

// ── 4. Group B: the long-run step is graded by distance ─────────────────────────────────────────────────────────────

/** The step as the runner reads it: the next long run (rounded to the half unit, as the plan shows it) minus the last, in the display unit. */
const stepOf = (lastKm: number, units = 1, opts?: { regain?: boolean }): number => Math.round((roundLongRunKm(longRunStepKm(lastKm, null, units, opts), units) - lastKm) * units * 100) / 100;

test('longRunStepKm (km): +1 km under 10 km, +1.5 km from 10 to under 16 km, +2 km from 16 km', () => {
  assert.equal(stepOf(6), 1);
  assert.equal(stepOf(9.5), 1);
  assert.equal(stepOf(10), 1.5);
  assert.equal(stepOf(15.5), 1.5);
  assert.equal(stepOf(16), 2);
  assert.equal(stepOf(24), 2);
  // The 6 km -> 8 km jump (+33%) of the flat rule is now 6 -> 7 (+17%).
  assert.equal(longRunStepKm(6, 18), 7);
  assert.equal(longRunStepKm(10, 18), 11.5);
  assert.equal(longRunStepKm(16, 18), 18);
  // Still never past the peak target, held at it.
  assert.equal(longRunStepKm(9.5, 10), 10);
  assert.equal(longRunStepKm(17, 18), 18);
  assert.equal(longRunStepKm(18, 18), 18);
  assert.equal(longRunStepKm(20, 18), 18);
});

test('longRunStepKm (imperial): +0.5 mi under 6 mi, +1 mi from 6 mi - graded on the distance as the runner reads it', () => {
  assert.equal(stepOf(4 * KM_PER_MILE, MI), 0.5);
  assert.equal(stepOf(5.5 * KM_PER_MILE, MI), 0.5);
  assert.equal(stepOf(6 * KM_PER_MILE, MI), 1);
  assert.equal(stepOf(9 * KM_PER_MILE, MI), 1);
  assert.equal(stepOf(14 * KM_PER_MILE, MI), 1);
});

test('longRunStepKm: a regain step (a restart / comeback / rebuild week) keeps the old +2 km (+1 mi), whatever the distance', () => {
  assert.equal(stepOf(6, 1, { regain: true }), 2);
  assert.equal(stepOf(12, 1, { regain: true }), 2);
  assert.equal(stepOf(4 * KM_PER_MILE, MI, { regain: true }), 1);
  assert.equal(longRunStepKm(6, 7, 1, { regain: true }), 7); // still never past the peak target
  assert.equal(longRunStepKm(6, null, 1, { regain: false }), 7);
  assert.equal(longRunStepKm(6, null), 7); // the default is the graded step
});

test('a 4-week build from a 6 km long run: no week grows the long run by more than 1 km while it is under 10 km', () => {
  const { plans } = simulate({ goalKm: 40, baseKm: 20, baseLong: 6, days: [0, 2, 4, 6], weeks: 6, race: null });
  const lr = longRuns(plans);
  let prev = 6;
  for (const km of lr) {
    if (prev < 10) assert.ok(km - prev <= 1 + 1e-9, `${prev} -> ${km} km: ${lr.join(', ')}`);
    prev = km;
  }
  // It still climbs: 7, 8, 9, 10 (a cutback week holds it).
  assert.deepEqual(lr.slice(0, 4), [7, 8, 9, 10]);
});

test('a comeback regains a distance the runner ran before the break at the old +2 km a week; once it is back the step is graded', () => {
  // Six 30 km weeks with a 14 km Sunday, an empty week, then the plan week by week (the runner obeys it).
  const runs: PlanRun[] = [];
  const add = (w: number, total: number, long: number): void => {
    const mon = addDayKey(D0, w * 7);
    const rest = (total - long) / 3;
    [0, 2, 4, 6].forEach((d, i) => runs.push({ day: addDayKey(mon, d), km: Math.round((i === 3 ? long : rest) * 10) / 10 }));
  };
  for (let w = 0; w < 6; w++) add(w, 30, 14);
  const rows: Array<{ kind: string; comeback: boolean; last: number | null; long: number | null }> = [];
  for (let w = 7; w < 13; w++) {
    const plan = enduranceWeekPlan({ runs, weekStart: addDayKey(D0, w * 7), goalKm: 40, race: null, today: addDayKey(D0, w * 7), unitsPerKm: 1, goalStartDay: D0 });
    rows.push({ kind: plan.kind, comeback: plan.comeback != null, last: plan.longRun.lastKm, long: plan.longRunKm });
    const t = plan.targetKm ?? 20;
    add(w, t, Math.min(plan.longRunKm ?? t / 4, t));
  }
  assert.equal(rows[0].kind, 'restart');
  // The comeback weeks (long run still under the 14 km from before the break): +2 km on the last one (rounded to the half km).
  const comeback = rows.filter(r => r.comeback);
  assert.ok(comeback.length >= 3, JSON.stringify(rows));
  for (const r of comeback) assert.equal(r.long, roundLongRunKm((r.last as number) + 2), `comeback: ${JSON.stringify(r)}`);
  // After the comeback, with the long run back above the pre-break 14 km, the step is the graded one (+1.5 km from 14.5 km).
  const after = rows.find(r => !r.comeback && r.kind === 'build' && (r.last as number) >= 14);
  assert.ok(after != null, JSON.stringify(rows));
  assert.equal(after.long, roundLongRunKm((after.last as number) + 1.5));
});

test('longRunPeakReachedOn follows the graded step: a late 6 km runner needs 4 more Sundays to reach 10 km, not 2', () => {
  const plan = { weekStart: '2026-03-02', longRunKm: 6, longRunAhead: false, buildWeeks: 0, cutbackOwed: false, kind: 'build' as const, unitsPerKm: 1 };
  // 6 -> 7 -> 8 -> 9 -> 10: the 4th Sunday after this one (no cutback is in the way between 2026-03-09 and 2026-03-29 for a runner on 0 build weeks).
  const on = longRunPeakReachedOn(plan, 6, 10, '2026-12-31', null);
  assert.ok(on != null && on >= '2026-03-29', `${on}`);
  // The same plan in miles: 4 mi -> 6 mi at +0.5 mi a week takes 4 Sundays too (it took 2 at the flat +2 km ~ +1.2 mi... 2 at +1 mi).
  const mi = longRunPeakReachedOn({ ...plan, unitsPerKm: MI }, 4 * KM_PER_MILE, 6 * KM_PER_MILE, '2026-12-31', null);
  assert.ok(mi != null && mi >= '2026-03-29', `${mi}`);
});

test('imperial: a 4-week build from a 4 mi long run grows it by at most 0.5 mi a week while it is under 6 mi', () => {
  const { plans } = simulate({ goalKm: 25 * KM_PER_MILE, baseKm: 12 * KM_PER_MILE, baseLong: 4 * KM_PER_MILE, days: [0, 2, 4, 6], weeks: 6, units: MI });
  const mi = longRuns(plans).map(k => Math.round(k * MI * 100) / 100);
  let prev = 4;
  for (const m of mi) {
    if (prev < 6) assert.ok(m - prev <= 0.5 + 0.06, `${prev} -> ${m} mi: ${mi.join(', ')}`);
    prev = m;
  }
  assert.ok(mi[0] === 4.5 && mi[1] === 5, mi.join(', '));
});

test('the card, the coach, the opener and the review all name the long run the plan has (one step, derived from the last long run)', () => {
  // Five 4-run weeks (15..23 km) with a 40% Sunday; today is the Monday of the sixth week, nothing run yet: the card's plan line, the coach's target line and the
  // structured long run all say the graded step from the last long run (9.2 km from 23 km x 0.4 -> +1).
  const monday = '2026-10-05';
  const runs: Run[] = [];
  [15, 17, 19, 21, 23].forEach((km, i) => {
    const mon = addDayKey(monday, -7 * (5 - i));
    [[1, km * 0.2], [3, km * 0.2], [5, km * 0.2], [6, km * 0.4]].forEach(([d, k]) => runs.push(run(addDayKey(mon, d), Math.round(k * 10) / 10)));
  });
  const gp = computeGoalProgress({ ...noRaceInput(runs), todayKey: monday, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 40 } });
  const plan = gp.distance?.plan;
  assert.ok(plan != null && plan.longRunKm != null);
  const last = gp.longRun?.lastKm as number;
  const expected = roundLongRunKm(longRunStepKm(last, null));
  assert.equal(plan.longRunKm, expected);
  assert.equal(gp.longRun?.nextKm, expected);
  assert.match(plan.purpose, new RegExp(`long run ${expected} km`));
  const text = formatGoalProgressLines(gp, 'metric').join('\n');
  assert.match(text, new RegExp(`next long run ~${expected} km`));
  assert.match(text, new RegExp(`long run ${expected} km`));
  assert.equal(expected - last <= 1.5 + 1e-9, true, `${last} -> ${expected}`);
});

test('Sunday morning, before the run: an easy run within 10% of the long run is not the long run run while the week still has room for it', () => {
  // Four 6 km weeks (Tue / Thu / Sat / Sun), then a week of 6.3 / 6.4 / 6.3 by Saturday against a ~26 km step with a 7 km long run planned: 19 + 7 = 26, so the long run is still ahead.
  const runs: PlanRun[] = [];
  for (let w = 0; w < 2; w++) {
    const mon = addDayKey(D0, w * 7);
    [1, 3, 5, 6].forEach(d => runs.push({ day: addDayKey(mon, d), km: 6 }));
  }
  const monday = addDayKey(D0, 14);
  [[1, 6.3], [3, 6.4], [5, 6.3]].forEach(([d, km]) => runs.push({ day: addDayKey(monday, d), km }));
  const sunday = addDayKey(monday, 6);
  const plan = enduranceWeekPlan({ runs, weekStart: monday, goalKm: 40, race: null, today: sunday, unitsPerKm: 1, goalStartDay: D0 });
  assert.equal(plan.longRunAhead, true, `${plan.purpose}`);
  // The long run really run on Saturday (the week at its number) is still done.
  const done = enduranceWeekPlan({ runs: [...runs.filter(r => r.day < addDayKey(monday, 5)), { day: addDayKey(monday, 1), km: 6 }, { day: addDayKey(monday, 3), km: 6 }, { day: addDayKey(monday, 5), km: 12 }], weekStart: monday, goalKm: 40, race: null, today: sunday, unitsPerKm: 1, goalStartDay: D0 });
  assert.equal(done.longRunAhead, false, `${done.purpose}`);
});

// ── Group D: the cutback is a real down week ────────────────────────────────────────────────────────────────────────
// 0.75 x min(last week's target, last week's actual), rounded like every weekly target; the long run is 0.75 x the one held; a spike in a cutback week is read against
// the week the cutback replaced; an obedient runner is never called "Light week" on a cutback. Every test here was written BEFORE the rule it locks in.

/**
 * Calendar weeks 0.. of `kms` (4 runs a week, Tue / Thu / Sat / Sun, a `longShare` Sunday), then the plan for the week after them: with 5 weeks of history that is the
 * 6th calendar week, the first cutback of a goal that started on D0. `prev` is the plan of the last week of the history (its target is what that week was asked for).
 */
function cutbackSetup(
  kms: number[],
  opts: { units?: number; goalKm?: number; longShare?: number; shape?: { days: number[]; weights: number[] }; today?: (monday: string) => string; extra?: (monday: string) => PlanRun[] } = {},
): { plan: EnduranceWeekPlan; monday: string; prev: EnduranceWeekPlan } {
  const runs: PlanRun[] = [];
  kms.forEach((km, i) => {
    const mon = addDayKey(D0, i * 7);
    if (opts.shape) {
      // (A weekday shape of the runner's own: the km split by weights over the run days.)
      const sum = opts.shape.weights.reduce((a, b) => a + b, 0);
      opts.shape.days.forEach((d, j) => runs.push({ day: addDayKey(mon, d), km: Math.round(((km * opts.shape!.weights[j]) / sum) * 10) / 10 }));
      return;
    }
    const long = Math.round(km * (opts.longShare ?? 0.4) * 10) / 10;
    const rest = Math.round(((km - long) / 3) * 10) / 10;
    [1, 3, 5].forEach(d => runs.push({ day: addDayKey(mon, d), km: rest }));
    runs.push({ day: addDayKey(mon, 6), km: long });
  });
  const monday = addDayKey(D0, kms.length * 7);
  runs.push(...(opts.extra?.(monday) ?? []));
  const common = { runs, goalKm: opts.goalKm ?? 30, race: null, unitsPerKm: opts.units ?? 1, goalStartDay: D0 };
  const prev = enduranceWeekPlan({ ...common, weekStart: addDayKey(monday, -7), today: addDayKey(monday, -7) });
  const plan = enduranceWeekPlan({ ...common, weekStart: monday, today: opts.today?.(monday) ?? monday });
  return { plan, monday, prev };
}

const round1Test = (n: number): number => Math.round(n * 10) / 10;

test('CUTBACK_FRACTION is 0.75', () => {
  assert.equal(CUTBACK_FRACTION, 0.75);
});

test('the cutback after a 20 km week (asked 20, ran 20) is 15 km', () => {
  const { plan, prev } = cutbackSetup([15, 16, 17, 18, 20]);
  assert.equal(prev.targetKm, 20, 'last week asked for 20');
  assert.ok(plan.cutback != null, `a cutback week: ${plan.kind} ${plan.purpose}`);
  assert.equal(plan.targetKm, 15);
  assert.equal(plan.targetKm, roundWeekTargetKm(CUTBACK_FRACTION * 20));
});

test('the cutback is 0.75 x the SMALLER of last week\'s target and actual: asked 24, ran 23 -> 17 km', () => {
  const { plan, prev } = cutbackSetup([15, 17, 19, 22, 23]);
  assert.equal(prev.targetKm, 24, 'last week asked for 24');
  assert.ok(plan.cutback != null, plan.purpose);
  assert.equal(plan.cutback.normalKm, 25, 'the week it replaces is the 10% step on the 23 km actually run');
  assert.equal(plan.targetKm, roundWeekTargetKm(CUTBACK_FRACTION * 23));
  assert.equal(plan.targetKm, 17);
});

test('a cutback never rewards an overshoot (asked 22, ran 25 -> 0.75 x 22) and never asks for more than was run after a short week (asked 24, ran 18 -> 0.75 x 18)', () => {
  const over = cutbackSetup([15, 17, 19, 20, 25]);
  assert.equal(over.prev.targetKm, 22);
  assert.ok(over.plan.cutback != null, over.plan.purpose);
  assert.equal(over.plan.targetKm, roundWeekTargetKm(CUTBACK_FRACTION * 22));
  const short = cutbackSetup([15, 17, 19, 22, 18]);
  assert.equal(short.prev.targetKm, 24);
  assert.ok(short.plan.cutback != null, short.plan.purpose);
  assert.equal(short.plan.targetKm, roundWeekTargetKm(CUTBACK_FRACTION * 18));
  assert.ok((short.plan.targetKm as number) < 18, 'a cutback right after a short week is below that week, never above it');
});

test('imperial: the cutback after a 15 mi week is 11.5 mi (rounded to the half mile like every weekly target)', () => {
  const kms = [8, 10, 11, 13.5, 15].map(mi => mi / MI);
  const { plan, prev } = cutbackSetup(kms, { units: MI, goalKm: 40 });
  assert.ok(plan.cutback != null, `a cutback week: ${plan.kind} ${plan.purpose}`);
  assert.ok(Math.abs((prev.targetKm as number) * MI - 15) < 0.06, `asked ${(prev.targetKm as number) * MI} mi`);
  const b = Math.min(prev.targetKm as number, kms[4]);
  assert.equal(plan.targetKm, roundWeekTargetKm(weekShareKm(b, CUTBACK_FRACTION, MI) + 1e-6, MI));
  assert.ok(Math.abs((plan.targetKm as number) * MI - 11.5) < 0.06, `${(plan.targetKm as number) * MI} mi`);
});

test('low volume: an 8 km week gives a 6 km cutback, and a base under the compare minimum (5 km) gives no cutback at all', () => {
  const low = cutbackSetup([5, 5.5, 6, 7, 8], { goalKm: 20 });
  assert.equal(low.prev.targetKm, 8);
  assert.ok(low.plan.cutback != null, low.plan.purpose);
  assert.equal(low.plan.targetKm, 6);
  const tiny = cutbackSetup([2, 2.5, 3, 3.5, 4], { goalKm: 20 });
  assert.equal(tiny.plan.cutback, null, `under 5 km there is nothing to cut back from: ${tiny.plan.purpose}`);
});

test('the cutback long run is 0.75 x the held long run, within the half-week cap, rounded to the half km', () => {
  const { plan } = cutbackSetup([15, 17, 19, 21, 23]);
  assert.ok(plan.cutback != null && plan.longRunKm != null);
  const lr = plan.longRun;
  const held = roundLongRunKm(lr.targetPeakKm != null ? Math.min(lr.lastKm as number, lr.targetPeakKm) : (lr.lastKm as number));
  const cap = weekShareKm(plan.targetKm as number, LONG_RUN_MAX_WEEK_SHARE);
  assert.equal(plan.longRunKm, floorLongRunKm(Math.min(roundLongRunKm(CUTBACK_FRACTION * held), cap)));
  assert.ok((plan.longRunKm as number) < held, `eased: ${plan.longRunKm} < held ${held}`);
  assert.ok((plan.longRunKm as number) <= (plan.targetKm as number) * LONG_RUN_MAX_WEEK_SHARE + 1e-9);
});

test('the obedient runner: week 6 is 17 km with a 7.5 km long run (was 20 / 10), and every cutback long run is 0.75 x the held one', () => {
  const { plans } = simulate({ goalKm: 30, baseKm: 15, baseLong: 6, days: [1, 3, 5, 6], weeks: 14 });
  const cuts = plans.filter(p => p.cutback != null);
  assert.ok(cuts.length >= 2, cuts.length + ' cutback weeks');
  assert.equal(cuts[0].targetKm, 17);
  assert.equal(cuts[0].longRunKm, 7.5);
  for (const c of cuts) {
    const held = roundLongRunKm(c.longRun.targetPeakKm != null ? Math.min(c.longRun.lastKm as number, c.longRun.targetPeakKm) : (c.longRun.lastKm as number));
    assert.equal(c.longRunKm, floorLongRunKm(Math.min(roundLongRunKm(CUTBACK_FRACTION * held), weekShareKm(c.targetKm as number, LONG_RUN_MAX_WEEK_SHARE))));
    assert.ok((c.longRunKm as number) < held, `eased: ${c.longRunKm} < ${held}`);
  }
});

test('a cutback long run does not fall under 5 km when the held one was 6 km or more (unless the half-week cap says so)', () => {
  const { plan } = cutbackSetup([10, 11, 12, 13, 15], { goalKm: 30 });
  assert.ok(plan.cutback != null, plan.purpose);
  const held = roundLongRunKm(Math.min(plan.longRun.lastKm as number, plan.longRun.targetPeakKm ?? Infinity));
  assert.ok(held >= 6 && held < 6.7, `a ${held} km held long run`);
  assert.equal(plan.longRunKm, Math.min(5, weekShareKm(plan.targetKm as number, LONG_RUN_MAX_WEEK_SHARE)));
});

test('the plan line, the coach and the structured plan all say the cutback week is eased, from the same long run', () => {
  const monday = '2026-10-19';
  const runs: Run[] = [];
  // Five weeks of build; the calendar week of 2026-10-19 is the 4th of its cycle, three plain build weeks before it.
  [15, 17, 19, 21, 23].forEach((km, i) => {
    const mon = addDayKey(monday, -7 * (5 - i));
    [[1, km * 0.2], [3, km * 0.2], [5, km * 0.2], [6, km * 0.4]].forEach(([d, k]) => runs.push(run(addDayKey(mon, d), Math.round(k * 10) / 10)));
  });
  const gp = computeGoalProgress({ ...noRaceInput(runs), todayKey: monday, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 } });
  const plan = gp.distance?.plan;
  assert.ok(plan?.cutback === true, `a cutback week: ${plan?.purpose}`);
  assert.match(plan.purpose, /^Cutback week: ~\d+ km, long run [\d.]+ km \(eased for the cutback\) — absorb the last three weeks/);
  const text = formatGoalProgressLines(gp, 'metric').join('\n');
  const target = text.split('\n').find(l => l.startsWith("- This week's target")) ?? '';
  assert.match(target, /a cutback week, ~[\d.]+ km; long run eased to [\d.]+ km \(eased for the cutback\)/);
  assert.doesNotMatch(target, /half the week/);
  assert.ok(plan.cutbackNormalKm != null && plan.cutbackNormalKm > (plan.targetKm as number), `cutbackNormalKm ${plan.cutbackNormalKm} (additive field)`);
});

test('a cutback week run as the normal week it replaced is graded against that week, not the lowered target (no spike up to 30% over it)', () => {
  const { plan } = cutbackSetup([15, 17, 19, 21, 23]);
  assert.ok(plan.cutback != null);
  const normal = plan.cutback.normalKm;
  const cut = plan.targetKm as number;
  assert.ok(normal > cut * 1.3, 'the replaced week is more than 30% above the cut, so the old edge called it a spike');
  assert.equal(plan.band.overKm, round1Test(Math.max(normal * 1.3, normal + 3)));
  // The week it replaced, run in full: a normal week (the skipped cutback), never a spike.
  assert.deepEqual(gradeEnduranceWeek(plan, normal), { level: 'good', gap: 'over' });
  // Up to the spike edge over the normal week: still a skipped cutback. Past it: a spike.
  const edge = plan.band.overKm as number;
  assert.deepEqual(gradeEnduranceWeek(plan, edge - 0.1), { level: 'good', gap: 'over' });
  assert.equal(gradeEnduranceWeek(plan, edge + 0.5).gap, 'spike');
  // The cut itself and a bit over it (10%) stay a good, planned cutback.
  assert.deepEqual(gradeEnduranceWeek(plan, cut), { level: 'good', gap: null });
  assert.deepEqual(gradeEnduranceWeek(plan, cut * 1.1), { level: 'good', gap: null });
});

test('an obedient runner is never called "Light week" in a cutback week, on any day, before or after that day\'s run (a front-loaded runner too)', () => {
  const kms = [15, 17, 19, 21, 23];
  const shapes: Array<{ name: string; shape?: { days: number[]; weights: number[] } }> = [
    { name: 'Tue / Thu / Sat / long Sun' },
    // Mon / Wed heavy, Fri / Sun light: the runner's usual rest-of-week after Wednesday is small, so a cutback at 75% reads "behind" unless it is scaled to the lowered week.
    { name: 'front-loaded Mon / Wed / Fri / Sun 2:2:1:1', shape: { days: [0, 2, 4, 6], weights: [2, 2, 1, 1] } },
  ];
  for (const { name, shape } of shapes) {
    const base = cutbackSetup(kms, { shape });
    assert.ok(base.plan.cutback != null, `${name}: ${base.plan.purpose}`);
    const cut = base.plan.targetKm as number;
    const long = base.plan.longRunKm as number;
    const days = shape?.days ?? [1, 3, 5, 6];
    const others = (cut - long) / (days.length - 1);
    const weekRuns: Array<[number, number]> = days.map((d, j) => [d, j === days.length - 1 ? long : others]);
    for (let dow = 0; dow <= 6; dow++) {
      for (const through of [dow - 1, dow]) {
        const extra = (mon: string): PlanRun[] => weekRuns.filter(([d]) => d <= through).map(([d, km]) => ({ day: addDayKey(mon, d), km: Math.round(km * 10) / 10 }));
        const { plan } = cutbackSetup(kms, { shape, today: mon => addDayKey(mon, dow), extra });
        assert.equal(plan.lightWeek, null, `${name}, day ${dow}, runs through ${through}: ${plan.purpose}`);
      }
    }
  }
});

test('a deeper cutback does not break the re-read of a past week: the obedient runner\'s 15 km peak is never "longer than the 10 km plan" (the chain cut-off keeps the cutback cycle)', async () => {
  const { buildScenario } = await import('./timeline/scenarios');
  const scn = buildScenario('runner_on_plan_obedient');
  const runs: PlanRun[] = scn.workouts.filter(w => w.type === 'Running' && w.distanceM).map(w => ({ day: w.day, km: (w.distanceM as number) / 1000 }));
  const race = { date: scn.user.raceDate as string, distanceKm: scn.user.raceDistanceKm as number };
  const monday = '2026-05-18'; // the Monday after the 15 km peak week; its chain reaches back no further than 2026-03-23 (the week-6 cutback is 3 weeks after that)
  const plan = enduranceWeekPlan({ runs: runs.filter(r => r.day <= monday), weekStart: monday, goalKm: 30, race, today: monday, racePeakWeekKm: 30, goalStartDay: scn.user.goalStartedDay });
  assert.equal(plan.longRun.peakPlan?.plannedKm, 15);
  assert.equal(plan.longRun.peakPlan?.within, true);
  assert.equal(plan.longRun.peakPlan?.brokenKm, null);
});

test('the peak date read in a cutback week steps from the long run before the cutback (the cutback week\'s eased long run is not the base)', () => {
  const { plan } = cutbackSetup([15, 17, 19, 21, 23], { goalKm: 30 });
  assert.ok(plan.cutback != null && plan.longRunKm != null);
  const lastKm = plan.longRun.lastKm as number;
  const sunday = addDayKey(plan.weekStart, 6);
  const fromCutback = longRunPeakReachedOn({ ...plan, longRunAhead: true }, lastKm, 15, addDayKey(sunday, 7 * 14), null);
  const fromNextWeek = longRunPeakReachedOn({ ...plan, cutback: null, longRunKm: lastKm, longRunAhead: false, buildWeeks: 0 }, lastKm, 15, addDayKey(sunday, 7 * 14), null);
  assert.ok(fromCutback != null && fromNextWeek != null);
  assert.equal(fromCutback, fromNextWeek, 'the climb carries on from the pre-cutback long run, one cutback week later');
});

// ── Group E: race week gets a shape, and 5K / 10K runners get strides ───────────────────────────────────────────────────

const RACE_MONDAY = addDayKey(RACE_DAY, -6); // 2026-06-15

interface RaceWeekSetup {
  raceKm: number;
  weekKm: number;
  /** Weekdays run in the build weeks (Mon = 0); the LAST one is the long-run day (40% of the week). */
  days: number[];
  units?: number;
  /** The wind-down weeks before race week (half 1, marathon 2) ran this much in total instead of `weekKm` (a light taper). */
  taperKm?: number;
  raceDate?: string;
}

/** Twelve training weeks before the race, the plan reader for any Monday / day. */
function raceWeekReader(o: RaceWeekSetup) {
  const raceDate = o.raceDate ?? RACE_DAY;
  const raceMonday = addDayKey(raceDate, -((new Date(`${raceDate}T00:00:00Z`).getUTCDay() + 6) % 7));
  const windWeeks = o.raceKm <= 10 ? 0 : o.raceKm < 30 ? 1 : 2;
  const runs: PlanRun[] = [];
  for (let k = 1; k <= 12; k++) {
    const mon = addDayKey(raceMonday, -7 * k);
    const km = k <= windWeeks && o.taperKm != null ? o.taperKm : o.weekKm;
    const long = km * 0.4;
    const rest = (km - long) / Math.max(1, o.days.length - 1);
    o.days.forEach((dow, i) => runs.push({ day: addDayKey(mon, dow), km: Math.round((i === o.days.length - 1 ? long : rest) * 10) / 10 }));
  }
  const race = { date: raceDate, distanceKm: o.raceKm };
  const racePeakWeekKm = peakWeekKmBeforeTaper(runs, raceDate, o.raceKm);
  const planAt = (weekStart: string, today = weekStart, extra: PlanRun[] = []): EnduranceWeekPlan => enduranceWeekPlan({
    runs: [...runs, ...extra].filter(r => r.day <= today),
    weekStart,
    goalKm: o.weekKm,
    race,
    today,
    racePeakWeekKm,
    unitsPerKm: o.units ?? 1,
    goalStartDay: '2026-01-05',
  });
  return { runs, raceMonday, planAt, race };
}

/** The race-week Monday line as the spec words it, built from the figures (numbers shown the way the card shows them). */
const raceWeekLine = (b: string, k: string, cap: string, unit: string): string =>
  `Race week: ~${b} ${unit} before the race — ${k} short easy runs, each ≤ ~${cap} ${unit}; 4–6 strides after the first; rest or a 15-min shakeout the day before`;

test('half marathon race-week Monday: 2 short easy runs (Tue, Thu - the Saturday is the race-eve shakeout, not a run), each at most ~6 km of the ~15 km, strides after the first', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6] });
  const plan = planAt(raceMonday);
  assert.equal(plan.kind, 'race_week');
  assert.equal(plan.targetKm, 15);
  // Shown: Tue and Thu. The cap still divides the week by 3 (the race-eve Saturday is a slot too): max(15 / 3, 0.4 x 15) = 6.
  assert.deepEqual(plan.raceWeekShape, { runs: 2, capRuns: 3, perRunCapKm: 6 });
  assert.equal(plainSpaces(plan.purpose), raceWeekLine('15', '2', '6', 'km'));
  assert.doesNotMatch(plan.purpose, /3 short easy runs/);
});

test('the race-eve slot is not a run in the count the card shows: Tue + Sat runner, race on Sunday = 1 short easy run (Saturday is the shakeout), the cap still shares the week over 2', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 38, days: [1, 5] });
  const plan = planAt(raceMonday);
  assert.deepEqual(plan.raceWeekShape, { runs: 1, capRuns: 2, perRunCapKm: 9 });
  assert.match(plainSpaces(plan.purpose), /^Race week: ~19 km before the race — 1 short easy run, ≤ ~9 km; 4–6 strides after it; rest or a 15-min shakeout the day before$/);
});

test('only the race-eve day is a usual run day before the race: one short easy run, the cap is the whole week (no zero-run line)', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 20, days: [5, 6] }); // Sat + Sun: Saturday is the eve
  const plan = planAt(raceMonday);
  assert.deepEqual(plan.raceWeekShape, { runs: 1, perRunCapKm: 10 });
  assert.match(plainSpaces(plan.purpose), /^Race week: ~10 km before the race — 1 short easy run, ≤ ~10 km; 4–6 strides after it; /);
});

test('the cap is the larger of an equal share and 40% of the week, rounded DOWN to a whole km (2 runs of a 19 km week: 9.5 -> 9)', () => {
  // A Tue + Sat runner: the 2 runs of the week (Tuesday and Saturday) share the budget.
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 38, days: [1, 5] });
  const plan = planAt(raceMonday);
  assert.equal(plan.targetKm, 19);
  assert.deepEqual(plan.raceWeekShape, { runs: 1, capRuns: 2, perRunCapKm: 9 });
  assert.match(plainSpaces(plan.purpose), /^Race week: ~19 km before the race — 1 short easy run, ≤ ~9 km; /);
});

test('a 2-day runner gets 2 runs; a runner whose only run day before the race is the long-run day gets 1 (the cap is then the whole week)', () => {
  const two = raceWeekReader({ raceKm: 21.1, weekKm: 20, days: [2, 6] }); // Wed + Sun: the Sunday is race day itself, so only the Wednesday is left
  const planTwo = two.planAt(two.raceMonday);
  assert.equal(planTwo.raceWeekShape?.runs, 1);
  assert.equal(planTwo.raceWeekShape?.perRunCapKm, planTwo.targetKm);
  assert.match(plainSpaces(planTwo.purpose), /^Race week: ~10 km before the race — 1 short easy run, ≤ ~10 km; 4–6 strides after it; rest or a 15-min shakeout the day before$/);
  const tueSat = raceWeekReader({ raceKm: 21.1, weekKm: 20, days: [1, 5] });
  assert.equal(tueSat.planAt(tueSat.raceMonday).raceWeekShape?.capRuns, 2); // (Tue + the race-eve Saturday share the cap; the card shows the one run)
});

test('a runner with 6 usual run days is told 3 runs at most (clamped), cap = 40% of the week', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 42.2, weekKm: 70, days: [0, 1, 2, 3, 4, 6] });
  const plan = planAt(raceMonday);
  assert.equal(plan.kind, 'race_week');
  assert.equal(plan.targetKm, 28); // marathon x0.4 of the 70 km peak
  assert.deepEqual(plan.raceWeekShape, { runs: 3, perRunCapKm: 11 }); // max(28 / 3, 0.4 x 28 = 11.2) -> 11
});

test('a runner with no weeks to read a rhythm from is told "2–3 short easy runs", the cap that fits either', () => {
  const race = { date: RACE_DAY, distanceKm: 21.1 };
  const runs: PlanRun[] = [{ day: '2026-06-09', km: 10 }, { day: '2026-06-11', km: 12 }];
  const plan = enduranceWeekPlan({ runs, weekStart: RACE_MONDAY, goalKm: 30, today: RACE_MONDAY, race, racePeakWeekKm: 30, goalStartDay: '2026-06-01' });
  assert.equal(plan.kind, 'race_week');
  assert.equal(plan.targetKm, 15);
  assert.deepEqual(plan.raceWeekShape, { runs: 3, runsFrom: 2, perRunCapKm: 7 }); // max(15 / 2, 0.4 x 15) = 7.5 -> 7
  assert.match(plainSpaces(plan.purpose), /^Race week: ~15 km before the race — 2–3 short easy runs, each ≤ ~7 km; 4–6 strides after the first; /);
});

test('a race week after a light taper: the shape reads the runner\'s training weeks, not the taper that was skipped', () => {
  const heavy = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6] });
  const light = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6], taperKm: 6 });
  const a = heavy.planAt(heavy.raceMonday);
  const b = light.planAt(light.raceMonday);
  assert.equal(b.kind, 'race_week');
  assert.deepEqual(b.raceWeekShape, a.raceWeekShape);
  assert.equal(b.targetKm, a.targetKm); // the ceiling is a share of the peak week, whatever the taper ran
});

test('a very small race week (under 3 km / 2 mi) has no shape to give: the old line stands', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 5, weekKm: 4, days: [1, 3, 5] });
  const plan = planAt(raceMonday);
  assert.equal(plan.kind, 'race_week');
  assert.ok((plan.targetKm as number) < 3, `${plan.targetKm}`);
  assert.equal(plan.raceWeekShape, undefined);
  assert.equal(plan.purpose, 'Race week: short easy runs, rest 1–2 days before the race');
});

test('imperial: the target and the cap are in miles, the cap is a multiple of 0.5 mi and rounds DOWN', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 40, days: [1, 3, 5, 6], units: MI });
  const plan = planAt(raceMonday);
  assert.equal(plan.kind, 'race_week');
  const target = Math.round((plan.targetKm as number) * MI * 10) / 10;
  assert.equal(target, 12.5); // half x0.5 of the 25 mi peak week
  const capMi = Math.round((plan.raceWeekShape?.perRunCapKm as number) * MI * 100) / 100;
  assert.equal(capMi, 5); // max(12.5 / 3 = 4.17, 0.4 x 12.5 = 5) -> 5 mi
  assert.equal(plan.raceWeekShape?.runs, 2);
  assert.equal(plan.raceWeekShape?.capRuns, 3);
  assert.equal(plainSpaces(plan.purpose), raceWeekLine('12.5', '2', '5', 'mi'));
});

test('imperial caps round down to the half mile (a 13.5 mi race week, 3 runs: 5.4 -> 5 mi, never 5.5)', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 43.5, days: [1, 3, 5, 6], units: MI });
  const plan = planAt(raceMonday);
  const target = Math.round((plan.targetKm as number) * MI * 10) / 10;
  const capMi = Math.round((plan.raceWeekShape?.perRunCapKm as number) * MI * 100) / 100;
  assert.equal(capMi % 0.5, 0, `${capMi} mi`);
  assert.ok(capMi <= Math.max(target / 3, 0.4 * target) + 1e-9, `${capMi} mi against ${target} mi`);
  assert.ok(capMi > Math.max(target / 3, 0.4 * target) - 0.5 - 1e-9);
});

test('the shape is for the early week only: from Friday (2 days out) or once half the budget is run, the old line (or the mid-week line) takes over', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6] });
  assert.ok(planAt(raceMonday, addDayKey(raceMonday, 2)).raceWeekShape != null, 'Wednesday, 4 days out');
  assert.ok(planAt(raceMonday, addDayKey(raceMonday, 3)).raceWeekShape != null, 'Thursday, 3 days out');
  const friday = planAt(raceMonday, addDayKey(raceMonday, 4));
  assert.equal(friday.raceWeekShape, undefined);
  assert.equal(friday.purpose, 'Race week: short easy runs, rest 1–2 days before the race');
  // 8 of the ~15 km run by Wednesday: more than half the budget.
  const half = planAt(raceMonday, addDayKey(raceMonday, 2), [{ day: addDayKey(raceMonday, 1), km: 8 }]);
  assert.equal(half.raceWeekShape, undefined);
  assert.equal(half.purpose, 'Race week: short easy runs, rest 1–2 days before the race');
  // 6 of 15 is not yet half.
  assert.ok(planAt(raceMonday, addDayKey(raceMonday, 2), [{ day: addDayKey(raceMonday, 1), km: 6 }]).raceWeekShape != null);
});

test('the shape stands all week: Thursday morning, with Tuesday\'s run in, it is the same runs and the same cap as Monday\'s', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6] });
  const monday = planAt(raceMonday);
  const thursday = planAt(raceMonday, addDayKey(raceMonday, 3), [{ day: addDayKey(raceMonday, 1), km: 6 }]);
  assert.deepEqual(thursday.raceWeekShape, monday.raceWeekShape);
  assert.equal(thursday.purpose, monday.purpose);
});

test('a race on a Saturday: the days to read run through Friday (Tue + Thu = 2 runs)', () => {
  const sat = addDayKey(RACE_DAY, -1);
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6], raceDate: sat });
  const plan = planAt(raceMonday);
  assert.equal(plan.kind, 'race_week');
  assert.equal(plan.raceWeekShape?.runs, 2);
});

test('the shape and the wind-down kinds: no other plan kind carries it', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6] });
  for (const back of [1, 2, 3]) assert.equal(planAt(addDayKey(raceMonday, -7 * back)).raceWeekShape, undefined, `${back} weeks out`);
  assert.equal(planAt(addDayKey(raceMonday, 7)).raceWeekShape, undefined); // recovery
  assert.equal(planAt(raceMonday, addDayKey(raceMonday, 5)).raceWeekShape, undefined); // race eve
});

// ── Strides for 5K / 10K runners ─────────────────────────────────────────────────────────────────────────────────────

test('10K runner: the last two build weeks before race week carry strides (the plan flag the longer races already use), the third-last does not', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 10, weekKm: 25, days: [1, 3, 6] });
  const last = planAt(addDayKey(raceMonday, -7));
  const secondLast = planAt(addDayKey(raceMonday, -14));
  const thirdLast = planAt(addDayKey(raceMonday, -21));
  assert.equal(last.strides, true);
  assert.equal(secondLast.strides, true);
  assert.equal(thirdLast.strides, false);
  assert.match(plainSpaces(last.purpose), new RegExp(STRIDES_COPY));
  assert.match(plainSpaces(secondLast.purpose), new RegExp(STRIDES_COPY));
  assert.doesNotMatch(plainSpaces(thirdLast.purpose), new RegExp(STRIDES_COPY));
  assert.equal(planAt(raceMonday).strides, false); // race week itself: its shape has the strides
});

test('10K race-week Monday: x0.6 of the peak week in 2 short easy runs (the Saturday is the shakeout) with strides after the first', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 10, weekKm: 25, days: [1, 3, 5, 6] });
  const plan = planAt(raceMonday);
  assert.equal(plan.kind, 'race_week');
  assert.equal(plan.targetKm, 15); // 10K x0.6
  assert.deepEqual(plan.raceWeekShape, { runs: 2, capRuns: 3, perRunCapKm: 6 });
  assert.equal(plainSpaces(plan.purpose), raceWeekLine('15', '2', '6', 'km'));
});

test('5K runner: strides on the last two build weeks and the same race-week shape (class "short" covers both)', () => {
  const { planAt, raceMonday } = raceWeekReader({ raceKm: 5, weekKm: 20, days: [1, 3, 6] });
  assert.equal(planAt(addDayKey(raceMonday, -7)).strides, true);
  assert.equal(planAt(addDayKey(raceMonday, -14)).strides, true);
  assert.equal(planAt(addDayKey(raceMonday, -21)).strides, false);
  const plan = planAt(raceMonday);
  assert.equal(plan.targetKm, 12); // x0.6 of 20
  assert.deepEqual(plan.raceWeekShape, { runs: 2, perRunCapKm: 6 }); // Tue + Thu; max(12 / 2, 4.8) = 6
});

test('strides for half and marathon are unchanged (2 build weeks before the taper)', () => {
  const half = raceWeekReader({ raceKm: 21.1, weekKm: 30, days: [1, 3, 5, 6] });
  assert.equal(half.planAt(addDayKey(half.raceMonday, -14)).strides, true); // the week before the taper week
  assert.equal(half.planAt(addDayKey(half.raceMonday, -21)).strides, true);
  assert.equal(half.planAt(addDayKey(half.raceMonday, -28)).strides, false);
});

// ── One shape on card, coach, review and the obedient reader ─────────────────────────────────────────────────────────

function raceWeekInput(over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  const monday = '2026-10-12';
  const runs: Run[] = [];
  // Four build weeks of 30 km (Tue / Thu / Sat 6 km, Sunday 12), then the taper week of 22 km.
  for (let k = 2; k <= 5; k++) for (const [d, km] of [[1, 6], [3, 6], [5, 6], [6, 12]] as Array<[number, number]>) runs.push(run(addDayKey(monday, -7 * k + d), km));
  for (const [d, km] of [[1, 5], [3, 5], [5, 5], [6, 7]] as Array<[number, number]>) runs.push(run(addDayKey(monday, -7 + d), km));
  return {
    ...noRaceInput(runs),
    todayKey: monday,
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    race: { date: '2026-10-18', distanceKm: 21.1 },
    racePeakWeekKm: 30,
    ...over,
  };
}

test('race-week Monday: the card, the coach line and the structured plan say the same runs and the same cap', () => {
  const gp = computeGoalProgress(raceWeekInput());
  const plan = gp.distance?.plan;
  assert.equal(plan?.kind, 'race_week');
  assert.deepEqual(plan?.raceWeekShape, { runs: 2, capRuns: 3, perRunCapKm: 6 });
  const cardLine = gp.reasons.find(r => r.kind === 'race_phase')?.text ?? '';
  assert.equal(cardLine, raceWeekLine('15', '2', '6', 'km'));
  const coach = formatGoalProgressLines(gp, 'metric').find(l => l.startsWith('- Race phase')) ?? '';
  assert.match(coach, /^- Race phase: race week — ~15\.0 km before the race at most; 2 short easy runs, each ≤ ~6 km; 4–6 strides after the first; rest or a 15-min shakeout the day before — no new volume or hard sessions$/);
});

test('imperial: card and coach name the same runs and the same cap in miles', () => {
  const gp = computeGoalProgress({ ...raceWeekInput(), unitSystem: 'imperial' });
  const plan = gp.distance?.plan;
  assert.ok(plan?.raceWeekShape != null);
  const cardLine = gp.reasons.find(r => r.kind === 'race_phase')?.text ?? '';
  const cap = /each ≤ ~([\d.]+) mi/.exec(cardLine)?.[1];
  assert.ok(cap != null, cardLine);
  const coach = formatGoalProgressLines(gp, 'imperial').find(l => l.startsWith('- Race phase')) ?? '';
  assert.ok(coach.includes(`${plan?.raceWeekShape?.runs} short easy runs, each ≤ ~${cap} mi`), `${coach}\n${cardLine}`);
  assert.equal(Number(cap) % 0.5, 0);
});

test('from Friday the coach and card are back to the old race-week line (the shape is for the early week)', () => {
  const gp = computeGoalProgress(raceWeekInput({ todayKey: '2026-10-16' }));
  assert.equal(gp.distance?.plan?.raceWeekShape, undefined);
  const coach = formatGoalProgressLines(gp, 'metric').find(l => l.startsWith('- Race phase')) ?? '';
  assert.doesNotMatch(coach, /strides/);
});

test('the per-run cap is an instruction the test runners can read: "each ≤ ~6 km" is a per_run_cap of 6 km, and nothing else in the line is a cap', async () => {
  const { extractInstructions } = await import('./timeline/instructions');
  const gp = computeGoalProgress(raceWeekInput());
  const reasons = gp.reasons.map(r => ({ kind: r.kind, text: r.text, tone: r.tone }));
  const snap = { card: { headline: gp.headline, reasons, distance: { text: gp.distance?.text ?? '' } }, coach: formatGoalProgressLines(gp, 'metric'), opener: null } as unknown as Parameters<typeof extractInstructions>[0];
  const ins = extractInstructions(snap, { longestSoFarKm: 0 });
  const per = ins.filter(i => i.kind === 'per_run_cap');
  assert.ok(per.length >= 2, 'the card and the coach both carry it');
  for (const i of per) assert.equal(i.hi, 6);
  assert.equal(ins.filter(i => i.kind !== 'per_run_cap').length, 0, ins.map(i => i.text).join(' | '));
});

test('the obedient runner keeps every race-week run within the per-run cap: the Tuesday is at most 6 km (it was 6.3), and the week still lands within 6% of the ~15 km', async () => {
  const { buildScenario } = await import('./timeline/scenarios');
  const scn = buildScenario('runner_on_plan_obedient');
  const race = scn.user.raceDate as string;
  const raceMonday = addDayKey(race, -6);
  const runs = scn.workouts.filter(w => w.type === 'Running' && w.day >= raceMonday && w.day < race).map(w => (w.distanceM as number) / 1000);
  assert.ok(runs.length >= 3, `${runs.join(', ')}`);
  const shakeout = runs[runs.length - 1];
  for (const km of runs.slice(0, -1)) assert.ok(km <= 6 + 1e-9, `${km} km against a 6 km per-run cap`);
  assert.ok(shakeout <= 3, `the race-eve shakeout, ${shakeout} km`);
  const total = runs.reduce((a, b) => a + b, 0);
  assert.ok(total <= 15 * 1.1 && total >= 15 * 0.94, `${total} km of ~15`);
});
