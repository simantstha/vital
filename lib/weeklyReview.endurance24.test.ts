/**
 * Wave 24e - the weekly review, round 6: the week the card called "done" is on plan, a restart that began mid-week is graded against its scaled number.
 * Every test here was written BEFORE the rule it locks in. (Its own file, like the wave 20 - 23 ones.)
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

const run = (day: string, distanceKm: number) => ({ day, durationMin: Math.round(distanceKm * 6), distanceKm, type: 'Running' });

function review(runs: Array<ReturnType<typeof run>>, over: Partial<WeeklyReviewInput> = {}): WeeklyReview {
  return computeWeeklyReview({
    goal: 'endurance',
    weekStart: WEEK_START,
    verdict: 'building',
    weightReadings: [],
    intakeDays: [],
    budget: null,
    trainingDays: runs.map(r => r.day),
    workouts: runs,
    progression: {},
    restingHr: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    weeklySessionsTarget: null,
    weeklyDistanceKmTarget: 30,
    unitSystem: 'metric',
    ...over,
  });
}

/** `kms[i]` km in the i-th week counting back from the reviewed one (last = reviewed): Tue / Thu / Sat and a 40% Sunday long run each. */
function weeksOf(kms: number[]): Array<ReturnType<typeof run>> {
  const out: Array<ReturnType<typeof run>> = [];
  kms.forEach((km, i) => {
    if (km <= 0) return;
    const monday = addDays(WEEK_START, -7 * (kms.length - 1 - i));
    out.push(run(addDays(monday, 1), km * 0.2), run(addDays(monday, 3), km * 0.2), run(addDays(monday, 5), km * 0.2), run(addDays(monday, 6), km * 0.4));
  });
  return out;
}

test('a week inside the 10% band the card calls "done" is on plan in the review: "You hit this week\'s step", never "Close to your step ... aim for ~23 again"', () => {
  // 15, 17, 19, 21, then 21.5 km against the ~23 km step (93%): the card said the week's km were done from 20.7 km.
  const r = review(weeksOf([15, 17, 19, 21, 21.5]));
  assert.equal(r.weekRating, 'good');
  assert.match(r.win ?? '', /^You hit this week's step: 21\.5 of ~23 km/);
  assert.doesNotMatch(r.win ?? '', /aim for|Close to/);
  assert.match(r.headline, /21\.5 of ~23 km — on plan/);
  // Just under the band (20 of ~23 = 87%) is not a good week at all: the week is short, said as it is.
  const short = review(weeksOf([15, 17, 19, 21, 20]));
  assert.equal(short.weekRating, 'mixed');
  assert.equal(short.win, null);
  assert.match(short.slip ?? '', /short of this week's step/);
});

test('at the weekly goal the band is the same: 28 of 30 km is "Close to your weekly goal: 28 of 30 km" with no nudge to run 30 again', () => {
  const r = review(weeksOf([22, 24, 26, 30, 24, 28]));
  assert.equal(r.win, 'Close to your weekly goal: 28 of 30 km.');
});

test('a restart that began mid-week is graded against its scaled number: 10 of ~10 km is on plan, and next week is the full 17 km restart', () => {
  // Weeks 1-6 build, week 7 empty, week 8 (the reviewed week 2026-10-26... counted back from WEEK_START): first run back on Thursday, Thu 3 + Sat 3 + Sun 4.
  const build = weeksOf([15, 17, 19, 21, 23, 25, 0, 0]);
  const reviewed = addDays(WEEK_START, 0);
  const runs = [...build, run(addDays(reviewed, 3), 3), run(addDays(reviewed, 5), 3), run(addDays(reviewed, 6), 4)];
  const r = review(runs);
  assert.equal(r.weekRating, 'good');
  assert.match(r.headline, /10 of ~10 km — on plan/);
  assert.equal(r.win, 'Back out there: 10 km after the break.');
  assert.match(r.nextWeek, /^Restart at ~17 km next week with easy runs/);
});
