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

test('a week inside the 10% band the card calls "done" is on plan in the review, but short of the step is not a "hit" (round 7): no win and never "aim for"', () => {
  // 15, 17, 19, 21, then 21.5 km against the ~23 km step (93%): the card said the week's km were done from 20.7 km.
  const r = review(weeksOf([15, 17, 19, 21, 21.5]));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.win, null);
  assert.doesNotMatch(r.nextWeek, /aim for|hit/); // next week steps on from what he ran ("Build to ~24 km"), so there is no "again" to say
  assert.match(r.headline, /21\.5 of ~23 km — on plan/);
  // At the step (displayed done at or above the displayed target) it is a hit.
  assert.match(review(weeksOf([15, 17, 19, 21, 23])).win ?? '', /^You hit this week's step: 23 of ~23 km/);
  // Just under the band (20 of ~23 = 87%) is not a good week at all: the week is short, said as it is.
  const short = review(weeksOf([15, 17, 19, 21, 20]));
  assert.equal(short.weekRating, 'mixed');
  assert.equal(short.win, null);
  assert.match(short.slip ?? '', /short of this week's step/);
});

test('at the weekly goal the band is the same: 28 of 30 km has no win and a neutral "Close to your weekly goal: 28 of 30 km — 30 again next week", no "aim for"', () => {
  const r = review(weeksOf([22, 24, 26, 30, 24, 28]));
  assert.equal(r.win, null);
  assert.match(r.nextWeek, /^Close to your weekly goal: 28 of 30 km — 30 again next week\./);
  assert.doesNotMatch(r.nextWeek, /aim for/);
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

// ── wave 24e group 2: hold and cutback rules ─────────────────────────────────

/** The calendar's cutback weeks are Mondays 2026-10-19, 2026-11-16 ...: `weeksOf` counted back from `lastMonday` (the reviewed week). */
function weeksFrom(kms: number[], lastMonday: string): Array<ReturnType<typeof run>> {
  const out: Array<ReturnType<typeof run>> = [];
  kms.forEach((km, i) => {
    if (km <= 0) return;
    const monday = addDays(lastMonday, -7 * (kms.length - 1 - i));
    out.push(run(addDays(monday, 1), km * 0.2), run(addDays(monday, 3), km * 0.2), run(addDays(monday, 5), km * 0.2), run(addDays(monday, 6), km * 0.4));
  });
  return out;
}

test('a cutback run as a normal week: rated good, NO win, a neutral Volume stat, no slip - and a neutral note opens "Next week" (first time)', () => {
  const r = review(weeksFrom([15, 17, 19, 21, 23, 25], '2026-10-19'), { weekStart: '2026-10-19' });
  assert.equal(r.weekRating, 'good');
  assert.equal(r.win, null);
  assert.equal(r.slip, null);
  assert.equal(r.weekGap, null);
  assert.equal(r.stats.find(st => st.label === 'Volume')!.tone, 'neutral');
  assert.equal(r.nextWeek, 'Ran the cutback as a normal week — hold ~25 km next week; long run 10 km, no 10% step on top of it.');
  assert.doesNotMatch(`${r.headline} ${r.nextWeek}`, /skipped|easier week before building/);
});

test('"an easier week" is said only when the hold really is easier than the week just run (a cutback run at 25.9 km, hold ~25)', () => {
  const r = review(weeksFrom([15, 17, 19, 21, 23, 25.9], '2026-10-19'), { weekStart: '2026-10-19' });
  assert.match(r.nextWeek, /^Ran the cutback as a normal week — next week's hold \(~25 km\) is your easier week; long run \d+(?:\.\d)? km before building again\.$/);
});

test('the SECOND cutback in a row run as a normal week gets a factual slip; still rated good', () => {
  // Weeks 1-6 build with the week-6 cutback run as 25 km, hold 25, build 27, 30, then the owed cutback (calendar week of 2026-11-16, ~24 km) run as 30 km.
  const r = review(weeksFrom([15, 17, 19, 21, 23, 25, 25, 27, 30, 30], '2026-11-16'), { weekStart: '2026-11-16' });
  assert.equal(r.weekRating, 'good');
  assert.match(r.slip ?? '', /^Second cutback run as a normal week: 30 km vs ~24 km planned$/);
  assert.equal(r.win, null);
  assert.equal(r.weekGap, null);
});

test('a hold week is not graded more harshly than a maintain week: a long run past the held one is "over the held" only when oversized (55% of the week)', () => {
  const hold = weeksFrom([15, 17, 19, 21, 23, 25, 25], '2026-10-26');
  const withSunday = (sun: number, sat: number) => hold.map(w => (w.day === '2026-11-01' ? { ...w, distanceKm: sun } : w.day === '2026-10-31' ? { ...w, distanceKm: sat } : w));
  const ok = review(withSunday(13, 2), { weekStart: '2026-10-26' }); // 13 of 25 km = 52%
  assert.equal(ok.weekRating, 'good');
  assert.doesNotMatch(ok.headline, /over the held|above the hold/);
  const over = review(withSunday(14, 1), { weekStart: '2026-10-26' }); // 14 of 25 km = 56%
  assert.equal(over.weekRating, 'good');
  assert.match(over.headline, /25 of ~25 km — long run 14 km, over the held 10 km/);
  assert.doesNotMatch(over.headline, /above the hold/);
  // A week that built past its NUMBER is still "above the hold".
  const built = review(weeksFrom([15, 17, 19, 21, 23, 25, 28], '2026-10-26'), { weekStart: '2026-10-26' });
  assert.equal(built.weekRating, 'mixed');
  assert.match(built.headline, /above the hold/);
});

test('imperial: the distance wording of a broken hold is unit-aware ("miles", never "km") and the long-run slip says "distance"', () => {
  const r = review(weeksFrom([15, 17, 19, 21, 23, 25, 28], '2026-10-26'), { weekStart: '2026-10-26', unitSystem: 'imperial' });
  assert.doesNotMatch(`${r.headline} ${r.slip} ${r.nextWeek}`, /\bkm\b/);
  assert.match(r.slip ?? '', /^Built again instead of holding: [\d.]+ vs ~[\d.]+ mi$/);
});

test('a rebuild week 2 km short of its step (messy d138-140: the card says "one short easy run or rest, either is fine") gets no "aim for ~17 again" from the review', async () => {
  const { runTimeline } = await import('./timeline/engine');
  const snaps = runTimeline('runner_messy');
  const saturday = snaps.find(x => x.idx === 138);
  const monday = snaps.find(x => x.idx === 140);
  assert.match(plainSpaces(saturday?.card?.reasons.find(r => r.kind === 'volume')?.text ?? ''), /~2 km left: one short easy run or rest, either is fine$/);
  assert.equal(monday?.review?.review.weekRating, 'good');
  assert.equal(monday?.review?.review.win, null);
  assert.match(plainSpaces(monday?.review?.review.nextWeek ?? ''), /^Close to your step: 15 of ~17 km — ~17 again next week\. Keep rebuilding/);
  assert.doesNotMatch(plainSpaces(monday?.review?.review.nextWeek ?? ''), /aim for/);
});
