/**
 * Wave 27 - the goal card carries ONE neutral injury check-in when the user has a recent active Injury fact. The
 * plan numbers (headline, distance, race, long run) are untouched; the line sits beside them as the first reason
 * (safety outranks praise; the card still shows at most 3 reasons).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeGoalProgress, HEADLINE_MAX_CHARS, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { injuryCheckInLine } from './injuryCheckIn';
import { formatGoalProgressLines } from './goalPromptText';
import { goalFallbackOpener, requiredOpenerLine } from './brain/openerText';

const TODAY = '2026-10-31'; // Saturday
const INJURY = { text: 'knee pain', since: '2026-10-24' };

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Run = { day: string; durationMin: number; distanceKm: number; type: string };
const run = (day: string, km: number): Run => ({ day, durationMin: Math.round(km * 6), distanceKm: km, type: 'Running' });

/** Four steady weeks of running ending today: 3 runs a week. */
function runs(): Run[] {
  const out: Run[] = [];
  for (let w = 0; w < 4; w++) for (const [d, km] of [[-1, 6], [-3, 6], [-5, 12]] as const) out.push(run(addDays(TODAY, -7 * w + d), km));
  return out;
}

function input(goal: GoalProgressInput['goal'], over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  const r = goal === 'endurance' ? runs() : [];
  return {
    goal,
    todayKey: TODAY,
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: goal === 'endurance' ? 30 : null },
    start: { weightKg: null, startedAt: null },
    weightReadings: [],
    intakeDays: [],
    budget: null,
    progression: {},
    trainingDays: r.map(x => x.day),
    workouts: r,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    ...over,
  };
}

const withInjury = (i: GoalProgressInput): GoalProgress => computeGoalProgress({ ...i, activeInjury: INJURY });

test('endurance: no injury fact -> no line and no field', () => {
  const p = computeGoalProgress(input('endurance'));
  assert.ok(!p.reasons.some(r => r.kind === 'injury'));
  assert.ok(!('injuryCheckIn' in p), 'the payload is byte-identical without an injury');
  const nulled = computeGoalProgress({ ...input('endurance'), activeInjury: null });
  assert.deepEqual(nulled, p);
});

test('endurance: an active injury adds the check-in as the first reason and the additive API field', () => {
  const base = computeGoalProgress(input('endurance'));
  const p = withInjury(input('endurance'));
  const line = injuryCheckInLine('endurance', INJURY);
  assert.deepEqual(p.reasons[0], { kind: 'injury', text: line, tone: 'neutral' });
  assert.equal(line, 'You noted knee pain on Oct 24 — if it still hurts, swap hard sessions (intervals, long runs) for easy work or rest, and see a professional if it persists.');
  assert.deepEqual(p.injuryCheckIn, INJURY);
  // Nothing else moves: the plan numbers are the same, the other reasons keep their order.
  assert.deepEqual({ ...p, reasons: [], injuryCheckIn: undefined }, { ...base, reasons: [], injuryCheckIn: undefined });
  assert.equal(p.headline, base.headline);
  assert.deepEqual(p.distance, base.distance);
  assert.deepEqual(p.reasons.slice(1), base.reasons.slice(0, 2));
});

test('the caps hold: <= 3 reasons and a headline within HEADLINE_MAX_CHARS, whatever the base card was', () => {
  const p = withInjury(input('endurance'));
  assert.ok(p.reasons.length <= 3, String(p.reasons.length));
  assert.ok(p.headline.length <= HEADLINE_MAX_CHARS, p.headline);
  assert.ok(!p.headline.includes('knee'), 'the check-in is a reason, never the headline');
  // A card that already carries 3 reasons drops its LAST one, not the safety line or the first two.
  const base = computeGoalProgress(input('endurance'));
  if (base.reasons.length === 3) assert.deepEqual(p.reasons.map(r => r.kind).slice(1), base.reasons.map(r => r.kind).slice(0, 2));
});

test('a race card keeps its countdown and phase beside the check-in', () => {
  const race = { date: '2026-12-20', distanceKm: 21.1 };
  const base = computeGoalProgress(input('endurance', { race }));
  const p = withInjury(input('endurance', { race }));
  assert.equal(p.reasons[0].kind, 'injury');
  assert.equal(p.reasons[1].kind, base.reasons[0].kind);
  assert.equal(p.reasons[1].text, base.reasons[0].text);
  assert.deepEqual(p.race, base.race);
  assert.equal(p.headline, base.headline);
});

test('muscle: the strength wording, with the lifts untouched', () => {
  const target = { weightKg: null, date: null, weeklySessions: 3 };
  const base = computeGoalProgress(input('muscle', { target }));
  const p = withInjury(input('muscle', { target }));
  assert.deepEqual(p.reasons[0], {
    kind: 'injury',
    text: 'You noted knee pain on Oct 24 — if it still hurts, swap hard sessions (heavy lifts) for easy work or rest, and see a professional if it persists.',
    tone: 'neutral',
  });
  assert.equal(p.headline, base.headline);
  assert.equal(p.verdict, base.verdict);
  assert.ok(p.reasons.length <= 3);
});

test('general: the line only when the user has training cues (a sessions target or a logged session)', () => {
  const none = computeGoalProgress({ ...input('general'), activeInjury: INJURY });
  assert.ok(!none.reasons.some(r => r.kind === 'injury'));
  assert.ok(!('injuryCheckIn' in none));
  const target = withInjury(input('general', { target: { weightKg: null, date: null, weeklySessions: 3 } }));
  assert.equal(target.reasons[0].kind, 'injury');
  assert.equal(target.reasons[0].text, injuryCheckInLine('general', INJURY));
  const trained = withInjury(input('general', { trainingDays: [addDays(TODAY, -2)] }));
  assert.equal(trained.reasons[0].kind, 'injury');
});

test('weight loss: no line - its card and plan speak of calories and the scale, not of sessions to swap', () => {
  const p = withInjury(input('weight_loss', { target: { weightKg: 80, date: null, weeklySessions: 3 } }));
  assert.ok(!p.reasons.some(r => r.kind === 'injury'));
  assert.ok(!('injuryCheckIn' in p));
});

test('the coach and brief prompt block carries the same line once, in the card\'s words', () => {
  const p = withInjury(input('endurance'));
  const lines = formatGoalProgressLines(p, 'metric');
  const line = injuryCheckInLine('endurance', INJURY);
  assert.equal(lines.filter(l => l.includes(line)).length, 1, lines.join('\n'));
  const none = formatGoalProgressLines(computeGoalProgress(input('endurance')), 'metric');
  assert.ok(!none.some(l => /injur|knee/i.test(l)));
});

test('the opener says the same line: required first sentence and the model-free fallback', () => {
  const p = withInjury(input('endurance'));
  const line = injuryCheckInLine('endurance', INJURY);
  assert.ok(requiredOpenerLine(p, 'endurance', 'metric')?.includes(line));
  assert.ok(goalFallbackOpener(p, 'endurance', 'metric')?.includes(line));
  const base = computeGoalProgress(input('endurance'));
  assert.ok(!requiredOpenerLine(base, 'endurance', 'metric')?.includes('knee'));
  // A goal line that ends in a question keeps ending in it (the route tells the model not to ask a second one).
  const asking = requiredOpenerLine({ ...p, lastSessionDaysAgo: 30 }, 'endurance', 'metric');
  assert.ok(asking?.includes(line));
  assert.ok(asking?.endsWith('?'), asking ?? 'null');
});
