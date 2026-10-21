import assert from 'node:assert/strict';
import test from 'node:test';
import { NBSP, plainSpaces } from './displayText';
import { computeGoalProgress, type GoalProgress, type GoalProgressInput, type GoalProgressIntakeDay } from './goalProgress';
import { formatGoalProgressLines } from './goalPromptText';
import { computeWeeklyReview, type WeeklyReview } from './weeklyReview';
import { goalFallbackOpener, goalOpenerLine, requiredOpenerLine } from './brain/openerText';
import { assessWeightSignals } from './brain/weightSignals';
import { computeWeightTrend, type WeightReading } from './weightTrend';

// The weight-loss week plan is read by the card, the opener, the coach lines, the coach signals and the weekly review. These
// tests run real data through all of them and check that they cannot disagree. Day 0 is Mon 2026-03-02.
const DAY0 = '2026-03-02';
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const D = (n: number): string => addDays(DAY0, n);
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const wobble = (n: number): number => (n % 2 === 0 ? 0.08 : -0.08);
const dow = (n: number): number => (n % 7 + 7) % 7;

function readings(days: number[], kgAt: (n: number) => number): WeightReading[] {
  return days.map(n => ({ measuredAt: `${D(n)}T07:30:00.000Z`, valueKg: Math.round(kgAt(n) * 100) / 100, source: 'manual' as const, localDay: D(n) }));
}
function food(days: number[], kcalAt: (n: number) => number): GoalProgressIntakeDay[] {
  return days.map(n => ({ day: D(n), kcal: kcalAt(n), proteinG: 140, source: 'logged' as const }));
}

const BUDGET = { targetKcal: 2000, proteinG: 140, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null };

function cardAt(
  all: WeightReading[], meals: GoalProgressIntakeDay[], today: number, over: Partial<GoalProgressInput> = {},
): GoalProgress {
  const upTo = (day: string) => day <= D(today);
  return computeGoalProgress({
    goal: 'weight_loss',
    todayKey: D(today),
    target: { weightKg: 84, date: D(126), weeklySessions: 3 },
    start: { weightKg: 92, startedAt: `${D(0)}T08:00:00.000Z` },
    weightReadings: all.filter(r => upTo(r.localDay)),
    intakeDays: meals.filter(m => upTo(m.day) && m.day > D(today - 28)),
    intakeHistoryDays: meals.filter(m => upTo(m.day)),
    budget: BUDGET,
    progression: {},
    trainingDays: [],
    workouts: [],
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    ...over,
  });
}

/** The review made on Monday `monday` (for the week before), with the card of that Monday's plan. */
function reviewOn(
  all: WeightReading[], meals: GoalProgressIntakeDay[], monday: number, over: Partial<GoalProgressInput> = {},
): { card: GoalProgress; review: WeeklyReview } {
  const sunday = monday - 1;
  const card = cardAt(all, meals, monday, { ...over });
  // The job runs on the Monday morning: only the data through Sunday exists.
  const cardMorning = cardAt(all.filter(r => r.localDay <= D(sunday)), meals.filter(m => m.day <= D(sunday)), monday, over);
  const sundayCard = cardAt(all, meals, sunday, over);
  const review = computeWeeklyReview({
    goal: 'weight_loss',
    weekStart: D(monday - 7),
    verdict: sundayCard.verdict,
    weightPlan: cardMorning.weightRead?.plan ?? null,
    weightReadings: all.filter(r => r.localDay <= D(sunday)),
    intakeDays: meals.filter(m => m.day >= D(monday - 14) && m.day <= D(sunday)),
    budget: over.budget ?? BUDGET,
    trainingDays: [],
    workouts: [],
    progression: {},
    restingHr: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    weeklySessionsTarget: 3,
    targetWeightKg: 84,
    unitSystem: 'metric',
  });
  return { card, review };
}

// Down 0.1 a day to day 35, flat for four weeks (35..62), then down again; weekends 330 kcal over in the flat weeks.
const PLATEAU = readings(range(0, 130), n => (n < 35 ? 92 - 0.1 * n : n < 63 ? 88.5 : 88.5 - 0.1 * (n - 62)) + wobble(n));
const MEALS = food(range(0, 100), n => 1900 + (n >= 35 && n < 56 ? 120 : 0) + (dow(n) >= 5 ? 330 : 0) + (n % 3 === 0 ? 40 : -20));

const actionText = (p: GoalProgress): string | undefined => p.reasons.find(r => r.kind === 'action' || r.kind === 'plateau' || r.kind === 'next_step')?.text;

test('a plateau: the card, the opener, the coach and the review all give the one instruction the plan made', () => {
  const { card, review } = reviewOn(PLATEAU, MEALS, 56);
  const plan = card.weightRead?.plan;
  assert.equal(plan?.state, 'plateau');
  assert.equal(plan?.plateauCause?.kind, 'weekends');
  assert.equal(card.verdict, 'holding');
  assert.equal(card.weightRead?.state, 'plateau');
  assert.equal(actionText(card), plan?.action.text);
  assert.equal(review.nextWeek, plan?.action.text, 'the review says what the card says');
  assert.equal(review.verdict, card.verdict);
  const coach = formatGoalProgressLines(card, 'metric').join('\n');
  assert.ok(coach.includes(plainSpaces(plan?.action.text ?? '')), coach);
  assert.match(coach, /name the weekends/);
  assert.doesNotMatch(coach, /often water/);
  assert.match(plainSpaces(review.nextWeek), /^Weekends averaged ~2,\d{3} kcal vs 2,0\d0 on weekdays/);
});

test('moving again: no date, no "behind", no trim — on the card, in the opener, in the coach lines and in the review', () => {
  for (const monday of [70, 77]) {
    const { card, review } = reviewOn(PLATEAU, MEALS, monday);
    assert.equal(card.weightRead?.plan?.state, 'moving_again', `week of ${monday}`);
    assert.equal(card.verdict, 'progressing');
    assert.match(plainSpaces(card.headline), /^Moving again — (weekly average|scale) down \d(\.\d)? kg from the plateau$/);
    assert.equal(card.eta, null);
    assert.equal(card.ratePerWeek.kg, null);
    const text = card.reasons.map(r => r.text).join(' | ');
    assert.doesNotMatch(text, /behind|trim|date/i);
    assert.equal(card.reasons.find(r => r.kind === 'action')?.text, 'Keep doing what restarted it');
    assert.equal(card.weightRead?.weeksVsTarget, null);
    const opener = goalOpenerLine(card, 'metric') ?? '';
    assert.match(opener, /and your weekly average is moving down again\.$/);
    assert.doesNotMatch(opener, /behind|ahead|on pace/);
    const coach = formatGoalProgressLines(card, 'metric').join('\n');
    assert.match(coach, /moving again after a plateau: no projected date, never "behind", no calorie cut/);
    assert.match(coach, /This week's plan.*Keep doing what restarted it/);
    assert.equal(review.nextWeek, 'Keep doing what restarted it');
  }
});

test('far behind: the date is not quoted — "the Jul 6 date won\'t hold" — and every surface says the same action', () => {
  const slow = readings(range(0, 130), n => 92 - 0.035 * n + wobble(n));
  const { card, review } = reviewOn(slow, MEALS, 49);
  const plan = card.weightRead?.plan;
  assert.equal(plan?.farBehind, true);
  assert.equal(card.verdict, 'behind');
  assert.equal(card.eta, null);
  assert.equal(card.onPaceForTargetDate, false);
  assert.equal(card.headline, "Behind pace — at this rate the Jul 6 date won't hold");
  assert.equal(card.weightRead?.weeksVsTarget, null);
  assert.equal(plainSpaces(actionText(card) ?? ''), 'Move the date or trim ~150 kcal a day (to ~1,850 kcal)');
  assert.equal(review.nextWeek, plan?.action.text);
  const opener = goalOpenerLine(card, 'metric') ?? '';
  assert.match(opener, /, but at this rate your Jul 6 date won't hold\.$/);
  assert.doesNotMatch(opener, /weeks? behind/);
  const coach = formatGoalProgressLines(card, 'metric').join('\n');
  assert.match(coach, /more than 8 weeks past the target date: do not quote a projected date/);
  assert.match(coach, /This week's plan.*Move the date or trim/);
});

test('the opener says "weekly average" for the 7-day mean and "on the scale" only for a single reading', () => {
  const early = cardAt(readings(range(0, 7), n => 92 - 0.1 * n), [], 7);
  assert.equal(early.weightRead?.state, 'early');
  assert.match(plainSpaces(early.headline), /^Early read — weekly average down \d(\.\d)? kg in 7 days$/);
  assert.match(goalOpenerLine(early, 'metric') ?? '', /down on your weekly average; your pace settles after 3 weeks\.$/);
  // Two weigh-ins in the week: no weekly average yet, so the latest reading is the number and the words say so.
  const sparse = cardAt(readings([0, 1, 3, 8], n => 92 - 0.1 * n), [], 8);
  assert.equal(sparse.weightRead?.weekMeanKg, null);
  assert.match(plainSpaces(sparse.headline), /^Early read — down \d(\.\d)? kg on the scale in 8 days$/);
  assert.match(goalOpenerLine(sparse, 'metric') ?? '', /down on the scale; your pace settles after 3 weeks\.$/);
});

test('one displayed weight: current.weightKg is the weekly average (the chart trend moves to trendKg) and no reason prints a trend number', () => {
  const steady = readings(range(0, 60), n => 92 - 0.12 * n + (n === 60 ? 0.8 : 0));
  const card = cardAt(steady, [], 60);
  const mean = card.weightRead?.weekMeanKg;
  assert.ok(mean != null);
  assert.equal(card.current.weightKg, mean);
  assert.ok(card.current.trendKg != null && card.current.trendKg !== mean, 'the lagging trend is its own number');
  assert.equal(card.current.changeKg, Math.round((mean - 92) * 10) / 10);
  assert.ok(!card.reasons.some(r => /[Tt]rend \d/.test(r.text)));
  const coach = formatGoalProgressLines(card, 'metric').join('\n');
  assert.match(coach, /weekly average [\d.]+ kg \(the one weight to quote/);
  assert.doesNotMatch(coach, /trend [\d.]+ kg/);
  // A goal reached: the displayed weight sits beside "Goal reached", not the 0.9 kg higher trend.
  const reached = readings(range(0, 102), n => (n < 80 ? 92 - 0.1 * n : 84 + wobble(n)));
  const done = cardAt(reached, [], 102);
  assert.equal(done.verdict, 'reached');
  assert.ok(Math.abs((done.current.weightKg as number) - 84) < 0.3, String(done.current.weightKg));
});

test('the pace tone: "above the ceiling" and the watch colour belong to the too-fast call alone', () => {
  // Not too fast (a pace that only just reached 1.02% a week, one week old): the top of the band, not a warning.
  const brisk = readings(range(0, 40), n => 92 - 0.14 * n);
  const card = cardAt(brisk, [], 38, { target: { weightKg: 60, date: D(400), weeklySessions: 3 } });
  const rate = card.reasons.find(r => r.kind === 'rate');
  assert.ok(rate, JSON.stringify(card.reasons));
  if (card.verdict !== 'too_fast') {
    assert.doesNotMatch(rate.text, /above the 1% a week ceiling/);
    assert.notEqual(rate.tone, 'watch');
  }
});

test('reached: "Set a new target or switch to maintenance" for 7 days after the target, then not every day', () => {
  const reached = readings(range(0, 130), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const shows = (n: number) => cardAt(reached, [], n).reasons.some(r => r.text === 'Set a new target or switch to maintenance');
  const first = cardAt(reached, [], 80);
  assert.equal(first.verdict, 'reached');
  assert.ok(first.reachedAt != null);
  const reachedDay = range(40, 80).find(n => D(n) === first.reachedAt) as number;
  for (const n of range(reachedDay, reachedDay + 7)) assert.equal(shows(n), true, `day +${n - reachedDay}`);
  for (const n of range(reachedDay + 8, reachedDay + 30)) assert.equal(shows(n), false, `day +${n - reachedDay}`);
});

test('held for two weeks on logged intake: the maintenance target is that intake — card and review', () => {
  const reached = readings(range(0, 130), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const meals = food(range(0, 130), n => 2050 + (n % 2 === 0 ? 40 : -40));
  const { card, review } = reviewOn(reached, meals, 84);
  assert.equal(card.verdict, 'reached');
  assert.equal(card.weightRead?.plan?.state, 'maintenance');
  assert.equal(plainSpaces(card.reasons.find(r => r.kind === 'next_step')?.text ?? ''), "You've held about 84 kg on ~2,050 kcal — make that your maintenance target");
  assert.equal(review.nextWeek, card.weightRead?.plan?.action.text);
  assert.doesNotMatch(review.nextWeek, /Switch to maintenance in Goals/);
  assert.equal(plainSpaces(goalOpenerLine(card, 'metric') ?? ''), "You've held about 84 kg on ~2,050 kcal — make that your maintenance target.");
  assert.equal(requiredOpenerLine(card, 'weight_loss', 'metric'), goalOpenerLine(card, 'metric'));
  assert.equal(goalFallbackOpener(card, 'weight_loss', 'metric')?.startsWith("You've held"), true);
  // NBSP between the number and its unit, in the card's own copy.
  assert.ok(card.reasons.some(r => r.text.includes(`2,050${NBSP}kcal`)));
});

test('after the first week a reached goal is told to hold, not to "switch to maintenance"', () => {
  const reached = readings(range(0, 130), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const { review } = reviewOn(reached, [], 77);
  assert.match(plainSpaces(review.nextWeek), /^Keep weighing in a few mornings a week; if your average drifts 1 kg above your target, that is your cue to act\.$/);
});

test('the coach signals follow the plan: "plateau" only in a plateau week, "too fast" only while the call is on', () => {
  const at = (today: number) => {
    const card = cardAt(PLATEAU, MEALS, today);
    const trend = computeWeightTrend(PLATEAU.filter(r => r.localDay <= D(today)));
    const signals = (weekPlan?: { state: string; tooFast: boolean } | null) => assessWeightSignals({
      trend, dailyIntakeKcal: [], floorKcal: 1500, goal: 'weight_loss', todayKey: D(today), goalStartDay: D(0), weekPlan,
    }).map(s => s.kind);
    return { card, daily: signals(undefined), planned: signals(card.weightRead?.plan) };
  };
  // Day 52: the scale has been flat 3 weeks as of today, but the week's plan (made from Sunday 48) has not named a plateau.
  const early = at(52);
  // (Wave 22w: day 52 is a flat fortnight - two flat weeks after a confirmed loss - which the card calls a calm hold, not a plateau.)
  assert.equal(early.card.weightRead?.state, 'plateau');
  assert.equal(early.card.weightRead?.plan?.flatWeeks, 2);
  assert.ok(early.daily.includes('plateau'), 'read from today\'s scale the plateau is already there');
  assert.ok(!early.planned.includes('plateau'), 'the coach says what the card says');
  // Day 57: the plan names it.
  assert.ok(at(57).planned.includes('plateau'));
});

test('a review that has no plan keeps its own tips (older callers, tests)', () => {
  const sundayCard = cardAt(PLATEAU, MEALS, 55);
  const withoutPlan = computeWeeklyReview({
    goal: 'weight_loss', weekStart: D(49), verdict: sundayCard.verdict,
    weightReadings: PLATEAU.filter(r => r.localDay <= D(55)), intakeDays: MEALS.filter(m => m.day >= D(42) && m.day <= D(55)),
    budget: BUDGET, trainingDays: [], workouts: [], progression: {}, restingHr: [], sleepMinutes: [], sleepGoalMinutes: 480,
    weeklySessionsTarget: 3, unitSystem: 'metric',
  });
  assert.equal(withoutPlan.verdict, sundayCard.verdict);
  assert.ok(withoutPlan.nextWeek.length > 0);
});

test('a reached goal whose calorie target already is maintenance is told to keep it — card and review say the same', () => {
  const reached = readings(range(0, 130), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const first = cardAt(reached, [], 80);
  const reachedDay = range(40, 80).find(n => D(n) === first.reachedAt) as number;
  const monday = reachedDay + (7 - dow(reachedDay)); // the Monday after the reach: inside its first week or just after
  const maintenance = { ...BUDGET, targetKcal: 2300, formulaTdee: 2350 };
  const { card, review } = reviewOn(reached, [], monday, { budget: maintenance });
  const text = 'Your calorie target is already at maintenance — keep it there and the weight should hold.';
  if (card.weightRead?.plan?.state === 'reached') {
    assert.equal(card.reasons.find(r => r.kind === 'next_step')?.text, text);
    assert.equal(plainSpaces(review.nextWeek), text);
  }
  // On a deficit budget the same week says to set a new target or switch.
  const deficit = cardAt(reached, [], reachedDay + 1, { budget: { ...BUDGET, formulaTdee: 2350 } });
  assert.equal(deficit.reasons.find(r => r.kind === 'next_step')?.text, 'Set a new target or switch to maintenance');
});
