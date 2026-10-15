/**
 * Wave 20a — endurance weekly review: "Close to your step", a race week that reads as the race, a half marathon's
 * early taper, a long run that jumped, imperial recovery ceilings, "Build to" until the goal has been run.
 * (Kept in its own file so the older weeklyReview tests stay untouched.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWeeklyReview as computeWeeklyReviewRaw, type WeeklyReview, type WeeklyReviewInput } from './weeklyReview';
import { plainSpaces } from './displayText';

function computeWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
  return JSON.parse(plainSpaces(JSON.stringify(computeWeeklyReviewRaw(input)))) as WeeklyReview;
}

const WEEK_START = '2026-09-28'; // Monday; the review is read on Monday 2026-10-05

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const run = (day: string, distanceKm: number, durationMin = Math.round(distanceKm * 6)) => ({ day, durationMin, distanceKm, type: 'Running' });

function base(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  return {
    goal: 'endurance',
    weekStart: WEEK_START,
    verdict: 'building',
    weightReadings: [],
    intakeDays: [],
    budget: null,
    trainingDays: [],
    workouts: [],
    progression: {},
    restingHr: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    weeklySessionsTarget: null,
    weeklyDistanceKmTarget: 30,
    unitSystem: 'metric',
    ...over,
  };
}

/** `weeks` km, the last one being the reviewed week: four runs each (Tue / Thu / Sat and a Sunday long run of 40%). */
function planReview(weeks: number[], over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  const workouts: ReturnType<typeof run>[] = [];
  const reviewed = over.weekStart ?? WEEK_START;
  weeks.forEach((km, i) => {
    if (km <= 0) return;
    const monday = addDays(reviewed, -7 * (weeks.length - 1 - i));
    workouts.push(run(addDays(monday, 1), km * 0.2), run(addDays(monday, 3), km * 0.2), run(addDays(monday, 5), km * 0.2), run(addDays(monday, 6), km * 0.4));
  });
  return base({ trainingDays: workouts.map(w => w.day), workouts, ...over });
}

const stat = (r: WeeklyReview, label: string) => r.stats.find(s => s.label === label);

test('"hit" only when the rounded km reach the step: 20 of ~22 km is "Close to your step"', () => {
  const close = computeWeeklyReview(planReview([15, 17, 18, 20, 20]));
  assert.equal(close.weekRating, 'good');
  assert.equal(close.win, 'Close to your step: 20 of ~22 km — aim for ~22 again.');
  const hit = computeWeeklyReview(planReview([15, 17, 19, 21]));
  assert.equal(hit.win, "You hit this week's step: 21 of ~21 km (+11% on last week).");
  // A climb back after a break asks for more next week, so it does not say "again".
  const climb = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 0, 0, 12, 14.5]));
  assert.match(climb.win ?? '', /^Close to your step: 14\.5 of ~18 km\.$/);
  // At the goal: 28 of 30 is close, 30 of 30 is held.
  assert.match(computeWeeklyReview(planReview([22, 24, 26, 28, 30, 28])).win ?? '', /^Close to your weekly goal: 28 of 30 km — aim for 30 again\.$/);
  assert.equal(computeWeeklyReview(planReview([22, 24, 26, 28, 30, 30])).win, 'You held your weekly goal: 30 of 30 km.');
});

test('a goal he has never run is "Build to", not "Hold"', () => {
  const r = computeWeeklyReview(planReview([22, 24, 26, 28]));
  assert.match(r.nextWeek, /^Build to 30 km; /);
  assert.equal(computeWeeklyReview(planReview([22, 24, 30, 28])).nextWeek.startsWith('Hold 30 km; '), true);
  // The first time at the goal is "reached", not "held".
  assert.equal(computeWeeklyReview(planReview([22, 24, 26, 28, 30])).win, 'You reached your weekly goal: 30 of 30 km.');
});

test('a short build week 15-21 days before a half is the taper starting early: fine, not "8 km short"', () => {
  const race = { raceDate: '2026-10-18', raceDistanceKm: 21.1 }; // 20 days after the reviewed Monday
  const early = computeWeeklyReview(planReview([22, 24, 26, 28, 30, 30, 22], race));
  assert.equal(early.weekRating, 'good');
  assert.equal(early.weekGap, null);
  assert.equal(early.slip, 'Started tapering early — fine.');
  assert.equal(early.win, null);
  assert.doesNotMatch(`${early.headline} ${early.slip}`, /short/);
  // Further out (30 days) it is a genuine short week; a marathon taper is not this rule either.
  const far = computeWeeklyReview(planReview([22, 24, 26, 28, 30, 30, 22], { raceDate: '2026-10-28', raceDistanceKm: 21.1 }));
  assert.equal(far.weekRating, 'mixed');
  assert.match(far.slip ?? '', /short/);
  const marathon = computeWeeklyReview(planReview([22, 24, 26, 28, 30, 30, 22], { raceDate: '2026-10-18', raceDistanceKm: 42.2 }));
  assert.notEqual(marathon.slip, 'Started tapering early — fine.');
  // Far under half the target is not "tapering early".
  const tiny = computeWeeklyReview(planReview([22, 24, 26, 28, 30, 30, 10], race));
  assert.notEqual(tiny.slip, 'Started tapering early — fine.');
});

test('the week the race was run leads with the race; race-week volume is a neutral footnote, never a dig', () => {
  const raceDay = addDays(WEEK_START, 6);
  const common = { raceDate: raceDay, raceDistanceKm: 21.1, racePeakWeekKm: 29 };
  const build = [15, 17, 19, 21, 23, 25, 28, 30, 30];
  const make = (raceWeekRuns: number[]) => {
    const r = planReview(build.slice(0, -1), { ...common, weekStart: addDays(WEEK_START, -0) });
    // build weeks end the week BEFORE the reviewed one; add the reviewed week by hand
    const reviewedRuns = raceWeekRuns.map((km, i) => run(addDays(WEEK_START, [1, 3, 5][i]), km));
    const race = run(raceDay, 21.1, 135);
    return computeWeeklyReview({ ...r, ...common, workouts: [...r.workouts.filter(w => w.day < WEEK_START), ...reviewedRuns, race], trainingDays: [...r.trainingDays, ...reviewedRuns.map(x => x.day), raceDay] });
  };
  // 28 km in a race week with a ~15 km plan.
  const over = make([9.4, 9.3, 9.3]);
  assert.equal(over.headline, 'Raced the half marathon — 21.1 km');
  assert.equal(over.weekRating, 'good');
  assert.equal(over.weekGap, null);
  assert.equal(over.win, 'You ran the half marathon — 21.1 km.');
  assert.equal(over.slip, null);
  const vol = stat(over, 'Volume')!;
  assert.equal(vol.tone, 'neutral');
  assert.match(vol.comparison ?? '', /^excl\. the race · plan was ~\d+ km$/);
  assert.doesNotMatch(`${over.headline} ${over.slip} ${over.nextWeek}`, /over the|too much|short easy runs/);
  // Inside the plan the plain fact stays.
  const calm = make([4, 4, 4]);
  assert.equal(calm.headline, 'Raced the half marathon — 21.1 km, after 12 km in race week');
  assert.equal(stat(calm, 'Volume')!.comparison, 'excl. the race');
});

test('a long run that jumped 2+ km over its plan: the slip says so and next week holds it', () => {
  const week = (monday: string, longKm: number, easy: number): ReturnType<typeof run>[] => [
    run(addDays(monday, 1), easy), run(addDays(monday, 3), easy), run(addDays(monday, 5), easy), run(addDays(monday, 6), longKm),
  ];
  const at = (n: number) => addDays(WEEK_START, -7 * n);
  const workouts = [...week(at(4), 6, 3), ...week(at(3), 7, 3.4), ...week(at(2), 8, 3.8), ...week(at(1), 10, 4.4), ...week(WEEK_START, 14, 4.6)];
  const r = computeWeeklyReview(base({ workouts, trainingDays: workouts.map(w => w.day) }));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.slip, 'Long run jumped to 14 km — hold 14 next week.');
  assert.match(r.nextWeek, /long run 14 km \(hold it after last week's jump\)/);
  assert.doesNotMatch(r.nextWeek, /16 km/);
  // On plan (12 km): no slip, and the long run grows.
  const onPlan = [...week(at(4), 6, 3), ...week(at(3), 7, 3.4), ...week(at(2), 8, 3.8), ...week(at(1), 10, 4.4), ...week(WEEK_START, 12, 4.6)];
  const ok = computeWeeklyReview(base({ workouts: onPlan, trainingDays: onPlan.map(w => w.day) }));
  assert.equal(ok.slip, null);
  assert.doesNotMatch(ok.nextWeek, /hold it/);
});

test('imperial recovery: a week a little over the ceiling is "right at" it, never "7.5 mi (ceiling 7 mi)"', () => {
  const raceDate = addDays(WEEK_START, -1); // the Sunday before: recovery week 1 is the reviewed week
  const builds = planReview([20, 22, 24, 26, 28, 29], { weekStart: addDays(WEEK_START, -7) }).workouts;
  const recovery = [run(addDays(WEEK_START, 1), 4), run(addDays(WEEK_START, 3), 4), run(addDays(WEEK_START, 4), 4)]; // 12 km = 7.46 mi
  const r = computeWeeklyReview(base({
    unitSystem: 'imperial', raceDate, raceDistanceKm: 21.1, racePeakWeekKm: 29,
    workouts: [...builds, run(raceDate, 21.1, 121), ...recovery], trainingDays: [...builds, ...recovery].map(w => w.day),
  }));
  assert.equal(r.headline, '3 sessions, 7.5 mi, right at your ~7.5 mi ceiling — recovery week');
  assert.equal(r.win, 'Recovery week kept easy: 7.5 mi, right at your ~7.5 mi ceiling.');
  assert.doesNotMatch(`${r.headline} ${r.win}`, /up to 7 mi|ceiling 7 mi/);
  // A week well inside the ceiling keeps the plain wording.
  const calm = computeWeeklyReview(base({
    unitSystem: 'imperial', raceDate, raceDistanceKm: 21.1, racePeakWeekKm: 29,
    workouts: [...builds, run(raceDate, 21.1, 121), run(addDays(WEEK_START, 2), 5)], trainingDays: [...builds.map(w => w.day), addDays(WEEK_START, 2)],
  }));
  assert.match(calm.win ?? '', /^Recovery week kept easy: 3\.1 mi \(ceiling 7 mi\)\.$/);
});
