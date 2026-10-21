/**
 * Wave 22e - endurance weekly review, round 4: a skipped cutback is not "30 of 30 km", the restart number, the taper ahead,
 * the race-day distance line, the cap note and the watch note. (Its own file, like the wave 20 / 21 ones.)
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

// ── P1-C: the skipped cutback ───────────────────────────────────────────────

test('a cutback week that ran far past its lowered number reads "above the cutback" in the headline - not "30 of 30 km"', () => {
  // The cutback week is Mon 2026-10-19 (20 km after 15 17 19 21 23). 24 km is 20% over it and under the spike line.
  const skipped = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 24], { weekStart: '2026-10-19' }));
  assert.match(skipped.headline, /^4 sessions, 24 of ~20 km — above the cutback · goal 30 km/);
  // Even a week that reached the weekly goal itself in a cutback week is read against the cutback (the goal is not the bar that week).
  const atGoal = computeWeeklyReview(planReview([15, 17, 19, 21, 25, 30], { weekStart: '2026-10-19' }));
  assert.doesNotMatch(atGoal.headline, /30 of 30/);
  // A cutback kept is unchanged.
  const kept = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 20], { weekStart: '2026-10-19' }));
  assert.match(kept.headline, /20 of ~20 km — on plan · goal 30 km/);
});

// ── P2.3: "30 km the week after" when the week after is the taper ──────────

test('"Next week" never promises the goal for a week that is the taper: "then the taper"', () => {
  // A half on Sun 2026-11-29: Monday 11-16 is 13 days out (the taper). Reviewing 11-02: next week 11-09 builds to ~28 km.
  const race = { raceDate: '2026-11-29', raceDistanceKm: 21.1 };
  const r = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25], { weekStart: '2026-11-02', ...race }));
  assert.equal(r.nextWeek, 'Build to ~28 km: long run 12 km, the rest mostly easy runs, plus 4–6 strides after one easy run; then the taper.');
  assert.doesNotMatch(r.nextWeek, /the week after|toward 30/);
  // A race further out keeps the arithmetic.
  const far = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25], { weekStart: '2026-11-02', raceDate: '2026-12-27', raceDistanceKm: 21.1 }));
  assert.equal(far.nextWeek, 'Build to ~28 km: long run 12 km, the rest mostly easy runs; 30 km the week after.');
});

test('a comeback week\'s "Next week" climbs "back toward your usual ~N km", as the card says - not toward the weekly goal (22e)', () => {
  // Weeks 1-6 build (15..25 km), two weeks off, a restart week of 12 km, then the comeback week ran 14.5 km.
  const history = [15, 17, 19, 21, 23, 25, 0, 0, 12, 14.5];
  const r = computeWeeklyReview(planReview(history));
  assert.match(r.nextWeek, /^Build up to ~\d+ km: long run [\d.]+ km, the rest mostly easy runs; then add ~10% a week, back toward your usual ~22 km\.$/);
});

test('recovery week 1\'s Volume stat says the week before held the race (22e)', () => {
  // A half on Sun 2026-10-11; reviewing recovery week 1 (10-12 -> 10-18) after race week (12 km without the race).
  const race = { raceDate: '2026-10-11', raceDistanceKm: 21.1 };
  const base = planReview([15, 17, 19, 21, 23, 25, 12, 8], { weekStart: '2026-10-12', ...race });
  const r = computeWeeklyReview(base);
  // (The 12 km race-week fixture's Sunday run is the race day itself: 7.2 km of it is training.)
  assert.equal(r.stats.find(st => st.label === 'Volume')!.comparison, '7.2 km last week, excl. the race');
});
