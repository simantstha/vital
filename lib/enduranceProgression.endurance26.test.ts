/**
 * Wave 26e group A - coaching arithmetic for the long run. Two caps: without a race the long run never steps above 21 km (13 mi) - a
 * general-fitness runner is not sent out for 30 km every Sunday - and a taper long run never passes its week's share (the late marathon
 * taper's Sunday, a week out, is 45% of the peak). Every test here was written BEFORE the rule it locks in. (Its own file, like the wave
 * 20 - 25 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LONG_RUN_MAX_WEEK_SHARE,
  NO_RACE_LONG_RUN_MAX_KM,
  TAPER_LATE_LONG_RUN_SHARE,
  addDayKey,
  enduranceWeekPlan,
  floorLongRunKm,
  noRaceLongRunMaxKm,
  peakWeekKmBeforeTaper,
  roundLongRunKm,
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
