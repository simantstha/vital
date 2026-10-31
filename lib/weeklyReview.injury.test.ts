/**
 * Wave 27 - the weekly review's "Next week" carries the same injury check-in line as the goal card, after the plan
 * (never instead of it).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWeeklyReview, type WeeklyReviewInput } from './weeklyReview';
import { injuryCheckInLine } from './injuryCheckIn';

const WEEK_START = '2026-10-19'; // Monday; the review runs on 2026-10-26
const INJURY = { text: 'knee pain', since: '2026-10-24' };

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const run = (day: string, km: number) => ({ day, durationMin: Math.round(km * 6), distanceKm: km, type: 'Running' });

function base(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  const workouts = [1, 3, 5, 6].map((d, i) => run(addDays(WEEK_START, d), i === 3 ? 12 : 6))
    .concat([1, 3, 5, 6].map((d, i) => run(addDays(WEEK_START, d - 7), i === 3 ? 10 : 5)));
  return {
    goal: 'endurance',
    weekStart: WEEK_START,
    verdict: 'building',
    weightReadings: [],
    intakeDays: [],
    budget: null,
    trainingDays: workouts.map(w => w.day),
    workouts,
    progression: {},
    restingHr: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    weeklySessionsTarget: null,
    weeklyDistanceKmTarget: 30,
    signupDay: '2026-06-01',
    ...over,
  };
}

test('endurance: no injury -> Next week has no check-in', () => {
  const r = computeWeeklyReview(base());
  assert.doesNotMatch(r.nextWeek, /You noted|professional/);
});

test('endurance: an active injury appends the card\'s exact line after the plan, leaving the rest of the review alone', () => {
  const plain = computeWeeklyReview(base());
  const r = computeWeeklyReview(base({ activeInjury: INJURY }));
  const line = injuryCheckInLine('endurance', INJURY);
  assert.equal(r.nextWeek, `${plain.nextWeek} ${line}`);
  assert.deepEqual({ ...r, nextWeek: '' }, { ...plain, nextWeek: '' });
});

test('muscle gets the strength wording; weight loss gets nothing; general only with training cues', () => {
  const muscle = computeWeeklyReview(base({ goal: 'muscle', weeklySessionsTarget: 3, strengthDays: base().trainingDays, activeInjury: INJURY }));
  assert.ok(muscle.nextWeek.endsWith(injuryCheckInLine('muscle', INJURY)), muscle.nextWeek);
  const loss = computeWeeklyReview(base({ goal: 'weight_loss', activeInjury: INJURY }));
  assert.doesNotMatch(loss.nextWeek, /You noted/);
  const noCues = computeWeeklyReview(base({ goal: 'general', trainingDays: [], workouts: [], weeklySessionsTarget: null, activeInjury: INJURY }));
  assert.doesNotMatch(noCues.nextWeek, /You noted/);
  const cues = computeWeeklyReview(base({ goal: 'general', weeklySessionsTarget: 3, activeInjury: INJURY }));
  assert.ok(cues.nextWeek.endsWith(injuryCheckInLine('general', INJURY)), cues.nextWeek);
});

test('a thin-data review keeps the line too (it still tells the user what to do next week)', () => {
  const r = computeWeeklyReview(base({ trainingDays: [], workouts: [], activeInjury: INJURY }));
  assert.ok(r.nextWeek.endsWith(injuryCheckInLine('endurance', INJURY)), r.nextWeek);
});

test('last week\'s stored tip is compared without its injury line, so a tip is still never repeated two weeks running', () => {
  const plain = computeWeeklyReview(base({ goal: 'weight_loss' }));
  const withTip = computeWeeklyReview(base({ goal: 'weight_loss', previousNextWeek: `${plain.nextWeek} ${injuryCheckInLine('endurance', INJURY)}` }));
  const without = computeWeeklyReview(base({ goal: 'weight_loss', previousNextWeek: plain.nextWeek }));
  assert.equal(withTip.nextWeek, without.nextWeek);
});
