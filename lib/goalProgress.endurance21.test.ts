/**
 * Wave 21e - endurance card: light weeks, race eve, taper Sunday, the long-run cap note's cadence, long runs that were
 * most of their week, whole-week session counts, cutbacks and strides. (Its own file, like the wave 20 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeGoalProgress as computeGoalProgressRaw, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { plainSpaces } from './displayText';

const TODAY = '2026-10-06'; // Tuesday

function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  return JSON.parse(plainSpaces(JSON.stringify(computeGoalProgressRaw(input)))) as GoalProgress;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Run = { day: string; durationMin: number; distanceKm: number; type: string };

function input(runs: Run[], over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return {
    goal: 'endurance',
    todayKey: TODAY,
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    start: { weightKg: null, startedAt: null },
    weightReadings: [],
    intakeDays: [],
    budget: null,
    progression: {},
    trainingDays: runs.map(r => r.day),
    workouts: runs,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    ...over,
  };
}

const run = (day: string, km: number, min = Math.round(km * 6)): Run => ({ day, durationMin: min, distanceKm: km, type: 'Running' });

/** `plan[0]` is the week of `todayKey`; each entry is `[weekday (Mon = 0), km]`; days after today are dropped. */
function weeks(todayKey: string, plan: Array<Array<[number, number]>>): Run[] {
  const dow = (new Date(`${todayKey}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(todayKey, -dow);
  const out: Run[] = [];
  plan.forEach((w, i) => {
    for (const [d, km] of w) {
      const day = addDays(monday, -7 * i + d);
      if (day <= todayKey) out.push(run(day, km));
    }
  });
  return out;
}
const wk = (km: number): Array<[number, number]> => [[1, km * 0.2], [3, km * 0.2], [5, km * 0.2], [6, km * 0.4]];
const texts = (p: GoalProgress): string => p.reasons.map(r => r.text).join(' | ');

test('light week: days off in the week (or well behind its pace from Friday) is "holding", never "On track for the half" - the long run is capped, not invited', () => {
  const half = { date: '2026-12-20', distanceKm: 21.1 };
  const sat = '2026-10-10';
  // One 6 km run on Tuesday after four 30 km weeks: Wednesday to Saturday is four days off.
  const light = computeGoalProgress(input(weeks(sat, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race: half }));
  assert.equal(light.verdict, 'holding');
  assert.equal(light.headline, 'Light week — 6 of 30 km so far');
  assert.doesNotMatch(light.headline, /On track|Behind|long run 12 of 15/);
  const plan = light.reasons.find(r => r.kind === 'plan')!;
  assert.equal(plan.text, "Light week — don't make it up; long run ≤ ~8 km easy, or skip it if you were ill");
  assert.equal(light.distance!.plan?.lightWeek, true);
  assert.equal(light.distance!.plan?.longRunKm, 8); // the cap: ~40% of a realistic week (70% of 30), under the last long run (12)
  assert.equal(light.longRun?.nextKm, 8);
  assert.ok(!texts(light).includes('Hold 30 km'), texts(light));
  // Sunday, and a build (not maintain) week: the same call.
  const sun = '2026-10-11';
  const build = computeGoalProgress(input(weeks(sun, [[[0, 3]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  assert.equal(build.verdict, 'holding');
  assert.match(build.headline, /^Light week — 3 of ~25 km so far$/);
  // A normal week at the same weekday is not light.
  const ordinary = computeGoalProgress(input(weeks(sat, [[[1, 6], [3, 6], [5, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race: half }));
  assert.notEqual(ordinary.headline.slice(0, 10), 'Light week');
  assert.equal(ordinary.distance!.plan?.lightWeek, undefined);
});

test('taper Sunday: the last day of a taper week says the week is done and what comes next - not "rest or a very easy jog from here"', () => {
  const sunday = '2026-10-11';
  // A half on Sunday 10-18: Monday 10-05 is 13 days out (the taper week), next Monday is race week.
  const race = { date: '2026-10-18', distanceKm: 21.1 };
  const history = weeks(sunday, [[[1, 8], [3, 8], [5, 6], [6, 14]], wk(30), wk(30), wk(30)]);
  const over = computeGoalProgress(input(history, { todayKey: sunday, race, racePeakWeekKm: 30 }));
  assert.equal(over.race?.phase, 'taper');
  assert.match(over.headline, /^Taper week — 36 of ~23 km, over the plan$/);
  const line = over.reasons.find(r => r.kind === 'race_phase')!;
  assert.equal(line.text, 'Taper week done — keep race week short and easy');
  assert.doesNotMatch(texts(over), /rest or a very easy jog/);
  // On plan it says the same on Sunday (and the headline is not "over").
  const calm = computeGoalProgress(input(weeks(sunday, [[[1, 5], [3, 5], [5, 4], [6, 8]], wk(30), wk(30), wk(30)]), { todayKey: sunday, race, racePeakWeekKm: 30 }));
  assert.equal(calm.reasons.find(r => r.kind === 'race_phase')!.text, 'Taper week done — keep race week short and easy');
  assert.match(calm.headline, /on plan$/);
  // A marathon's first taper week is followed by another taper week, not race week.
  const marathon = computeGoalProgress(input(history, { todayKey: sunday, race: { date: '2026-10-25', distanceKm: 42.2 }, racePeakWeekKm: 30 }));
  assert.equal(marathon.race?.phase, 'taper');
  assert.equal(marathon.reasons.find(r => r.kind === 'race_phase')!.text, 'Taper week done — keep next week short and easy');
  // Not on a Saturday: the leftover budget talk stays.
  const saturday = computeGoalProgress(input(weeks('2026-10-10', [[[1, 8], [3, 8], [5, 6]], wk(30), wk(30), wk(30)]), { todayKey: '2026-10-10', race, racePeakWeekKm: 30 }));
  assert.doesNotMatch(texts(saturday), /Taper week done/);
});

test('the long-run cap note: said in the goal\'s first build week and then every 4th, never in a taper, race, recovery or rebuild week', () => {
  const race = { date: '2026-12-20', distanceKm: 21.1 }; // a 30 km goal cannot carry the half's 18 km peak: 15 km fits
  const started = '2026-09-07'; // a Monday: its week is week 0
  const at = (todayKey: string) => {
    const monday = addDays(todayKey, -((new Date(`${todayKey}T00:00:00Z`).getUTCDay() + 6) % 7));
    const weeksBack = Math.round((Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${started}T00:00:00Z`)) / (7 * 86_400_000));
    const plan: Array<Array<[number, number]>> = [[]];
    for (let w = 1; w <= Math.min(weeksBack, 5); w++) plan.push(wk(30));
    return computeGoalProgress(input(weeks(todayKey, plan), { todayKey, race, start: { weightKg: null, startedAt: null, startedDay: started } }));
  };
  const said = (p: GoalProgress): boolean => /Your 30 km weeks fit a 15 km long run/.test(texts(p));
  // Weeks 1, 2, 3 of the goal: quiet. Week 4: said. (Week 0 is the baseline week and has no long run line.)
  assert.equal(said(at('2026-10-06')), false); // week 4 would be 2026-10-05; this Tuesday is week 4 of the goal -> check below
  assert.equal(at('2026-10-06').longRun?.capNoteDue, true); // 4 weeks after the goal's first week
  assert.equal(at('2026-09-29').longRun?.capNoteDue, undefined); // week 3
  assert.equal(at('2026-09-22').longRun?.capNoteDue, undefined); // week 2
  assert.equal(at('2026-10-13').longRun?.capNoteDue, undefined); // week 5
  assert.equal(at('2026-11-03').longRun?.capNoteDue, true); // week 8
  // Wind-down weeks never carry it, even though the race peak is still the capped one.
  const taper = computeGoalProgress(input(weeks('2026-12-09', [[], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-12-09', race, racePeakWeekKm: 30, start: { weightKg: null, startedAt: null, startedDay: started } }));
  assert.equal(taper.race?.phase, 'taper');
  assert.equal(taper.longRun?.capNoteDue, undefined);
  assert.doesNotMatch(texts(taper), /raise the goal/);
});

test('a long run that was most of its week: one watch note, the peak is never praised as good', () => {
  const race = { date: '2026-11-22', distanceKm: 21.1 };
  const bigLong: Array<[number, number]> = [[1, 4], [3, 4], [5, 4], [6, 18]]; // an 18 km long run in a 30 km week: 60%
  const monday = '2026-10-12';
  const p = computeGoalProgress(input(weeks(monday, [[], bigLong, wk(30), wk(30), wk(30)]), { todayKey: monday, race }));
  const note = p.reasons.find(r => r.kind === 'long_run')!;
  assert.deepEqual({ text: note.text, tone: note.tone }, { text: '18 km was 60% of your week — keep long runs ~15 km on 30 km weeks, or add easy km', tone: 'watch' });
  assert.equal(p.reasons.filter(r => r.kind === 'long_run').length, 1);
  assert.ok(p.reasons.every(r => !(r.kind === 'long_run' && r.tone === 'good')));
  assert.doesNotMatch(p.headline, /peak 18 km reached/);
  assert.equal(p.longRun?.oversized, true);
  // An ordinary 14 km long run in a 30 km week (47%) says nothing of the kind.
  const ordinary = computeGoalProgress(input(weeks(monday, [[], [[1, 5], [3, 5], [5, 6], [6, 14]], wk(30), wk(30), wk(30)]), { todayKey: monday, race }));
  assert.ok(ordinary.reasons.every(r => !/of your week/.test(r.text)));
  // In the taper the "peak long run - done" line stays, but is neutral, not [good].
  const taperDay = '2026-11-10'; // 12 days out: the half's taper week
  const taper = computeGoalProgress(input(weeks(taperDay, [[], bigLong, wk(30), wk(30), wk(30)]), { todayKey: taperDay, race, racePeakWeekKm: 30 }));
  assert.equal(taper.race?.phase, 'taper');
  const done = taper.reasons.find(r => r.kind === 'long_run')!;
  assert.deepEqual({ text: done.text, tone: done.tone }, { text: 'Peak long run 18 km — done', tone: 'neutral' });
  // A normal peak is still praised.
  const fine = computeGoalProgress(input(weeks(taperDay, [[], [[1, 5], [3, 5], [5, 6], [6, 14]], wk(30), wk(30), wk(30)]), { todayKey: taperDay, race, racePeakWeekKm: 30 }));
  assert.equal(fine.reasons.find(r => r.kind === 'long_run')!.tone, 'good');
});

test('sessions: whole calendar weeks ("3 or 4 runs a week so far"), steady through the days of a week - no jittery average', () => {
  const start = '2026-09-21'; // the goal began on a Monday, 15 days ago
  const history = weeks(TODAY, [[], [[1, 5], [3, 5], [5, 5], [6, 10]], [[1, 5], [3, 5], [6, 8]]]);
  const text = (todayKey: string) => computeGoalProgress(input(history.filter(r => r.day <= todayKey), { todayKey, start: { weightKg: null, startedAt: null, startedDay: start } }))
    .reasons.find(r => r.kind === 'sessions')!.text;
  assert.equal(text(TODAY), '3 or 4 runs a week so far');
  assert.equal(text('2026-10-07'), '3 or 4 runs a week so far');
  assert.equal(text('2026-10-10'), '3 or 4 runs a week so far');
  assert.doesNotMatch(text(TODAY), /Averaging|\d\.\d/);
  // Before the first whole week is done it counts this week so far.
  const first = computeGoalProgress(input([run('2026-10-05', 5), run('2026-10-06', 5)], { start: { weightKg: null, startedAt: null, startedDay: '2026-10-05' } }));
  assert.equal(first.reasons.find(r => r.kind === 'sessions')?.text, '2 runs so far this week');
});

test('cutback week on the card: ~80% of the step, the long run held, named "Cutback week" - and graded as its own target', () => {
  // Monday 2026-10-19 is the calendar's cutback week; weeks 09-14 (baseline) .. 10-12 precede it.
  const todayKey = '2026-10-20';
  const history = weeks(todayKey, [[], wk(23), wk(21), wk(19), wk(17), wk(15)]);
  const p = computeGoalProgress(input(history, { todayKey }));
  assert.equal(p.distance!.plan?.kind, 'build');
  assert.equal(p.distance!.plan?.cutback, true);
  assert.equal(p.distance!.stepTargetKm, 20); // 80% of the 25 km step
  assert.match(p.reasons.find(r => r.kind === 'plan')!.text, /^Cutback week: ~20 km, long run [\d.]+ km — absorb the last three weeks$/);
  assert.equal(p.distance!.plan?.longRunHeld, true);
  assert.match(p.headline, /^Building — 23 km last week/);
  // Running the full ~25 km instead says "step is done" while a day is left - not a spike: 25 is the week it replaces.
  const thursday = '2026-10-22';
  const ran = computeGoalProgress(input(weeks(thursday, [[[0, 13], [1, 12]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thursday }));
  assert.equal(ran.verdict, 'building');
  assert.match(ran.reasons[0].text, /^25 of ~20 km — the week's step is done; keep the rest of the week easy and short$/);
});

test('strides: the last 2 build weeks before a taper add "plus 4–6 strides after one easy run" to the plan line', () => {
  const race = { date: '2026-11-08', distanceKm: 21.1 }; // a half: taper starts Monday 10-26, so 10-12 and 10-19 are the last two build weeks
  const plan = (todayKey: string) => {
    const p = computeGoalProgress(input(weeks(todayKey, [[], wk(30), wk(30), wk(30), wk(30)]), { todayKey, race }));
    return p.reasons.find(r => r.kind === 'plan')?.text ?? '';
  };
  assert.doesNotMatch(plan('2026-10-06'), /strides/);
  assert.match(plan('2026-10-13'), /plus 4–6 strides after one easy run$/);
  assert.match(plan('2026-10-20'), /plus 4–6 strides after one easy run$/);
});

test('taper copy on the card joins "3×1 km" / "3×0.5 mi" (and every new line) with U+00A0 - with and without a weekly distance target', () => {
  const race = { date: '2026-10-18', distanceKm: 21.1 };
  const breaking = /\d (km|mi|kg|lb|kcal|min)\b/;
  for (const unitSystem of ['metric', 'imperial'] as const) {
    const rep = unitSystem === 'metric' ? '3×1 km' : '3×0.5 mi';
    // With a weekly distance target the week plan's purpose line carries the reps; without one the race-phase reason does.
    const withTarget = computeGoalProgressRaw(input(weeks('2026-10-07', [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-10-07', race, racePeakWeekKm: 30, unitSystem }));
    const noTarget = computeGoalProgressRaw(input(weeks('2026-10-07', [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), {
      todayKey: '2026-10-07', race, racePeakWeekKm: 30, unitSystem, target: { weightKg: null, date: null, weeklySessions: 4, weeklyDistanceKm: null },
    }));
    for (const gp of [withTarget, noTarget]) {
      const all = [gp.headline, gp.distance?.text ?? '', gp.distance?.plan?.purpose ?? '', ...gp.reasons.map(r => r.text)].join(' | ');
      assert.ok(all.includes(`plus ${rep} at race pace midweek`), `${unitSystem}: ${all}`);
      assert.equal(breaking.test(all), false, all);
    }
  }
  // The light, cutback and strides lines and the share note too.
  const lines: string[] = [];
  const sat = '2026-10-10';
  const light = computeGoalProgressRaw(input(weeks(sat, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race: { date: '2026-12-20', distanceKm: 21.1 }, unitSystem: 'imperial' }));
  lines.push(light.headline, ...light.reasons.map(r => r.text));
  const cut = computeGoalProgressRaw(input(weeks('2026-10-20', [[], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-20', unitSystem: 'imperial' }));
  lines.push(cut.headline, ...cut.reasons.map(r => r.text));
  const big = computeGoalProgressRaw(input(weeks('2026-10-12', [[], [[1, 4], [3, 4], [5, 4], [6, 18]], wk(30), wk(30), wk(30)]), { todayKey: '2026-10-12', race: { date: '2026-11-22', distanceKm: 21.1 }, unitSystem: 'imperial' }));
  lines.push(big.headline, ...big.reasons.map(r => r.text));
  const strides = computeGoalProgressRaw(input(weeks('2026-10-13', [[], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-10-13', race: { date: '2026-11-08', distanceKm: 21.1 } }));
  lines.push(...strides.reasons.map(r => r.text));
  assert.ok(lines.some(l => l.startsWith('Light week')) && lines.some(l => l.startsWith('Cutback week')) && lines.some(l => /strides/.test(l)) && lines.some(l => /of your week/.test(l)));
  for (const l of lines) assert.equal(breaking.test(l), false, l);
});

test('a jump in a cutback week is a jump over the cutback number: the headline, the distance line and the reason all quote that one target', () => {
  const sunday = '2026-10-25'; // the cutback week 10-19, ended with a 40 km week instead of ~20 km
  const p = computeGoalProgress(input(weeks(sunday, [[[1, 9], [3, 9], [5, 10], [6, 12]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sunday }));
  assert.equal(p.distance!.plan?.cutback, true);
  assert.equal(p.distance!.stepTargetKm, 20);
  assert.equal(p.verdict, 'holding');
  assert.equal(p.headline, 'Over the safe step — 40 of ~20 km. Hold ~28 km next week');
  assert.equal(p.distance!.text, '40 of ~20 km running this week · goal 30 km');
  assert.equal(p.reasons.find(r => r.kind === 'volume')!.text, "40 km is 20 km over this week's safe step; big jumps raise injury risk — keep tomorrow's run easy and hold next week's step");
  // ... the Monday after holds one step up from the 25 km week the cutback replaced (not from the 40 km jump, nor from the cutback's
  // own low), and names last week's step as the target its cards showed.
  const monday = computeGoalProgress(input(weeks('2026-10-26', [[], [[1, 9], [3, 9], [5, 10], [6, 12]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-26' }));
  assert.equal(monday.distance!.plan?.kind, 'hold');
  assert.equal(monday.distance!.stepTargetKm, 28);
  assert.equal(monday.reasons.find(r => r.kind === 'volume')!.text, "Last week's 40 km was over the safe step of ~20 km");
  // The normal week instead of the cutback (25 km, 25% over its 20 km) is no jump.
  const normal = computeGoalProgress(input(weeks(sunday, [[[1, 8], [3, 8], [5, 9]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sunday }));
  assert.equal(normal.distance!.thisWeekKm, 25);
  assert.notEqual(normal.verdict, 'holding');
  assert.doesNotMatch(normal.headline, /Over the safe step/);
});

test('a comeback week more than 10% over its "up to" cap is "a touch over, fine" on the card - never "on plan" - and the ceiling climbs from the ceiling, not the overshoot (wave 22e)', () => {
  const monday = '2026-10-26';
  // Weeks 1-6 build (15..25 km), two weeks off, a restart week of 12 km, then the comeback week "up to ~15 km" ran at `lastKm`.
  const hist = (lastKm: number) => [[], wk(lastKm), wk(12), [], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const card = (lastKm: number) => computeGoalProgress(input(weeks(monday, hist(lastKm)), { todayKey: monday }));
  const over = card(18);
  assert.equal(over.headline, 'Building — 18 of up to ~15 km last week, a touch over, fine');
  assert.equal(over.verdict, 'building');
  assert.equal(over.distance!.stepTargetKm, 18, '1.25x the 15 km ceiling (18.75, floored), never 1.25x the overshoot or the 22 km rung');
  assert.equal(over.distance!.text, '0 of up to ~18 km running this week · goal 30 km');
  assert.equal(over.distance!.plan?.overCap, true);
  assert.equal(over.distance!.plan?.overCapRead, 'touch');
  assert.match(over.reasons.find(r => r.kind === 'plan')!.text, /^Up to ~18 km this week: /);
  assert.doesNotMatch(texts(over), /on plan|on track|Hold here/);
  // Far past the ceiling it is a spike: the week after stays AT the ceiling (no "hold here, up to ~20 km" that is higher than last week's).
  const well = card(20);
  assert.equal(well.verdict, 'holding');
  assert.equal(well.headline, 'Well over the ceiling last week — stay at ~15 km this week');
  assert.equal(well.distance!.stepTargetKm, 15);
  assert.equal(well.distance!.plan?.kind, 'hold');
  assert.equal(well.distance!.plan?.overCapRead, 'well');
  assert.equal(well.reasons.find(r => r.kind === 'volume')!.text, "Last week's 20 km was well over its ~15 km ceiling — don't build on the jump");
  // Exactly 10% over the ceiling is inside its slack: on plan, and the ladder climbs (1.25 x 16.5 km).
  const within = card(16.5);
  assert.match(within.headline, /on plan$/);
  assert.equal(within.distance!.plan?.overCap, undefined);
  assert.equal(within.distance!.stepTargetKm, 20);
});

test('a taper week says "on plan" only while the week can still land in the taper band: the long run ahead counts, at the weekend a short week is "easy runs are enough"', () => {
  const race = { date: '2026-06-21', distanceKm: 21.1 };
  const card = (todayKey: string, thisWeek: Array<[number, number]>) =>
    computeGoalProgress(input(weeks(todayKey, [thisWeek, wk(30), wk(30), wk(30), wk(28)]), { todayKey, race }));
  // Friday, 5.4 km in: the taper's 8 km long run is still ahead (5.4 + 8 is over 60% of ~23 km), so the claim stands.
  const friday = card('2026-06-12', [[1, 2.8], [3, 2.6]]);
  assert.equal(friday.distance!.plan?.kind, 'taper');
  assert.equal(friday.headline, 'Taper week — 5.4 of ~23 km, on plan');
  // Saturday with 2 km all week: even the long run would not bring it to the band - missing taper volume is safe, but it is not "on plan".
  const saturday = card('2026-06-13', [[1, 2]]);
  assert.equal(saturday.headline, 'Taper week — 2 of ~23 km; easy runs are enough');
  assert.equal(saturday.verdict, 'on_track', 'never a "behind" in a taper');
  assert.equal(card('2026-06-14', [[1, 2]]).headline, 'Taper week — 2 of ~23 km; easy runs are enough');
  // The long run still to come on Saturday keeps it on plan; a long run done on Sunday lands it; a Sunday with only short runs and no long run does not.
  assert.equal(card('2026-06-13', [[1, 2.8], [3, 2.8], [4, 2.8]]).headline, 'Taper week — 8.4 of ~23 km, on plan');
  assert.equal(card('2026-06-14', [[1, 2.8], [3, 2.8], [6, 9]]).headline, 'Taper week — 14.6 of ~23 km, on plan');
  assert.equal(card('2026-06-14', [[1, 2.8], [3, 2.8]]).headline, 'Taper week — 5.6 of ~23 km; easy runs are enough');
});
