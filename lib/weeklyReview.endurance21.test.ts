/**
 * Wave 21e - endurance weekly review: cutback weeks named, strides in the plan copy, a careful comeback graded against
 * the week before it, one plan for the card and "Next week", NBSP in the taper copy. (Its own file, like the wave 20 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWeeklyReview as computeWeeklyReviewRaw, type WeeklyReview, type WeeklyReviewInput } from './weeklyReview';
import { plainSpaces } from './displayText';

function computeWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
  return JSON.parse(plainSpaces(JSON.stringify(computeWeeklyReviewRaw(input)))) as WeeklyReview;
}

const WEEK_START = '2026-09-28'; // Monday

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

const BREAKING_UNIT_SPACE = /\d (km|mi|kg|lb|kcal|min)\b/;
const raw = (input: WeeklyReviewInput): WeeklyReview => computeWeeklyReviewRaw(input);
const allText = (r: WeeklyReview): string => [r.headline, r.win, r.slip, r.nextWeek, ...r.stats.flatMap(st => [st.value, st.comparison])].filter(Boolean).join(' | ');

test('cutback: "Next week" names it, the cutback week itself is graded as its own target and never short', () => {
  // Reviewing Mon 2026-10-12: the coming week (10-19) is the calendar's cutback week after three plain build weeks.
  const before = computeWeeklyReview(planReview([15, 17, 19, 21, 23], { weekStart: '2026-10-12' }));
  assert.equal(before.nextWeek, 'Cutback week: ~20 km, long run 9 km — absorb the last three weeks.');
  // Reviewing the cutback week: 20 km of a ~20 km cutback is done, and says so.
  const done = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 20], { weekStart: '2026-10-19' }));
  assert.equal(done.weekRating, 'good');
  assert.equal(done.win, 'Cutback week done: 20 km — the last three weeks have time to settle in.');
  assert.equal(done.slip, null);
  // ... and the week after goes back to the progression (~10% over the 23 km before the cutback), not 10% of the cutback.
  assert.match(done.nextWeek, /^Build to ~25 km: /);
  // Never "short": even far under the lowered number is good, with no distance gap.
  const easy = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 12], { weekStart: '2026-10-19' }));
  assert.equal(easy.weekRating, 'good');
  assert.equal(easy.weekGap, null);
  assert.equal(easy.slip, null);
  // The full normal week instead of the cutback is no "jump": 25 km is the week it replaced.
  const normal = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25], { weekStart: '2026-10-19' }));
  assert.equal(normal.weekGap, null);
  assert.notEqual(normal.weekRating, 'mixed');
  assert.equal(normal.win, null); // no praise for skipping the cutback
});

test('strides: the last 2 build weeks before the taper say "plus 4–6 strides after one easy run" in "Next week"', () => {
  // A half on Sun 2026-11-08: Monday 11-02 is 6 days out (race week), 10-26 is 13 days out (taper) - so 10-12 and 10-19 are the last build weeks.
  const race = { raceDate: '2026-11-08', raceDistanceKm: 21.1 };
  const a = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25], { weekStart: '2026-10-12', ...race })); // next week = 10-19
  assert.match(a.nextWeek, /plus 4–6 strides after one easy run/);
  const b = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 28], { weekStart: '2026-10-19', ...race })); // next week = 10-26: the taper
  assert.doesNotMatch(b.nextWeek, /strides/);
  assert.match(b.nextWeek, /^Taper: /);
  const mid = computeWeeklyReview(planReview([15, 17, 19, 21, 23], { weekStart: '2026-10-05', ...race })); // next week = 10-12: still one of the last two
  assert.match(mid.nextWeek, /strides/);
  const earlier = computeWeeklyReview(planReview([15, 17, 19, 21], { weekStart: '2026-09-28', ...race })); // next week = 10-05: three weeks out of the taper
  assert.doesNotMatch(earlier.nextWeek, /strides/);
});

test('a careful comeback is graded against the week before it, never as "5 km short of this week\'s step"', () => {
  // Weeks 1-6 build, a 2-week gap, a 12 km restart week, then a comeback week.
  const grew = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 0, 0, 12, 13]));
  assert.equal(grew.weekRating, 'good');
  assert.equal(grew.weekGap, null);
  assert.equal(grew.slip, null);
  assert.equal(grew.win, 'Back on the way up: 13 km, up from 12 km last week.');
  assert.match(grew.nextWeek, /^Build up to ~16 km: /); // 1.25x the 13 km, worded as a ceiling
  const shrank = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 0, 0, 12, 10]));
  assert.equal(shrank.weekRating, 'mixed');
  assert.deepEqual(shrank.weekGap, { kind: 'distance', doneKm: 10, targetKm: 30, stepKm: 15, comebackFromKm: 12 });
  assert.equal(shrank.slip, '10 km, down from 12 km last week — keep building back, up to ~15 km');
  assert.doesNotMatch(shrank.slip ?? '', /short of this week/);
});

test('the taper plan copy joins "3×1 km" / "3×0.5 mi" with U+00A0 in the card-side review text (no ASCII space between a digit and the unit)', () => {
  for (const unitSystem of ['metric', 'imperial'] as const) {
    const r = raw(planReview([30, 30, 30, 30, 30, 30], { raceDate: '2026-10-18', raceDistanceKm: 21.1, racePeakWeekKm: 40, unitSystem }));
    assert.match(r.nextWeek, unitSystem === 'metric' ? /3×1 km at race pace midweek/ : /3×0\.5 mi at race pace midweek/);
    assert.equal(BREAKING_UNIT_SPACE.test(allText(r)), false, allText(r));
  }
  // The strides and cutback copy follow the same rule.
  const strides = raw(planReview([15, 17, 19, 21, 23, 25], { weekStart: '2026-10-12', raceDate: '2026-11-08', raceDistanceKm: 21.1 }));
  assert.equal(BREAKING_UNIT_SPACE.test(allText(strides)), false, allText(strides));
  assert.ok(strides.nextWeek.includes('plus 4–6 strides after one easy run'));
  const cutback = raw(planReview([15, 17, 19, 21, 23], { weekStart: '2026-10-12' }));
  assert.match(cutback.nextWeek, /^Cutback week: ~20 km, long run 9 km — absorb the last three weeks\.$/);
  assert.equal(BREAKING_UNIT_SPACE.test(allText(cutback)), false, allText(cutback));
});

test('the cap note in "Next week" follows the plan\'s cadence, not every Monday', () => {
  // At the 15 km peak a 30 km goal can carry (the half's own peak is 18): the cap note is part of "Next week" only in the weeks it is due.
  const race = { raceDate: '2026-12-20', raceDistanceKm: 21.1 };
  const lr = { lastKm: 15, peakKm: 15, targetPeakKm: 15, raceTargetKm: 18 };
  const texts: boolean[] = [];
  for (const weekStart of ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']) {
    const r = computeWeeklyReview(planReview([14, 16, 18, 20, 22], { weekStart, longRun: lr, signupDay: '2026-09-07', ...race }));
    texts.push(/fit a 15 km long run/.test(r.nextWeek));
  }
  // The goal's week 0 is 2026-09-07; "Next week" is 10-12, 10-19, 10-26, 11-02 (week 8), 11-09: only week 8 carries the note.
  assert.deepEqual(texts, [false, false, false, true, false]);
});

test('a jump in a cutback week is read against the cutback number the card showed that week (~20 km), and the hold next week still steps up from the 25 km week it replaced', () => {
  const r = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 40], { weekStart: '2026-10-19' }));
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'spike', doneKm: 40, stepKm: 20, targetKm: 30 });
  assert.equal(r.headline, '4 sessions, 40 of ~20 km — well above the safe step · goal 30 km');
  assert.equal(r.slip, "Jumped 20 km over this week's step — big jumps raise injury risk");
  assert.equal(r.nextWeek, 'Hold around ~28 km next week, then build ~10% a week toward 30 km.');
});

test('a comeback week more than 10% over its "up to" cap is "over the cap" in the review - no "on plan", no praise, a neutral Volume - and Next week holds at what was run', () => {
  // Weeks 1-6 build (15..25 km), two weeks off, a restart week of 12 km, then the comeback week "up to ~15 km" ran 18 km.
  const history = [15, 17, 19, 21, 23, 25, 0, 0, 12];
  const r = computeWeeklyReview(planReview([...history, 18]));
  assert.equal(r.headline, '4 sessions, 18 of up to ~15 km — a little over the cap · goal 30 km');
  assert.equal(r.stats.find(st => st.label === 'Volume')!.tone, 'neutral');
  assert.equal(r.win, null);
  assert.equal(r.slip, null);
  assert.equal(r.nextWeek, 'Hold here, up to ~18 km: long run 9 km, the rest mostly easy runs; then add ~10% a week toward 30 km.');
  assert.equal(computeWeeklyReview(planReview([...history, 20])).headline, '4 sessions, 20 of up to ~15 km — well over the cap · goal 30 km');
  // Exactly 10% over the ceiling is inside its slack: on plan, praised for the climb, and the ladder goes on.
  const within = computeWeeklyReview(planReview([...history, 16.5]));
  assert.match(within.headline, /^4 sessions, 16\.5 of up to ~15 km — on plan · goal 30 km/);
  assert.equal(within.win, 'Back on the way up: 16.5 km, up from 12 km last week.');
  assert.match(within.nextWeek, /^Build up to ~20 km: /);
});
