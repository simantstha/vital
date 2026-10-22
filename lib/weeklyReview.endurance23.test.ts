/**
 * Wave 23e - endurance weekly review, round 5: a hold week he built through is not praised as held. (Its own file, like the wave 20 / 21 / 22 ones.)
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

const stat = (r: WeeklyReview, label: string) => r.stats.find(s => s.label === label);

// The calendar's cutback week is Mon 2026-10-19; a week of 25 km there skips it, so the next one (Mon 10-26) holds ~25 km.
const SKIPPED_CUTBACK = [15, 17, 19, 21, 23, 25];

test('a hold week kept (25 km, long run at the held one) after a skipped cutback: good, "held after", and the win names the cause', () => {
  const r = computeWeeklyReview(planReview([...SKIPPED_CUTBACK, 25], { weekStart: '2026-10-26' }));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  assert.equal(r.win, 'Held at ~25 km after the skipped cutback — right call.');
  assert.doesNotMatch(r.win ?? '', /jump/);
  assert.match(r.headline, /^4 sessions, 25 of ~25 km — on plan · goal 30 km/);
  assert.equal(stat(r, 'Volume')!.tone, 'good');
  assert.equal(r.slip, null);
});

test('a hold week built through (28 of ~25 km, long run 11.2 against the held ~10): "above the hold", neutral Volume, no win, a factual slip', () => {
  const r = computeWeeklyReview(planReview([...SKIPPED_CUTBACK, 28], { weekStart: '2026-10-26' }));
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'hold', doneKm: 28, targetKm: 25 });
  assert.equal(r.headline, '4 sessions, 28 of ~25 km — above the hold · goal 30 km');
  assert.equal(stat(r, 'Volume')!.comparison, '+12% vs last week');
  assert.equal(stat(r, 'Volume')!.tone, 'neutral');
  assert.equal(r.win, null);
  assert.equal(r.slip, 'Built again instead of holding: 28 vs ~25 km');
  assert.doesNotMatch(`${r.headline} ${r.slip} ${r.nextWeek}`, /Held back|exactly right|guilt|skipped/);
});

test('a hold week whose KM were held but whose long run was not names the long run, in the same factual words', () => {
  // 25 km, but the Sunday run is 13 km (52% of the week) against a held ~10.
  const weeks = planReview([...SKIPPED_CUTBACK, 25], { weekStart: '2026-10-26' });
  const workouts = weeks.workouts.map(w => (w.day === '2026-11-01' ? { ...w, distanceKm: 13 } : w.day === '2026-10-31' ? { ...w, distanceKm: 2 } : w));
  const r = computeWeeklyReview({ ...weeks, workouts });
  assert.equal(r.weekRating, 'mixed');
  assert.equal(r.weekGap?.kind, 'hold');
  assert.match(r.slip ?? '', /^Held the km, but the long run was 13 km against the held \d+(\.\d)? km$/);
  assert.equal(r.win, null);
});

test('a spike hold kept keeps the spike wording ("after last week\'s jump"); a ceiling hold says it stayed at the ceiling', () => {
  const spike = computeWeeklyReview(planReview([15, 17, 19, 21, 18, 40, 22]));
  assert.equal(spike.win, "Held back after last week's jump — exactly right.");
  assert.equal(stat(spike, 'Volume')!.comparison, 'held after 40 km last week');
});

test('the Volume stat of a hold week built through (or jumped again) is never "held after"', () => {
  // 26 km against a ~22 km hold: built through. 30 km: a jump again (spike).
  const built = computeWeeklyReview(planReview([15, 17, 19, 21, 18, 40, 26]));
  assert.equal(built.weekRating, 'mixed');
  assert.equal(built.weekGap?.kind, 'hold');
  assert.doesNotMatch(stat(built, 'Volume')!.comparison ?? '', /held after/);
  assert.equal(stat(built, 'Volume')!.tone, 'neutral');
  const jumped = computeWeeklyReview(planReview([15, 17, 19, 21, 18, 40, 30]));
  assert.equal(jumped.weekRating, 'mixed');
  assert.equal(jumped.weekGap?.kind, 'spike');
  assert.doesNotMatch(stat(jumped, 'Volume')!.comparison ?? '', /held after/);
  assert.equal(stat(jumped, 'Volume')!.tone, 'watch');
});

test('the week after a cutback is reviewed against the last full week before it: one base, named, on the stat, the headline and the win (23e P2-4)', () => {
  // The calendar's cutback week Mon 2026-10-19 ran as planned (20 km after 23); the week of 10-26 ran 25 km: +25% on the cutback, +9% on the 23 km week.
  const r = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 20, 25], { weekStart: '2026-10-26' }));
  assert.equal(r.weekRating, 'good');
  assert.equal(stat(r, 'Volume')!.comparison, '+9% on your last full week (23 km), back on the build after the cutback');
  assert.equal(r.headline, '4 sessions, 25 of ~25 km — on plan · goal 30 km, +9% vs last full week');
  assert.equal(r.win, "You hit this week's step: 25 of ~25 km (+9% on your last full week).");
  // The cutback week itself is still measured against the week before it, as planned.
  const cut = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 20], { weekStart: '2026-10-19' }));
  assert.equal(stat(cut, 'Volume')!.comparison, '−13% vs last week, as planned (cutback)');
  // A week that did not follow a cutback is unchanged.
  const plainWeek = computeWeeklyReview(planReview([15, 17, 19, 21, 23], { weekStart: '2026-10-12' }));
  assert.equal(stat(plainWeek, 'Volume')!.comparison, '+10% vs last week');
});

test('a comeback week\'s "Next week" names the ladder it climbs (up to ~25% a week until the usual week, about 10% after), not "then add ~10% a week" (23e P2-5)', () => {
  // Weeks 1-8 build to 30 km; week 9 is one 6 km run then a break; week 10 comes back with 15 km.
  const sick = planReview([15, 17, 19, 21, 23, 25, 28, 30, 6, 15]);
  const sickWeek = { ...sick, workouts: sick.workouts.filter(w => !(w.day > addDays(WEEK_START, -7 + 1) && w.day <= addDays(WEEK_START, -7 + 6))) };
  const r = computeWeeklyReview(sickWeek);
  assert.match(r.nextWeek, /^Build up to ~\d+ km: long run [\d.]+ km, the rest mostly easy runs; then up to ~25% a week until you're back at your usual ~[\d.]+ km, about 10% after that\.$/);
  assert.doesNotMatch(r.nextWeek, /add ~10% a week/);
});

test('a recovery / taper week quoting a % vs last week says "as planned (recovery)" / "as planned (taper)" (23e P2-7)', () => {
  // Half marathon on Sun 2026-09-20; recovery week 1 is Mon 09-21, recovery week 2 the reviewed week (Mon 09-28).
  const race = { raceDate: '2026-09-20', raceDistanceKm: 21.1 };
  const input = planReview([15, 17, 19, 21, 23, 25, 12, 8, 11], { ...race });
  const raceRun = run('2026-09-20', 21.1);
  const r = computeWeeklyReview({ ...input, workouts: [...input.workouts, raceRun], trainingDays: [...input.trainingDays, raceRun.day] });
  assert.equal(stat(r, 'Volume')!.comparison, '+38% vs last week, as planned (recovery)');
  // The taper week: reviewing Mon 09-14's week... a half's taper is the 14 days before: the week of 09-07 (13 days out).
  const taper = computeWeeklyReview({ ...planReview([15, 17, 19, 21, 23, 28, 21], { weekStart: '2026-09-07', ...race }) });
  assert.match(stat(taper, 'Volume')!.comparison ?? '', /^−25% vs last week, as planned \(taper\)$/);
});
