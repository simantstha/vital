import assert from 'node:assert/strict';
import test from 'node:test';
import { plainSpaces } from './displayText';
import {
  calorieFloorKcal, isInstruction, TRIM_MAX_KCAL_PER_STEP, TRIM_STEP_KCAL, weightWeekPlan, type WeightPlanInput, type WeightWeekPlan,
} from './weightWeekPlan';
import { computeWeightTrend, type WeightReading } from './weightTrend';

// Day 0 is Mon 2026-03-02; day n is n days later. Weeks start on the Mondays 0, 7, 14, ...
const DAY0 = '2026-03-02';

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const D = (n: number): string => addDays(DAY0, n);
const dow = (n: number): number => (n % 7 + 7) % 7; // Mon = 0

function reading(n: number, kg: number): WeightReading {
  return { measuredAt: `${D(n)}T07:30:00.000Z`, valueKg: Math.round(kg * 100) / 100, source: 'manual', localDay: D(n) };
}

/** One weigh-in on each listed day (day numbers) with the weight `kgAt(n)`. */
function readings(days: number[], kgAt: (n: number) => number): WeightReading[] {
  return days.map(n => reading(n, kgAt(n)));
}
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const wobble = (n: number): number => (n % 2 === 0 ? 0.08 : -0.08);

/** The plan a user sees on day `today` (readings through that day only). */
function planAt(all: WeightReading[], today: number, over: Partial<WeightPlanInput> = {}): WeightWeekPlan {
  const days = computeWeightTrend(all.filter(r => r.localDay <= D(today))).days;
  const plan = weightWeekPlan({
    todayKey: D(today),
    days,
    startDay: D(0),
    startKg: 92,
    targetKg: 84,
    targetDate: D(126),
    reached: false,
    reachedAt: null,
    intakeDays: [],
    targetKcal: 2000,
    floorKcal: 1500,
    weeklySessions: 3,
    ...over,
  });
  assert.ok(plan, `a plan on day ${today}`);
  return plan as WeightWeekPlan;
}

/** What must not change inside a week. */
function decision(p: WeightWeekPlan): string {
  return JSON.stringify({ state: p.state, call: p.call, etaDate: p.etaDate, weeksVsTarget: p.weeksVsTarget, action: p.action, cause: p.plateauCause?.kind ?? null, verdict: p.verdict });
}

/** The user's food log: a day's kcal from a function of the day number. */
function intake(days: number[], kcalAt: (n: number) => number) {
  return days.map(n => ({ day: D(n), kcal: kcalAt(n), source: 'logged' as const }));
}

// Falls 0.08 kg a day (0.56 kg/wk) from 92, weighed daily.
const STEADY = readings(range(0, 100), n => 92 - 0.08 * n + wobble(n));

test('the plan is decided once a week: the same call, date and action on every day of a week, changing only on the Monday', () => {
  // A slowing loss (so the pace, and with it the date, moves every day under a daily read).
  const slowing = readings(range(0, 100), n => (n < 35 ? 92 - 0.12 * n : 92 - 0.12 * 35 - 0.025 * (n - 35)) + wobble(n));
  for (const monday of [28, 35, 42, 49, 56]) {
    const week = range(monday, monday + 6).map(n => planAt(slowing, n));
    for (const p of week) assert.equal(decision(p), decision(week[0]), `day ${monday}..: ${p.action.text}`);
    assert.equal(week[0].weekStart, D(monday));
  }
  // ...and it does change from one week to the next.
  const decisions = new Set([28, 35, 42, 49, 56].map(m => decision(planAt(slowing, m))));
  assert.ok(decisions.size > 1);
});

test('the first days of a goal are an early read as of the goal start; the pace comes from the Monday after the 3 weeks', () => {
  const early = planAt(STEADY, 5);
  assert.equal(early.state, 'early');
  assert.equal(early.asOf, D(0), 'as of the goal start');
  assert.equal(early.young, true);
  assert.equal(early.etaDate, null);
  assert.equal(early.call, 'none');
  assert.equal(planAt(STEADY, 20).state, 'early', 'still inside the first 3 weeks on Sunday of week 3');
  const first = planAt(STEADY, 21);
  assert.equal(first.state, 'pace');
  assert.equal(first.confirmed, false);
  assert.equal(first.verdict, 'progressing');
  assert.equal(first.firstPaceWeek, true);
});

test('the date shows once another week confirms the pace — and the countdown names the actual Monday', () => {
  const first = planAt(STEADY, 24); // Thursday of week 4 (days 21..27)
  assert.equal(first.action.kind, 'confirm_pace');
  assert.equal(plainSpaces(first.action.text), 'Your projected date shows on Mon, Mar 30 once another week of weigh-ins confirms this pace');
  assert.equal(first.etaDate, null);
  // That Monday it does show.
  const next = planAt(STEADY, 28);
  assert.equal(next.confirmed, true);
  assert.ok(next.etaDate != null || next.call === 'on_pace' || next.call === 'ahead');
  assert.equal(next.firstPaceWeek, false);
  assert.equal(isInstruction(first.action), false);
});

test('ahead / on pace: keep your routine — no calorie instruction', () => {
  const p = planAt(STEADY, 42, { targetDate: D(126) });
  assert.ok(p.call === 'on_pace' || p.call === 'ahead', p.call);
  assert.equal(p.action.kind, 'keep_going');
  assert.equal(isInstruction(p.action), false);
});

// A plateau: down 0.1 a day to day 35, flat for 4 weeks (days 35..62), then down again.
const PLATEAU = readings(range(0, 100), n => (n < 35 ? 92 - 0.1 * n : n < 63 ? 88.5 : 88.5 - 0.1 * (n - 62)) + wobble(n));

// A slow, steady loss (0.25 kg/wk): 6.5 kg to go at day 42 is a projection far past a date at day 126.
const SLOW = readings(range(0, 100), n => 92 - 0.035 * n + wobble(n));

/** A user who logs food (about 2,000 kcal a day from day 20): a calorie trim can be checked. One who logs none is told activity and logging first (wave 22w). */
const LOGGER = intake(range(20, 100), n => 1980 + (n % 3) * 20);

test('a pace slow enough to put the date more than 8 weeks out quotes no date: the date will not hold', () => {
  const p = planAt(SLOW, 49, { intakeDays: LOGGER });
  assert.equal(p.state, 'pace');
  assert.equal(p.call, 'behind');
  assert.equal(p.farBehind, true);
  assert.equal(p.etaDate, null);
  assert.equal(p.weeksVsTarget, null);
  assert.equal(p.onPace, false);
  // The action never names the month the pace projects to - only that the date moves.
  assert.equal(plainSpaces(p.action.text), 'Move the date or trim ~150 kcal a day (to ~1,850 kcal)');
  assert.equal(p.action.kcalTarget, 1850);
  assert.equal(p.action.kind, 'trim');
  // A user who logs no food gets activity and logging first, not a trim there is nothing to check against.
  const noLogs = planAt(SLOW, 49);
  assert.equal(noLogs.action.kind, 'move_date');
  assert.equal(plainSpaces(noLogs.action.text), 'Move the date, or add two 30-minute walks and log a few days so we can see where the calories go');
  assert.equal(noLogs.action.kcalTarget, undefined);
});

test('the trim is ONE step (TRIM_STEP_KCAL): never over 200 kcal, and never under the calorie floor', () => {
  assert.equal(TRIM_STEP_KCAL, 150);
  assert.ok(TRIM_STEP_KCAL <= TRIM_MAX_KCAL_PER_STEP);
  const at = (over: Partial<WeightPlanInput>) => planAt(SLOW, 49, { intakeDays: LOGGER, ...over });
  // A budget 100 over the floor: the step shrinks to what the floor allows.
  const near = at({ targetKcal: 1600, floorKcal: 1500 });
  assert.equal(plainSpaces(near.action.text).match(/trim ~(\d+) kcal/)?.[1], '100');
  assert.equal(near.action.kcalTarget, 1500);
  // On the floor: only the date moves.
  const onFloor = at({ targetKcal: 1500, floorKcal: 1500 });
  assert.equal(onFloor.action.kind, 'move_date');
  assert.equal(onFloor.action.kcalTarget, undefined);
  assert.equal(plainSpaces(onFloor.action.text), 'Move the date — your calories are already near the 1,500 kcal floor');
  // No floor on the budget: 1,500 for men, 1,200 for women, 1,400 when the profile says neither.
  assert.equal(calorieFloorKcal(0, 'male'), 1500);
  assert.equal(calorieFloorKcal(null, 'female'), 1200);
  assert.equal(calorieFloorKcal(undefined, null), 1400);
  assert.equal(calorieFloorKcal(1350, 'male'), 1350, "the budget's own floor wins");
  assert.equal(plainSpaces(at({ targetKcal: 1450, floorKcal: 0, sex: 'female' }).action.text).match(/trim ~(\d+) kcal/)?.[1], '150');
  assert.equal(plainSpaces(at({ targetKcal: 1450, floorKcal: 0, sex: 'male' }).action.kind), 'move_date');
  // No budget at all: the step is named without a target to land on.
  const none = at({ targetKcal: null });
  assert.match(plainSpaces(none.action.text), /trim ~150 kcal a day$/);
  assert.equal(none.action.kcalTarget, undefined);
});

test('the trim does not move from one day to the next inside a week, and is a step per week, not a sum', () => {
  const week = range(49, 55).map(n => planAt(SLOW, n, { intakeDays: LOGGER }));
  assert.equal(new Set(week.map(p => p.action.text)).size, 1);
});

const FOOD_PLATEAU = intake(range(0, 70), n => 1900 + (n >= 35 && n < 56 ? 120 : 0) + (dow(n) >= 5 ? 330 : 0) + (n % 3 === 0 ? 40 : -20));

test('a plateau is named from the logs of its own three weeks: weekends 300+ kcal over name the weekends', () => {
  const p = planAt(PLATEAU, 56, { intakeDays: FOOD_PLATEAU });
  assert.equal(p.state, 'plateau');
  assert.equal(p.verdict, 'holding');
  assert.equal(p.plateauCause?.kind, 'weekends');
  assert.match(plainSpaces(p.action.text), /^Weekends averaged ~2,\d{3} kcal vs 2,0\d0 on weekdays — bring the weekends back toward your 2,000 kcal target first; if still flat 2 weeks after that, trim ~150 kcal a day$/);
  assert.equal(p.action.kind, 'plateau_weekends');
  assert.ok(p.plateauMeanKg != null && Math.abs(p.plateauMeanKg - 88.5) < 0.3);
});

test('logged days within 150 kcal of the target are not blamed; without a weekend gap it is the plain "often water" plateau', () => {
  const flatFood = intake(range(0, 70), n => 2000 + (n % 2 === 0 ? 60 : -40));
  const p = planAt(PLATEAU, 56, { intakeDays: flatFood });
  assert.equal(p.plateauCause?.kind, 'water');
  assert.equal(plainSpaces(p.action.text), 'Common and often water: keep 2,000 kcal and 3 sessions; if still flat in 2 weeks, trim ~150 kcal a day or add two 30-minute walks');
});

test('logged days averaging over the target by more than 150 kcal lead with the logs', () => {
  const heavy = intake(range(0, 70), n => 2260 + (n % 2 === 0 ? 60 : -40));
  const p = planAt(PLATEAU, 56, { intakeDays: heavy });
  assert.equal(p.plateauCause?.kind, 'intake');
  assert.match(plainSpaces(p.action.text), /^Logged days averaged ~2,2\d0 kcal vs your 2,000 kcal target — getting back to target is the first lever; if still flat 2 weeks after that, trim ~150 kcal a day$/);
  assert.equal(p.plateauCause?.targetKcal, 2000);
});

test('fewer than 8 logged days in the plateau\'s span name no cause: water', () => {
  const thin = intake([50, 52, 54, 55], () => 2600);
  assert.equal(planAt(PLATEAU, 56, { intakeDays: thin }).plateauCause?.kind, 'water');
});

test('the cause, once named, is kept for the rest of the plateau — whatever the later logs say', () => {
  // The logs of the plateau's first week name the weekends; afterwards the user logs light weekends and heavy weekdays.
  const food = [
    ...FOOD_PLATEAU,
    ...intake(range(56, 70), n => (dow(n) >= 5 ? 1800 : 2350)),
  ];
  const flatLonger = readings(range(0, 100), n => (n < 35 ? 92 - 0.1 * n : 88.5) + wobble(n));
  const first = planAt(flatLonger, 56, { intakeDays: food });
  assert.equal(first.plateauCause?.kind, 'weekends');
  for (const monday of [63, 70]) {
    const later = planAt(flatLonger, monday, { intakeDays: food });
    assert.equal(later.state, 'plateau');
    assert.equal(later.plateauCause?.kind, 'weekends', `week of day ${monday}`);
    assert.equal(later.action.text, first.action.text, `week of day ${monday}`);
  }
});

test('moving again: the 14 days after a plateau ends say so — no date, no "behind", no trim', () => {
  assert.equal(planAt(PLATEAU, 63).state, 'plateau', 'the Sunday before still has the flat weeks');
  const moving = [planAt(PLATEAU, 70), planAt(PLATEAU, 77)];
  for (const p of moving) {
    assert.equal(p.state, 'moving_again', `week of ${p.weekStart}`);
    assert.equal(p.verdict, 'progressing');
    assert.equal(p.call, 'none');
    assert.equal(p.etaDate, null);
    assert.equal(p.pace, null);
    assert.equal(p.action.text, 'Keep doing what restarted it');
    assert.equal(p.action.kind, 'keep_what_worked');
    assert.equal(p.action.kcalTarget, undefined);
    assert.ok(p.plateauMeanKg != null && Math.abs(p.plateauMeanKg - 88.5) < 0.3);
  }
  // Two weeks on it is an ordinary pace again.
  assert.equal(planAt(PLATEAU, 84).state, 'pace');
});

test('welcome back: a gap of 7+ days is an event that can enter mid-week, and ends with the third weigh-in back', () => {
  const pre = readings(range(0, 59), n => 92 - 0.07 * n);
  const gap = (back: number[]) => [...pre, ...readings(back, () => 92 - 0.07 * 59 - 1.4)];
  // Monday 70 is a plan week whose Sunday (69) had no weigh-ins since day 59: the first one back (Wednesday) is the event.
  const before = planAt(gap([]), 71);
  assert.notEqual(before.state, 'returning');
  const first = planAt(gap([72]), 72);
  assert.equal(first.state, 'returning');
  assert.equal(first.pace, null);
  assert.equal(first.etaDate, null);
  // The colour from before the gap is kept (wave 22w); never behind or too fast.
  assert.ok(['progressing', 'holding', 'on_track', 'ahead'].includes(first.verdict), first.verdict);
  assert.equal(planAt(gap([72, 73]), 73).state, 'returning');
  // The third weigh-in back ends it, and the plan is made as of that day.
  const third = planAt(gap([72, 73, 74]), 74);
  assert.notEqual(third.state, 'returning');
  assert.equal(third.asOf, D(74));
});

test('"losing too fast" entering is an event: it may start mid-week, once, and is kept to the next Monday', () => {
  // A month at 1.3 kg/wk... starting on day 36 so the Sunday (day 41) plan has not got there yet.
  const fast = readings(range(0, 60), n => (n < 36 ? 92 - 0.07 * n : 92 - 0.07 * 36 - 0.26 * (n - 36)));
  const states = range(42, 48).map(n => planAt(fast, n, { targetKg: 70, targetDate: D(300) }));
  const changes = states.filter((p, i) => i > 0 && decision(p) !== decision(states[i - 1])).length;
  assert.ok(changes <= 1, states.map(p => `${p.call}/${p.asOf}`).join(' '));
  const sixty = planAt(fast, 60, { targetKg: 70, targetDate: D(300) });
  assert.equal(sixty.call, 'too_fast');
  assert.equal(sixty.verdict, 'too_fast');
  assert.equal(sixty.action.kind, 'eat_to_target');
  assert.equal(plainSpaces(sixty.action.text), 'Eat up to your full 2,000 kcal target — a slower loss is easier to keep');
  assert.equal(sixty.action.kcalTarget, 2000);
});

test('within a kilo of the target a too-fast loss is "nearly there": ease toward maintenance - the step is given once', () => {
  const fast = readings(range(0, 60), n => 92 - 0.19 * n);
  const over = { targetKg: 82.5, targetDate: D(80) };
  // Someone who logs food (every other day, so never "8 days held" below) is given the step as a number - and, from the step on, eats it (wave 24w:
  // the standing level reads the food log, so "the step you started" needs logs at the level since the day it began).
  const logs = intake(range(28, 60).filter(n => n % 2 === 0), n => (n < 48 ? 2000 : 2150));
  const p = planAt(fast, 48, { ...over, intakeDays: logs }); // Sunday 48: within a kilo - the event that gives the step
  assert.equal(p.nearlyThere, true);
  assert.equal(p.action.kind, 'ease_to_maintenance');
  // The step is a number (wave 22w): from the 2,000 kcal budget, 150-200 kcal a day, then watch the weekly average.
  assert.equal(plainSpaces(p.action.text), 'Start easing calories toward maintenance as you close in on 82.5 kg — add ~150–200 kcal a day (to ~2,150–2,200 kcal) and watch the weekly average for 2 weeks');
  assert.equal(p.action.kcalTarget, 2150);
  assert.notEqual(p.verdict, 'too_fast');
  assert.deepEqual(p.step, { since: D(48), readOn: D(63), phase: 'given', outcome: null, loKcal: 2150, hiKcal: 2200, food: false });
  // From the next day it is a standing level, not the same sentence again (wave 23w) - and it is read on the first Monday 14+ days on.
  for (const n of [49, 52, 56, 62]) {
    const standing = planAt(fast, n, { ...over, intakeDays: logs });
    // (The first standing week has only the step's own Sunday logged: too few days to claim it - wave 24w; the week after has 4.)
    const text = n < 56 ? 'Aim for ~2,150–2,200 kcal a day; we\'ll read it on Mon, May 4' : 'Stay at ~2,150–2,200 kcal (the step you started Apr 19); we\'ll read it on Mon, May 4';
    assert.equal(plainSpaces(standing.action.text), text, `day ${n}`);
    assert.equal(standing.action.kind, 'ease_to_maintenance');
    assert.equal(standing.action.kcalTarget, 2150);
    assert.equal(standing.step?.phase, 'standing');
    assert.equal(isInstruction(standing.action), true);
  }
  // Someone who logs no food is given a food, never a calorie number (wave 23w).
  const food = planAt(fast, 48, over);
  assert.equal(food.action.kind, 'ease_to_maintenance');
  assert.equal(plainSpaces(food.action.text), 'Start easing calories toward maintenance as you close in on 82.5 kg — add a ~150–200 kcal snack a day (e.g. yogurt and fruit) and watch the weekly average for 2 weeks');
  assert.equal(food.action.kcalTarget, undefined);
  assert.equal(food.step?.food, true);
  assert.equal(food.step?.loKcal, null);
  assert.equal(plainSpaces(planAt(fast, 50, over).action.text), 'Keep the daily snack (the step you started Apr 19); we\'ll read it on Mon, May 4');
});

test('reached: "set a new target or switch to maintenance" for the first 7 days, then maintenance — not asked daily; the step is said once', () => {
  const calm = readings(range(0, 100), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const reachedAt = D(62);
  const logs = intake(range(40, 100).filter(n => n % 2 === 0), n => (n < 62 ? 2000 : 2150)); // logs food, but never 8 days of 14; eats the step from day 62 (wave 24w)
  const planOn = (n: number, over: Partial<WeightPlanInput> = {}) => planAt(calm, n, { reached: true, reachedAt, intakeDays: logs, ...over });
  // The reach day: the question, with the step in full - and why it is asked ("you no longer need a deficit").
  const reach = planOn(62);
  assert.equal(reach.state, 'reached');
  assert.equal(reach.action.kind, 'next_target');
  assert.equal(plainSpaces(reach.action.text), 'Set a new target or switch to maintenance — you no longer need a deficit, so add ~150–200 kcal a day (to ~2,150–2,200 kcal) and watch the weekly average for 2 weeks');
  assert.equal(reach.verdict, 'reached');
  // The week after still asks, but the step is a level to stay at - it is not said again.
  for (const n of range(63, 69)) {
    const p = planOn(n);
    assert.equal(p.state, 'reached', `day ${n}`);
    assert.equal(p.action.kind, 'next_target');
    // (Only the reach day itself is logged since the step began: too few days to claim it was taken.)
    assert.equal(plainSpaces(p.action.text), 'Set a new target or switch to maintenance — aim for ~2,150–2,200 kcal a day; we\'ll read it on Mon, May 18', `day ${n}`);
    assert.equal(p.verdict, 'reached');
  }
  for (const n of range(70, 76)) {
    const p = planOn(n);
    assert.equal(p.state, 'maintenance', `day ${n}`);
    assert.notEqual(p.action.kind, 'next_target');
    assert.equal(plainSpaces(p.action.text), 'Stay at ~2,150–2,200 kcal (the step you started May 3); we\'ll read it on Mon, May 18', `day ${n}`);
  }
});

test('P2-6: the step is a number - from the budget (capped at the TDEE estimate), or only the amounts without a budget; a budget already at maintenance keeps it', () => {
  const calm = readings(range(0, 140), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const logs = intake(range(40, 140).filter(n => n % 2 === 0), () => 2000);
  const at = (n: number, over: Partial<WeightPlanInput> = {}) => planAt(calm, n, { reached: true, reachedAt: D(62), intakeDays: logs, ...over });
  const lead = 'Set a new target or switch to maintenance — you no longer need a deficit, so add';
  // A learned TDEE (or the formula) caps the landing: 2,150 kcal of maintenance leaves one 150 kcal step.
  const capped = at(62, { learnedTdee: 2150, formulaTdee: 2500 });
  assert.equal(plainSpaces(capped.action.text), `${lead} ~150 kcal a day (to ~2,150 kcal) and watch the weekly average for 2 weeks`);
  assert.equal(capped.action.kcalTarget, 2150);
  // The learned estimate wins over the formula.
  assert.match(plainSpaces(at(62, { learnedTdee: 2400, formulaTdee: 2100 }).action.text), /\(to ~2,150–2,200 kcal\)/);
  // No budget: only the amounts.
  assert.equal(plainSpaces(at(62, { targetKcal: null }).action.text), `${lead} ~150–200 kcal a day and watch the weekly average for 2 weeks`);
  // A budget that already is maintenance has no step: it keeps it, and the watch is two-sided.
  const askingAlready = at(62, { formulaTdee: 2050 });
  assert.equal(askingAlready.action.kind, 'hold');
  assert.equal(askingAlready.step, null);
  const already = at(77, { formulaTdee: 2050 });
  assert.equal(already.action.kind, 'hold');
  assert.match(plainSpaces(already.action.text), /^Your calorie target is already at maintenance — keep it there and watch the weekly average; a drift of 1 kg above or below your target is your cue to act\.$/);
  // Imperial users read lb in the cue.
  assert.match(plainSpaces(at(98, { unitSystem: 'imperial' }).action.text), /drifts 2\.2 lb above or below your target/);
  // One thing all week.
  assert.equal(new Set(range(77, 83).map(n => at(n).action.text)).size, 1);
});

test('P2-A: the step is read on the first Monday 14+ days after it was given: held within 0.5 kg - keep it; the level stands after that', () => {
  const calm = readings(range(0, 140), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const logs = intake(range(40, 140).filter(n => n % 2 === 0), n => (n < 62 ? 2000 : 2150)); // eats the step from day 62 (wave 24w)
  const at = (n: number, over: Partial<WeightPlanInput> = {}) => planAt(calm, n, { reached: true, reachedAt: D(62), intakeDays: logs, ...over });
  // Given May 3 (day 62); 14 days on is Sunday May 17, so the first plan Monday on or after it is May 18 (day 77).
  const read = at(77);
  assert.equal(read.state, 'maintenance');
  assert.equal(read.action.kind, 'maintenance_target');
  assert.equal(plainSpaces(read.action.text), 'Your weekly average held within 0.5 kg on ~2,150–2,200 kcal — keep it, that\'s your maintenance');
  assert.equal(read.action.kcalTarget, 2150);
  assert.equal(read.step?.phase, 'read');
  assert.equal(read.step?.outcome, 'held');
  assert.equal(isInstruction(read.action), true);
  // The weeks after it say the level, as a level - and keep it for good (a hold, not another instruction).
  for (const n of [84, 91, 98, 112]) {
    const settled = at(n);
    assert.equal(settled.action.kind, 'hold', `day ${n}`);
    assert.equal(plainSpaces(settled.action.text), 'Stay at ~2,150–2,200 kcal — your maintenance; if your average drifts 1 kg above or below your target, that is your cue to act', `day ${n}`);
    assert.equal(settled.action.kcalTarget, 2150);
    assert.equal(settled.step?.phase, 'settled');
  }
  // Not read before the 14 days are up.
  assert.equal(plainSpaces(at(70).action.text), 'Stay at ~2,150–2,200 kcal (the step you started May 3); we\'ll read it on Mon, May 18');
  // Someone who logs no food keeps "that snack", with no calorie number anywhere.
  const food = (n: number) => planAt(calm, n, { reached: true, reachedAt: D(62) });
  assert.equal(plainSpaces(food(62).action.text), 'Set a new target or switch to maintenance — you no longer need a deficit, so add a ~150–200 kcal snack a day (e.g. yogurt and fruit) and watch the weekly average for 2 weeks');
  assert.equal(plainSpaces(food(70).action.text), 'Keep the daily snack (the step you started May 3); we\'ll read it on Mon, May 18');
  assert.equal(plainSpaces(food(77).action.text), 'Your weekly average held within 0.5 kg — keep that snack, it\'s your maintenance');
  assert.equal(plainSpaces(food(84).action.text), 'Keep the daily snack — it\'s your maintenance; if your average drifts 1 kg above or below your target, that is your cue to act');
  for (const n of [62, 70, 77, 84, 98]) {
    const p = food(n);
    assert.equal(p.action.kcalTarget, undefined, `day ${n}`);
    assert.doesNotMatch(plainSpaces(p.action.text), /\d,\d{3}/, `day ${n}`);
  }
  // Imperial users read lb.
  assert.match(plainSpaces(at(77, { unitSystem: 'imperial' }).action.text), /^Your weekly average held within 1\.1 lb on ~2,150–2,200 kcal/);
  // Held on logs that never reached the step (wave 24w): the maintenance is what the logs say, not the step's level.
  const never = planAt(calm, 77, { reached: true, reachedAt: D(62), intakeDays: intake(range(40, 140).filter(n => n % 2 === 0), () => 2000) });
  assert.equal(plainSpaces(never.action.text), "Your weekly average held within 0.5 kg on ~2,000 kcal without the step — that's your maintenance");
  assert.equal(never.action.kcalTarget, 2000);
  assert.equal(never.step?.phase, 'read');
});

test('P2-A: still falling after the step - add another ~150; rising - back off ~100; each notch is given once and stands too', () => {
  const falling = readings(range(0, 140), n => (n < 62 ? 92 - 0.13 * n : 83.94 - 0.1 * (n - 62)));
  // Eats each level from the day it is given (wave 24w: the standing level reads the food log): 2,150 from day 62, 2,300 from day 77.
  const logs = intake(range(40, 140).filter(n => n % 2 === 0), n => (n < 62 ? 2000 : n < 77 ? 2150 : 2300));
  const fall = (n: number) => planAt(falling, n, { reached: true, reachedAt: D(62), intakeDays: logs });
  const more = fall(77);
  assert.equal(plainSpaces(more.action.text), 'Your weekly average is still falling (down 0.7 kg in a week) — add another ~150 kcal a day (to ~2,300–2,350 kcal); we\'ll read it on Mon, Jun 1');
  assert.equal(more.action.kind, 'maintenance_target');
  assert.equal(more.action.kcalTarget, 2300);
  assert.equal(more.step?.outcome, 'falling');
  assert.equal(more.step?.phase, 'given');
  // The notch stands until it is read in its turn (14 days later), and is not said again.
  assert.equal(plainSpaces(fall(84).action.text), 'Stay at ~2,300–2,350 kcal (the step you started May 18); we\'ll read it on Mon, Jun 1');
  assert.equal(fall(84).step?.phase, 'standing');
  assert.equal(fall(84).step?.outcome, 'falling');
  // A TDEE estimate caps the climb: the notch lands on it, and already at the top of it the average falling again adds no notch.
  const toCap = planAt(falling, 77, { reached: true, reachedAt: D(62), intakeDays: logs, formulaTdee: 2200 });
  assert.match(plainSpaces(toCap.action.text), /add another ~150 kcal a day \(to ~2,200 kcal\); we'll read it on Mon, Jun 1$/);
  const capped = planAt(falling, 77, { reached: true, reachedAt: D(62), intakeDays: logs, formulaTdee: 2150 });
  assert.match(plainSpaces(capped.action.text), /^Your weekly average is still falling \(down 0\.7 kg in a week\) — you are already at the top of your maintenance estimate, so stay at ~2,150 kcal and we'll read it on Mon, Jun 1$/);
  // Still falling on logs that never reached the step: no second notch on top of a step that was not taken (wave 24w).
  const neverTook = planAt(falling, 77, { reached: true, reachedAt: D(62), intakeDays: intake(range(40, 140).filter(n => n % 2 === 0), () => 2000) });
  assert.equal(plainSpaces(neverTook.action.text), 'Your weekly average is still falling (down 0.7 kg in a week), and your logs are still ~2,000 kcal — eat the step first (~2,150–2,200 kcal); we\'ll read it on Mon, Jun 1');
  assert.equal(neverTook.action.kcalTarget, 2150);
  assert.equal(neverTook.step?.loKcal, 2150);
  // Rising: back off, never under the budget.
  const rising = readings(range(0, 140), n => (n < 62 ? 92 - 0.13 * n : 83.94 + 0.1 * (n - 62)));
  const rise = (n: number, over: Partial<WeightPlanInput> = {}) => planAt(rising, n, { reached: true, reachedAt: D(62), intakeDays: logs, ...over });
  const back = rise(77);
  assert.equal(plainSpaces(back.action.text), 'Your weekly average is rising (up 0.7 kg in a week) — back off ~100 kcal a day (to ~2,050–2,100 kcal); we\'ll read it on Mon, Jun 1');
  assert.equal(back.action.kcalTarget, 2050);
  assert.equal(back.step?.outcome, 'rising');
  assert.match(plainSpaces(rise(77, { targetKcal: 1950 }).action.text), /\(to ~2,000–2,050 kcal\)/);
  assert.match(plainSpaces(rise(77, { targetKcal: 2150, formulaTdee: undefined }).action.text), /back off ~100 kcal a day \(to ~2,200–2,250 kcal\)/);
  // The food version: a smaller snack, another small snack.
  const foodRise = planAt(rising, 77, { reached: true, reachedAt: D(62) });
  assert.equal(plainSpaces(foodRise.action.text), 'Your weekly average is rising (up 0.7 kg in a week) — make the snack ~100 kcal smaller; we\'ll read it on Mon, Jun 1');
  const foodFall = planAt(falling, 77, { reached: true, reachedAt: D(62) });
  assert.equal(plainSpaces(foodFall.action.text), 'Your weekly average is still falling (down 0.7 kg in a week) — add another small snack (~150 kcal); we\'ll read it on Mon, Jun 1');
  // Too few weigh-ins to read it: it waits for the next Monday and says so.
  const sparse = [...readings(range(0, 62), n => 92 - 0.13 * n), ...readings([63, 70, 72], () => 84), ...readings(range(78, 140), () => 84)];
  assert.equal(plainSpaces(planAt(sparse, 77, { reached: true, reachedAt: D(62), intakeDays: logs }).action.text), 'Stay at ~2,150–2,200 kcal (the step you started May 3); we\'ll read it on Mon, May 25');
});

test('held for 2+ weeks on logged intake, the weight names its own maintenance target - as soon as two held weeks exist', () => {
  const calm = readings(range(0, 100), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const food = intake(range(40, 100), n => 2050 + (n % 2 === 0 ? 40 : -40));
  const at = (n: number, over: Partial<WeightPlanInput> = {}) => planAt(calm, n, { reached: true, reachedAt: D(62), intakeDays: food, ...over });
  // Day 70 is the first plan Monday after the question (reached Sunday 62): the weeks before and after it both held, and 10 days are logged.
  const p = at(70);
  assert.equal(p.state, 'maintenance');
  assert.equal(p.action.kind, 'maintenance_target');
  // (The week before gave the step to ~2,150-2,200, and the logs since never reached it: the weight held without the step - wave 24w.)
  assert.equal(plainSpaces(p.action.text), "You held about 84 kg on ~2,050 kcal without the step — that's your maintenance");
  assert.equal(p.action.kcalTarget, 2050);
  assert.equal(isInstruction(p.action), true);
  assert.equal(p.step?.phase, 'read');
  // A week later the level stands, as it was named (a sticky figure), without being named again.
  const next = at(77);
  assert.equal(next.action.kind, 'hold');
  assert.equal(plainSpaces(next.action.text), 'Stay at ~2,050 kcal — your maintenance; if your average drifts 1 kg above or below your target, that is your cue to act');
  assert.equal(next.action.kcalTarget, 2050);
  // Logged days that round to another 50 later do not move it...
  const drifting = intake(range(40, 100), n => (n < 75 ? 2050 : 2100) + (n % 2 === 0 ? 40 : -40));
  assert.equal(planAt(calm, 84, { reached: true, reachedAt: D(62), intakeDays: drifting }).action.kcalTarget, 2050);
  // ...a real change of 100+ kcal, said by two Mondays in a row, names the new figure and says it replaces the old one.
  const changed = intake(range(40, 100), n => (n < 71 ? 2050 : 2300) + (n % 2 === 0 ? 40 : -40));
  assert.equal(planAt(calm, 77, { reached: true, reachedAt: D(62), intakeDays: changed }).action.kcalTarget, 2050, 'one Monday of it is not enough');
  const replaced = planAt(calm, 84, { reached: true, reachedAt: D(62), intakeDays: changed });
  assert.equal(replaced.action.kcalTarget, 2300);
  assert.equal(plainSpaces(replaced.action.text), "You've held about 84 kg on ~2,300 kcal — make that your maintenance target (it replaces ~2,050 kcal)");
  assert.equal(plainSpaces(planAt(calm, 91, { reached: true, reachedAt: D(62), intakeDays: changed }).action.text), 'Stay at ~2,300 kcal — your maintenance; if your average drifts 1 kg above or below your target, that is your cue to act');
  // Not before two weeks have been held (the step toward maintenance is the plan's action until then)...
  assert.doesNotMatch(at(63).action.text, /You've held/);
  // ...a weekly average still moving more than 0.5 kg between the two weeks is not held...
  const stillSettling = readings(range(0, 100), n => (n < 62 ? 92 - 0.13 * n : 84 - 0.05 * (n - 62) + wobble(n)));
  assert.doesNotMatch(planAt(stillSettling, 70, { reached: true, reachedAt: D(62), intakeDays: food }).action.text, /You've held/);
  // ...nor on fewer than 8 logged days...
  assert.doesNotMatch(at(70, { intakeDays: intake([63, 64, 65, 66, 67, 68, 69], () => 2050) }).action.text, /You've held/);
  // ...and a budget already there keeps its target.
  const same = at(70, { targetKcal: 2050 });
  assert.equal(same.action.kind, 'hold');
  assert.equal(plainSpaces(same.action.text), 'You held about 84 kg on ~2,050 kcal without the step — keep your calorie target where it is');
  // Imperial users read lb.
  assert.match(plainSpaces(at(70, { unitSystem: 'imperial' }).action.text), /^You held about 18[56] lb on ~2,050 kcal without the step/);
});

test('plan text joins numbers to units with U+00A0, in kg and in lb', () => {
  const NB = '\u00a0';
  const kg = planAt(SLOW, 49, { intakeDays: LOGGER }).action.text;
  assert.ok(kg.includes(`150${NB}kcal`), kg);
  assert.doesNotMatch(kg, /\d kcal/);
  const slow = readings(range(0, 100), n => 92 - 0.04 * n);
  const lb = planAt(slow, 70, { unitSystem: 'imperial', targetDate: D(150) });
  assert.match(lb.action.text, new RegExp(`~1\\.\\d\\d${NB}lb/wk`));
  assert.doesNotMatch(lb.action.text, /\d kg|\d lb/);
  assert.match(planAt(slow, 70, { targetDate: D(150) }).action.text, new RegExp(`~0\\.\\d\\d${NB}kg/wk`));
});

test('no weigh-ins, no plan', () => {
  assert.equal(weightWeekPlan({
    todayKey: D(10), days: [], startDay: null, startKg: null, targetKg: 80, targetDate: null, reached: false, reachedAt: null,
    intakeDays: [], targetKcal: null, floorKcal: null, weeklySessions: null,
  }), null);
});

// ── Wave 22w: round-4 dietitian + "Sam" findings ────────────────────────────────────────────────────────────────────────

// Sam: down 0.5 kg/wk to day 34, then flat at 89.5 kg (two flat weeks are common; the 21-day line still holds the good weeks).
const STALL = readings(range(0, 100), n => (n < 35 ? 92 - 0.0714 * n : 89.5) + wobble(n));

test('P1-1: a flat fortnight after a confirmed loss is a calm hold, never "behind", a date or a trim', () => {
  const week = range(49, 55).map(n => planAt(STALL, n));
  for (const p of week) assert.equal(decision(p), decision(week[0]), 'the same all week');
  const p = week[0];
  assert.equal(p.state, 'plateau');
  assert.equal(p.flatWeeks, 2);
  assert.equal(p.verdict, 'holding');
  assert.equal(p.call, 'none');
  assert.equal(p.etaDate, null);
  assert.equal(p.weeksVsTarget, null);
  assert.equal(p.farBehind, false);
  assert.equal(p.onPace, null);
  assert.equal(p.pace, null, 'the 21-day line holds the good weeks: no stale rate next to "two flat weeks"');
  assert.ok(p.plateauMeanKg != null && Math.abs(p.plateauMeanKg - 89.5) < 0.2);
  // No food log: nothing to judge the cause on, and nothing to trim.
  assert.equal(p.action.kind, 'plateau_water');
  assert.equal(plainSpaces(p.action.text), "Keep 2,000 kcal; we'll look again next Monday");
  assert.equal(p.action.kcalTarget, 2000);
  assert.doesNotMatch(p.action.text, /trim|move the date|[A-Z][a-z]{2} \d{4}/);
  // The week before was an ordinary pace: the fortnight is the news.
  assert.equal(planAt(STALL, 42).state, 'pace');
  // One more flat week and it is a plateau (flatWeeks 3).
  const plateau = planAt(STALL, 56);
  assert.equal(plateau.state, 'plateau');
  assert.equal(plateau.flatWeeks, 3);
});

test('P1-1: the flat fortnight judges its cause over its own 14 days of logs', () => {
  const weekends = intake(range(0, 70), n => 1950 + (dow(n) >= 5 ? 420 : 0) + (n % 3 === 0 ? 40 : -20));
  const p = planAt(STALL, 49, { intakeDays: weekends });
  assert.equal(p.flatWeeks, 2);
  assert.equal(p.plateauCause?.kind, 'weekends');
  assert.equal(p.plateauCause?.spanDays, 14);
  assert.equal(p.action.kind, 'plateau_weekends');
  assert.match(plainSpaces(p.action.text), /^Weekends averaged ~2,\d{3} kcal vs 1,9\d0 on weekdays — bring them back toward your 2,000 kcal target$/);
  assert.doesNotMatch(p.action.text, /trim/);
  // Logged days on target are not blamed.
  const onTarget = planAt(STALL, 49, { intakeDays: intake(range(0, 70), n => 2000 + (n % 2 === 0 ? 40 : -40)) });
  assert.equal(plainSpaces(onTarget.action.text), "Keep 2,000 kcal; we'll look again next Monday");
});

test('P3-C: a cause the flat fortnight named is carried into the plateau a week later - one cause, one figure', () => {
  // Weekends run 2,500 before day 42 and 2,200 after it: the 14 days of the fortnight (35-48) and the 21 of the plateau (35-55) average different figures.
  const logs = intake(range(0, 70), n => (dow(n) >= 5 ? (n < 42 ? 2500 : 2200) : 1950) + (n % 3 === 0 ? 40 : -20));
  const fortnight = planAt(STALL, 49, { intakeDays: logs });
  assert.equal(fortnight.flatWeeks, 2);
  assert.equal(fortnight.plateauCause?.kind, 'weekends');
  const plateau = planAt(STALL, 56, { intakeDays: logs });
  assert.equal(plateau.flatWeeks, 3);
  assert.equal(plateau.plateauCause?.kind, 'weekends');
  // The figure the plateau quotes is the one the fortnight named, not a re-judgement of the longer span.
  assert.equal(plateau.plateauCause?.weekendAvgKcal, fortnight.plateauCause?.weekendAvgKcal);
  assert.equal(plateau.plateauCause?.weekdayAvgKcal, fortnight.plateauCause?.weekdayAvgKcal);
  assert.equal(planAt(STALL, 63, { intakeDays: logs }).plateauCause?.weekendAvgKcal, fortnight.plateauCause?.weekendAvgKcal, 'kept for as long as the plateau lasts');
  // A fortnight that named only "water" (too few logged days) hands the plateau nothing to carry: the plateau judges its own span.
  const thin = intake(range(42, 55).filter(n => n % 2 === 0), n => (dow(n) >= 5 ? 2500 : 1950));
  assert.equal(planAt(STALL, 49, { intakeDays: thin }).plateauCause?.kind, 'water');
});

test('P3-B: "on pace" on two paces that land on opposite sides of the date says so; two that both land early do not', () => {
  const speeding = readings(range(0, 100), n => (n < 35 ? 92 - 0.05 * n : 92 - 0.05 * 35 - 0.1 * (n - 35)) + wobble(n));
  // Day 49, date day 126: last week's pace lands after the date, this week's before it.
  const straddling = planAt(speeding, 49, { targetDate: D(126) });
  assert.equal(straddling.call, 'on_pace');
  assert.ok(straddling.earlierPace != null);
  assert.equal(straddling.earlierPaceStraddles, true);
  // Day 56, date day 110: both paces land before it (this one 14+ days early, last week's within the margin).
  const bothEarly = planAt(speeding, 56, { targetDate: D(110) });
  assert.equal(bothEarly.call, 'on_pace');
  assert.ok(bothEarly.earlierPace != null);
  assert.equal(bothEarly.earlierPaceStraddles, false);
  // No range at all: nothing straddles.
  assert.equal(planAt(STEADY, 42).earlierPaceStraddles, false);
});

test('P1-1: a slow steady loss, or a loss that never was confirmed, is not a flat fortnight', () => {
  assert.equal(planAt(SLOW, 49).flatWeeks, null);
  assert.equal(planAt(STEADY, 56).flatWeeks, null);
  // The goal's first weeks (no confirmed pace 14 days ago) are never a fortnight.
  assert.notEqual(planAt(STALL, 28).flatWeeks, 2);
});

test('P1-1: after a flat fortnight the weekly average falling again is "moving again", not "behind"', () => {
  const stallThenFall = readings(range(0, 100), n => (n < 35 ? 92 - 0.0714 * n : n < 49 ? 89.5 : 89.5 - 0.1 * (n - 48)) + wobble(n));
  assert.equal(planAt(stallThenFall, 49).flatWeeks, 2);
  const p = planAt(stallThenFall, 56);
  assert.equal(p.state, 'moving_again');
  assert.equal(p.verdict, 'progressing');
  assert.equal(p.action.text, 'Keep doing what restarted it');
  assert.ok(p.plateauMeanKg != null && Math.abs(p.plateauMeanKg - 89.5) < 0.2);
});

test('P1-1: no user-facing plan string names a projected month (far behind says only that the date moves)', () => {
  for (const day of [42, 49, 56]) {
    const p = planAt(SLOW, day, { intakeDays: LOGGER });
    assert.doesNotMatch(plainSpaces(p.action.text), /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b(?! \d{1,2}\b)/);
  }
});

test('P1-2: a calorie target never moves back up on the next Monday without a sentence saying so', () => {
  // 0.21 kg/wk to day 34, then flat: behind with a trim on Monday 42; on Monday 49 the weeks are a plateau and the plan keeps 2,000 kcal.
  const slowThenFlat = readings(range(0, 100), n => (n < 35 ? 92 - 0.03 * n : 90.95) + wobble(n));
  const before = planAt(slowThenFlat, 42, { intakeDays: LOGGER });
  assert.equal(before.action.kind, 'trim');
  assert.equal(before.action.kcalTarget, 1850);
  const after = planAt(slowThenFlat, 49, { intakeDays: LOGGER });
  assert.equal(after.state, 'plateau');
  assert.equal(after.action.kcalTarget, 2000);
  assert.match(plainSpaces(after.action.text), /^Go back to 2,000 kcal — last week's trim isn't needed\. Common and often water: keep 2,000 kcal/);
  assert.equal(after.action.kind, 'plateau_water', 'the kind stays the cause\'s');
  // The sentence belongs to that one Monday: the next one just carries the plan.
  assert.doesNotMatch(planAt(slowThenFlat, 56, { intakeDays: LOGGER }).action.text, /Go back to/);
  // A week that trims again is the same step, so nothing is walked back.
  const again = planAt(SLOW, 56, { intakeDays: LOGGER });
  assert.equal(again.action.kcalTarget, 1850);
  assert.doesNotMatch(again.action.text, /Go back to/);
});

test('P1-2: one trim step for a behind pace and a plateau alike, and no trim for a user who logs no food', () => {
  const logged = planAt(PLATEAU, 56, { intakeDays: intake(range(0, 70), n => 2000 + (n % 2 === 0 ? 60 : -40)) });
  assert.match(plainSpaces(logged.action.text), new RegExp(`trim ~${TRIM_STEP_KCAL} kcal a day`));
  const behind = planAt(SLOW, 49, { intakeDays: LOGGER });
  assert.match(plainSpaces(behind.action.text), new RegExp(`trim ~${TRIM_STEP_KCAL} kcal a day`));
  // No food log: the plateau's second step is activity and logging, the behind pace's too.
  const noLogs = planAt(PLATEAU, 56);
  assert.equal(plainSpaces(noLogs.action.text), 'Common and often water: keep 2,000 kcal and 3 sessions; if still flat in 2 weeks, add two 30-minute walks and log a few days so we can see where the calories go');
  assert.doesNotMatch(noLogs.action.text, /trim/);
  // Two or fewer logged days is still "no food log".
  assert.doesNotMatch(planAt(PLATEAU, 56, { intakeDays: intake([50, 52], () => 2000) }).action.text, /trim/);
});

test('P2-1: a week that begins with the newest weigh-in 7+ days old keeps the last plan\'s call and colour, with a neutral action', () => {
  const pre = readings(range(0, 59), n => 92 - 0.08 * n + wobble(n));
  const gapAfter = (back: number[]) => [...pre, ...readings(back, n => 92 - 0.08 * n)];
  const last = planAt(gapAfter([]), 59); // the plan in force the day of the last weigh-in
  assert.ok(last.verdict === 'ahead' || last.verdict === 'on_track', last.verdict);
  // Monday 70 (asOf Sunday 69) has 11 days without a weigh-in: nothing is remade from the old readings.
  const week = range(70, 76).map(n => planAt(gapAfter([]), n));
  for (const p of week) {
    assert.equal(p.staleSince, D(59));
    assert.equal(p.weekStart, D(70));
    assert.equal(p.verdict, last.verdict, 'the colour from before the gap');
    assert.equal(p.state, last.state);
    assert.equal(p.action.kind, 'keep_weighing');
    assert.equal(plainSpaces(p.action.text), 'No weigh-in since Apr 30 — step on the scale when you can; your plan picks up from there');
    assert.equal(isInstruction(p.action), false);
    assert.equal(decision(p), decision(week[0]), 'the same all week');
  }
  // A week that begins with a weigh-in 6 days old is not stale.
  assert.equal(planAt(gapAfter([]), 63).staleSince, null);
  assert.equal(planAt(gapAfter([]), 64).staleSince, null);
});

test('P2-1: the first weigh-in back is a welcome back that keeps the colour from before the gap; three of them make the new pace call', () => {
  const pre = readings(range(0, 59), n => 92 - 0.08 * n + wobble(n));
  const gapAfter = (back: number[]) => [...pre, ...readings(back, n => 92 - 0.08 * n - 0.4)];
  const before = planAt(gapAfter([]), 59);
  assert.ok(before.verdict === 'ahead' || before.verdict === 'on_track', before.verdict);
  const first = planAt(gapAfter([72]), 72);
  assert.equal(first.state, 'returning');
  assert.equal(first.staleSince, null, 'the weigh-in ends the stale week');
  assert.equal(first.verdict, before.verdict, 'never downgraded to progressing');
  assert.equal(planAt(gapAfter([72, 73]), 73).verdict, before.verdict);
  const third = planAt(gapAfter([72, 73, 74]), 74);
  assert.notEqual(third.state, 'returning');
  assert.equal(third.asOf, D(74));
  // Behind or too fast before the gap is not carried: those calls wait for 3 weigh-ins.
  const slow = [...readings(range(0, 59), n => 92 - 0.035 * n + wobble(n)), ...readings([72], () => 89.9)];
  const slowReturn = planAt(slow, 72, { intakeDays: LOGGER });
  assert.equal(slowReturn.state, 'returning');
  assert.ok(slowReturn.verdict === 'progressing' || slowReturn.verdict === 'holding', slowReturn.verdict);
});

test('P2-2: "moving again" is an event inside the week - the plateau message does not hold while the weekly average falls', () => {
  // Flat at 88.5 kg to day 58 (a plateau by Monday 56), then 0.2 kg a day.
  const fallsMidWeek = readings(range(0, 100), n => (n < 35 ? 92 - 0.1 * n : n < 59 ? 88.5 : 88.5 - 0.2 * (n - 58)) + wobble(n));
  const week = range(56, 62).map(n => planAt(fallsMidWeek, n));
  assert.deepEqual(week.map(p => p.state), ['plateau', 'plateau', 'plateau', 'plateau', 'plateau', 'plateau', 'moving_again']);
  // The week's average (3+ weigh-ins) is a full tolerance under the plateau's on day 62, not before.
  const moving = week[6];
  assert.equal(moving.verdict, 'progressing');
  assert.equal(moving.action.text, 'Keep doing what restarted it');
  assert.ok(moving.plateauMeanKg != null && Math.abs(moving.plateauMeanKg - 88.5) < 0.2);
  assert.equal(moving.asOf, D(62), 'made as of the day it entered');
  // It enters once: the next Monday is the same plan.
  assert.equal(decision(planAt(fallsMidWeek, 63)), decision(moving));
  // A scale that only wobbles inside the tolerance never ends the plateau mid-week.
  assert.equal(planAt(PLATEAU, 62).state, 'plateau');
});

test('P2-3: "nearly there" is called on the Monday from closeness - within a kilo while losing 0.75%+ a week - not only once "too fast" enters', () => {
  // 0.85 kg/wk (about 1%/wk, ahead of a far date), 0.8 kg to go by the Sunday.
  const closing = readings(range(0, 100), n => 92 - 0.12 * n + wobble(n));
  const target = 92 - 0.12 * 59 - 0.8; // 0.8 kg under the weekly average of Sunday 62 (the mean of days 56-62 sits at day 59)
  const monday = planAt(closing, 63, { targetKg: target, targetDate: D(126) });
  assert.equal(monday.nearlyThere, true);
  assert.equal(monday.action.kind, 'ease_to_maintenance');
  // (Within a kilo already on Saturday 61: the step was given then, so the Monday carries it as the standing level - wave 23w.)
  assert.match(plainSpaces(monday.action.text), /^Keep the daily snack \(the step you started May 2\); we'll read it on Mon, May 18$/);
  assert.equal(monday.asOf, D(62), 'decided from Sunday, not from a mid-week event');
  assert.equal(monday.updated, null);
  // The same call all week.
  for (const n of range(64, 69)) assert.equal(decision(planAt(closing, n, { targetKg: target, targetDate: D(126) })), decision(monday), `day ${n}`);
  // More than a kilo out, or a slow pace, is an ordinary week.
  assert.equal(planAt(closing, 63, { targetKg: target - 2, targetDate: D(126) }).nearlyThere, false);
  assert.equal(planAt(STEADY, 56, { targetKg: 92 - 0.08 * 55 - 0.8, targetDate: D(126) }).nearlyThere, false);
});

test('P2-3: a plan an event re-made inside its week says so (updated day and why); a Monday plan has no label', () => {
  const monday = planAt(STALL, 49);
  assert.equal(monday.updated, null);
  // The welcome back is an event inside the week, labelled with the first weigh-in back.
  const pre = readings(range(0, 59), n => 92 - 0.08 * n + wobble(n));
  const back = [...pre, ...readings([72, 73], n => 92 - 0.08 * n)];
  const stale = planAt(back, 70);
  assert.equal(stale.staleSince, D(59));
  assert.equal(stale.updated, null, 'a stale week is the last plan carried, not an update');
  const returning = planAt(back, 72);
  assert.equal(returning.state, 'returning');
  assert.deepEqual(returning.updated, { day: D(72), why: 'weighed in again after 12 days' });
  // The plateau ending inside the week.
  const fallsMidWeek = readings(range(0, 100), n => (n < 35 ? 92 - 0.1 * n : n < 59 ? 88.5 : 88.5 - 0.2 * (n - 58)) + wobble(n));
  assert.deepEqual(planAt(fallsMidWeek, 62).updated, { day: D(62), why: 'the weekly average is falling again' });
  assert.equal(planAt(fallsMidWeek, 61).updated, null);
  // The target being reached mid-week.
  const calm = readings(range(0, 100), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const reachedOn = planAt(calm, 64, { reached: true, reachedAt: D(62) }); // reached Sunday 62; Monday 63 starts the next week
  assert.equal(reachedOn.updated, null, 'the reach was before this week');
  const sameWeek = planAt(calm, 60, { reached: true, reachedAt: D(58) }); // reached Thursday 58, week of Monday 56
  assert.deepEqual(sameWeek.updated, { day: D(58), why: 'target reached' });
  // An event that leaves the call and the action as the Monday had them is not an update.
  const closing = readings(range(0, 100), n => 92 - 0.14 * n);
  const nearly = [63, 64, 65, 66].map(n => planAt(closing, n, { targetKg: 92 - 0.14 * 59 - 0.8, targetDate: D(126) }));
  for (const [i, p] of nearly.entries()) {
    assert.equal(p.nearlyThere, true, `day ${63 + i}`);
    assert.equal(p.updated, null, `day ${63 + i}`);
  }
  // Closing in on the target INSIDE the week (1.2 kg out on the Sunday, within a kilo by Tuesday) is the event that re-makes the plan.
  const inWeek = planAt(closing, 65, { targetKg: 92 - 0.14 * 59 - 1.2, targetDate: D(126) });
  assert.equal(inWeek.nearlyThere, true);
  assert.deepEqual(inWeek.updated, { day: D(64), why: 'within a kilo of the target' });
  assert.equal(planAt(closing, 63, { targetKg: 92 - 0.14 * 59 - 1.2, targetDate: D(126) }).nearlyThere, false);
});

test('P2-3: the reached question runs to the end of a calendar week - it never ends on a Saturday', () => {
  const calm = readings(range(0, 120), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  // Reached on a Friday (day 65): the week of Monday 63 and the next one (Monday 70, 5 days later) both ask; Monday 77 does not.
  const planOn = (n: number) => planAt(calm, n, { reached: true, reachedAt: D(65) });
  for (const n of range(65, 76)) assert.equal(planOn(n).action.kind, 'next_target', `day ${n}`);
  assert.notEqual(planOn(77).action.kind, 'next_target');
  assert.equal(planOn(76).action.text, planOn(70).action.text, 'one question for the whole week');
  // Reached on a Monday: that week asks, the next Monday (7 days later) does not.
  const mondayReach = (n: number) => planAt(calm, n, { reached: true, reachedAt: D(63) });
  for (const n of range(63, 69)) assert.equal(mondayReach(n).action.kind, 'next_target', `day ${n}`);
  assert.notEqual(mondayReach(70).action.kind, 'next_target');
});

// ═══ wave 24w, P2-1: the easing step reads the food log ══════════════════════════════════════════════════════════════════════════

/** Logged days from `from` to `to` (day numbers) at `kcal`. */
const steady = (from: number, to: number, kcal: number) => intake(range(from, to), () => kcal);

test('P2-1 (24w): "the step you started" is said only when the logs since the step show it; otherwise the logs are named, or nothing is claimed', () => {
  const fast = readings(range(0, 70), n => 92 - 0.19 * n);
  const over = { targetKg: 82.5, targetDate: D(80) };
  // The step is given on Sunday day 48 (Apr 19); the plan weeks after it begin on Mondays 49 and 56 and are read on Monday 63 (May 4).
  const before = steady(28, 47, 2000);
  const at = (n: number, after: ReturnType<typeof steady>) => plainSpaces(planAt(fast, n, { ...over, intakeDays: [...before, ...after] }).action.text);
  // Eating at the step's level since it began: claimed, in both standing weeks.
  assert.equal(at(56, steady(48, 70, 2150)), "Stay at ~2,150–2,200 kcal (the step you started Apr 19); we'll read it on Mon, May 4");
  // Within 50 kcal of the low end still counts (mean 2,100).
  assert.equal(at(56, steady(48, 70, 2100)), "Stay at ~2,150–2,200 kcal (the step you started Apr 19); we'll read it on Mon, May 4");
  // Logs still where they were: the step is not claimed. The logs are named, and the step is what it is.
  assert.equal(at(56, steady(48, 70, 2000)), "Your logs are still ~2,000 kcal, so the step is about one extra snack a day (to ~2,150–2,200 kcal); we'll read it on Mon, May 4");
  assert.equal(at(56, steady(48, 70, 2050)), "Your logs are still ~2,050 kcal, so the step is about one extra snack a day (to ~2,150–2,200 kcal); we'll read it on Mon, May 4");
  // Days BEFORE the step began are not counted: a week at 2,300 before it does not make 2,000 after it a step taken.
  const heavyBefore = steady(28, 47, 2300);
  assert.equal(plainSpaces(planAt(fast, 56, { ...over, intakeDays: [...heavyBefore, ...steady(48, 70, 2000)] }).action.text),
    "Your logs are still ~2,000 kcal, so the step is about one extra snack a day (to ~2,150–2,200 kcal); we'll read it on Mon, May 4");
  // Fewer than 3 logged days since it began (week 49 sees only Sunday 48): nothing to claim, nothing to contradict.
  assert.equal(at(49, steady(48, 70, 2000)), "Aim for ~2,150–2,200 kcal a day; we'll read it on Mon, May 4");
  assert.equal(at(56, [...steady(48, 49, 2150), ...steady(60, 70, 2150)]), "Aim for ~2,150–2,200 kcal a day; we'll read it on Mon, May 4");
  // The plan is one thing all week.
  const week = range(56, 62).map(n => plainSpaces(planAt(fast, n, { ...over, intakeDays: [...before, ...steady(48, 70, 2000)] }).action.text));
  assert.equal(new Set(week).size, 1);
});

test('P2-1 (24w): on the read day a step that was not taken is not "replaced": "You held about 84 kg on ~2,050 kcal without the step - that\'s your maintenance"', () => {
  const calm = readings(range(0, 100), n => (n < 62 ? 92 - 0.13 * n : 84 + wobble(n)));
  const at = (n: number, food: ReturnType<typeof intake>, over: Partial<WeightPlanInput> = {}) => planAt(calm, n, { reached: true, reachedAt: D(62), intakeDays: food, ...over });
  const jitter = (n: number) => (n % 2 === 0 ? 40 : -40);
  // Logs ~2,050 all along: the weight held, the step never was.
  const notTaken = intake(range(40, 100), n => 2050 + jitter(n));
  const p = at(70, notTaken);
  assert.equal(plainSpaces(p.action.text), "You held about 84 kg on ~2,050 kcal without the step — that's your maintenance");
  assert.doesNotMatch(p.action.text, /replaces/);
  assert.equal(p.action.kind, 'maintenance_target');
  assert.equal(p.action.kcalTarget, 2050);
  // The level then stands as the maintenance.
  assert.equal(plainSpaces(at(77, notTaken).action.text), 'Stay at ~2,050 kcal — your maintenance; if your average drifts 1 kg above or below your target, that is your cue to act');
  // A budget that already is that figure keeps its target.
  assert.equal(plainSpaces(at(70, notTaken, { targetKcal: 2050 }).action.text), "You held about 84 kg on ~2,050 kcal without the step — keep your calorie target where it is");
  // Imperial users read lb.
  assert.match(plainSpaces(at(70, notTaken, { unitSystem: 'imperial' }).action.text), /^You held about 18[56] lb on ~2,050 kcal without the step — that's your maintenance$/);
  // Logs that took the step (about 2,150, the low end) read as before: held on the step's level, no "without".
  const taken = intake(range(40, 100), n => (n < 56 ? 2000 : 2150) + jitter(n));
  assert.equal(plainSpaces(at(70, taken).action.text), "You've held about 84 kg on ~2,150 kcal — make that your maintenance target");
  // Logs well above the step (it was taken, and then some): the old sentence - the figure replaces the step.
  const higher = intake(range(40, 100), n => (n < 56 ? 2000 : 2400) + jitter(n));
  assert.equal(plainSpaces(at(70, higher).action.text), "You've held about 84 kg on ~2,400 kcal — make that your maintenance target (it replaces the step to ~2,150–2,200 kcal)");
});
