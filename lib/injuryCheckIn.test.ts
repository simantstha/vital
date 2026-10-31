/**
 * Wave 27 - the injury check-in: a logged Injury fact reaches the plan surfaces (goal card, weekly review, coach brief /
 * opener) as ONE neutral check-in line. This file covers the pure rules (window, text, wording, which goals); the surfaces
 * have their own tests (goalProgress.injury.test.ts, weeklyReview.injury.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INJURY_CHECK_IN_WINDOW_DAYS,
  injuryCheckInApplies,
  injuryCheckInLine,
  injuryText,
  pickInjuryCheckIn,
  stripInjuryCheckIn,
} from './injuryCheckIn';

const TODAY = '2026-10-31';

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

test('the window is 28 days from the day the fact was logged', () => {
  assert.equal(INJURY_CHECK_IN_WINDOW_DAYS, 28);
  const at = (age: number) => pickInjuryCheckIn([{ label: 'Knee pain', loggedDay: addDays(TODAY, -age) }], TODAY);
  assert.deepEqual(at(0), { text: 'knee pain', since: TODAY });
  assert.deepEqual(at(10), { text: 'knee pain', since: addDays(TODAY, -10) });
  assert.notEqual(at(28), null, 'day 28 is still inside the window');
  assert.equal(at(29), null, 'day 29 is stale: an unresolved note this old is more likely forgotten than live');
  assert.equal(at(90), null);
});

test('a fact logged after the day being asked about does not exist yet (the weekly review is as-of its Sunday)', () => {
  assert.equal(pickInjuryCheckIn([{ label: 'Knee pain', loggedDay: addDays(TODAY, 1) }], TODAY), null);
});

test('no rows, blank labels and malformed days give nothing - never a fabricated injury', () => {
  assert.equal(pickInjuryCheckIn([], TODAY), null);
  assert.equal(pickInjuryCheckIn([{ label: '   ', loggedDay: TODAY }], TODAY), null);
  assert.equal(pickInjuryCheckIn([{ label: 'Knee pain', loggedDay: 'yesterday' }], TODAY), null);
  assert.equal(pickInjuryCheckIn([{ label: 'Knee pain', loggedDay: '' }], TODAY), null);
});

test('the most recently logged injury inside the window wins; an older one outside it is ignored', () => {
  const picked = pickInjuryCheckIn([
    { label: 'Shin splints', loggedDay: addDays(TODAY, -20) },
    { label: 'Sore left Achilles', loggedDay: addDays(TODAY, -3) },
    { label: 'Old ankle sprain', loggedDay: addDays(TODAY, -200) },
  ], TODAY);
  assert.deepEqual(picked, { text: 'sore left Achilles', since: addDays(TODAY, -3) });
});

test('the text is the fact\'s body part, not its "since" clause or its capital letter', () => {
  assert.equal(injuryText('Knee pain since Oct 20'), 'knee pain');
  assert.equal(injuryText('Lower back strain, since last Tuesday'), 'lower back strain');
  assert.equal(injuryText('Torn ACL'), 'torn ACL');
  assert.equal(injuryText('ACL tear'), 'ACL tear');
  assert.equal(injuryText('  Plantar   fasciitis '), 'plantar fasciitis');
  assert.equal(injuryText('since Oct 20'), null);
  assert.equal(injuryText(''), null);
  const long = injuryText('Chronic pain in the outside of my left knee that flares up on downhill running and stairs');
  assert.ok(long != null && long.length <= 40, long ?? 'null');
});

test('one wording per goal: neutral, dated, never claims to know it still hurts', () => {
  const ci = { text: 'knee pain', since: '2026-10-24' };
  assert.equal(
    injuryCheckInLine('endurance', ci),
    'You noted knee pain on Oct 24 — if it still hurts, swap hard sessions (intervals, long runs) for easy work or rest, and see a professional if it persists.',
  );
  assert.equal(
    injuryCheckInLine('muscle', ci),
    'You noted knee pain on Oct 24 — if it still hurts, swap hard sessions (heavy lifts) for easy work or rest, and see a professional if it persists.',
  );
  assert.equal(
    injuryCheckInLine('general', ci),
    'You noted knee pain on Oct 24 — if it still hurts, swap hard sessions for easy work or rest, and see a professional if it persists.',
  );
  for (const goal of ['endurance', 'muscle', 'general'] as const) {
    assert.doesNotMatch(injuryCheckInLine(goal, ci), /you (are|have|still have) (hurt|injured)|your injury/i);
  }
});

test('which goals get the line: endurance and strength always, general only with training cues, weight loss never', () => {
  assert.equal(injuryCheckInApplies('endurance', { hasTrainingCues: false }), true);
  assert.equal(injuryCheckInApplies('muscle', { hasTrainingCues: false }), true);
  assert.equal(injuryCheckInApplies('general', { hasTrainingCues: true }), true);
  assert.equal(injuryCheckInApplies('general', { hasTrainingCues: false }), false);
  // Its card and review speak of calories and the scale; no session is prescribed, so a training swap has nothing to attach to.
  assert.equal(injuryCheckInApplies('weight_loss', { hasTrainingCues: true }), false);
});

test('stripInjuryCheckIn removes only our own trailing sentence (so last week\'s stored tip can still be compared)', () => {
  const ci = { text: 'knee pain', since: '2026-10-24' };
  const tip = 'Add 2 km to your long run.';
  assert.equal(stripInjuryCheckIn(`${tip} ${injuryCheckInLine('endurance', ci)}`), tip);
  assert.equal(stripInjuryCheckIn(tip), tip);
  assert.equal(stripInjuryCheckIn('You noted a PR on Monday — nice.'), 'You noted a PR on Monday — nice.');
});
