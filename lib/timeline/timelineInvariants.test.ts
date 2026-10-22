/**
 * Timeline invariants: behaviours the persona-review waves fixed, locked in as tests over the day-by-day
 * simulation (lib/timeline/README.md). Each invariant runs once per relevant scenario; a failure names the
 * scenario, the day and the offending string. Add an invariant by writing a `find` function and one
 * `invariant(...)` call. Scenarios run once per process (runTimeline caches), not once per test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TAPER_GOOD_MIN_FRACTION, racePhaseInfo } from '../enduranceProgression';
import { weekFitsSessionTarget, type GoalLiftReturn } from '../goalProgress';
import { liftLapseMinDays, liftReturnDisplay, liftShortName } from '../liftChange';
import { KM_PER_MILE } from '../metricFormat';
import { calorieFloorKcal, isInstruction, TRIM_MAX_KCAL_PER_STEP } from '../weightWeekPlan';
import { runTimeline, stepDay } from './engine';
import { extractInstructions } from './instructions';
import { COMEBACK_OBEDIENT_ILL_DAYS, OBEDIENT_SHORT_WEEK, SCENARIO_NAMES, buildScenario, type ScenarioName } from './scenarios';
import { addDays, dayDiff, weekdayOf, type DaySnapshot } from './types';

const ALL: readonly ScenarioName[] = SCENARIO_NAMES;
const RUNNERS = ALL.filter(n => n.startsWith('runner_'));
const LIFTERS = ALL.filter(n => n.startsWith('lifter'));
const WEIGHT: readonly ScenarioName[] = ['weight_loss', 'weight_loss_logged', 'weight_loss_obedient'];

// ── plumbing ────────────────────────────────────────────────────────────────

interface Violation { snap: DaySnapshot; detail: string }
interface Text { where: string; text: string }

const MAX_REPORTED = 5;

function describeDay(s: DaySnapshot): string {
  return `day ${s.idx} (${s.weekday} ${s.date})`;
}

/** Registers one `test` per scenario: the invariant holds when `find` returns no violations. */
function invariant(scenarios: readonly ScenarioName[], title: string, find: (snaps: DaySnapshot[], name: ScenarioName) => Violation[]): void {
  for (const name of scenarios) {
    test(`${name}: ${title}`, () => {
      const found = find(runTimeline(name), name);
      const shown = found.slice(0, MAX_REPORTED).map(v => `  ${describeDay(v.snap)}: ${v.detail}`).join('\n');
      const more = found.length > MAX_REPORTED ? `\n  ... and ${found.length - MAX_REPORTED} more` : '';
      assert.equal(found.length, 0, `${name} violates "${title}" on ${found.length} day(s):\n${shown}${more}`);
    });
  }
}

/** Text with non-breaking spaces made plain, for matching by regex; quotes in messages show the raw U+00A0 as "␣". */
const plain = (s: string): string => s.replace(/ /g, ' ');
const visible = (s: string): string => s.replace(/ /g, '␣');

/** The goal card's user-visible strings (headline, reasons, distance line). */
function cardTexts(s: DaySnapshot): Text[] {
  const gp = s.card;
  if (!gp) return [];
  const out: Text[] = [{ where: 'card.headline', text: gp.headline }];
  gp.reasons.forEach((r, i) => out.push({ where: `card.reasons[${i}] (${r.kind})`, text: r.text }));
  if (gp.distance) out.push({ where: 'card.distance.text', text: gp.distance.text });
  return out;
}

/** The coach goal lines and the opener (both are given to the model in plain ASCII spaces). */
function coachTexts(s: DaySnapshot): Text[] {
  const out: Text[] = (s.coach ?? []).map((t, i) => ({ where: `coach[${i}]`, text: t }));
  if (s.opener?.required) out.push({ where: 'opener.required', text: s.opener.required });
  if (s.opener?.fallback) out.push({ where: 'opener.fallback', text: s.opener.fallback });
  return out;
}

/** The Monday weekly review's user-visible strings. */
function reviewTexts(s: DaySnapshot): Text[] {
  const r = s.review?.review;
  if (!r) return [];
  const out: Text[] = [{ where: 'review.headline', text: r.headline }];
  r.stats.forEach((st, i) => {
    out.push({ where: `review.stats[${i}].label`, text: st.label }, { where: `review.stats[${i}].value`, text: st.value });
    if (st.comparison) out.push({ where: `review.stats[${i}].comparison`, text: st.comparison });
  });
  if (r.win) out.push({ where: 'review.win', text: r.win });
  if (r.slip) out.push({ where: 'review.slip', text: r.slip });
  out.push({ where: 'review.nextWeek', text: r.nextWeek });
  return out;
}

const allTexts = (s: DaySnapshot): Text[] => [...cardTexts(s), ...coachTexts(s), ...reviewTexts(s)];

/** One violation per text that matches `re` (matched on the plain-space form); the offending string is quoted. */
function textMatches(snaps: DaySnapshot[], texts: (s: DaySnapshot) => Text[], re: RegExp, applies: (s: DaySnapshot) => boolean = () => true, label = ''): Violation[] {
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!applies(snap)) continue;
    for (const t of texts(snap)) {
      if (re.test(plain(t.text))) out.push({ snap, detail: `${label}${t.where}: "${visible(t.text)}"` });
    }
  }
  return out;
}

/** Every string (and non-finite number) anywhere in `v` that reads like a leaked JS value. */
const BAD_TEXT = /NaN|undefined|\bnull\b|Infinity|\[object/;
function scanValue(v: unknown, path: string, out: Array<{ where: string; value: string }>): void {
  if (typeof v === 'string') {
    if (BAD_TEXT.test(v)) out.push({ where: path, value: v });
  } else if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push({ where: path, value: String(v) });
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => scanValue(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) scanValue(x, `${path}.${k}`, out);
  }
}

// ── all scenarios ───────────────────────────────────────────────────────────

invariant(ALL, 'no function throws on any day', snaps =>
  snaps.filter(s => s.errors.length > 0).map(snap => ({ snap, detail: snap.errors.join(' || ') })));

invariant(ALL, 'no "NaN", "undefined", "null" or "Infinity" in any user-visible string', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const hits: Array<{ where: string; value: string }> = [];
    scanValue(snap.card, 'card', hits);
    scanValue(snap.coach, 'coach', hits);
    scanValue(snap.opener, 'opener', hits);
    if (snap.review) {
      scanValue(snap.review.review, 'review', hits);
      scanValue(snap.review.alert, 'alert', hits);
    }
    for (const h of hits) out.push({ snap, detail: `${h.where}: "${visible(h.value)}"` });
  }
  return out;
});

const HEADLINE_MAX = 80;
const MAX_REASONS = 3;
const MAX_REVIEW_STATS = 4;

invariant(ALL, `headline <= ${HEADLINE_MAX} characters (card and review)`, snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const card = snap.card?.headline;
    if (card != null && card.length > HEADLINE_MAX) out.push({ snap, detail: `card.headline is ${card.length} characters: "${visible(card)}"` });
    const rev = snap.review?.review.headline;
    if (rev != null && rev.length > HEADLINE_MAX) out.push({ snap, detail: `review.headline is ${rev.length} characters: "${visible(rev)}"` });
  }
  return out;
});

invariant(ALL, `at most ${MAX_REASONS} reasons on the card`, snaps =>
  snaps.filter(s => s.reasons.length > MAX_REASONS).map(snap => ({ snap, detail: `${snap.reasons.length} reasons: ${snap.reasons.map(r => `"${visible(r.text)}"`).join(' | ')}` })));

invariant(ALL, `at most ${MAX_REVIEW_STATS} review stats`, snaps =>
  snaps.filter(s => (s.review?.review.stats.length ?? 0) > MAX_REVIEW_STATS).map(snap => ({
    snap, detail: `${snap.review?.review.stats.length} stats: ${snap.review?.review.stats.map(st => `"${visible(st.label)}"`).join(' | ')}`,
  })));

invariant(ALL, 'every weekly review has a non-empty next week', snaps =>
  snaps.filter(s => s.review && s.review.review.nextWeek.trim() === '').map(snap => ({ snap, detail: `review.nextWeek is empty (headline "${visible(snap.review?.review.headline ?? '')}")` })));

// A digit, an ASCII space, then a unit. The app glues them with U+00A0 so a number never wraps away from its unit.
const ASCII_SPACE_BEFORE_UNIT = /\d (?:kg|km|mi|lb|kcal)\b/;

// Every scenario, taper and race weeks included: the taper line's race-pace reps are "3×1 km" / "3×0.5 mi" with U+00A0 (wave 21e).
invariant(ALL, 'numbers and units in card and review text are joined by U+00A0 (no ASCII space before kg, km, mi, lb, kcal)', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    for (const t of [...cardTexts(snap), ...reviewTexts(snap)]) {
      const hit = ASCII_SPACE_BEFORE_UNIT.exec(t.text);
      if (hit) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" (ASCII space after "${hit[0].slice(0, hit[0].indexOf(' '))}")` });
    }
  }
  return out;
});

// ── endurance ───────────────────────────────────────────────────────────────

/** The first "<number> km|mi" in a review's Next week, i.e. the week target it states. */
function nextWeekTarget(nextWeek: string): { value: number; unit: 'km' | 'mi' } | null {
  const m = /(\d+(?:\.\d+)?)\s*(km|mi)\b/.exec(plain(nextWeek));
  return m ? { value: Number(m[1]), unit: m[2] as 'km' | 'mi' } : null;
}

invariant(RUNNERS, "on a Monday with a plan and a review, the card's week target equals the review's next-week target", (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    const target = snap.card?.distance?.plan?.targetKm;
    if (!snap.review || target == null) continue;
    const said = nextWeekTarget(snap.review.review.nextWeek);
    if (!said) continue;
    compared++;
    const cardValue = said.unit === 'mi' ? Math.round((target / KM_PER_MILE) * 10) / 10 : target;
    if (Math.abs(cardValue - said.value) > 0.05) {
      out.push({ snap, detail: `card plan target ${target} km (${cardValue} ${said.unit}) vs review next week "${visible(snap.review.review.nextWeek)}"` });
    }
  }
  assert.ok(compared > 0 || out.length > 0, `${name}: no Monday had both a card plan target and a review target, so this invariant checked nothing`);
  return out;
});

const HALF_OR_LESS: Record<string, number> = { build: 0.5, maintain: 0.5, hold: 0.5, restart: 0.4 };

invariant(RUNNERS, "the plan's long run is at most 50% of the week target (40% in a restart week)", snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const plan = snap.card?.distance?.plan;
    if (!plan || plan.targetKm == null || plan.longRunKm == null) continue;
    const share = HALF_OR_LESS[plan.kind];
    if (share == null) continue;
    if (plan.longRunKm > plan.targetKm * share + 1e-9) {
      out.push({ snap, detail: `${plan.kind} week: long run ${plan.longRunKm} km of a ${plan.targetKm} km week is ${Math.round((plan.longRunKm / plan.targetKm) * 100)}% (max ${share * 100}%): "${visible(plan.purpose)}"` });
    }
  }
  return out;
});

const ON_TRACK_WORDS = /\bon (?:track|plan)\b/i;

// A light week (4+ days off, or well behind its own pace from Friday) is "don't make it up": never "On track" / "on plan".
invariant(['runner_messy', 'runner_no_race'], 'a light week is never "On track" or "on plan" on the card', (snaps, name) => {
  const out: Violation[] = [];
  let lightDays = 0;
  for (const snap of snaps) {
    if (snap.card?.distance?.plan?.lightWeek == null) continue;
    lightDays++;
    if (snap.card.verdict === 'on_track') out.push({ snap, detail: `verdict on_track in a light week: "${visible(snap.card.headline)}"` });
    for (const t of cardTexts(snap)) if (ON_TRACK_WORDS.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
  }
  assert.ok(lightDays > 0, `${name}: no day was a light week, so this invariant checked nothing`);
  return out;
});

// Race eve: the day before the race is for rest, so no figure of the week's km (a target, "x of y km so far", "this week") appears.
// The standing weekly goal ("Goal: endurance; 30.0 km/week") and the long-run history line are not figures of this week.
const WEEK_KM_FIGURE = /\d(?:\.\d+)?\s?(?:km|mi)\b[^\n]*\b(?:so far|this week|week's|a week|\/week|target)\b|\b(?:so far|this week|week's target|target)\b[^\n]*\d(?:\.\d+)?\s?(?:km|mi)\b/i;
const isRaceEve = (s: DaySnapshot): boolean => s.race?.daysToRace === 1 && s.race.phase !== 'recovery';

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_imperial', 'runner_on_plan_obedient', 'runner_messy'], 'race eve shows no km-of-the-week figure (card, coach lines, opener)', (snaps, name) => {
  const out: Violation[] = [];
  let eves = 0;
  for (const snap of snaps) {
    if (!isRaceEve(snap)) continue;
    eves++;
    const texts = [...cardTexts(snap), ...coachTexts(snap).filter(t => !/^- (?:Goal|Long run)\b/.test(t.text))];
    for (const t of texts) if (WEEK_KM_FIGURE.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    for (const t of cardTexts(snap)) {
      if (t.where === 'card.distance.text' && /\d/.test(t.text)) out.push({ snap, detail: `${t.where} carries a figure: "${visible(t.text)}"` });
    }
  }
  assert.ok(eves > 0, `${name}: no race-eve day was stepped, so this invariant checked nothing`);
  return out;
});

const NEVER_BEHIND = new Set(['taper', 'race_week', 'recovery', 'rebuild', 'restart']);

invariant(RUNNERS, 'never a "behind" verdict in a taper, race, recovery, rebuild or restart week', snaps =>
  snaps.filter(s => s.card?.verdict === 'behind' && NEVER_BEHIND.has(s.card.distance?.plan?.kind ?? '')).map(snap => ({
    snap, detail: `verdict behind in a ${snap.card?.distance?.plan?.kind} week: "${visible(snap.card?.headline ?? '')}"`,
  })));

const NEXT_GOAL = /Set your next goal/i;

invariant(RUNNERS, '"Set your next goal" appears only in recovery week 1 (days 1-7 after the race)', snaps =>
  textMatches(snaps, allTexts, NEXT_GOAL, s => {
    const daysAfter = s.race ? -s.race.daysToRace : null;
    return !(daysAfter != null && daysAfter >= 1 && daysAfter <= 7);
  }));

// "keep Sunday's run <= 4 km" / "keep tomorrow's run <= 3 km": a km cap on a run that, on race eve, is the race or a rest day.
const CAPPED_NEXT_RUN = /(?:sunday|tomorrow)['’]s run\b[^\d.!?]{0,25}\d/i;

invariant(RUNNERS, "race eve never caps Sunday's run or tomorrow's run with a distance", snaps =>
  textMatches(snaps, s => [...cardTexts(s), ...coachTexts(s)], CAPPED_NEXT_RUN, s => s.race?.daysToRace === 1 && s.race.phase !== 'recovery'));

const RACE_OR_PHASE = /\b(?:race|races|racing|marathon|taper|tapering|phase)\b/i;

invariant(['runner_no_race'], 'never mentions a race or a phase', snaps => textMatches(snaps, allTexts, RACE_OR_PHASE));

// ── lifter ──────────────────────────────────────────────────────────────────

// A lapse starts after liftLapseMinDays(weekly sessions target) days without a strength session: 4 days for 4 a week (wave 21s).
const inLapse = (s: DaySnapshot): boolean => (s.card?.lastSessionDaysAgo ?? 0) >= liftLapseMinDays(s.card?.target.weeklySessions);

invariant(LIFTERS, 'never "Progressing" on a day past the lapse threshold (4 days without a strength session at 4 a week)', snaps => {
  const out = textMatches(snaps, s => [...cardTexts(s), ...coachTexts(s)], /\bprogressing\b/i, inLapse);
  for (const snap of snaps) {
    if (inLapse(snap) && snap.card?.verdict === 'progressing') out.push({ snap, detail: `verdict progressing, last session ${snap.card.lastSessionDaysAgo} days ago` });
  }
  return out;
});

invariant(LIFTERS, 'never a positive lift change on a day past the lapse threshold', snaps => {
  const liftTexts = (s: DaySnapshot): Text[] => [
    ...cardTexts(s).filter(t => t.where === 'card.headline' || t.where.endsWith('(lift)')),
    ...coachTexts(s).filter(t => /1RM/.test(t.text)),
  ];
  return textMatches(snaps, liftTexts, /\+\s?\d/, inLapse);
});

invariant(LIFTERS, 'never a lift "win" on a day past the lapse threshold', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!inLapse(snap)) continue;
    for (const r of snap.reasons) if (r.kind === 'lift' && r.tone === 'good') out.push({ snap, detail: `good-toned lift reason: "${visible(r.text)}"` });
    const win = snap.review?.review.win;
    if (win && /1RM|\blift\b/i.test(win)) out.push({ snap, detail: `review.win: "${visible(win)}"` });
  }
  return out;
});

invariant(LIFTERS, 'never "Stalled" while a lift return is in progress', snaps => {
  const returning = (s: DaySnapshot): boolean => s.card?.liftReturn != null && !s.card.liftReturn.regained;
  const out = textMatches(snaps, s => [...cardTexts(s), ...coachTexts(s)], /\bstalled\b/i, returning);
  for (const snap of snaps) {
    if (returning(snap) && snap.card?.verdict === 'stalled') out.push({ snap, detail: `verdict stalled while returning to ${snap.card.liftReturn?.name}` });
  }
  return out;
});

const mondayOfDate = (day: string): string => addDays(day, -['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayOf(day)));

// The week can no longer reach its sessions target when the sessions so far plus the days left (today included) are under
// it. Counted from the scenario's own rows, not from the card, so a card that miscounts cannot excuse itself.
invariant(LIFTERS, 'a week that can no longer reach its session target is never verdict "progressing"', (snaps, name) => {
  const scn = buildScenario(name);
  const target = scn.user.weeklySessions;
  const trained = new Set(scn.sets.filter(x => !x.isWarmup).map(x => x.day));
  const out: Violation[] = [];
  let shortOutsideLapse = 0;
  for (const snap of snaps) {
    if (target == null || snap.card?.goal !== 'muscle') continue;
    const monday = mondayOfDate(snap.date);
    const done = [...trained].filter(d => d >= monday && d <= snap.date).length;
    const daysLeft = 7 - dayDiff(snap.date, monday);
    if (done >= target || done + daysLeft >= target) continue;
    if (!inLapse(snap)) shortOutsideLapse++;
    if (snap.card.verdict === 'progressing') {
      out.push({ snap, detail: `${done} of ${target} sessions with ${daysLeft} day(s) left, verdict progressing: "${visible(snap.card.headline)}"` });
    }
  }
  if (name === 'lifter_short_week') assert.ok(shortOutsideLapse > 0, `${name}: no short-week day outside a lapse, so this invariant checked nothing`);
  return out;
});

const BACK_ABOVE_ALL = /back above your pre-break best/i;

invariant(LIFTERS, '"Back above your pre-break best" appears only when every lift return is regained', (snaps, name) => {
  const out: Violation[] = [];
  const allBack = (rets: Array<{ regained: boolean }> | null | undefined): boolean => rets != null && rets.length > 0 && rets.every(r => r.regained);
  const claim = (snap: DaySnapshot, texts: Text[], rets: Array<{ name?: string; pct?: number; regained: boolean }> | null | undefined): void => {
    if (allBack(rets)) return;
    for (const t of texts) {
      if (BACK_ABOVE_ALL.test(plain(t.text))) {
        const state = rets == null ? 'no liftReturns' : rets.map(r => `${r.name ?? '?'} ${r.regained ? 'regained' : `${r.pct}%`}`).join(', ');
        out.push({ snap, detail: `${t.where}: "${visible(t.text)}" while liftReturns = [${state}]` });
      }
    }
  };
  let mixedDays = 0;
  for (const snap of snaps) {
    const rets = snap.card?.liftReturns;
    if (rets && rets.some(r => r.regained) && rets.some(r => !r.regained)) mixedDays++;
    claim(snap, [...cardTexts(snap), ...coachTexts(snap)], rets);
    // The review reads the return as of the reviewed Sunday (the card it was built from).
    claim(snap, reviewTexts(snap), snap.review?.progress.liftReturns);
  }
  if (name === 'lifter') assert.ok(mixedDays > 0, `${name}: no day had some lifts back and some not, so the mixed-return case was never exercised`);
  return out;
});

// The review's "Next week" cues the next load of each lift: "Squat 110 → 112.5 kg, bench 87.5 → 90 kg" (the unit once, on the target).
// (The card's "(123 → 133 kg)" is an estimated 1RM over 4 weeks, a measurement and not a load to lift.)
const NEXT_LOAD_CUE = /(\d+(?:\.\d+)?)\s?→\s?(\d+(?:\.\d+)?)\s?(kg|lb)\b/g;

invariant(LIFTERS, 'every next-load cue in the weekly review ("Squat 110 → 112.5 kg") lands on a multiple of 2.5 kg / 5 lb, above the load it starts from', (snaps, name) => {
  const out: Violation[] = [];
  let cues = 0;
  for (const snap of snaps) {
    for (const t of reviewTexts(snap).filter(x => x.where === 'review.nextWeek')) {
      for (const m of plain(t.text).matchAll(NEXT_LOAD_CUE)) {
        cues++;
        const from = Number(m[1]);
        const to = Number(m[2]);
        const step = m[3] === 'kg' ? 2.5 : 5;
        const onGrid = Math.abs(to / step - Math.round(to / step)) < 1e-9;
        if (!onGrid || to <= from) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" (${m[0]} is ${onGrid ? 'not above the start' : `not a multiple of ${step} ${m[3]}`})` });
      }
    }
  }
  assert.ok(cues > 0, `${name}: no next-load cue appeared, so this invariant checked nothing`);
  return out;
});

// ── weight ──────────────────────────────────────────────────────────────────

invariant(WEIGHT, 'no week is rated tough on weight alone', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r || r.weekRating !== 'tough') continue;
    const onlyWeightFlags = r.stats.every(st => st.tone !== 'watch' || /weight|trend/i.test(st.label));
    if (onlyWeightFlags && (r.weekGap == null || r.weekGap.kind === 'weight')) {
      out.push({ snap, detail: `tough week, gap ${JSON.stringify(r.weekGap)}: "${visible(r.headline)}"` });
    }
  }
  return out;
});

invariant(WEIGHT, '"too fast" never appears in a review when that Monday\'s card verdict is not too_fast', snaps =>
  textMatches(snaps, reviewTexts, /too fast/i, s => s.review != null && s.card?.verdict !== 'too_fast', 'card verdict is not too_fast; '));

const MAX_VERDICT_CHANGES = 3;
const VERDICT_WINDOW_DAYS = 14;

invariant(WEIGHT, `at most ${MAX_VERDICT_CHANGES} card verdict changes in any ${VERDICT_WINDOW_DAYS}-day window`, snaps => {
  const out: Violation[] = [];
  const days = snaps.filter(s => s.card != null);
  for (let i = 0; i + VERDICT_WINDOW_DAYS <= days.length; i++) {
    const window = days.slice(i, i + VERDICT_WINDOW_DAYS);
    const changes: string[] = [];
    for (let j = 1; j < window.length; j++) {
      const prev = window[j - 1].card?.verdict;
      const cur = window[j].card?.verdict;
      if (prev !== cur) changes.push(`day ${window[j].idx} ${prev} -> ${cur}`);
    }
    if (changes.length > MAX_VERDICT_CHANGES) {
      out.push({ snap: window[0], detail: `${changes.length} verdict changes in days ${window[0].idx}-${window[window.length - 1].idx}: ${changes.join('; ')}` });
    }
  }
  return out;
});

// A Monday's card and weekly review are built from ONE week plan (lib/weightWeekPlan.ts): the same verdict and the same action.
// An instruction (move the date, trim, eat to target, a plateau's cause, a new target...) is the review's "Next week" word for word;
// a non-instruction ("Keep your routine") leaves the review its own tip, which must not be a different instruction.
const OTHER_INSTRUCTION = /\btrim ~|move the date|new target|maintenance target|easing calories|eat up to|get(?:ting)? back to target|bring the weekends|often water|restarted it/i;

invariant(WEIGHT, "on every Monday the card's verdict and action match the weekly review's", (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    if (!snap.review || !snap.card) continue;
    compared++;
    const review = snap.review.review;
    if (snap.card.verdict !== review.verdict) {
      out.push({ snap, detail: `card verdict ${snap.card.verdict} ("${visible(snap.card.headline)}") vs review verdict ${review.verdict} ("${visible(review.headline)}")` });
    }
    const plan = snap.card.weightRead?.plan;
    if (!plan) continue;
    const action = plan.action;
    const stated = isInstruction(action) || ((plan.state === 'maintenance' || plan.state === 'reached') && action.kind === 'hold');
    if (stated && review.nextWeek !== action.text) {
      out.push({ snap, detail: `card action [${action.kind}] "${visible(action.text)}" vs review next week "${visible(review.nextWeek)}"` });
    } else if (!stated && OTHER_INSTRUCTION.test(plain(review.nextWeek))) {
      out.push({ snap, detail: `card action [${action.kind}] "${visible(action.text)}" asks nothing, review next week asks "${visible(review.nextWeek)}"` });
    }
  }
  assert.ok(compared > 0, `${name}: no Monday had both a card and a review, so this invariant checked nothing`);
  return out;
});

// The week's one action is decided on the Monday: inside a calendar week it changes at most once (an event: welcome back, too fast...),
// never day by day. The one change that never counts is the target being reached - it is news the same day, even in a week that
// already changed once (Tuesday "start easing toward maintenance", Friday "set a new target or switch to maintenance").
invariant(WEIGHT, "the card's action text changes at most once per calendar week (reaching the target aside)", snaps => {
  const out: Violation[] = [];
  const byWeek = new Map<string, Array<{ snap: DaySnapshot; text: string; reached: boolean }>>();
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    if (plan == null) continue;
    const week = mondayOfDate(snap.date);
    byWeek.set(week, [...(byWeek.get(week) ?? []), { snap, text: plan.action.text, reached: plan.state === 'reached' }]);
  }
  for (const [week, days] of byWeek) {
    const changes: string[] = [];
    for (let i = 1; i < days.length; i++) {
      if (days[i].text !== days[i - 1].text && !days[i].reached) {
        changes.push(`${days[i].snap.weekday} ${days[i].snap.date}: "${visible(days[i - 1].text)}" -> "${visible(days[i].text)}"`);
      }
    }
    if (changes.length > 1) out.push({ snap: days[0].snap, detail: `${changes.length} action changes in the week of ${week}: ${changes.join(' ; ')}` });
  }
  return out;
});

// "3 weeks behind" is a date claim off a single noisy pace; a weight-loss surface says the date moves, never how many weeks behind.
// (The coach's own prohibition quotes the phrase - `do not quote ... "weeks behind"` - and is not a claim.)
const WEEKS_BEHIND = /(?<!["“])\bweeks behind\b/i;

invariant(WEIGHT, 'no card, review, coach line or opener says "weeks behind"', snaps => textMatches(snaps, allTexts, WEEKS_BEHIND));

// Trim advice: "trim ~200 kcal a day (to ~1,800 kcal)". One weekly step is never over 200 kcal and never lands under the floor.
const TRIM_ADVICE = /trim ~([\d,]+) kcal a day(?: \(to ~([\d,]+) kcal\))?/gi;

invariant(WEIGHT, 'trim advice is at most 200 kcal a day in one step and never goes below the calorie floor', (snaps, name) => {
  const scn = buildScenario(name);
  const floor = calorieFloorKcal(scn.profile.sex === 'male' ? 1500 : 1200);
  const out: Violation[] = [];
  let trims = 0;
  for (const snap of snaps) {
    for (const t of allTexts(snap)) {
      for (const m of plain(t.text).matchAll(TRIM_ADVICE)) {
        trims++;
        const step = Number(m[1].replace(/,/g, ''));
        const landing = m[2] != null ? Number(m[2].replace(/,/g, '')) : null;
        if (step > TRIM_MAX_KCAL_PER_STEP) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" (a ${step} kcal step, max ${TRIM_MAX_KCAL_PER_STEP})` });
        if (landing != null && landing < floor) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" (lands on ${landing} kcal, under the ${floor} kcal floor)` });
      }
    }
    const target = snap.card?.weightRead?.plan?.action.kcalTarget;
    if (target != null && target < floor) out.push({ snap, detail: `plan action kcalTarget ${target} is under the ${floor} kcal floor: "${visible(snap.card?.weightRead?.plan?.action.text ?? '')}"` });
  }
  // Wave 22w: a user who logs no food is never told to trim (see the wave 22w block), so only the logged scenario has trim advice to check.
  if (name === 'weight_loss_logged') assert.ok(trims > 0, `${name}: no trim advice appeared, so this invariant checked nothing`);
  return out;
});

// One progress weight (wave 21b): the card's "down X kg" (early read, "since the start"), the opener's "X of Y kg down" and the coach's
// "-X kg since start" are the same number as `current.changeKg`, and `progressPct` is that number against the goal's span. A change
// computed from the unrounded weekly mean next to a display of the rounded one reads "down 1 kg" over "0.9 of 8 kg".
const EARLY_DOWN = /\bdown ([\d.]+) kg(?: on the scale)? in \d+ days?\b/i;
const DOWN_SINCE_START = /\bDown ([\d.]+) kg since the start\b/;
const OPENER_PROGRESS = /You're ([\d.]+) of ([\d.]+) kg (down|up)\b/;
const COACH_SINCE_START = /([+\-−]?[\d.]+) kg since start at ([\d.]+) kg/;
const SAME_DISPLAYED_KG = 0.05;

invariant(WEIGHT, 'every "down X kg" / "X of Y kg" figure agrees with current.changeKg (one rounded progress weight)', (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  const signed = (s: string): number => Number(s.replace('−', '-'));
  for (const snap of snaps) {
    const cur = snap.card?.current;
    if (!snap.card || cur?.changeKg == null || cur.startWeightKg == null) continue;
    const change = cur.changeKg;
    const lost = -change;
    const check = (where: string, text: string, said: number, expected: number, what: string): void => {
      compared++;
      if (Math.abs(said - expected) >= SAME_DISPLAYED_KG) out.push({ snap, detail: `${where}: "${visible(text)}" says ${what} ${said} kg, current.changeKg is ${change} (${expected})` });
    };
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      const text = plain(t.text);
      const early = EARLY_DOWN.exec(text) ?? DOWN_SINCE_START.exec(text);
      if (early) check(t.where, text, Number(early[1]), lost, 'down');
      const opener = OPENER_PROGRESS.exec(text);
      if (opener) {
        check(t.where, text, Number(opener[1]), opener[3] === 'down' ? lost : change, opener[3]);
        const span = snap.card.target.weightKg != null ? Math.abs(cur.startWeightKg - snap.card.target.weightKg) : null;
        if (span != null) check(t.where, text, Number(opener[2]), span, 'of');
      }
      const coach = COACH_SINCE_START.exec(text);
      if (coach) {
        check(t.where, text, signed(coach[1]), change, 'since start');
        check(t.where, text, Number(coach[2]), cur.startWeightKg, 'start at');
      }
    }
    // progressPct is the same rounded change against the goal's span (a reached goal is 100 by rule).
    const target = snap.card.target.weightKg;
    if (cur.progressPct != null && target != null && snap.card.verdict !== 'reached' && cur.startWeightKg !== target) {
      const exact = Math.min(100, Math.max(0, (lost / (cur.startWeightKg - target)) * 100));
      compared++;
      if (Math.abs(cur.progressPct - exact) > 0.5 + 1e-6) out.push({ snap, detail: `progressPct ${cur.progressPct} but changeKg ${change} of a ${cur.startWeightKg} -> ${target} kg goal is ${Math.round(exact * 100) / 100}%` });
    }
  }
  assert.ok(compared > 0, `${name}: no since-start figure was compared, so this invariant checked nothing`);
  return out;
});

// A reached goal asks "set a new target or switch to maintenance" for a window that the week plan owns (REACHED_ASK_DAYS). The card, the
// coach lines and the opener all read it: on the same day either all three ask or none does (the opener used to stop after 3 days
// while the card asked for 7 - "Holding at 84.0 kg" over "Set a new target or switch to maintenance").
const NEXT_TARGET_ASK = /set a new target or switch to maintenance|next step is a new target or maintenance/i;

invariant(WEIGHT, 'a reached goal asks for a next step on the card if and only if the coach lines and the opener do', (snaps, name) => {
  const out: Violation[] = [];
  let askDays = 0;
  let reachedDays = 0;
  for (const snap of snaps) {
    if (snap.card?.verdict !== 'reached') continue;
    reachedDays++;
    const card = cardTexts(snap).some(t => t.where.startsWith('card.reasons') && NEXT_TARGET_ASK.test(plain(t.text)));
    const opener = NEXT_TARGET_ASK.test(plain(snap.opener?.required ?? ''));
    const coach = (snap.coach ?? []).some(t => NEXT_TARGET_ASK.test(plain(t)));
    if (card) askDays++;
    if (card !== opener || card !== coach) {
      out.push({ snap, detail: `card ${card ? 'asks' : 'does not ask'} ("${visible(snap.card.reasons.map(r => r.text).join(' | '))}"), coach ${coach ? 'asks' : 'does not ask'}, opener ${opener ? 'asks' : 'does not ask'}: "${visible(snap.opener?.required ?? '')}"` });
    }
  }
  if (name === 'weight_loss_logged') assert.ok(askDays > 0 && reachedDays > askDays, `${name}: the reached stretch never both asked and stopped asking, so this invariant checked nothing`);
  return out;
});

// A weight-loss goal has ONE weight: the weekly average (the chart's smoothed line is a drawing, never a number the card or the review
// quotes). When a week lacks the weigh-ins for a weekly mean the review still compares the smoothed line, but says "weight change",
// never "weight trend" / "trend weight" / "Trend change" (day 91 said "Your weight trend is down 0.7 kg" where every other week
// said "Your weekly average weight is down ..."). The coach lines are left out: they explain to the model that the smoothed trend
// is not the weight to quote.
const WEIGHT_AS_TREND = /weight trend|trend weight|trend change|smoothed trend/i;

invariant(WEIGHT, 'no card or review string calls the progress weight a "trend" (weight trend, trend weight, trend change)', snaps =>
  textMatches(snaps, s => [...cardTexts(s), ...reviewTexts(s)], WEIGHT_AS_TREND));

// ── weight loss, wave 22w (round-4 dietitian + "Sam" findings) ──────────────────────────────────────────────────────────────────────
// Everything between this banner and the "one target per week" banner below is weight-loss only (wave 22w).

const WL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WL_MEAN_MIN_WEIGH_INS = 3;
const WL_FLAT_KG = 0.2;
const WL_FAR_BEHIND_DAYS = 56;

/** Mean of the scenario's raw weigh-ins in the 7 days ending `end`; null under 3 weigh-ins. */
function wlWeekMean(weighIns: ReadonlyArray<{ day: string; kg: number }>, end: string): number | null {
  const from = addDays(end, -6);
  const inWeek = weighIns.filter(w => w.day >= from && w.day <= end);
  return inWeek.length >= WL_MEAN_MIN_WEIGH_INS ? inWeek.reduce((s, w) => s + w.kg, 0) / inWeek.length : null;
}

/** The flat fortnight (P1-1): the last two 7-day means up to the plan's Sunday are within 0.2 kg, after a confirmed loss pace 14+ days earlier. */
function wlFlatFortnightDays(snaps: DaySnapshot[], name: ScenarioName): DaySnapshot[] {
  const weighIns = buildScenario(name).weighIns;
  return snaps.filter(snap => {
    const plan = snap.card?.weightRead?.plan;
    if (plan == null) return false;
    const w2 = wlWeekMean(weighIns, plan.asOf);
    const w1 = wlWeekMean(weighIns, addDays(plan.asOf, -7));
    if (w1 == null || w2 == null || Math.abs(w2 - w1) > WL_FLAT_KG) return false;
    // A confirmed loss pace in a plan made 14+ days before this plan's Sunday.
    return snaps.some(s => {
      const earlier = s.card?.weightRead?.plan;
      return earlier != null && earlier.asOf <= addDays(plan.asOf, -14) && earlier.state === 'pace' && earlier.confirmed
        && earlier.pace != null && earlier.pace.kgPerWeek < 0;
    });
  });
}

const WONT_HOLD_OR_BEHIND = /won't hold|behind pace|move the date/i;

invariant(WEIGHT, 'a flat fortnight after a confirmed loss pace is a calm hold: never "behind", "won\'t hold" or "move the date" (P1-1)', (snaps, name) => {
  const out: Violation[] = [];
  const days = wlFlatFortnightDays(snaps, name);
  assert.ok(days.length > 0, `${name}: no flat fortnight after a confirmed loss appeared, so this invariant checked nothing`);
  for (const snap of days) {
    const verdict = snap.card?.verdict;
    if (verdict === 'behind' || verdict === 'stalled') {
      out.push({ snap, detail: `flat fortnight after a confirmed loss reads verdict ${verdict}: "${visible(snap.card?.headline ?? '')}"` });
    }
    const plan = snap.card?.weightRead?.plan;
    if (plan?.farBehind || plan?.call === 'behind') out.push({ snap, detail: `flat fortnight plan call ${plan.call}, farBehind ${plan.farBehind}` });
    for (const t of allTexts(snap)) {
      if (WONT_HOLD_OR_BEHIND.test(plain(t.text)) && !/do not quote a projected date/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
  }
  return out;
});

/** A month quoted without a day ("Jan 2027", "~Aug"): the first day of that month. Dates with a day ("Jul 6") are not month quotes. */
const MONTH_QUOTE = new RegExp(`\\b(${WL_MONTHS.join('|')})\\b(?! \\d{1,2}\\b)(?: (\\d{4}))?`, 'g');

invariant(WEIGHT, 'no user-facing string quotes a projected month more than 8 weeks past the target date (P1-1)', (snaps, name) => {
  const scn = buildScenario(name);
  const target = scn.user.targetDate as string;
  const year = Number(target.slice(0, 4));
  const out: Violation[] = [];
  for (const snap of snaps) {
    for (const t of allTexts(snap)) {
      for (const m of plain(t.text).matchAll(MONTH_QUOTE)) {
        const monthStart = `${m[2] ?? year}-${String(WL_MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-01`;
        if (dayDiff(monthStart, target) > WL_FAR_BEHIND_DAYS) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" quotes ${m[0]}, ${dayDiff(monthStart, target)} days past the ${target} target date` });
      }
    }
  }
  return out;
});

/** The kcal level a plan action states: its `kcalTarget`, else the first "(to ~1,800 kcal)" / "keep 2,000 kcal" / "your 2,000 kcal target" in its text. */
function wlStatedKcal(action: { text: string; kcalTarget?: number }): number | null {
  if (action.kcalTarget != null) return action.kcalTarget;
  const m = /(?:\(to ~|keep |your |toward |full )([\d,]{4,})\s*kcal/i.exec(plain(action.text));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const WL_KCAL_REVERSAL_SENTENCE = /go back to [\d,]+ kcal|last week's trim/i;

invariant(WEIGHT, 'a stated calorie target never moves back up on the next Monday without a sentence saying so (P1-2)', snaps => {
  const out: Violation[] = [];
  let prev: { snap: DaySnapshot; kcal: number } | null = null;
  for (const snap of snaps) {
    if (snap.weekday !== 'Mon') continue;
    const plan = snap.card?.weightRead?.plan;
    const kcal = plan != null && plan.state !== 'reached' && plan.state !== 'maintenance' ? wlStatedKcal(plan.action) : null;
    if (prev != null && kcal != null && kcal > prev.kcal && plan != null && !WL_KCAL_REVERSAL_SENTENCE.test(plain(plan.action.text))) {
      out.push({ snap, detail: `Mon ${prev.snap.date} stated ${prev.kcal} kcal, Mon ${snap.date} states ${kcal} kcal without saying so: "${visible(plan.action.text)}"` });
    }
    prev = kcal != null ? { snap, kcal } : null;
  }
  return out;
});

// A user who logs no food gets no calorie trim they cannot check: the first step is activity or logging (P1-2).
invariant(['weight_loss'], 'a user with no food logs is never told to trim calories (P1-2)', snaps =>
  textMatches(snaps, allTexts, /trim ~[\d,]+ kcal/i));

// P2-1: a plan is never remade from stale data. On a day with nothing new (no weigh-in, food log or workout) the verdict cannot change,
// unless a calendar week began AND the newest weigh-in is under 7 days old. (The 14-day "last weigh-in N days ago" nudge, verdict
// insufficient_data, is the one honest exception: it is the data going stale, not a re-made plan.)
invariant(WEIGHT, 'the verdict never changes on a day with no new data, unless a calendar week began and the newest weigh-in is under 7 days old (P2-1)', snaps_ => {
  const out: Violation[] = [];
  const scn = buildScenario(snaps_[0].scenario as ScenarioName);
  const logged = new Set<string>([
    ...scn.weighIns.map(w => w.day), ...scn.intake.map(i => i.day), ...scn.workouts.map(w => w.day), ...scn.sets.map(x => x.day),
  ]);
  for (let i = 1; i < snaps_.length; i++) {
    const prev = snaps_[i - 1];
    const cur = snaps_[i];
    if (logged.has(cur.date) || prev.card == null || cur.card == null) continue;
    const before = prev.card.verdict;
    const after = cur.card.verdict;
    if (before === after || before === 'insufficient_data' || after === 'insufficient_data') continue;
    const fresh = cur.card.lastWeighInDaysAgo != null && cur.card.lastWeighInDaysAgo < 7;
    if (cur.weekday === 'Mon' && fresh) continue;
    out.push({
      snap: cur,
      detail: `verdict ${before} -> ${after} with nothing new logged (${cur.weekday}, newest weigh-in ${cur.card.lastWeighInDaysAgo} days old): "${visible(prev.card.headline)}" -> "${visible(cur.card.headline)}"`,
    });
  }
  return out;
});

// P2-7: on a Monday, every "Holding at X" - the card, the coach lines, the opener, the review's headline / win and the push - is one
// number. (Mondays on which the user already weighed in are left out: the card's weekly average then includes that reading and the review,
// which is for last week, cannot.)
const HOLDING_AT = /Holding at ([\d.]+)/g;

invariant(WEIGHT, 'on a Monday every "Holding at X" across card, opener, review and push is one X (P2-7)', (snaps, name) => {
  const weighInDays = new Set(buildScenario(name).weighIns.map(w => w.day));
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    if (snap.review == null || snap.card == null || weighInDays.has(snap.date)) continue;
    const texts: Text[] = [...allTexts(snap), { where: 'push.title', text: snap.review.alert.title }, { where: 'push.body', text: snap.review.alert.body }];
    const said = new Map<string, string>();
    for (const t of texts) for (const m of plain(t.text).matchAll(HOLDING_AT)) said.set(m[1], said.has(m[1]) ? `${said.get(m[1])}, ${t.where}` : t.where);
    if (said.size > 0) compared++;
    if (said.size > 1) out.push({ snap, detail: `"Holding at" says ${[...said].map(([x, where]) => `${x} (${where})`).join(' vs ')}` });
  }
  if (name === 'weight_loss_logged') assert.ok(compared > 0, `${name}: no Monday said "Holding at", so this invariant checked nothing`);
  return out;
});

// P2-6: easing toward maintenance is a number, not a direction. "Start easing calories toward maintenance" always carries the step
// ("add ~150-200 kcal a day (to ~2,150-2,200 kcal)"), and for the first 3 weeks after the target is reached the plan's action states a
// calorie figure (the step, the user's own held intake, or a budget that already is maintenance). The maintenance watch is two-sided.
const KCAL_FIGURE = /~[\d,]+(?:\s?[-–]\s?[\d,]+)?\s?kcal/;
const MAINTENANCE_STEP_WINDOW_DAYS = 21;

invariant(WEIGHT, 'easing toward maintenance and a reached goal\'s first 3 weeks state a calorie figure; the maintenance watch is two-sided (P2-6)', (snaps, name) => {
  const out: Violation[] = [];
  let easing = 0;
  let reachedChecked = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    if (plan == null) continue;
    for (const t of allTexts(snap)) {
      if (/easing calories toward maintenance/i.test(plain(t.text)) && /^(?:card\.reasons|review\.nextWeek|coach)/.test(t.where)) {
        easing++;
        if (!KCAL_FIGURE.test(plain(t.text)) && !/This week's plan|Nearly there|snack/.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" names no calorie figure` });
      }
    }
    // (A user who logs no food gets the step as a snack, never a calorie figure - wave 23w.)
    if (plan.action.kind === 'ease_to_maintenance' && !KCAL_FIGURE.test(plain(plan.action.text)) && !/snack/.test(plain(plan.action.text))) out.push({ snap, detail: `plan action [ease_to_maintenance] "${visible(plan.action.text)}" names no calorie figure` });
    const reachedDaysAgo = snap.card?.weightRead?.reachedDaysAgo;
    if (snap.card?.verdict === 'reached' && reachedDaysAgo != null && reachedDaysAgo <= MAINTENANCE_STEP_WINDOW_DAYS) {
      reachedChecked++;
      if (!KCAL_FIGURE.test(plain(plan.action.text)) && !/snack/.test(plain(plan.action.text))) out.push({ snap, detail: `reached ${reachedDaysAgo} days ago, plan action [${plan.action.kind}] "${visible(plan.action.text)}" names no calorie figure` });
    }
    if (plan.state === 'maintenance' && /drifts?\b/.test(plain(plan.action.text)) && !/above or below/.test(plain(plan.action.text))) {
      out.push({ snap, detail: `maintenance watch is one-sided: "${visible(plan.action.text)}"` });
    }
  }
  assert.ok(easing > 0 && reachedChecked > 0, `${name}: nothing easing toward maintenance or reached appeared, so this invariant checked nothing`);
  return out;
});

// P2-2: a plateau message does not hold while the scale falls. "Moving again" is an event that can enter inside the week: once the week's
// average (3+ weigh-ins) is a full tolerance (0.2 kg) under the plateau's, the plateau is over. (A smaller gap is inside the tolerance that
// defines "flat", so it is still a flat week.)
invariant(WEIGHT, "a plateau is not announced once this week's average is a tolerance under the plateau's (P2-2)", (snaps, name) => {
  const out: Violation[] = [];
  let underTolerance = 0;
  for (const snap of snaps) {
    const read = snap.card?.weightRead;
    const plan = read?.plan;
    if (plan == null || plan.plateauMeanKg == null || read?.weekMeanKg == null || (read.state !== 'plateau' && read.state !== 'moving_again')) continue;
    const gap = Math.round((plan.plateauMeanKg - read.weekMeanKg) * 10) / 10;
    if (gap < 0.2 - 1e-9) continue;
    underTolerance++;
    if (read.state === 'plateau') {
      out.push({ snap, detail: `plan state plateau (mean ${plan.plateauMeanKg}) while the weekly average is ${read.weekMeanKg}, ${gap} kg lower: "${visible(snap.card?.headline ?? '')}" / "${visible(snap.opener?.required ?? '')}"` });
    }
  }
  assert.ok(underTolerance > 0, `${name}: the weekly average never fell a tolerance under a plateau, so this invariant checked nothing`);
  return out;
});

// P2-3: "the same all week" is true or not said. A plan that changed inside its calendar week says so in the coach lines
// ("set Jun 8, updated Tue Jun 9: ..."), never "the same all week"; "nearly there" is decided on the Monday from closeness (within a kilo of the
// target while losing 0.75% a week or more), not on the day the loss tips over 1%; and the reached question runs to the end of a calendar week,
// so the card, the coach lines and the opener never drop it on a Saturday.
const PLAN_LINE = /This week's plan \(set ([^,)]+)(?:, ([^)]*))?\)/;

invariant(WEIGHT, "a coach line says the week's plan is \"the same all week\" only when it is, and labels a mid-week update (P2-3)", (snaps, name) => {
  const out: Violation[] = [];
  const firstOfWeek = new Map<string, string>();
  let updatedDays = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    if (plan == null) continue;
    const week = mondayOfDate(snap.date);
    if (!firstOfWeek.has(week)) firstOfWeek.set(week, plan.action.text);
    const line = (snap.coach ?? []).map(plain).find(t => PLAN_LINE.test(t));
    if (line == null) continue;
    const label = PLAN_LINE.exec(line)?.[2] ?? '';
    const changed = plan.action.text !== firstOfWeek.get(week);
    if (changed) updatedDays++;
    if (changed && (/the same all week/.test(label) || !/updated/.test(label))) {
      out.push({ snap, detail: `the plan changed inside the week ("${visible(firstOfWeek.get(week) ?? '')}" -> "${visible(plan.action.text)}") but the coach line says: "${visible(line.slice(0, 120))}"` });
    }
    if (!changed && /updated/.test(label)) out.push({ snap, detail: `the coach line says the plan was updated but its action is the week's first: "${visible(line.slice(0, 120))}"` });
  }
  assert.ok(updatedDays > 0 || name !== 'weight_loss', `${name}: no plan changed inside a week, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, '"nearly there" is decided on the Monday: within a kilo of the target and losing 0.75%+ a week is the easing step from day one (P2-3)', (snaps, name) => {
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    const read = snap.card?.weightRead;
    if (snap.weekday !== 'Mon' || plan == null || read?.state !== 'pace' || snap.card?.verdict === 'reached') continue;
    const target = snap.card?.target.weightKg;
    const pct = plan.pace?.pctPerWeek;
    if (target == null || read.weekMeanKg == null || pct == null || pct > -0.75) continue;
    if (read.weekMeanKg - target > 1 || read.weekMeanKg - target < 0) continue;
    checked++;
    if (plan.action.kind !== 'ease_to_maintenance') {
      out.push({ snap, detail: `${(read.weekMeanKg - target).toFixed(1)} kg to go at ${pct}%/wk but the Monday plan is [${plan.action.kind}] "${visible(plan.action.text)}"` });
    }
  }
  assert.ok(checked > 0, `${name}: no Monday was within a kilo of the target while losing 0.75%+ a week, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'the reached question never ends in the middle of a calendar week (P2-3)', snaps => {
  const out: Violation[] = [];
  const asks = new Map<string, boolean>();
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    if (snap.card?.verdict !== 'reached' || plan == null) continue;
    const week = mondayOfDate(snap.date);
    const asking = plan.action.kind === 'next_target';
    const before = asks.get(week);
    if (before === true && !asking) out.push({ snap, detail: `the "set a new target or switch to maintenance" question was asked earlier this week and is gone on ${snap.weekday}: "${visible(plan.action.text)}"` });
    if (before === undefined) asks.set(week, asking);
  }
  return out;
});

// P2-4: when the plan's call is ahead / too fast / nearly there, or there is a kilo or less to go, the review's "Next week" never pushes
// restriction (a weekend tip, "decide the meal ahead"): it is the plan's own instruction, else "Keep your routine - no need to tighten anything".
const NO_NEED_TO_TIGHTEN = 'Keep your routine — no need to tighten anything';

invariant(WEIGHT, "the review's next week does not tighten anything while the plan says ahead, too fast, nearly there or a kilo to go (P2-4)", (snaps, name) => {
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    const read = snap.card?.weightRead;
    if (snap.review == null || plan == null || snap.card?.verdict === 'reached' || plan.state === 'reached' || plan.state === 'maintenance') continue;
    const target = snap.card?.target.weightKg;
    const toGo = target != null && read?.weekMeanKg != null ? read.weekMeanKg - target : null;
    const easy = plan.call === 'ahead' || plan.call === 'too_fast' || plan.nearlyThere || (toGo != null && toGo >= 0 && toGo <= 1);
    if (!easy) continue;
    checked++;
    const next = snap.review.review.nextWeek;
    if (next !== plan.action.text && plain(next) !== NO_NEED_TO_TIGHTEN) {
      out.push({ snap, detail: `plan call ${plan.call}${plan.nearlyThere ? ' (nearly there)' : ''}, ${toGo?.toFixed(1)} kg to go, action [${plan.action.kind}] but the review's next week is "${visible(next)}"` });
    }
  }
  assert.ok(checked > 0, `${name}: no Monday review had an easy plan, so this invariant checked nothing`);
  return out;
});

// P2-5: the rate must not contradict the call. "On track for Jul 6" over "Down 0.37 kg/wk" (6.5 kg to go at 0.37 kg/wk lands weeks after Jul 6) is a
// card arguing with itself: when an on-pace call rests on two paces that straddle the date, the card shows the range ("0.37-0.58 kg/wk"), and the
// coach never calls the target date an "ETA" (it is the date to hold, not a projection).
const RATE_RANGE = /\d+(?:\.\d+)?\s?[-–]\s?\d+(?:\.\d+)?\s?(?:kg|lb)\/wk/;

invariant(WEIGHT, "an on-pace call whose single rate would land more than a week off the date shows the rate as a range (P2-5)", (snaps, name) => {
  const weighIns = buildScenario(name).weighIns;
  const out: Violation[] = [];
  let straddling = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    const card = snap.card;
    if (card?.verdict !== 'on_track' || plan?.call !== 'on_pace' || plan.pace == null || card.target.date == null || card.target.weightKg == null) continue;
    // The plan's own projection: from the 7-day mean at the last weigh-in through its Sunday (the pace is anchored to that day).
    const anchor = [...weighIns].filter(w => w.day <= plan.asOf).sort((a, b) => (a.day < b.day ? 1 : -1))[0];
    const kg = wlWeekMean(weighIns, anchor.day) ?? anchor.kg;
    if (plan.pace.kgPerWeek >= 0) continue;
    const finish = addDays(anchor.day, Math.ceil(((kg - card.target.weightKg) / -plan.pace.kgPerWeek) * 7));
    if (Math.abs(dayDiff(finish, card.target.date)) <= 7) continue;
    straddling++;
    const rate = card.reasons.find(r => r.kind === 'rate');
    if (rate == null || !RATE_RANGE.test(plain(rate.text))) {
      out.push({ snap, detail: `"${visible(card.headline)}" over a single rate that lands on ${finish}, ${dayDiff(finish, card.target.date)} days from ${card.target.date}: "${visible(rate?.text ?? '(no rate reason)')}"` });
    }
  }
  assert.ok(straddling > 0, `${name}: no on-pace card had a rate off the date, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'the coach lines never call the target date an "ETA" (P2-5)', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const date = snap.card?.target.date;
    if (date == null) continue;
    for (const [i, line] of (snap.coach ?? []).entries()) {
      if (new RegExp(`ETA ${date}`).test(line)) out.push({ snap, detail: `coach[${i}]: "${visible(line.slice(0, 260))}"` });
    }
  }
  return out;
});

// P2-8: one formatted rate. The headline's "losing about 0.58 kg a week" and the opener's "losing about 0.6 kg a week" are the same rate rounded
// twice, to different places; every surface quotes the one the card printed.
const LOSING_ABOUT = /losing about ([\d.]+) (?:kg|lb) a week/;

invariant(WEIGHT, 'the opener quotes the rate the headline printed, not the same rate rounded again (P2-8)', (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    const head = LOSING_ABOUT.exec(plain(snap.card?.headline ?? ''));
    const open = LOSING_ABOUT.exec(plain(snap.opener?.required ?? ''));
    if (head == null || open == null) continue;
    compared++;
    if (head[1] !== open[1]) out.push({ snap, detail: `headline "${visible(snap.card?.headline ?? '')}" vs opener "${visible(snap.opener?.required ?? '')}"` });
  }
  assert.ok(compared > 0, `${name}: no day quoted a rate in both headline and opener, so this invariant checked nothing`);
  return out;
});

// ── wave 22w, P3: wording ──────────────────────────────────────────────────────────────────────────────────────────────────────────

invariant(WEIGHT, 'the early read says where the weekly average is against the start, not "X of Y kg down on your weekly average" (P3)', (snaps, name) => {
  const out = textMatches(snaps, s => [...coachTexts(s), ...cardTexts(s)], /of [\d.]+ kg down on your weekly average/);
  assert.ok(snaps.some(s => /weekly average is [\d.]+ kg below your start/.test(plain(s.opener?.required ?? ''))), `${name}: the early read never used the new wording, so this invariant checked nothing`);
  return out;
});

invariant(['weight_loss_logged'], 'the calorie adherence line counts "in the last 7 days" (it is a rolling week) and its tone does not flip day to day (P3)', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    for (const r of snap.card?.reasons ?? []) {
      if (r.kind !== 'calorie_adherence') continue;
      seen++;
      if (/this week/.test(r.text) || !/in the last 7 days/.test(plain(r.text)) || r.tone !== 'neutral') out.push({ snap, detail: `[${r.tone}] "${visible(r.text)}"` });
    }
  }
  assert.ok(seen > 0, `${name}: no adherence line appeared, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'a reached card does not print "weekly average 84.2 kg" as the reach; it says how close the average is to the target (P3)', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const target = snap.card?.target.weightKg;
    const lead = snap.card?.verdict === 'reached' ? snap.card.reasons.find(r => r.kind === 'reached') : undefined;
    const avg = snap.card?.weightRead?.weekMeanKg;
    if (lead == null || target == null || avg == null || Math.abs(avg - target) < 0.05) continue;
    seen++;
    if (!/weekly average within [\d.]+ kg of your target/.test(plain(lead.text))) out.push({ snap, detail: `weekly average ${avg} vs target ${target}: "${visible(lead.text)}"` });
  }
  assert.ok(seen > 0, `${name}: no reached card had an average off the target, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, '"Holding at 84.0 kg, within 1 kg of 84 kg" is never said when the average is exactly on the target (P3)', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const all: Text[] = [...allTexts(snap), ...(snap.review ? [{ where: 'push.body', text: snap.review.alert.body }] : [])];
    for (const t of all) {
      const m = /Holding at ([\d.]+) kg, within 1 kg of ([\d.]+) kg/.exec(plain(t.text));
      if (m && Math.abs(Number(m[1]) - Number(m[2])) < 0.05) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
  }
  return out;
});

invariant(WEIGHT, 'the opener that asks about a new target names the reach (P3; it congratulates on the reach day and the Monday after - wave 23w)', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const line = snap.opener?.required ?? '';
    if (!/set a new target or switch to maintenance/i.test(line) || snap.card?.verdict !== 'reached') continue;
    seen++;
    if (!/Congratulations|You've reached/.test(line)) out.push({ snap, detail: `"${visible(line)}"` });
  }
  assert.ok(seen > 0, `${name}: the reached opener never asked, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'a rate "over the last 3 weeks" is never quoted when the newest weigh-in is a week old or more (P3)', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const age = snap.card?.lastWeighInDaysAgo;
    if (age == null || age < 7) continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      if (/over the last \d+ weeks/.test(plain(t.text))) out.push({ snap, detail: `newest weigh-in ${age} days old, ${t.where}: "${visible(t.text.slice(0, 200))}"` });
    }
  }
  return out;
});

invariant(WEIGHT, 'a weight-loss review never labels its weight change "smoothed" (the card does not quote the smoothed trend) (P3)', (snaps, name) => {
  const out = textMatches(snaps, reviewTexts, /smoothed/i);
  assert.ok(snaps.filter(s => s.review != null).length > 0, `${name}: no review, so this invariant checked nothing`);
  return out;
});

// P2-6 (follow-up): inside the reached / maintenance weeks a calorie figure that changes by 100+ kcal from one Monday to the next says so
// ("it replaces last week's ~2,150 kcal step"): "add to ~2,150-2,200" and then "make ~2,050 your maintenance target" in silence is whiplash.
invariant(WEIGHT, "a calorie figure that moves 100+ kcal between two reached / maintenance Mondays says it replaces last week's (P2-6)", snaps => {
  const out: Violation[] = [];
  let prev: { snap: DaySnapshot; kcal: number } | null = null;
  for (const snap of snaps) {
    if (snap.weekday !== 'Mon') continue;
    const plan = snap.card?.weightRead?.plan;
    const kcal = plan != null && (plan.state === 'reached' || plan.state === 'maintenance') ? plan.action.kcalTarget ?? null : null;
    if (prev != null && kcal != null && plan != null && Math.abs(kcal - prev.kcal) >= 100 && !/replaces|instead of|last week/i.test(plain(plan.action.text))) {
      out.push({ snap, detail: `Mon ${prev.snap.date} ${prev.kcal} kcal -> Mon ${snap.date} ${kcal} kcal without saying so: "${visible(plan.action.text)}"` });
    }
    prev = kcal != null ? { snap, kcal } : null;
  }
  return out;
});

// P2-1: coming back after a gap carries the colour from before it: a welcome back never downgrades on_track / ahead to progressing.
// Compared on each return day with the verdict of the last day before the gap.
invariant(WEIGHT, 'a welcome back keeps the verdict the card had before the gap (P2-1)', snaps_ => {
  const out: Violation[] = [];
  let checked = 0;
  for (let i = 1; i < snaps_.length; i++) {
    const read = snaps_[i].card?.weightRead;
    if (read?.state !== 'returning' || read.returned == null) continue;
    const before = snaps_.find(s => s.date === read.returned?.sinceDay);
    if (before?.card == null) continue;
    checked++;
    const was = before.card.verdict;
    const now = snaps_[i].card?.verdict;
    if (['on_track', 'ahead', 'progressing'].includes(was) && now !== was) {
      out.push({ snap: snaps_[i], detail: `before the gap (${before.date}) the card was ${was} ("${visible(before.card.headline)}"), the welcome back is ${now} ("${visible(snaps_[i].card?.headline ?? '')}")` });
    }
  }
  assert.ok(checked > 0, 'no welcome back with a known pre-gap day appeared, so this invariant checked nothing');
  return out;
});

// ── one target per week (wave 21b) ──────────────────────────────────────────

// "40 of ~20 km", "5 km of ~20 km", "20 of up to ~18 km": a figure of the week against ITS target. The tilde number is the week's one
// target (`distance.stepTargetKm`, display unit) on every surface of the day - the headline, the distance line, the reasons, the coach
// lines and the opener. (Day 41 of runner_messy, a cutback week, said "of ~25 km" in the headline and "of ~20 km" on the distance line.)
const OF_WEEK_TARGET = /(\d+(?:\.\d+)?)(?:\s?(?:km|mi))?\s+of\s+(?:up to\s+)?~(\d+(?:\.\d+)?)\s?(km|mi)\b(?! last week)/g;

const inDisplayUnit = (km: number, unit: string): number => Math.round((unit === 'mi' ? km / KM_PER_MILE : km) * 10) / 10;

invariant(RUNNERS, 'every "N of ~M km|mi" figure of the week on the card, coach lines and opener has M = distance.stepTargetKm', (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    const distance = snap.card?.distance;
    if (!distance || distance.thisWeekKm == null) continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      for (const m of plain(t.text).matchAll(OF_WEEK_TARGET)) {
        compared++;
        const said = Number(m[2]);
        const target = inDisplayUnit(distance.stepTargetKm, m[3]);
        if (Math.abs(said - target) > 0.05 + 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" says ~${said} ${m[3]}, distance.stepTargetKm is ${distance.stepTargetKm} km (${target} ${m[3]})` });
      }
    }
  }
  assert.ok(compared > 0, `${name}: no "N of ~M" figure appeared, so this invariant checked nothing`);
  return out;
});

const OVER_THE_STEP = /(\d+(?:\.\d+)?)\s?(km|mi) is (\d+(?:\.\d+)?)\s?(?:km|mi) over this week's safe step/;

invariant(RUNNERS, 'the "N km is X km over this week\'s safe step" reason measures the week against distance.stepTargetKm', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const distance = snap.card?.distance;
    if (!distance) continue;
    for (const t of cardTexts(snap)) {
      const m = OVER_THE_STEP.exec(plain(t.text));
      if (!m) continue;
      const done = Number(m[1]);
      const over = Number(m[3]);
      const target = inDisplayUnit(distance.stepTargetKm, m[2]);
      if (Math.abs(done - over - target) > 0.15 + 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" implies a step of ${Math.round((done - over) * 10) / 10} ${m[2]}, distance.stepTargetKm is ${distance.stepTargetKm} km (${target} ${m[2]})` });
    }
  }
  return out;
});

// The review grades the finished week against the target the card showed that week (its last day's card, the plan's target stands all
// week): "40 of ~20 km" in the review is the "~20 km" on Sunday's distance line, whether that week was a cutback, a hold or a build.
invariant(RUNNERS, "the review's graded target for the past week equals the target that week's last card showed", (snaps, name) => {
  const out: Violation[] = [];
  const byDate = new Map(snaps.map(s => [s.date, s]));
  let compared = 0;
  for (const snap of snaps) {
    const rv = snap.review;
    if (!rv) continue;
    const sunday = byDate.get(addDays(rv.weekStart, 6));
    const shown = sunday?.card?.distance?.stepTargetKm;
    if (shown == null) continue;
    const gap = rv.review.weekGap;
    const stated: Array<{ where: string; km: number }> = [];
    if (gap != null && (gap.kind === 'spike' || (gap.kind === 'distance' && gap.stepKm != null))) stated.push({ where: `weekGap.${gap.kind}.stepKm`, km: gap.stepKm as number });
    for (const t of reviewTexts(snap).filter(x => x.where === 'review.headline')) {
      for (const m of plain(t.text).matchAll(OF_WEEK_TARGET)) stated.push({ where: `${t.where} "${visible(t.text)}"`, km: Number(m[2]) * (m[3] === 'mi' ? KM_PER_MILE : 1) });
    }
    for (const s of stated) {
      compared++;
      // The headline prints the target in the display unit (1 decimal): compare there.
      const unit = sunday?.card?.distance && /\bmi\b/.test(plain(sunday.card.distance.text)) ? 'mi' : 'km';
      if (Math.abs(inDisplayUnit(s.km, unit) - inDisplayUnit(shown, unit)) > 0.05 + 1e-9) {
        out.push({ snap, detail: `review ${s.where} grades the week against ${inDisplayUnit(s.km, unit)} ${unit}, the last card of that week (${sunday?.date}) showed ~${inDisplayUnit(shown, unit)} ${unit}: "${visible(sunday?.card?.distance?.text ?? '')}"` });
      }
    }
  }
  // ... and the hold week's card quotes last week's step the same way: "Last week's 40 km was over the safe step of ~20 km".
  const LAST_WEEK_STEP = /Last week's [\d.]+\s?(?:km|mi) was over the safe step of ~(\d+(?:\.\d+)?)\s?(km|mi)\b|[\d.]+\s+of up to ~(\d+(?:\.\d+)?)\s?(km|mi) last week\b/;
  for (const snap of snaps) {
    const weekStart = snap.card?.distance?.weekStart;
    if (weekStart == null) continue;
    const lastSunday = byDate.get(addDays(weekStart, -1));
    const shown = lastSunday?.card?.distance?.stepTargetKm;
    if (shown == null) continue;
    for (const t of cardTexts(snap)) {
      const m = LAST_WEEK_STEP.exec(plain(t.text));
      if (!m) continue;
      compared++;
      const said = Number(m[1] ?? m[3]);
      const unit = m[2] ?? m[4];
      if (Math.abs(said - inDisplayUnit(shown, unit)) > 0.05 + 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" but last week's last card (${lastSunday?.date}) showed ~${inDisplayUnit(shown, unit)} ${unit}` });
    }
  }
  assert.ok(compared > 0, `${name}: no review stated a graded target, so this invariant checked nothing`);
  return out;
});

// "Over the safe step — 40 of ~20 km. Hold ~28 km next week": the number is the one the coming Monday's card (and, through the
// weekly-review invariant above, its review) actually uses.
const HOLD_NEXT_WEEK = /Hold ~(\d+(?:\.\d+)?)\s?(km|mi) next week/;

invariant(['runner_messy'], 'a "Hold ~N next week" headline is the target of the coming Monday\'s card', (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    const m = HOLD_NEXT_WEEK.exec(plain(snap.card?.headline ?? ''));
    if (!m) continue;
    const nextMonday = addDays(mondayOfDate(snap.date), 7);
    const monday = snaps.find(s => s.date === nextMonday);
    const target = monday?.card?.distance?.stepTargetKm;
    if (target == null) continue;
    compared++;
    if (Math.abs(inDisplayUnit(target, m[2]) - Number(m[1])) > 0.05 + 1e-9) {
      out.push({ snap, detail: `"${visible(snap.card?.headline ?? '')}" but the card on Monday ${nextMonday} targets ${inDisplayUnit(target, m[2])} ${m[2]}: "${visible(monday?.card?.headline ?? '')}"` });
    }
  }
  assert.ok(compared > 0, `${name}: no "Hold ~N next week" headline met a following Monday, so this invariant checked nothing`);
  return out;
});

// A careful comeback week's "up to ~18 km" is a ceiling. Running more than the shared 10% ceiling slack over it is never "on plan" /
// "on track", never a green Volume stat or a "Back on the way up" win, on the Monday card or in the review. Wave 22e replaced the wave-21 rule
// "the week after holds at what was run" (it climbed 18 -> 20 -> 24 -> 28 for 21 days of "a little over the cap"): a touch over is said ONCE
// ("a touch over, fine") and the ceiling climbs from the CEILING; far over is a spike and the next week stays AT the ceiling (see below).
const COMEBACK_CAP_SLACK = 1.1;

invariant(RUNNERS, 'a comeback week more than 10% over its "up to" cap is never "on plan" / praised, on the card and in the review, and names the overshoot', (snaps, name) => {
  const out: Violation[] = [];
  const byDate = new Map(snaps.map(s => [s.date, s]));
  let overWeeks = 0;
  for (const sunday of snaps) {
    if (weekdayOf(sunday.date) !== 'Sun') continue;
    const d = sunday.card?.distance;
    if (!d?.plan?.upTo || d.thisWeekKm == null || !(d.thisWeekKm > d.stepTargetKm * COMEBACK_CAP_SLACK + 1e-9)) continue;
    overWeeks++;
    const week = mondayOfDate(sunday.date);
    const nextMonday = addDays(week, 7);
    // The review of that week.
    const reviewSnap = byDate.get(nextMonday);
    const rv = reviewSnap?.review;
    if (reviewSnap && rv && rv.weekStart === week) {
      for (const t of reviewTexts(reviewSnap)) {
        if (ON_TRACK_WORDS.test(plain(t.text)) || /on the way up/i.test(t.text)) out.push({ snap: reviewSnap, detail: `${t.where}: "${visible(t.text)}" for ${d.thisWeekKm} of up to ~${d.stepTargetKm} km` });
      }
      if (!/a touch over|well over the ceiling/i.test(plain(rv.review.headline))) out.push({ snap: reviewSnap, detail: `review.headline "${visible(rv.review.headline)}" does not say the week went over its ceiling (${d.thisWeekKm} of up to ~${d.stepTargetKm} km)` });
      const volume = rv.review.stats.find(st => st.label === 'Volume');
      if (volume?.tone === 'good') out.push({ snap: reviewSnap, detail: `review stat Volume "${visible(volume.value)}" is good-toned for ${d.thisWeekKm} of up to ~${d.stepTargetKm} km` });
    }
    // The card of the week after: about last week until the next one is run (its last day, Sunday, judges that week itself - wave 22e).
    for (let i = 0; i < 6; i++) {
      const next = byDate.get(addDays(nextMonday, i));
      const nd = next?.card?.distance;
      if (!next || !nd || (nd.plan?.kind !== 'build' && nd.plan?.kind !== 'hold')) continue;
      if (ON_TRACK_WORDS.test(plain(next.card?.headline ?? ''))) out.push({ snap: next, detail: `card.headline "${visible(next.card?.headline ?? '')}" after a week of ${d.thisWeekKm} of up to ~${d.stepTargetKm} km` });
      // (Wave 23e P3-a: "a touch over, fine" is said ONCE - on that Sunday and the Monday after; a spike's hold keeps its words all week.)
      else if ((i === 0 || nd.plan?.overCapRead === 'well') && !/a touch over|well over the ceiling/i.test(next.card?.headline ?? '')) out.push({ snap: next, detail: `card.headline "${visible(next.card?.headline ?? '')}" does not say last week went over its ceiling (${d.thisWeekKm} of up to ~${d.stepTargetKm} km)` });
    }
  }
  if (name === 'runner_messy') assert.ok(overWeeks > 0, `${name}: no comeback week went over its "up to" cap, so this invariant checked nothing`);
  return out;
});

// ── verdict churn (wave 21b) ────────────────────────────────────────────────

// Nothing new happened and the verdict still turned over on two days running: noise, not news. A lifter's verdict may change on the day
// a strength session is logged or on the Monday a calendar week begins; otherwise it moves at most once at a time (the lapse starting,
// the week no longer able to reach its target). lifter_short_week days 56-58 went progressing -> "sessions behind" (the 28-day count
// slid under 70% as an old session aged out) -> holding (4 days without a session) with nothing logged.
invariant(LIFTERS, 'the verdict does not change on two consecutive days unless a strength session was logged or a calendar week began', (snaps, name) => {
  const scn = buildScenario(name);
  const trained = new Set(scn.sets.filter(x => !x.isWarmup).map(x => x.day));
  const eventDay = (s: DaySnapshot): boolean => trained.has(s.date) || weekdayOf(s.date) === 'Mon';
  const out: Violation[] = [];
  const days = snaps.filter(s => s.card != null);
  let changes = 0;
  for (let i = 2; i < days.length; i++) {
    const [a, b, c] = [days[i - 2], days[i - 1], days[i]];
    // Only truly consecutive calendar days (the imperial scenario skips days).
    if (dayDiff(b.date, a.date) !== 1 || dayDiff(c.date, b.date) !== 1) continue;
    const changedB = b.card?.verdict !== a.card?.verdict;
    const changedC = c.card?.verdict !== b.card?.verdict;
    if (changedB) changes++;
    if (changedB && changedC && !eventDay(b) && !eventDay(c)) {
      out.push({ snap: c, detail: `${a.card?.verdict} (${a.date}) -> ${b.card?.verdict} (${b.date}) -> ${c.card?.verdict}, no session logged and no new week: "${visible(b.card?.headline ?? '')}" then "${visible(c.card?.headline ?? '')}"` });
    }
  }
  assert.ok(changes > 0, `${name}: the verdict never changed, so this invariant checked nothing`);
  return out;
});

// ── taper honesty (wave 21b) ────────────────────────────────────────────────

// A taper week's volume is meant to be cut, so a low week is safe - the light-week rule (don't make it up) is for build weeks and does
// not apply. But ", on plan" is a claim the week must still be able to make: at the weekend, what is run plus the taper's long run still
// to come must reach the shared taper band (60% of the target, windDownBand), else the card says "easy runs are enough". Earlier in
// the week the long run is ahead, so the claim stands - runner_on_plan day 102, "5.4 of ~22 km, on plan" on a Friday, is honest:
// 5.4 + the 11.5 km Sunday long run lands the week at 17 km.
invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_imperial', 'runner_on_plan_obedient', 'runner_messy'], 'a weekend taper card says "on plan" only when the week can land in the taper band (run so far + the long run still to come)', (snaps, name) => {
  const scn = buildScenario(name);
  const out: Violation[] = [];
  let weekendDays = 0;
  for (const snap of snaps) {
    const d = snap.card?.distance;
    if (d?.plan?.kind !== 'taper' || d.thisWeekKm == null) continue;
    const weekday = weekdayOf(snap.date);
    if (weekday !== 'Sat' && weekday !== 'Sun') continue;
    weekendDays++;
    const monday = mondayOfDate(snap.date);
    const longest = Math.max(0, ...scn.workouts.filter(w => w.type === 'Running' && w.distanceM && w.day >= monday && w.day <= snap.date).map(w => (w.distanceM as number) / 1000));
    const planned = d.plan.longRunKm ?? 0;
    const ahead = longest < planned * 0.6 ? planned : 0;
    if (d.thisWeekKm + ahead >= d.stepTargetKm * TAPER_GOOD_MIN_FRACTION) continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      if (/\bon plan\b/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" with ${d.thisWeekKm} km run and ${ahead} km of long run ahead, under the band's ${Math.round(d.stepTargetKm * TAPER_GOOD_MIN_FRACTION * 10) / 10} km` });
    }
  }
  assert.ok(weekendDays > 0, `${name}: no taper weekend was stepped, so this invariant checked nothing`);
  return out;
});

// ── strength round 4 (wave 22s) ─────────────────────────────────────────────

// A week 1-3 sessions short is not made up: the review's "Next week" says to go back to the target, with the loads, and never asks
// for the missed sessions again. lifter_short_week day 49 read "Book 4 sessions — lock in the missed ones now, starting with Monday."
// (Priya read it as "make up the 3 missed sessions"; the no-makeup rule had been written for 0-session weeks and comebacks only).
const MAKE_UP_PHRASES = /missed ones|the missed one\b|make up|catch up|lock in the missed/i;
// "don't make up the missed ones" is the instruction itself, not a request to make them up.
const NEGATED_MAKE_UP = /\b(?:don[’']t|do not|never) (?:make up|catch up on) the missed ones/gi;

invariant(LIFTERS, 'a muscle review never asks to make up, catch up or lock in the missed sessions', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const next = snap.review?.review.nextWeek;
    if (next == null) continue;
    const text = plain(next).replace(NEGATED_MAKE_UP, '');
    if (MAKE_UP_PHRASES.test(text)) out.push({ snap, detail: `review.nextWeek: "${visible(next)}"` });
  }
  return out;
});

// The same week, the other way round: a muscle week with 1..target-1 sessions says "Back to N this week" + "don't make up", ends with
// "starting today" (the review is read on its Monday, unless she has lifted that day) and cues the planned load of every main lift she did NOT train that week: the
// step the previous week's cue already gave ("Squat 112.5 kg"), taken from the scenario's own rows so a wrong load cannot excuse itself.
invariant(['lifter_short_week'], 'a short muscle week says "Back to N this week", not to make up the missed ones, and repeats the planned load of each lift skipped', (snaps, name) => {
  const scn = buildScenario(name);
  const target = scn.user.weeklySessions as number;
  const out: Violation[] = [];
  let checked = 0;
  const topLoad = (ex: string, from: string, to: string): number | null => {
    const loads = scn.sets.filter(s => s.exercise === ex && !s.isWarmup && s.day >= from && s.day <= to && s.loadKg != null).map(s => s.loadKg as number);
    return loads.length > 0 ? Math.max(...loads) : null;
  };
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r || r.weekGap?.kind !== 'sessions' || r.weekGap.done === 0 || r.weekGap.done >= target) continue;
    checked++;
    const text = plain(r.nextWeek);
    if (!new RegExp(`^Back to ${target} this week — don't make up the missed ones\\.`).test(text)) out.push({ snap, detail: `review.nextWeek does not open with the no-makeup line: "${visible(r.nextWeek)}"` });
    // (Wave 23s: not once she has already lifted on the review's own Monday - "starting today" is then stale.)
    const liftedMonday = scn.sets.some(x => !x.isWarmup && x.day === snap.date);
    if (liftedMonday ? /\btoday\b/.test(text) : !/, starting today\.$/.test(text)) out.push({ snap, detail: `review.nextWeek ${liftedMonday ? 'says "today" after a session on its Monday' : 'does not end "starting today."'}: "${visible(r.nextWeek)}"` });
    const weekStart = r.weekStart;
    const prevStart = addDays(weekStart, -7);
    for (const ex of ['squat', 'deadlift']) {
      if (topLoad(ex, weekStart, addDays(weekStart, 6)) != null) continue; // trained that week: the normal next-load rule
      const prev = topLoad(ex, prevStart, addDays(prevStart, 6));
      if (prev == null) continue;
      const planned = prev + 2.5;
      const named = new RegExp(`\\b${ex}\\b[^,.;]*?(\\d+(?:\\.\\d+)?)\\s?kg`, 'i').exec(text);
      if (!named || Number(named[1]) !== planned) out.push({ snap, detail: `${ex} was not trained and its planned step is ${planned} kg, but review.nextWeek says: "${visible(r.nextWeek)}"` });
    }
  }
  assert.ok(checked > 0, `${name}: no short muscle week was reviewed, so this invariant checked nothing`);
  return out;
});

// A week is short when the sessions it still needs cannot be done with a rest day in between: more missing sessions than days left
// (today counts only while no session is logged on it - a session today is already in the count), or three days back to back
// (a plan's own back-to-back days aside: 6 a week already has runs of 3). lifter_short_week: Thursday's bench was session 1 of 4
// with Fri-Sat-Sun left, and the card read "Progressing" on Thu-Fri, "Lifts up, week short" on Sat-Sun - a different answer each day.
const weekFitsTarget = (done: number, target: number, daysLeft: number, trainedToday: boolean): boolean => {
  const missing = target - done;
  if (missing <= 0) return true;
  const available = daysLeft - (trainedToday ? 1 : 0);
  if (missing > available) return false;
  if (target >= 7) return true;
  const longestRun = Math.ceil(missing / (available - missing + 1));
  return longestRun < Math.max(3, Math.ceil(target / (8 - target)) + 1);
};

invariant(LIFTERS, 'a week whose missing sessions no longer fit (too few days left, or three or more in a row) says "week short" on the card, not "Progressing"', (snaps, name) => {
  const scn = buildScenario(name);
  const target = scn.user.weeklySessions as number;
  const trained = new Set(scn.sets.filter(x => !x.isWarmup).map(x => x.day));
  const out: Violation[] = [];
  let flagged = 0;
  for (const snap of snaps) {
    if (snap.card?.goal !== 'muscle') continue;
    const monday = mondayOfDate(snap.date);
    const done = [...trained].filter(d => d >= monday && d <= snap.date).length;
    const daysLeft = 7 - dayDiff(snap.date, monday);
    if (weekFitsTarget(done, target, daysLeft, trained.has(snap.date))) continue;
    flagged++;
    const wk = snap.card.reasons.find(r => r.kind === 'week_sessions');
    if (snap.card.verdict === 'progressing' || wk?.tone !== 'watch') {
      out.push({ snap, detail: `${done} of ${target} sessions, ${daysLeft} day(s) left${trained.has(snap.date) ? ' (one trained today)' : ''}, the missing ones no longer fit, but verdict ${snap.card.verdict}, week line "${visible(wk?.text ?? '(none)')}" (${wk?.tone}): "${visible(snap.card.headline)}"` });
    }
  }
  if (name === 'lifter_short_week') assert.ok(flagged > 0, `${name}: no day had a week that no longer fits, so this invariant checked nothing`);
  return out;
});

// Fewer changes, each with a reason: in any 8 days the verdict turns over at most 3 times. lifter_short_week days 42-49 changed 4 times
// (progressing, holding "No sessions for 4 days", progressing, "Lifts up, week short", progressing) with one real event in the week.
const LIFTER_CHANGE_WINDOW_DAYS = 8;
const LIFTER_MAX_CHANGES = 3;

invariant(LIFTERS, `at most ${LIFTER_MAX_CHANGES} card verdict changes in any ${LIFTER_CHANGE_WINDOW_DAYS} consecutive days`, snaps => {
  const out: Violation[] = [];
  const days = snaps.filter(s => s.card != null);
  for (let i = 0; i + LIFTER_CHANGE_WINDOW_DAYS <= days.length; i++) {
    const window = days.slice(i, i + LIFTER_CHANGE_WINDOW_DAYS);
    if (dayDiff(window[window.length - 1].date, window[0].date) !== LIFTER_CHANGE_WINDOW_DAYS - 1) continue; // a skipped day
    const changes: string[] = [];
    for (let j = 1; j < window.length; j++) {
      const prev = window[j - 1].card?.verdict;
      const cur = window[j].card?.verdict;
      if (prev !== cur) changes.push(`day ${window[j].idx} ${prev} -> ${cur}`);
    }
    if (changes.length > LIFTER_MAX_CHANGES) {
      out.push({ snap: window[0], detail: `${changes.length} verdict changes in days ${window[0].idx}-${window[window.length - 1].idx}: ${changes.join('; ')}` });
    }
  }
  return out;
});

// On the Monday the review is read, "this week" is the week that just began (the card says "1 of 4 sessions this week", the opener
// "Welcome back"). The review is about the week before, so its headline, stats, win, slip and push say "last week" and never
// "this week": "No sessions this week (2nd week off)" sat beside a card counting this week's first session (days 63 and 70).
// ("Next week" is about the coming week and may say it.)
invariant(LIFTERS, 'no Monday review string (headline, stats, win, slip, push) calls the reviewed week "this week"', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const review = snap.review;
    if (!review) continue;
    const texts = [...reviewTexts(snap).filter(t => t.where !== 'review.nextWeek'), { where: 'alert.title', text: review.alert.title }, { where: 'alert.body', text: review.alert.body }];
    for (const t of texts) if (/\bthis week\b/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
  }
  return out;
});

// A next-load cue is one loadable step: it starts on the 2.5 kg / 5 lb grid and adds exactly one step, and it says "~" when the load
// she logged is not on the grid ("bench ~195 → 200 lb"). lifter_imperial read "bench 176 → 180 lb", "182 → 185" (+3), "Squat 243 → 250,
// bench 193 → 200" (+7): the lb start was rounded to 1 lb and only the target to the 5 lb grid. (The kg rows are already on the grid.)
invariant(LIFTERS, 'every next-load cue ("Squat 110 → 112.5 kg", "bench ~195 → 200 lb") starts on the grid and adds exactly one step (2.5 kg / 5 lb)', (snaps, name) => {
  const out: Violation[] = [];
  let cues = 0;
  const onGrid = (v: number, step: number): boolean => Math.abs(v / step - Math.round(v / step)) < 1e-9;
  for (const snap of snaps) {
    const text = snap.review?.review.nextWeek;
    if (text == null) continue;
    for (const m of plain(text).matchAll(/(~?)(\d+(?:\.\d+)?)\s?→\s?(\d+(?:\.\d+)?)\s?(kg|lb)\b/g)) {
      cues++;
      const step = m[4] === 'kg' ? 2.5 : 5;
      const from = Number(m[2]);
      const to = Number(m[3]);
      if (!onGrid(from, step) || !onGrid(to, step) || Math.abs(to - from - step) > 1e-9) {
        out.push({ snap, detail: `review.nextWeek: "${visible(text)}" (${m[0]} starts off the ${step} ${m[4]} grid or is not one step of ${step} ${m[4]})` });
      }
    }
  }
  assert.ok(cues > 0, `${name}: no next-load cue appeared, so this invariant checked nothing`);
  return out;
});

// The lift the card leads with is sticky: it changes to another lift only when that lift has out-trained it by 2+ sessions (over the 8
// completed weeks the ranking looks at) at two Mondays in a row. lifter_short_week: one short week (the squat and deadlift sessions
// dropped) made bench the most-trained lift by ONE session, and from day 49 to the end the card led with "Bench Press" instead of "Squat".
// Counted from the scenario's own rows. Days with a lapse or a return in progress lead with a different lift on purpose and are skipped.
invariant(LIFTERS, 'the lift the card leads with changes only when another lift has out-trained it by 2+ sessions at two Mondays in a row', (snaps, name) => {
  const scn = buildScenario(name);
  const keyOf = new Map<string, string>(scn.sets.map(s => [s.display, s.exercise]));
  const sessionsOf = (exercise: string, anchor: string): number => {
    const days = new Set(scn.sets.filter(s => s.exercise === exercise && !s.isWarmup && s.day >= addDays(anchor, -56) && s.day < anchor).map(s => s.day));
    return days.size;
  };
  const out: Violation[] = [];
  let prev: { exercise: string; snap: DaySnapshot } | null = null;
  for (const snap of snaps) {
    const card = snap.card;
    if (!card || card.liftReturn != null || inLapse(snap)) continue;
    const lead = card.reasons.find(r => r.kind === 'lift');
    const named = lead ? /^(?:(?:This|Last) week: )?(.+?) est\. 1RM [+−]/.exec(plain(lead.text))?.[1] : undefined;
    const exercise = named != null ? keyOf.get(named) : undefined;
    if (exercise == null) continue;
    if (prev && prev.exercise !== exercise) {
      const anchor = mondayOfDate(snap.date);
      const margin = (at: string): number => sessionsOf(exercise, at) - sessionsOf(prev!.exercise, at);
      if (margin(anchor) < 2 || margin(addDays(anchor, -7)) < 2) {
        out.push({ snap, detail: `the card led with ${prev.exercise} on ${prev.snap.date} and leads with ${exercise} now, but ${exercise} out-trained it by ${margin(anchor)} session(s) this Monday and ${margin(addDays(anchor, -7))} the Monday before (8 completed weeks each): "${visible(lead?.text ?? '')}"` });
      }
    }
    prev = { exercise, snap };
  }
  return out;
});

// The server SENDS the headline lift (GoalProgress.headlineLift) so the iOS Trends Strength card leads with the same lift as the goal card
// instead of ranking the lifts itself: it is the lift the card's lead lift line names, and it exists for the muscle goal only.
invariant(ALL, 'headlineLift is sent for the muscle goal only, and is the lift the card\'s lead lift line names', (snaps, name) => {
  const scn = buildScenario(name);
  const keyOf = new Map<string, string>(scn.sets.map(s => [s.display, s.exercise]));
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const card = snap.card;
    if (!card) continue;
    if (card.goal !== 'muscle') {
      if ('headlineLift' in card) out.push({ snap, detail: `a ${card.goal} card carries headlineLift ${JSON.stringify(card.headlineLift)}` });
      continue;
    }
    const sent = card.headlineLift;
    if (typeof sent !== 'string' || sent === '') {
      if (card.reasons.some(r => r.kind === 'lift')) out.push({ snap, detail: `a lift line is shown but headlineLift is ${JSON.stringify(sent)}` });
      continue;
    }
    if (card.liftReturn != null || inLapse(snap)) continue; // those lines name the lift furthest behind / the last one trained, not the headline lift
    const lead = card.reasons.find(r => r.kind === 'lift');
    const named = lead ? /^(?:(?:This|Last) week: )?(.+?) est\. 1RM [+−]/.exec(plain(lead.text))?.[1] : undefined;
    if (named == null) continue;
    checked++;
    if (keyOf.get(named) !== sent) out.push({ snap, detail: `headlineLift "${sent}" but the lead lift line names ${named}: "${visible(lead?.text ?? '')}"` });
  }
  if (LIFTERS.includes(name)) assert.ok(checked > 0, `${name}: no lead lift line was compared, so this invariant checked nothing`);
  return out;
});

// A slack week (half the planned sessions or fewer, but not none) has no lift-progress win: "Bench Press estimated 1RM is up 6 kg vs 4
// weeks ago" on a 1-of-4 week quotes a number whose "now" side was set the week before. The win may only cite what was done that week
// ("You still got Thursday's bench session in.", or the week's weight / protein win), or there is none. lifter_short_week day 49.
// (A week with no session at all has no lift win already.)
const LIFT_PROGRESS_WIN = /1RM|\bvs \d+ weeks?\b|\bvs the week before\b|\bover \d+ wks\b/i;

invariant(LIFTERS, 'a review of a week with at most half its planned sessions has no 4-week lift win (what was done that week, or none)', (snaps, name) => {
  const out: Violation[] = [];
  let slack = 0;
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r || r.weekGap?.kind !== 'sessions' || r.weekGap.done === 0 || r.weekGap.done * 2 > r.weekGap.target) continue;
    slack++;
    if (r.win != null && LIFT_PROGRESS_WIN.test(plain(r.win))) out.push({ snap, detail: `${r.weekGap.done} of ${r.weekGap.target} sessions, review.win: "${visible(r.win)}"` });
  }
  if (name === 'lifter_short_week') assert.ok(slack > 0, `${name}: no slack week was reviewed, so this invariant checked nothing`);
  return out;
});

// While EVERY lift is still rebuilding after a break, the card and the coach line say where each one stands. The card named only the
// headline squat ("Building back — Squat est. 1RM 136 of 142 kg") while the deadlift sat at 94%, and the deadlift line came and went
// (days 71-76 hidden, day 77 shown, day 78 hidden after she deadlifted: a 3-point hide rule). The percentages are the displayed ones.
invariant(LIFTERS, 'while every lift is rebuilding, the card reasons and the coach line give each lift\'s percentage of its pre-break best', (snaps, name) => {
  const out: Violation[] = [];
  let days = 0;
  for (const snap of snaps) {
    const rets = snap.card?.liftReturns;
    if (!rets || rets.length < 2 || rets.some(r => r.regained)) continue;
    days++;
    const imperial = buildScenario(name).profile.units === 'imperial';
    const card = plain(snap.card?.reasons.map(r => r.text).join(' | ') ?? '');
    const coach = plain((snap.coach ?? []).join(' | '));
    for (const [i, r] of rets.entries()) {
      // The headline lift's line prints its numbers, so its share is of THOSE (whole kg or lb); the standing line and the coach line print
      // none, so their share is of whole kg whatever the unit (wave 23s: a lb lifter reads the same 95% as a kg one).
      const f = imperial ? 2.20462 : 1;
      const pre = Math.round(r.preBreakKg * f);
      const recent = Math.min(Math.round(r.recentKg * f), pre - 1);
      const shownPct = Math.min(99, Math.round((recent / pre) * 100));
      const kgPct = liftReturnDisplay(r, false).pct;
      const label = liftShortName(r.exercise);
      if (!new RegExp(`${i === 0 ? r.name.toLowerCase() : label}[^|]*\\b${i === 0 ? shownPct : kgPct}%`, 'i').test(card)) out.push({ snap, detail: `card reasons do not give ${r.name} at ${i === 0 ? shownPct : kgPct}%: "${visible(card)}"` });
      if (!new RegExp(`${r.name.toLowerCase()} ${kgPct}% of its pre-break best`, 'i').test(coach)) out.push({ snap, detail: `coach lines do not give ${r.name} at ${kgPct}%: "${visible(coach)}"` });
    }
  }
  if (name === 'lifter') assert.ok(days > 0, `${name}: no day had two or more lifts all rebuilding, so this invariant checked nothing`);
  return out;
});

// The headline lift only changes with news: on a day nothing was logged and no new week began, the lift the server sends as the headline
// lift (and so the Strength card's first row, and the comeback's lead lift) is the same as the day before. The sticky ranking was replayed
// over weeks the 84-day loader window only half holds, so the oldest week lost a day's sets every day and the lead flipped Tue -> Wed
// (lifter_short_week days 85-86, 94-95, 96-97).
invariant(LIFTERS, 'headlineLift does not change on a day with no strength session logged and no new calendar week', (snaps, name) => {
  const scn = buildScenario(name);
  const trained = new Set(scn.sets.filter(x => !x.isWarmup).map(x => x.day));
  const out: Violation[] = [];
  let prev: DaySnapshot | null = null;
  for (const snap of snaps) {
    if (snap.card?.goal !== 'muscle') continue;
    if (prev && dayDiff(snap.date, prev.date) === 1 && prev.card?.headlineLift !== snap.card.headlineLift && !trained.has(snap.date) && weekdayOf(snap.date) !== 'Mon') {
      out.push({ snap, detail: `headlineLift ${prev.card?.headlineLift} (${prev.date}) -> ${snap.card.headlineLift} with nothing logged and no new week` });
    }
    prev = snap;
  }
  return out;
});

// A comeback sentence that names the lifts already back ("Squat and bench back at pre-break; deadlift at 98%") says "above" only when every
// named lift is above its pre-break number as printed, "at" only when every one is exactly at it, and "at or above" for a mix - the card
// said "Squat back above pre-break" on Friday and "...back at pre-break" on Sunday for the same squat (145 vs 142 kg) - and writes the names
// in sentence case: "Bench and squat", not "Bench Press and squat". Checked on the card headline and on the review headline.
invariant(LIFTERS, 'a "back at / above / at or above pre-break" sentence matches the printed numbers of the lifts it names, in sentence case', (snaps, name) => {
  const imperial = buildScenario(name).profile.units === 'imperial';
  const shown = (r: { preBreakKg: number; recentKg: number }): { pre: number; recent: number } => {
    const f = imperial ? 2.20462 : 1;
    return { pre: Math.round(r.preBreakKg * f), recent: Math.round(r.recentKg * f) };
  };
  const out: Violation[] = [];
  let sentences = 0;
  const check = (snap: DaySnapshot, where: string, text: string, rets: Array<{ exercise: string; name: string; preBreakKg: number; recentKg: number; regained: boolean }> | null | undefined): void => {
    const m = /(?:^|, )([A-Z][^;]*?) back (at or above|above|at) pre-break;/.exec(plain(text));
    if (!m || !rets) return;
    sentences++;
    const named = rets.filter(r => r.regained && m[1].toLowerCase().split(/, | and /).some(n => r.name.toLowerCase() === n || (r.exercise === 'bench press' && n === 'bench')));
    if (named.length === 0) return;
    const rel = named.every(r => shown(r).recent > shown(r).pre) ? 'above' : named.every(r => shown(r).recent <= shown(r).pre) ? 'at' : 'at or above';
    if (m[2] !== rel) out.push({ snap, detail: `${where}: "${visible(text)}" says "${m[2]}" but ${named.map(r => `${r.name} ${shown(r).recent} vs ${shown(r).pre}`).join(', ')}` });
    if (!/^[A-Z][^A-Z]*$/.test(m[1])) out.push({ snap, detail: `${where}: "${visible(text)}" names the lifts "${m[1]}" (not sentence case)` });
  };
  for (const snap of snaps) {
    if (snap.card) check(snap, 'card.headline', snap.card.headline, snap.card.liftReturns);
    if (snap.review) check(snap, 'review.headline', snap.review.review.headline, snap.review.progress.liftReturns);
  }
  if (name === 'lifter') assert.ok(sentences > 0, `${name}: no comeback sentence naming lifts that are back appeared, so this invariant checked nothing`);
  return out;
});

// "Lifts up, week short — Squat +10 kg" read like a load added to the bar: the number is the estimated 1RM, so the headline says so.
// (Wave 23s: a slack week now leads with "Week short — 1 of 4 so far", so no lifter scenario reaches a "Lifts up" headline any more; the
// unit tests in lib/goalProgress.test.ts cover "Lifts up, sessions behind". The invariant stays for the day one appears.)
invariant(LIFTERS, 'a "Lifts up, ..." headline says the number is the est. 1RM', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const h = snap.card?.headline;
    if (h == null || !/^Lifts up\b/.test(plain(h))) continue;
    if (!/est\. 1RM/.test(plain(h))) out.push({ snap, detail: `card.headline: "${visible(h)}"` });
  }
  return out;
});

// "Deload week done — lighter loads, as planned." is only true if the week before planned it. lifter day 35: the day-28 review had asked for
// "Squat 107.5 → 110 kg", so the lighter week was the lifter's own call, and the win now names the timing instead.
invariant(LIFTERS, 'a deload win says "as planned" only when the previous review asked for a lighter week', (snaps, name) => {
  const out: Violation[] = [];
  const reviewOn = (date: string): DaySnapshot | undefined => snaps.find(s => s.date === date && s.review != null);
  let deloads = 0;
  for (const snap of snaps) {
    const win = snap.review?.review.win;
    if (win == null || !/^Deload week done/.test(plain(win))) continue;
    deloads++;
    const prev = reviewOn(addDays(snap.date, -7))?.review?.review.nextWeek ?? '';
    if (/as planned/.test(plain(win)) && !/lighter|deload|ease back/i.test(plain(prev))) out.push({ snap, detail: `review.win: "${visible(win)}" after a previous "Next week" of "${visible(prev)}"` });
  }
  if (name === 'lifter') assert.ok(deloads > 0, `${name}: no deload week was reviewed, so this invariant checked nothing`);
  return out;
});

// "Trend weight up 0.17 kg/wk with no training" reads as blame, and the rate is a 28-day one: in the first two weeks of a lapse most of it
// was earned before the break. Until the lapse covers half the window the line says so; "with no training" is for a longer one.
invariant(LIFTERS, 'in the first 14 days of a lapse the weight-rate line never says "with no training" (most of its 28 days is from before the break)', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const ago = snap.card?.lastSessionDaysAgo;
    if (ago == null || ago >= 14 || !inLapse(snap)) continue;
    for (const t of cardTexts(snap)) if (/with no training/.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" (last session ${ago} days ago)` });
  }
  return out;
});

// The same weigh-ins read the same in both units: a weekly average that moved 0.04 kg is "no change" in kg and in lb (it was "+0.1 lb" in
// lifter_imperial on days 14 and 35, where lifter says "no change"). The noise threshold is the metric one, 0.05 kg, in both.
test('lifter_imperial: the weekly weight stat says "no change" on exactly the Mondays lifter does', () => {
  const noChange = (snaps: DaySnapshot[]): string[] =>
    snaps.filter(s => s.review?.review.stats.some(st => st.label === 'Weekly avg weight' && st.value === 'no change')).map(s => s.date);
  const metric = noChange(runTimeline('lifter'));
  const imperial = noChange(runTimeline('lifter_imperial'));
  assert.ok(metric.length > 0, 'lifter has no "no change" week, so this test checked nothing');
  assert.deepEqual(imperial, metric);
});

// "inside the 0.1–0.5% safe band" / "under the 0.1% a week floor" is jargon to a lifter. The muscle card says what the range is for.
invariant(LIFTERS, 'no card, coach line or opener calls the weight range a "safe band", "floor" or "ceiling"', snaps =>
  textMatches(snaps, s => [...cardTexts(s), ...coachTexts(s)], /safe band|a week floor|a week ceiling/i));

// The same +2.5 kg on the bar reads the same change every week: the week-over-week change was the difference of two ROUNDED e1RMs, so one
// step read "+3", then "+4", then "+3" (lifter days 14, 21, 28). Computed from the unrounded change (the 4-week number keeps its printed
// endpoints, "126 → 136 kg", which must add up). The squat is stepped +2.5 kg at the same reps and RPE, so its e1RM moves by one amount.
invariant(LIFTERS, 'a constant +2.5 kg step on the squat reads the same week-over-week change in every review', (snaps, name) => {
  const scn = buildScenario(name);
  const topSquat = (monday: string): number | null => {
    const loads = scn.sets.filter(s => s.exercise === 'squat' && !s.isWarmup && s.day >= monday && s.day <= addDays(monday, 6) && s.loadKg != null).map(s => s.loadKg as number);
    return loads.length > 0 ? Math.max(...loads) : null;
  };
  const seen = new Map<string, string[]>();
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r) continue;
    const stat = r.stats.find(st => st.label === 'Squat est. 1RM' && st.comparison === 'vs the week before');
    if (!stat) continue;
    const now = topSquat(r.weekStart);
    const before = topSquat(addDays(r.weekStart, -7));
    if (now == null || before == null || now - before !== 2.5) continue;
    seen.set(stat.value, [...(seen.get(stat.value) ?? []), snap.date]);
  }
  const out: Violation[] = [];
  if (seen.size > 1) {
    const detail = [...seen.entries()].map(([value, days]) => `${plain(value)} on ${days.join(', ')}`).join(' vs ');
    const first = snaps.find(s => s.review && s.date === [...seen.values()][1][0]) as DaySnapshot;
    out.push({ snap: first, detail: `the same +2.5 kg step reads differently: ${detail}` });
  }
  assert.ok([...seen.values()].flat().length >= 2, `${name}: fewer than two +2.5 kg squat weeks were compared, so this invariant checked nothing`);
  return out;
});

// A slack week (half the planned sessions or fewer, but not none) must not lead with, or colour, a lift gain the week did not produce:
// lifter_short_week day 49 read "1 of 4 sessions, Squat est. 1RM +10 kg over 4 wks" with a green squat stat, for a squat she did not train
// that week (the Thursday bench was a light 3x8 volume day). A lift gain may appear only for a lift trained at working weight that week -
// a top set at 90% or more of its best in the 4 weeks before. Counted from the scenario's own rows. The push body is the headline.
invariant(LIFTERS, 'a review of a week with at most half its planned sessions rates no lift green and leads with no lift gain unless that lift was trained at working weight that week', (snaps, name) => {
  const scn = buildScenario(name);
  const exerciseOf = new Map<string, string>(scn.sets.map(s => [`${s.display} est. 1RM`, s.exercise]));
  const topLoad = (exercise: string, from: string, to: string): number | null => {
    const loads = scn.sets.filter(s => s.exercise === exercise && !s.isWarmup && s.day >= from && s.day <= to && s.loadKg != null && s.loadKg > 0).map(s => s.loadKg as number);
    return loads.length > 0 ? Math.max(...loads) : null;
  };
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r || r.weekGap?.kind !== 'sessions' || r.weekGap.done === 0 || r.weekGap.done * 2 > r.weekGap.target) continue;
    checked++;
    const weekEnd = addDays(r.weekStart, 6);
    let gainShown = false;
    for (const st of r.stats) {
      const exercise = exerciseOf.get(st.label);
      if (exercise == null) continue;
      const now = topLoad(exercise, r.weekStart, weekEnd);
      const best = topLoad(exercise, addDays(r.weekStart, -28), addDays(r.weekStart, -1));
      const working = now != null && (best == null || now >= best * 0.9 - 1e-9);
      if (working) { gainShown = gainShown || st.tone === 'good'; continue; }
      const texts = [{ where: 'review.headline', text: r.headline }, { where: 'alert.body', text: snap.review?.alert.body ?? '' }];
      if (st.tone === 'good') out.push({ snap, detail: `${r.weekGap.done} of ${r.weekGap.target} sessions: stat "${st.label}" ${st.value} is rated good, but the lift had no working-weight set in the reviewed week (top ${now ?? 'none'} kg vs ${best ?? 'none'} kg before)` });
      for (const t of texts) if (plain(t.text).includes(`${st.label} +`)) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" leads with a ${st.label} gain, but the lift had no working-weight set in the reviewed week` });
    }
    if (!gainShown && !/^\d+ of \d+ sessions last week — a short week$/.test(plain(r.headline))) out.push({ snap, detail: `review.headline: "${visible(r.headline)}" (a slack week with no lift gain to show leads with the week: "N of M sessions last week — a short week")` });
  }
  if (name === 'lifter_short_week') assert.ok(checked > 0, `${name}: no slack week was reviewed, so this invariant checked nothing`);
  return out;
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// wave 22e: endurance round 4 (running coach + 4 runner personas). Every invariant here was written BEFORE the rule it locks in.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/** Running km per local day from a scenario's own rows (the race run is not training volume, as the plan counts it). */
function scenarioRunKm(name: ScenarioName): Map<string, number> {
  const scn = buildScenario(name);
  const out = new Map<string, number>();
  for (const w of scn.workouts) {
    if (w.type !== 'Running' || !w.distanceM || w.day === scn.user.raceDate) continue;
    out.set(w.day, (out.get(w.day) ?? 0) + w.distanceM / 1000);
  }
  return out;
}

/** Running km of the Mon-Sun week at `monday` from its Monday through `through` (inclusive). */
function kmThrough(runKm: Map<string, number>, monday: string, through: string): number {
  let km = 0;
  for (let d = monday; d <= through; d = addDays(d, 1)) km += runKm.get(d) ?? 0;
  return km;
}

const isLightWeekRead = (s: DaySnapshot): boolean => s.card?.distance?.plan?.lightWeek === true || /^Light week\b/.test(plain(s.card?.headline ?? ''));

// P1-B. "Light week — 6.7 of ~17 km so far" on a Friday of a runner who was exactly on pace (the long run is Sunday).
invariant(RUNNERS, 'no light-week read on a day where the week so far is at least last week\'s km through the same weekday', (snaps, name) => {
  const runKm = scenarioRunKm(name);
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!isLightWeekRead(snap)) continue;
    const monday = mondayOfDate(snap.date);
    const prevMonday = addDays(monday, -7);
    const prevSame = kmThrough(runKm, prevMonday, addDays(prevMonday, dayDiff(snap.date, monday)));
    const prevTotal = kmThrough(runKm, prevMonday, addDays(prevMonday, 6));
    const done = kmThrough(runKm, monday, snap.date);
    if (prevTotal > 0 && done >= prevSame - 1e-9) out.push({ snap, detail: `"${visible(snap.card?.headline ?? '')}": ${Math.round(done * 10) / 10} km so far, last week had ${Math.round(prevSame * 10) / 10} km by the same weekday` });
  }
  return out;
});

invariant(RUNNERS, 'a light-week read appears only in a week that really came in under 90% of its target (counted from the rows)', (snaps, name) => {
  const runKm = scenarioRunKm(name);
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!isLightWeekRead(snap)) continue;
    const monday = mondayOfDate(snap.date);
    const total = kmThrough(runKm, monday, addDays(monday, 6));
    const target = snap.card?.distance?.stepTargetKm ?? 0;
    if (total >= target * 0.9 - 1e-9) out.push({ snap, detail: `"${visible(snap.card?.headline ?? '')}" but the week then ran ${Math.round(total * 10) / 10} km of ~${target} km` });
  }
  return out;
});

const nextMondayPhase = (name: ScenarioName, snap: DaySnapshot): string | null => {
  const scn = buildScenario(name);
  return racePhaseInfo(scn.user.raceDate, addDays(mondayOfDate(snap.date), 7), scn.user.raceDistanceKm)?.phase ?? null;
};
const isPreTaperWeek = (name: ScenarioName, snap: DaySnapshot): boolean => {
  const next = nextMondayPhase(name, snap);
  const thisPhase = buildScenario(name).user.raceDate == null ? null : racePhaseInfo(buildScenario(name).user.raceDate, mondayOfDate(snap.date), buildScenario(name).user.raceDistanceKm)?.phase;
  return thisPhase === 'build' && (next === 'taper' || next === 'race_week');
};

invariant(RUNNERS, 'no light-week read in a pre-taper week (the week before the taper or race week): easing off there is fine', (snaps, name) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!isPreTaperWeek(name, snap)) continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      if (/\blight week\b/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
    if (snap.card?.distance?.plan?.lightWeek === true) out.push({ snap, detail: 'distance.plan.lightWeek is set in a pre-taper week' });
  }
  return out;
});

// A "long run ≤ N" cap in the days before a taper must never sit under the taper's own planned long run (the next Monday's card).
const LONG_RUN_CAP = /\b(?:long|longest) run ≤ ~?(\d+(?:\.\d+)?)/i;

invariant(RUNNERS.filter(n => n !== 'runner_no_race'), 'a "long run ≤ N" cap is never below the planned taper long run', (snaps, name) => {
  const byDate = new Map(snaps.map(s => [s.date, s]));
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!isPreTaperWeek(name, snap)) continue;
    const taperLong = byDate.get(addDays(mondayOfDate(snap.date), 7))?.card?.distance?.plan?.longRunKm;
    if (taperLong == null) continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      const m = LONG_RUN_CAP.exec(plain(t.text));
      if (m && Number(m[1]) < taperLong - 0.5 - 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" is under the taper's planned long run of ${taperLong} km` });
    }
  }
  return out;
});

// The residual: an ill runner (one 6 km run on Tuesday, then nothing) is a light week from Thursday, when the remaining km cannot fit.
// Wave 23e (G2): from the FRIDAY, not the Thursday. On a Thursday morning the card cannot tell an ill runner (Tuesday's run done, Thursday's skipped) from a
// runner who did exactly what the plan said (Tuesday's run done, Thursday's still to come): both have the same week so far. The obedient runner is never
// "Light week" - the day after, with Thursday's run missing, the ill one is.
invariant(['runner_messy', 'runner_comeback_spike'], 'the week of an illness reads as a light week from the Friday (6 km run, the rest cannot fit)', (snaps, name) => {
  const friday = snaps.find(s => s.idx === 60);
  assert.ok(friday != null && weekdayOf(friday.date) === 'Fri', `${name}: day 60 is not a stepped Friday`);
  const out: Violation[] = [];
  if (!isLightWeekRead(friday)) out.push({ snap: friday, detail: `Friday after one 6 km run reads "${visible(friday.card?.headline ?? '')}" (verdict ${friday.card?.verdict})` });
  return out;
});

// ── wave 22e / P1-A: the comeback over-cap loop ─────────────────────────────

/** The week's "up to" read from a Sunday card: the ceiling C (stepTargetKm) and the km run A, or null when the week had no ceiling. */
function sundayCeiling(s: DaySnapshot): { ceiling: number; ran: number } | null {
  const d = s.card?.distance;
  if (weekdayOf(s.date) !== 'Sun' || !d?.plan?.upTo || d.thisWeekKm == null) return null;
  return { ceiling: d.stepTargetKm, ran: d.thisWeekKm };
}

invariant(RUNNERS, '"Hold here" never appears in a week whose target is higher than last week\'s target', (snaps) => {
  const byDate = new Map(snaps.map(s => [s.date, s]));
  const out: Violation[] = [];
  for (const snap of snaps) {
    const d = snap.card?.distance;
    if (!d) continue;
    const lastSunday = byDate.get(addDays(d.weekStart, -1));
    const lastTarget = lastSunday?.card?.distance?.stepTargetKm;
    if (lastTarget == null || d.stepTargetKm <= lastTarget + 1e-9) continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      if (/\bhold here\b/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" in a week targeting ${d.stepTargetKm} km after a week that targeted ${lastTarget} km` });
    }
  }
  return out;
});

invariant(RUNNERS, 'a week more than 10% over its comeback ceiling is not followed by another one unless it was "well over" (more than 25% over)', (snaps, name) => {
  const out: Violation[] = [];
  const sundays = snaps.filter(s => weekdayOf(s.date) === 'Sun');
  let over = 0;
  for (let i = 1; i < sundays.length; i++) {
    const a = sundayCeiling(sundays[i - 1]);
    const b = sundayCeiling(sundays[i]);
    if (a && a.ran > a.ceiling * 1.1 + 1e-9) over++;
    if (a && b && dayDiff(sundays[i].date, sundays[i - 1].date) === 7 && a.ran > a.ceiling * 1.1 + 1e-9 && a.ran <= a.ceiling * 1.25 + 1e-9 && b.ran > b.ceiling * 1.1 + 1e-9) {
      out.push({ snap: sundays[i], detail: `${a.ran} of up to ~${a.ceiling} km (${sundays[i - 1].date}), then ${b.ran} of up to ~${b.ceiling} km again: the ceiling followed the overshoot` });
    }
  }
  if (name === 'runner_messy') assert.ok(over > 0, `${name}: no comeback week went over its ceiling, so this invariant checked nothing`);
  return out;
});

invariant(RUNNERS, "a comeback ceiling never climbs more than 1.25x the previous ceiling when that week ran over it (and never more than 1.25x the km run when it did not)", (snaps) => {
  const out: Violation[] = [];
  const sundays = snaps.filter(s => weekdayOf(s.date) === 'Sun');
  for (let i = 1; i < sundays.length; i++) {
    const a = sundayCeiling(sundays[i - 1]);
    const next = sundays[i].card?.distance;
    if (!a || !next || dayDiff(sundays[i].date, sundays[i - 1].date) !== 7) continue;
    const limit = a.ran > a.ceiling * 1.1 + 1e-9 ? a.ceiling * 1.25 : Math.max(a.ceiling, a.ran) * 1.25;
    if (next.stepTargetKm > limit + 0.5 + 1e-9) {
      out.push({ snap: sundays[i], detail: `${a.ran} of up to ~${a.ceiling} km, then the week targets ${next.stepTargetKm} km (limit ${Math.round(limit * 10) / 10} km): "${visible(next.text)}"` });
    }
  }
  return out;
});

invariant(['runner_comeback_spike'], 'S2: a big overshoot of the first comeback week reads as a spike and the ceiling is held', (snaps, name) => {
  const out: Violation[] = [];
  const byDate = new Map(snaps.map(s => [s.date, s]));
  const sunday = snaps.find(s => s.idx === 76);
  assert.ok(sunday != null && sundayCeiling(sunday) != null, `${name}: day 76 is not a Sunday with an "up to" ceiling`);
  const { ceiling, ran } = sundayCeiling(sunday) as { ceiling: number; ran: number };
  assert.ok(ran > ceiling * 1.25, `${name}: the scripted week did not overshoot (${ran} of up to ~${ceiling} km)`);
  const monday = byDate.get(addDays(sunday.date, 1)) as DaySnapshot;
  const plan = monday.card?.distance?.plan;
  if (plan?.kind !== 'hold') out.push({ snap: monday, detail: `plan kind ${plan?.kind}, not a hold, after ${ran} of up to ~${ceiling} km: "${visible(monday.card?.headline ?? '')}"` });
  if (monday.card?.distance?.stepTargetKm !== ceiling) out.push({ snap: monday, detail: `target ${monday.card?.distance?.stepTargetKm} km, the ceiling to hold was ${ceiling} km` });
  if (monday.card?.verdict !== 'holding') out.push({ snap: monday, detail: `verdict ${monday.card?.verdict}: "${visible(monday.card?.headline ?? '')}"` });
  const review = monday.review?.review;
  if (review?.weekRating !== 'mixed' || review.weekGap?.kind !== 'spike') out.push({ snap: monday, detail: `review rated ${review?.weekRating} with gap ${JSON.stringify(review?.weekGap)}: "${visible(review?.headline ?? '')}"` });
  if (!/well over the ceiling/i.test(plain(review?.headline ?? ''))) out.push({ snap: monday, detail: `review headline "${visible(review?.headline ?? '')}" does not say well over the ceiling` });
  return out;
});

// The card, the review and the coach read ONE grade for the week that was run against its ceiling.
const OVER_GRADE = (text: string): 'well' | 'touch' | null => (/well over/i.test(text) ? 'well' : /a touch over|a little over|over the cap/i.test(text) ? 'touch' : null);

invariant(RUNNERS, 'the review and the Monday card read the same over-the-ceiling grade, and a good review never carries an over-the-cap headline', (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const rv = snap.review?.review;
    if (!rv) continue;
    const reviewGrade = OVER_GRADE(plain(rv.headline));
    const cardGrade = OVER_GRADE(plain(snap.card?.headline ?? ''));
    if (reviewGrade !== cardGrade) out.push({ snap, detail: `review headline "${visible(rv.headline)}" (${reviewGrade}) vs card headline "${visible(snap.card?.headline ?? '')}" (${cardGrade})` });
    if (rv.weekRating === 'good' && reviewGrade === 'well') out.push({ snap, detail: `a good week with a well-over headline: "${visible(rv.headline)}"` });
    if (rv.weekRating === 'good' && /over the cap/i.test(plain(rv.headline))) out.push({ snap, detail: `a good week with an over-the-cap headline: "${visible(rv.headline)}"` });
    if (reviewGrade === 'well' && rv.weekGap?.kind !== 'spike') out.push({ snap, detail: `well over the ceiling but weekGap ${JSON.stringify(rv.weekGap)}: "${visible(rv.headline)}"` });
  }
  return out;
});

invariant(['runner_messy'], 'messy comeback: week 11 is "a touch over, fine" (next ceiling 22 km), week 12 is on plan (next 29 km), week 13 is on plan', (snaps) => {
  const out: Violation[] = [];
  const at = (idx: number): DaySnapshot => snaps.find(s => s.idx === idx) as DaySnapshot;
  const check = (idx: number, target: number, headline: RegExp, review?: RegExp): void => {
    const s = at(idx);
    if (s.card?.distance?.stepTargetKm !== target) out.push({ snap: s, detail: `target ${s.card?.distance?.stepTargetKm} km, expected ${target} km` });
    if (!headline.test(plain(s.card?.headline ?? ''))) out.push({ snap: s, detail: `card headline "${visible(s.card?.headline ?? '')}" does not match ${headline}` });
    if (review && !review.test(plain(s.review?.review.headline ?? ''))) out.push({ snap: s, detail: `review headline "${visible(s.review?.review.headline ?? '')}" does not match ${review}` });
  };
  check(77, 22, /^Building — 20 of up to ~18 km last week, a touch over, fine$/, /^4 sessions, 20 of up to ~18 km — a touch over, fine · goal 30 km$/);
  check(84, 29, /, on plan$/, /24 of up to ~22 km — on plan/);
  // Week 13 ran 28 of up to ~29 km: inside its ceiling, no over-the-ceiling grade on either surface (the ladder is over; the step is the goal).
  check(91, 30, /^(?!.*\b(?:touch over|well over)\b)/, /^4 sessions, 28 of up to ~29 km · goal 30 km/);
  return out;
});

// "Well over the ceiling — 29 of up to ~18 km. Stay at ~18 km next week" (Sunday) is the target of the coming Monday's card (wave 22e: the
// Sunday headline used to say "Hold ~20 km next week" over a Monday that stayed at 18).
const STAY_NEXT_WEEK = /Stay at ~(\d+(?:\.\d+)?)\s?(km|mi) next week/;

invariant(['runner_comeback_spike'], 'a "Stay at ~N next week" headline is the target of the coming Monday\'s card', (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    const m = STAY_NEXT_WEEK.exec(plain(snap.card?.headline ?? ''));
    if (!m) continue;
    const monday = snaps.find(s => s.date === addDays(mondayOfDate(snap.date), 7));
    const target = monday?.card?.distance?.stepTargetKm;
    if (target == null) continue;
    compared++;
    if (Math.abs(inDisplayUnit(target, m[2]) - Number(m[1])) > 0.05 + 1e-9) out.push({ snap, detail: `"${visible(snap.card?.headline ?? '')}" but the card on Monday ${monday?.date} targets ${inDisplayUnit(target, m[2])} ${m[2]}: "${visible(monday?.card?.headline ?? '')}"` });
  }
  assert.ok(compared > 0, `${name}: no "Stay at ~N next week" headline met a following Monday, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P1-C: a skipped cutback is not "30 of 30 km" ─────────────────

const ANY_OF_FIGURE = /(\d+(?:\.\d+)?)(?:\s?(?:km|mi))?\s+of\s+(?:up to\s+)?~?(\d+(?:\.\d+)?)\s?(km|mi)\b/g;

/** Mondays of the weeks whose Sunday card says "cutback", with that week's lowered target (km) and the km run. */
function cutbackWeeks(snaps: DaySnapshot[]): Array<{ monday: string; targetKm: number; ranKm: number; sunday: DaySnapshot }> {
  const out: Array<{ monday: string; targetKm: number; ranKm: number; sunday: DaySnapshot }> = [];
  for (const s of snaps) {
    const d = s.card?.distance;
    if (weekdayOf(s.date) !== 'Sun' || !d?.plan?.cutback || d.thisWeekKm == null) continue;
    out.push({ monday: mondayOfDate(s.date), targetKm: d.stepTargetKm, ranKm: d.thisWeekKm, sunday: s });
  }
  return out;
}

invariant(RUNNERS, 'in a cutback week every card, coach and review distance figure of the week uses the cutback target (never "30 of 30 km")', (snaps, name) => {
  const out: Violation[] = [];
  let weeks = 0;
  for (const w of cutbackWeeks(snaps)) {
    weeks++;
    const unit = /\bmi\b/.test(plain(w.sunday.card?.distance?.text ?? '')) ? 'mi' : 'km';
    const expected = inDisplayUnit(w.targetKm, unit);
    const check = (snap: DaySnapshot, texts: Text[]): void => {
      for (const t of texts) {
        for (const m of plain(t.text).matchAll(ANY_OF_FIGURE)) {
          // "long run 14 of 15 km" is the long-run build, not the week's distance.
          if (/\brun\s*$/i.test(plain(t.text).slice(Math.max(0, (m.index ?? 0) - 12), m.index))) continue;
          if (Math.abs(Number(m[2]) - expected) > 0.05 + 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" says "${m[0]}" in a cutback week of ~${expected} ${unit}` });
        }
      }
    };
    for (let i = 0; i < 7; i++) {
      const snap = snaps.find(s => s.date === addDays(w.monday, i));
      if (snap) check(snap, [...cardTexts(snap), ...coachTexts(snap)]);
    }
    const review = snaps.find(s => s.date === addDays(w.monday, 7));
    if (review?.review?.weekStart === w.monday) check(review, reviewTexts(review).filter(t => t.where === 'review.headline'));
  }
  assert.ok(weeks > 0 || name === 'runner_messy' || name === 'runner_comeback_spike' || name === 'runner_no_race' || name === 'runner_on_plan_imperial', `${name}: no cutback week was stepped, so this invariant checked nothing`);
  return out;
});

invariant(RUNNERS, 'a cutback week that ran more than 15% over its lowered target names the cutback on the Sunday card and in the review headline (wave 23e: "a normal week, not the cutback" - no guilt)', (snaps) => {
  const out: Violation[] = [];
  for (const w of cutbackWeeks(snaps)) {
    if (!(w.ranKm > w.targetKm * 1.15 + 1e-9) || /Over the safe step/i.test(plain(w.sunday.card?.headline ?? ''))) continue;
    if (!/cutback/i.test(plain(w.sunday.card?.headline ?? ''))) out.push({ snap: w.sunday, detail: `Sunday card headline "${visible(w.sunday.card?.headline ?? '')}" after ${w.ranKm} of ~${w.targetKm} km does not name the cutback` });
    const review = snaps.find(s => s.date === addDays(w.monday, 7));
    const headline = review?.review?.weekStart === w.monday ? review.review.review.headline : null;
    if (review && headline != null && !/not the cutback/i.test(plain(headline))) out.push({ snap: review, detail: `review headline "${visible(headline)}" after ${w.ranKm} of ~${w.targetKm} km does not say it was a normal week, not the cutback` });
  }
  return out;
});

// ── wave 22e / P2.1: a skipped cutback is not rewarded ──────────────────────

/** A cutback week more than 10% over its lowered target that is not a spike (a spike has its own read): the cutback was skipped. */
function skippedCutbacks(snaps: DaySnapshot[]): Array<{ monday: string; targetKm: number; ranKm: number; sunday: DaySnapshot }> {
  return cutbackWeeks(snaps).filter(w => w.ranKm > w.targetKm * 1.1 + 1e-9 && !/Over the safe step/i.test(plain(w.sunday.card?.headline ?? '')));
}

// (Wave 23e: the review no longer grades it mixed with a "Cutback skipped" slip - see the P2-6 invariant at the end of this file - but the week after still holds at the
// week it replaced and never steps up from the skip.)
invariant(RUNNERS, 'a cutback that became a normal week (more than 10% over its lowered number) is followed by a hold at the week it replaced - never a +12% build', (snaps, name) => {
  const out: Violation[] = [];
  const byDate = new Map(snaps.map(s => [s.date, s]));
  let skipped = 0;
  for (const w of skippedCutbacks(snaps)) {
    skipped++;
    const nextMonday = byDate.get(addDays(w.monday, 7));
    const plan = nextMonday?.card?.distance?.plan;
    const normalKm = w.targetKm / 0.8;
    if (nextMonday && plan?.kind !== 'hold') out.push({ snap: nextMonday, detail: `plan kind ${plan?.kind} after ${w.ranKm} of ~${w.targetKm} km (a cutback that became a normal week): "${visible(nextMonday.card?.headline ?? '')}"` });
    if (nextMonday?.card?.distance && nextMonday.card.distance.stepTargetKm > Math.ceil(normalKm) + 1 + 1e-9) out.push({ snap: nextMonday, detail: `target ${nextMonday.card.distance.stepTargetKm} km steps up after a skipped cutback (the week it replaced was ~${Math.round(normalKm)} km)` });
    if (nextMonday && !/^Your cutback became a normal week — hold ~/.test(plain(nextMonday.card?.headline ?? ''))) out.push({ snap: nextMonday, detail: `card headline "${visible(nextMonday.card?.headline ?? '')}" does not hold at the week the cutback replaced` });
    const review = nextMonday?.review;
    if (review && review.weekStart === w.monday && !/hold ~|Hold ~/.test(plain(review.review.nextWeek))) out.push({ snap: nextMonday as DaySnapshot, detail: `next week "${visible(review.review.nextWeek)}" does not hold` });
  }
  if (name === 'runner_on_plan' || name === 'runner_no_race') assert.ok(skipped > 0, `${name}: no cutback was skipped, so this invariant checked nothing`);
  return out;
});

// S1 walks the other path: a cutback that is run as planned is "Cutback week done", a good week, and the week after builds on the week before it.
invariant(['runner_on_plan_obedient'], 'a cutback run as planned is a good week with "Cutback week done" and is never called skipped', (snaps, name) => {
  const out: Violation[] = [];
  let done = 0;
  for (const w of cutbackWeeks(snaps)) {
    const review = snaps.find(s => s.date === addDays(w.monday, 7))?.review;
    if (!review || review.weekStart !== w.monday) continue;
    done++;
    const rv = review.review;
    if (rv.weekRating !== 'good' || !/^Cutback week done: /.test(plain(rv.win ?? ''))) out.push({ snap: snaps.find(s => s.date === addDays(w.monday, 7)) as DaySnapshot, detail: `rating ${rv.weekRating}, win "${visible(rv.win ?? '')}" for ${w.ranKm} of ~${w.targetKm} km` });
    for (const t of [rv.headline, rv.slip ?? '', rv.nextWeek]) if (/skipped|above the cutback/i.test(plain(t))) out.push({ snap: snaps.find(s => s.date === addDays(w.monday, 7)) as DaySnapshot, detail: `"${visible(t)}"` });
  }
  assert.ok(done > 0, `${name}: no reviewed cutback week, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.2: the restart number does not change overnight ───────────

const RESTART_NUMBER = /\b[Rr]estart(?: at)? ~(\d+(?:\.\d+)?)\s?(km|mi)\b/;

invariant(RUNNERS, "the restart number a Sunday shows is the number Monday's card and Monday's review show (the card quotes 'if you restart tomorrow')", (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const sunday of snaps) {
    if (weekdayOf(sunday.date) !== 'Sun') continue;
    const sundayText = [...cardTexts(sunday)].map(t => RESTART_NUMBER.exec(plain(t.text))).find(m => m != null);
    if (!sundayText) continue;
    const monday = snaps.find(s => s.date === addDays(sunday.date, 1));
    if (!monday) continue;
    const shown = Number(sundayText[1]);
    const mondayCard = [...cardTexts(monday)].map(t => RESTART_NUMBER.exec(plain(t.text))).find(m => m != null);
    const mondayReview = RESTART_NUMBER.exec(plain(monday.review?.review.nextWeek ?? ''));
    for (const [where, m] of [['Monday card', mondayCard], ['Monday review next week', mondayReview]] as const) {
      if (!m) continue;
      compared++;
      if (Number(m[1]) !== shown) out.push({ snap: monday, detail: `${where} says restart at ~${m[1]} ${m[2]}, Sunday ${sunday.date} said ~${shown}: "${visible(sunday.card?.headline ?? '')}" then "${visible(monday.card?.headline ?? '')}"` });
    }
  }
  if (name === 'runner_no_race') assert.ok(compared > 0, `${name}: no Sunday restart number met a Monday, so this invariant checked nothing`);
  return out;
});

// When the number drops during a break the card says why ("Two weeks off now - restart a bit lower, ~12 km"), never a silent change.
invariant(RUNNERS, 'when the restart number shown during a break drops from one day to the next, the card says why', (snaps, name) => {
  const out: Violation[] = [];
  let drops = 0;
  const onBreak = (s: DaySnapshot): number | null => {
    if (!/^On a break/.test(plain(s.card?.headline ?? ''))) return null;
    const m = RESTART_NUMBER.exec(plain(s.card?.headline ?? ''));
    return m ? Number(m[1]) : null;
  };
  for (let i = 1; i < snaps.length; i++) {
    const a = onBreak(snaps[i - 1]);
    const b = onBreak(snaps[i]);
    if (a == null || b == null || b >= a) continue;
    drops++;
    const texts = cardTexts(snaps[i]).map(t => plain(t.text)).join(' | ');
    if (!/weeks? off now — restart a bit lower/i.test(texts)) out.push({ snap: snaps[i], detail: `restart ~${a} -> ~${b} with no reason on the card: "${visible(snaps[i].card?.headline ?? '')}"` });
  }
  if (name === 'runner_no_race') assert.ok(drops > 0, `${name}: the restart number never dropped during a break, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.3: "Next week" follows the plan ahead ─────────────────────

invariant(RUNNERS, '"Next week" never sends a runner "toward 30 km" / "30 km the week after" when the week after is a taper, race or recovery week', (snaps, name) => {
  const scn = buildScenario(name);
  const out: Violation[] = [];
  for (const snap of snaps) {
    const rv = snap.review;
    if (!rv || scn.user.raceDate == null) continue;
    const afterNext = addDays(rv.weekStart, 14);
    const phase = racePhaseInfo(scn.user.raceDate, afterNext, scn.user.raceDistanceKm)?.phase;
    if (phase !== 'taper' && phase !== 'race_week') continue;
    if (/the week after|a week toward/i.test(plain(rv.review.nextWeek)) && !/taper|race week/i.test(plain(rv.review.nextWeek))) {
      out.push({ snap, detail: `week after next (${afterNext}) is ${phase}: "${visible(rv.review.nextWeek)}"` });
    }
  }
  return out;
});

// A comeback week's "Next week" and the same Monday's card say the SAME place the climb goes: "back toward your usual ~29 km", not "toward 30 km".
// ("back toward your usual ~22 km" on the card; since wave 23e the review names the ladder: "until you're back at your usual ~22 km".)
const BACK_TOWARD_USUAL = /back (?:toward|at) your usual ~(\d+(?:\.\d+)?)\s?(km|mi)\b/;

invariant(RUNNERS, "a comeback week's review Next week names the same usual km as the Monday card (\"back toward your usual ~29 km\")", (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  for (const snap of snaps) {
    const rv = snap.review;
    if (!rv) continue;
    const cardUsual = BACK_TOWARD_USUAL.exec(plain(snap.card?.distance?.plan?.purpose ?? ''));
    if (!cardUsual) continue;
    compared++;
    const said = BACK_TOWARD_USUAL.exec(plain(rv.review.nextWeek));
    if (!said || said[1] !== cardUsual[1]) out.push({ snap, detail: `card: "${visible(snap.card?.distance?.plan?.purpose ?? '')}" but review next week: "${visible(rv.review.nextWeek)}"` });
  }
  if (name === 'runner_messy' || name === 'runner_comeback_spike') assert.ok(compared > 0, `${name}: no comeback Monday had a card and a review, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.4: race day shows the race, not the week's km ─────────────

const isRaceDay = (s: DaySnapshot): boolean => s.race?.daysToRace === 0 && s.race.phase !== 'recovery';

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_imperial', 'runner_on_plan_obedient', 'runner_messy'], 'race day carries no km-of-the-week figure (card, coach lines, opener): "Race done - 21.1 km", not "28 of ~14 km running this week"', (snaps, name) => {
  const out: Violation[] = [];
  let days = 0;
  for (const snap of snaps) {
    if (!isRaceDay(snap)) continue;
    days++;
    const d = snap.card?.distance;
    if (d?.thisWeekKm != null) out.push({ snap, detail: `distance.thisWeekKm ${d.thisWeekKm} is set on race day: "${visible(d.text)}"` });
    const texts = [...cardTexts(snap), ...coachTexts(snap).filter(t => !/^- (?:Goal|Long run)\b/.test(t.text))];
    for (const t of texts) if (WEEK_KM_FIGURE.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    if (snap.card?.race?.completed != null && !/^Race done — [\d.]+\s?(?:km|mi)$/.test(plain(d?.text ?? ''))) out.push({ snap, detail: `distance.text "${visible(d?.text ?? '')}" is not "Race done — N km" once the race is logged` });
  }
  assert.ok(days > 0, `${name}: no race day was stepped, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.5: the cap note and the watch note are said once, in the right weeks ─────────────────

const SHARE_NOTE = /was \d+% of your week/;
const CAP_RAISE_NOTE = /raise the goal to ~/;

invariant(RUNNERS, 'the "N km was 60% of your week" watch note is said once per week (the Monday it applies), not on every day', (snaps, name) => {
  const out: Violation[] = [];
  const byWeek = new Map<string, DaySnapshot[]>();
  let notes = 0;
  for (const snap of snaps) {
    if (!cardTexts(snap).some(t => t.where.startsWith('card.reasons') && SHARE_NOTE.test(plain(t.text)))) continue;
    notes++;
    const monday = mondayOfDate(snap.date);
    byWeek.set(monday, [...(byWeek.get(monday) ?? []), snap]);
  }
  for (const [monday, days] of byWeek) {
    if (days.length > 1 || days.some(s => weekdayOf(s.date) !== 'Mon')) {
      out.push({ snap: days[0], detail: `the watch note was shown on ${days.length} day(s) of the week of ${monday} (${days.map(s => weekdayOf(s.date)).join(', ')}): "${visible(days[0].card?.reasons.find(r => SHARE_NOTE.test(plain(r.text)))?.text ?? '')}"` });
    }
  }
  if (name === 'runner_on_plan') assert.ok(notes > 0, `${name}: the watch note never appeared, so this invariant checked nothing`);
  return out;
});

invariant(RUNNERS, 'the "raise the goal to ~36 km" cap note is never shown in a light, restart, comeback or rebuild week, nor when the raised goal cannot be reached by +10% a week before the taper', (snaps, name) => {
  const scn = buildScenario(name);
  const out: Violation[] = [];
  let shown = 0;
  for (const snap of snaps) {
    const hit = [...cardTexts(snap), ...coachTexts(snap)].filter(t => CAP_RAISE_NOTE.test(plain(t.text)));
    if (hit.length === 0) continue;
    shown++;
    const plan = snap.card?.distance?.plan;
    const why: string[] = [];
    if (plan?.lightWeek) why.push('light week');
    if (plan?.kind === 'restart' || plan?.kind === 'rebuild') why.push(`${plan.kind} week`);
    if (plan?.comebackKm != null && plan.kind === 'build') why.push('comeback week');
    // Reachable: last week's km grown 10% a week for the build weeks left before the taper must reach the raised goal (twice the peak long run).
    const d = snap.card?.distance;
    const raceDate = scn.user.raceDate;
    if (d && raceDate) {
      const taperStart = addDays(raceDate, -(scn.user.raceDistanceKm != null && scn.user.raceDistanceKm <= 21.15 ? 14 : 21));
      const stepsLeft = Math.max(0, Math.ceil(dayDiff(taperStart, d.weekStart) / 7));
      const lastKm = snaps.find(s => s.date === addDays(d.weekStart, -1))?.card?.distance?.thisWeekKm ?? null;
      const raised = (snap.card?.longRun?.raceTargetKm ?? 18) * 2;
      if (lastKm != null && lastKm * 1.1 ** stepsLeft < raised - 0.5) why.push(`${lastKm} km grown 10% for ${stepsLeft} weeks (${Math.round(lastKm * 1.1 ** stepsLeft)} km) cannot reach the raised ${raised} km goal`);
    }
    for (const w of why) out.push({ snap, detail: `${hit[0].where}: "${visible(hit[0].text)}" in a ${w}` });
  }
  assert.ok(shown > 0 || name === 'runner_no_race' || name === 'runner_comeback_spike' || name === 'runner_comeback_obedient' || name === 'runner_on_plan_imperial', `${name}: the cap note never appeared, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.6: a warning before the spike ─────────────────────────────

const isWindDownPhaseName = (phase: string | undefined): boolean => phase === 'taper' || phase === 'race_week' || phase === 'recovery';

// Wave 23e / P1-1 (replaces the wave-22e "from 70% say keep the rest to one short easy run" rule, which fired on a flat 70% of the target, ignored the
// long run still to come and gave no number - "17 of up to ~18 km - keep the rest to one short easy run" next to "Up to ~18 km this week: long run 9 km").
// The remaining-km line now fires only when the week so far plus the planned long run still to come is over 110% of the week's number, says ONE number
// ("14 of ~20 km - keep Sunday's long run to ~6 km", or "this week's km are done; skip the long run" under 3 km / 2 mi left), and the plan line, the
// coach and the next long run carry the SAME number.
invariant(RUNNERS, 'the remaining-km line says a number (never "keep the rest to one short easy run"), fires only when done + the unrun long run is over 110% of the target, and the plan line / coach / next long run say the same number', (snaps, name) => {
  const out: Violation[] = [];
  let trimmed = 0;
  for (const snap of snaps) {
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      if (/keep the rest to one short easy run/.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" has no number` });
    }
    const d = snap.card?.distance;
    const plan = d?.plan;
    if (!plan?.longRunTrim) continue;
    trimmed++;
    const trim = plan.longRunTrim;
    // The line that carries the number: the remaining-km reason, or the taper's own "keep Sunday's run <= N" (same number), or - when a spike headline owns
    // the card - the plan line itself.
    const lines = (snap.card?.reasons ?? []).filter(r => ['volume', 'race_phase', 'plan'].includes(r.kind)).map(r => plain(r.text));
    const spikeHeadline = /^(?:Over the safe step|Well over the ceiling)/.test(plain(snap.card?.headline ?? ''));
    const unit = /\bmi\b/.test(plain(d?.text ?? '')) ? 'mi' : 'km';
    if (trim.weekDone) {
      if (plan.longRunKm != null) out.push({ snap, detail: `week done, but the plan still plans a ${plan.longRunKm} km long run: "${visible(plan.purpose)}"` });
      if (!lines.some(l => /km are done|done — no long run/.test(l))) out.push({ snap, detail: `week done, but no card line says so: ${lines.map(visible).join(' | ')}` });
      if (snap.coach && !snap.coach.some(l => /km are done/.test(plain(l)))) out.push({ snap, detail: "week done, but the coach never says the week's km are done" });
    } else {
      if (plan.longRunKm == null) { out.push({ snap, detail: 'a trimmed long run with no long run in the plan' }); continue; }
      const planned = inDisplayUnit(plan.longRunKm, unit);
      // Every "keep Sunday's long run to ~N" / "keep Sunday's run <= N" on the card is the plan's number (within the half-unit rounding).
      const said = lines.flatMap(l => [...l.matchAll(/(?:long(?:est)? run to ~|keep Sunday['’]s run ≤ )(\d+(?:\.\d+)?)/g)].map(m => Number(m[1])));
      if (said.length === 0 && !spikeHeadline && !isWindDownPhaseName(snap.card?.race?.phase)) out.push({ snap, detail: `longRunTrim ${JSON.stringify(trim)} with no remaining-km line: ${lines.map(visible).join(' | ')}` });
      for (const n of said) if (Math.abs(n - planned) > 0.5 + 1e-9) out.push({ snap, detail: `remaining-km line says ${n} ${unit} vs the plan's long run ${planned} ${unit}: "${visible(plan.purpose)}"` });
      if (snap.card?.longRun && snap.card.longRun.nextKm != null && Math.abs(snap.card.longRun.nextKm - plan.longRunKm) > 1e-9) out.push({ snap, detail: `coach next long run ${snap.card.longRun.nextKm} km vs plan ${plan.longRunKm} km` });
    }
  }
  // The rule fires on these days in the runners that over- or under-ran the plan's week.
  if (name === 'runner_messy' || name === 'runner_on_plan' || name === 'runner_comeback_spike') assert.ok(trimmed > 0, `${name}: the long run was never trimmed, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.7: "peak reached" is not praise for a long run that broke the plan ─────────────────

// "Long run peak 15 km — on target", "On track for the half — long run peak 15 km reached", "Peak long run 18 km — done": the card praises the peak.
const PEAK_PRAISE = /long run peak [\d.]+\s?(?:km|mi)\b(?: — on target| reached)|\bpeak long run [\d.]+\s?(?:km|mi) — done/i;

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_imperial', 'runner_on_plan_obedient', 'runner_messy'], 'a peak long run is praised ("peak reached", "on target", "Peak long run - done") only when it was at most the plan + 0.5 km and at most half of its week', (snaps, name) => {
  const runKm = scenarioRunKm(name);
  const scn = buildScenario(name);
  const byDate = new Map(snaps.map(s => [s.date, s]));
  const out: Violation[] = [];
  let praised = 0;
  for (const snap of snaps) {
    const praise = [...cardTexts(snap)].find(t => PEAK_PRAISE.test(plain(t.text)));
    if (!praise) continue;
    praised++;
    // The 28-day peak run: the longest run strictly inside the last 28 days (the race itself excluded), the latest on a tie.
    let peakDay: string | null = null;
    let peakKm = 0;
    for (let i = 0; i < 28; i++) {
      const day = addDays(snap.date, -i);
      const km = runKm.get(day) ?? 0;
      if (km > peakKm + 1e-9 || (km === peakKm && km > 0 && peakDay == null)) { peakKm = km; peakDay = day; }
    }
    if (peakDay == null) continue;
    const monday = mondayOfDate(peakDay);
    const planKm = byDate.get(addDays(monday, 6))?.card?.distance?.plan?.longRunKm ?? byDate.get(monday)?.card?.distance?.plan?.longRunKm ?? null;
    const stepTarget = byDate.get(monday)?.card?.distance?.stepTargetKm ?? 0;
    const weekKm = Math.max(kmThrough(runKm, monday, addDays(monday, 6)), addDays(monday, 6) > snap.date ? stepTarget : 0);
    const tol = 0.5;
    if (planKm != null && peakKm > planKm + tol + 1e-9) out.push({ snap, detail: `${praise.where}: "${visible(praise.text)}" but the ${Math.round(peakKm * 10) / 10} km peak run (${peakDay}) was longer than that week's planned ${planKm} km` });
    else if (peakKm > weekKm * 0.5 + 1e-9) out.push({ snap, detail: `${praise.where}: "${visible(praise.text)}" but the ${Math.round(peakKm * 10) / 10} km peak run (${peakDay}) was ${Math.round((peakKm / weekKm) * 100)}% of its ${Math.round(weekKm * 10) / 10} km week` });
  }
  // (Wave 23e: the static on-plan runners add 1 km of long run a week from 6 km; with the owed cutback back in the cycle their long runs always outrun the plan's
  // held / +2 km long run, so their peak is - correctly - never praised. The obedient runner and the messy one still prove the praise exists.)
  assert.ok(praised > 0 || scn.user.raceDate == null || name === 'runner_on_plan_imperial' || name === 'runner_on_plan' || name === 'runner_on_plan_half', `${name}: the peak was never praised, so this invariant checked nothing`);
  return out;
});

// ── wave 22e / P2.8: an imperial runner never reads a kilometre, nor two numbers for one thing ───────────

invariant(['runner_on_plan_imperial'], 'no card, coach line, opener or review string says "km" to an imperial runner', (snaps, name) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    for (const t of [...cardTexts(snap), ...coachTexts(snap), ...reviewTexts(snap)]) {
      // The standing goal line of the coach is metric-free too ("Goal: endurance; 18.6 mi/week"), so there is no exemption.
      if (/\bkm\b/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
  }
  assert.ok(snaps.length > 0, `${name}: nothing stepped`);
  return out;
});

// "11.2 mi was 60% of your week - keep long runs ~9 mi on 18.6 mi weeks, or add easy miles": the weeks it names are the GOAL's (the number
// every other line says), and the long run it keeps is at most half of them (the plan's peak target at that goal).
const SHARE_NOTE_NUMBERS = /keep long runs ~(\d+(?:\.\d+)?)\s?(km|mi) on (\d+(?:\.\d+)?)\s?(?:km|mi) weeks/;

invariant(RUNNERS, 'the long-run watch note names the goal\'s own weekly distance and a long run of at most half of it', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const d = snap.card?.distance;
    if (!d) continue;
    for (const t of cardTexts(snap)) {
      const m = SHARE_NOTE_NUMBERS.exec(plain(t.text));
      if (!m) continue;
      const goal = inDisplayUnit(d.targetKm, m[2]);
      if (Math.abs(Number(m[3]) - goal) > 0.05 + 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" names ${m[3]} ${m[2]} weeks, the goal is ${goal} ${m[2]}` });
      if (Number(m[1]) > goal / 2 + 1e-9) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" keeps long runs at ~${m[1]} ${m[2]}, over half of the ${goal} ${m[2]} goal` });
      if (m[2] === 'mi' && /add easy km/.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" says km to a runner in miles` });
    }
  }
  return out;
});

// ── wave 22e / P2.9: the last day of a week judges THIS week ────────────────

invariant(RUNNERS, 'on the Sunday of a build, hold or maintain week the card headline judges this week (its km), not "N km last week"', (snaps, name) => {
  const out: Violation[] = [];
  let sundays = 0;
  for (const snap of snaps) {
    const d = snap.card?.distance;
    if (weekdayOf(snap.date) !== 'Sun' || !d?.plan || d.thisWeekKm == null || d.thisWeekKm <= 0) continue;
    if (d.plan.kind !== 'build' && d.plan.kind !== 'maintain' && d.plan.kind !== 'hold') continue;
    if (d.plan.lightWeek || d.plan.easingOff || /^Over the safe step —|^Well over the ceiling —|^Light week|^Eased off|^On a break/.test(plain(snap.card?.headline ?? ''))) continue;
    sundays++;
    const unit = /\bmi\b/.test(plain(d.text)) ? 'mi' : 'km';
    const done = inDisplayUnit(d.thisWeekKm, unit);
    const headline = plain(snap.card?.headline ?? '');
    if (/\blast week\b/.test(headline)) out.push({ snap, detail: `headline "${visible(snap.card?.headline ?? '')}" is about last week on the last day of a week that ran ${done} ${unit}` });
    else if (d.plan.kind !== 'maintain' && !new RegExp(`(?:^|[^\\d.])${String(done).replace('.', '\\.')}(?:\\s?${unit})?(?:\\s|,|;|$)`).test(headline)) out.push({ snap, detail: `headline "${visible(snap.card?.headline ?? '')}" does not carry this week's ${done} ${unit}` });
  }
  assert.ok(sundays > 0 || name === 'runner_on_plan_imperial', `${name}: no build or maintain Sunday was stepped, so this invariant checked nothing`);
  return out;
});

// ═══ wave 22e / P3: small copy honesty ═══════════════════════════════════════

invariant(RUNNERS, 'day 0 (nothing run yet) reads "baseline week", not "0 of 30 km running this week"', (snaps, name) => {
  const day0 = snaps.find(s => s.idx === 0);
  if (!day0) return []; // the imperial scenario only steps the days around phase changes
  const text = plain(day0.card?.distance?.text ?? '');
  assert.ok(text !== '', `${name}: day 0 has no distance line`);
  return /baseline week/.test(text) ? [] : [{ snap: day0, detail: `distance.text "${visible(day0.card?.distance?.text ?? '')}"` }];
});

invariant(RUNNERS, 'every "On a break" card says what to do if the break was an illness', (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    if (!/^On a break/.test(plain(snap.card?.headline ?? ''))) continue;
    if (!cardTexts(snap).some(t => /if you were ill, wait until you've been symptom-free for 24–48 h/i.test(plain(t.text)))) out.push({ snap, detail: `"${visible(snap.card?.headline ?? '')}" has no illness guard` });
  }
  return out;
});

invariant(RUNNERS, 'a rebuild week names its long run on the card (the coach and the review already do)', (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const plan = snap.card?.distance?.plan;
    if (plan?.kind !== 'rebuild' || plan.longRunKm == null) continue;
    if (!/long(?:est)? run/i.test(plain(plan.purpose))) out.push({ snap, detail: `rebuild purpose "${visible(plan.purpose)}" with a ${plan.longRunKm} km long run planned` });
  }
  return out;
});

invariant(RUNNERS, 'the sessions line never reads "0–4 runs a week" - after a break it is "N runs a week before your break"', (snaps) =>
  textMatches(snaps, cardTexts, /^0(?:–| or )\d+ runs? a week/));

invariant(RUNNERS, 'race week never says "keep the days before the race ≤ N km" next to "rest 1-2 days": it says to rest tomorrow and shake out the day before', (snaps) =>
  textMatches(snaps, s => [...cardTexts(s), ...coachTexts(s)], /keep the days before the race ≤/));

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_obedient', 'runner_messy'], "recovery week 1's Volume stat says the week before it held the race (\"excl. the race\"), not \"same as last week\"", (snaps, name) => {
  const scn = buildScenario(name);
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const rv = snap.review;
    if (!rv || scn.user.raceDate == null || rv.weekStart !== addDays(scn.user.raceDate, 1)) continue;
    checked++;
    const volume = rv.review.stats.find(st => st.label === 'Volume');
    if (volume && !/race/i.test(plain(volume.comparison ?? ''))) out.push({ snap, detail: `Volume "${visible(volume.value)}" — "${visible(volume.comparison ?? '')}"` });
  }
  assert.ok(checked > 0, `${name}: no recovery-week-1 review was stepped, so this invariant checked nothing`);
  return out;
});

invariant(RUNNERS, 'the coach never says a long run is "held" when it is lower than the last one (it "eased to ... (half the week)")', (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const last = snap.card?.longRun?.lastKm;
    if (last == null) continue;
    for (const t of coachTexts(snap)) {
      const m = /long run (\d+(?:\.\d+)?) (?:km|mi) held/.exec(plain(t.text));
      if (m && inDisplayUnit(last, /\bmi\b/.test(plain(snap.card?.distance?.text ?? '')) ? 'mi' : 'km') - Number(m[1]) > 0.55) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" but the last long run was ${last} km` });
    }
  }
  return out;
});

// ═══ wave 22e follow-up: no two lines of one day disagree ═════════════════════════════════════════════

// 1. Whether this week's target still applies is ONE answer on a day: the headline, the plan line and the coach's target line all say the target is
//    waived ("Eased off early", "Easing off", "Light week", "no need to make up") or none of them does.
const TARGET_WAIVED = /eased off early|easing off|taper starts tomorrow|race week starts tomorrow|light week|don't make it up|no need to make up/i;

invariant(RUNNERS, "the card headline, the plan line and the coach's target line agree on whether this week's target still applies", (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const card = snap.card;
    if (!card?.distance?.plan) continue;
    const coachLine = (snap.coach ?? []).find(l => l.startsWith("- This week's target"));
    const reads = [
      { where: 'headline', text: card.headline },
      { where: 'plan purpose', text: card.distance.plan.purpose },
      ...(coachLine ? [{ where: 'coach target line', text: coachLine }] : []),
    ].map(r => ({ ...r, waived: TARGET_WAIVED.test(plain(r.text)) }));
    if (reads.some(r => r.waived) && reads.some(r => !r.waived)) {
      out.push({ snap, detail: reads.map(r => `${r.where} (${r.waived ? 'waived' : 'applies'}): "${visible(r.text)}"`).join(' | ') });
    }
  }
  return out;
});

// 3. On a break the week's own target is not quoted (it is stale): the distance line says so, and the restart number is the one number.
invariant(RUNNERS, 'on a break no "N of ~M km" week figure is quoted, and the coach restarts at the headline\'s number', (snaps, name) => {
  const out: Violation[] = [];
  let days = 0;
  for (const snap of snaps) {
    if (!/^On a break/.test(plain(snap.card?.headline ?? ''))) continue;
    days++;
    const headlineRestart = RESTART_NUMBER.exec(plain(snap.card?.headline ?? ''));
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      const of = /\d(?:\.\d+)?(?:\s?(?:km|mi))? of (?:up to )?~\d/.exec(plain(t.text));
      if (of) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" quotes the stale week target on a break` });
      const coachRestart = /^- This week's target: restart at ~(\d+(?:\.\d+)?)/.exec(plain(t.text));
      if (coachRestart && headlineRestart && Number(coachRestart[1]) !== Number(headlineRestart[1])) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" restarts at a different number than the headline "${visible(snap.card?.headline ?? '')}"` });
    }
  }
  if (name === 'runner_no_race' || name === 'runner_messy') assert.ok(days > 0, `${name}: no break day was stepped, so this invariant checked nothing`);
  return out;
});

// 4. The sessions line: a range whose low end is at most half its high end is a break in the window, said as "N runs a week before your break".
invariant(RUNNERS, 'the sessions line never reads a range like "1–4 runs a week" (a break inside the window)', (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    for (const t of cardTexts(snap)) {
      const m = /^(\d+)(?:–| or )(\d+) runs? a week/.exec(plain(t.text));
      if (m && Number(m[1]) * 2 <= Number(m[2])) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
  }
  return out;
});

// 5. A planned cutback is not a drop: the card and the review say "as planned" next to the negative change.
invariant(RUNNERS, 'a cutback week\'s negative change is said "as planned" on the card and in the review (never a bare "−13%")', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  const byDate = new Map(snaps.map(s => [s.date, s]));
  for (const snap of snaps) {
    if (/your cutback week/.test(plain(snap.card?.headline ?? '')) && /[−-]\d+%/.test(plain(snap.card?.headline ?? ''))) {
      seen++;
      if (!/as planned/.test(plain(snap.card?.headline ?? ''))) out.push({ snap, detail: `card headline "${visible(snap.card?.headline ?? '')}"` });
    }
  }
  for (const w of cutbackWeeks(snaps)) {
    const review = byDate.get(addDays(w.monday, 7));
    const rv = review?.review?.weekStart === w.monday ? review.review.review : null;
    if (!review || !rv || w.ranKm > w.targetKm * 1.1) continue;
    const volume = rv.stats.find(st => st.label === 'Volume');
    if (volume && /[−-]\d+%/.test(plain(volume.comparison ?? ''))) {
      seen++;
      if (!/as planned \(cutback\)/.test(plain(volume.comparison ?? ''))) out.push({ snap: review, detail: `Volume "${visible(volume.value)}" — "${visible(volume.comparison ?? '')}"` });
      if (volume.tone === 'watch') out.push({ snap: review, detail: `Volume tone ${volume.tone} for a planned cutback` });
      if (/[−-]\d+%/.test(plain(rv.headline)) && !/as planned/.test(plain(rv.headline))) out.push({ snap: review, detail: `review headline "${visible(rv.headline)}"` });
    }
  }
  if (name === 'runner_on_plan_obedient') assert.ok(seen > 0, `${name}: no cutback week showed a negative change, so this invariant checked nothing`);
  return out;
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// wave 23s: strength round 5 (strength coach + 3 lifter personas). Every invariant here was written BEFORE the rule it locks in.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

// G-S. lifter_obedient does exactly what the app says (the prescribed loads, 4 sessions a week) except for ONE ill week (week 7, only
// Thursday). Outside that week - its cards, and the review that rates it - she is never criticised: no amber line on the card, no
// "behind"/"stalled" verdict, no review slip, no amber review stat, no "mixed"/"tough" week.
const OBEDIENT_ILL_START = addDays('2026-03-02', (OBEDIENT_SHORT_WEEK - 1) * 7);
const OBEDIENT_ILL_END = addDays(OBEDIENT_ILL_START, 6);

invariant(['lifter_obedient'], 'an obedient lifter is never criticised outside her one ill week (no amber line, no slip, no behind / stalled / tough)', (snaps, name) => {
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const inIllWeek = snap.date >= OBEDIENT_ILL_START && snap.date <= OBEDIENT_ILL_END;
    if (!inIllWeek && snap.card) {
      checked++;
      for (const r of snap.card.reasons) if (r.tone === 'watch') out.push({ snap, detail: `card.reasons (${r.kind}) is amber: "${visible(r.text)}"` });
      if (snap.card.verdict === 'behind' || snap.card.verdict === 'stalled' || snap.card.verdict === 'too_fast') out.push({ snap, detail: `card verdict ${snap.card.verdict}: "${visible(snap.card.headline)}"` });
    }
    const r = snap.review?.review;
    if (r && r.weekStart !== OBEDIENT_ILL_START) {
      if (r.slip != null) out.push({ snap, detail: `review.slip: "${visible(r.slip)}"` });
      for (const st of r.stats) if (st.tone === 'watch') out.push({ snap, detail: `review stat ${st.label} is amber: ${st.value} ${st.comparison ?? ''}` });
      if (r.weekRating === 'tough' || r.weekRating === 'mixed') out.push({ snap, detail: `week rated ${r.weekRating}: "${visible(r.headline)}"` });
    }
  }
  assert.ok(checked > 0, `${name}: no card day was checked`);
  return out;
});

// G-S. Never two different loads for the same lift on one day: every "<lift> A → B kg", "<lift> ~X kg" or "<lift> X kg" in the day's texts
// (card, coach lines, opener, review) that names a load for a lift names the SAME load as the others of that lift that day.
const LOAD_MENTION = /\b(squat|bench(?: press)?|deadlift|overhead press)\s+(~?)(\d+(?:\.\d+)?)(?:\s?→\s?(\d+(?:\.\d+)?))?\s?(kg|lb)\b/gi;
const liftWord = (w: string): string => (/^bench/i.test(w) ? 'bench' : w.toLowerCase());

/** Every load a text names for a lift: the load to lift (the arrow's right side, else the single number). */
function loadMentions(text: string): Array<{ lift: string; load: number; unit: string; raw: string }> {
  return [...plain(text).matchAll(LOAD_MENTION)].map(m => ({ lift: liftWord(m[1]), load: Number(m[4] ?? m[3]), unit: m[5], raw: m[0] }));
}

invariant(LIFTERS, 'one load per lift per day: no two texts of the same day name different loads for the same lift', (snaps) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const byLift = new Map<string, Array<{ load: number; where: string; raw: string }>>();
    for (const t of allTexts(snap)) for (const m of loadMentions(t.text)) byLift.set(m.lift, [...(byLift.get(m.lift) ?? []), { load: m.load, where: t.where, raw: m.raw }]);
    for (const [lift, ms] of byLift) {
      if (new Set(ms.map(m => m.load)).size > 1) out.push({ snap, detail: `${lift}: ${ms.map(m => `"${m.raw}" (${m.where})`).join(' vs ')}` });
    }
  }
  return out;
});

// G-S. The loop closes for an obedient lifter: the load a review prescribes for a lift IS what she lifts the week after (her top working
// set of that lift), and the next review starts its step from that load, on the grid and without a "~". Counted from the scenario's rows.
invariant(['lifter_obedient'], 'the loads a review prescribes are the loads she then lifts, and the next review steps from them (no "~", exactly one step)', (snaps, name) => {
  const scn = buildScenario(name);
  const exerciseOf: Record<string, string> = { squat: 'squat', bench: 'bench press', deadlift: 'deadlift' };
  const top = (exercise: string, from: string): number | null => {
    const loads = scn.sets.filter(s => s.exercise === exercise && !s.isWarmup && s.day >= from && s.day <= addDays(from, 6) && s.loadKg != null).map(s => s.loadKg as number);
    return loads.length > 0 ? Math.max(...loads) : null;
  };
  const out: Violation[] = [];
  let pairs = 0;
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r) continue;
    const nextMonday = addDays(r.weekStart, 7);
    // The ill week is the one week she is not following the prescription (its loads are a single volume session), on either side of it.
    if (nextMonday === OBEDIENT_ILL_START || r.weekStart === OBEDIENT_ILL_START) continue;
    for (const m of plain(r.nextWeek).matchAll(/\b(squat|bench|deadlift)\s+(~?)(\d+(?:\.\d+)?)(?:\s?→\s?(\d+(?:\.\d+)?))?\s?kg\b/gi)) {
      const exercise = exerciseOf[liftWord(m[1])];
      const prescribed = Number(m[4] ?? m[3]);
      const lifted = top(exercise, nextMonday);
      if (lifted == null) continue;
      pairs++;
      if (lifted !== prescribed) out.push({ snap, detail: `review.nextWeek "${visible(r.nextWeek)}" prescribes ${liftWord(m[1])} ${prescribed} kg, she lifted ${lifted} kg in the week of ${nextMonday}` });
      if (m[4] != null) {
        const was = top(exercise, r.weekStart);
        if (m[2] === '~' || was !== Number(m[3]) || Math.abs(Number(m[4]) - Number(m[3]) - 2.5) > 1e-9) out.push({ snap, detail: `review.nextWeek "${visible(r.nextWeek)}": ${m[0]} should step one grid step from the ${was} kg she lifted that week, without a "~"` });
      }
    }
  }
  assert.ok(pairs > 8, `${name}: only ${pairs} prescribed loads were compared, so this invariant checked (almost) nothing`);
  return out;
});

// ── Main item: the slack-week rule on every surface. A muscle week with 0 < sessions <= half the target that can no longer reach its target
// (the card's Thu-Sun) shows no green lift or weight line unless that lift was trained at working weight that week (a top set at 90% or more
// of its best in the 4 weeks before); the card's headline leads with the week; the review's headline names it, its weight stat is neutral and
// its win is the session she did. Counted from the scenario's own rows, so a card that miscounts cannot excuse itself.
const SESSIONS_RE_WEEK = /^Week short — \d+ of \d+ so far$/;

interface SlackDay { done: number; target: number; monday: string }

function slackCardDay(name: ScenarioName, date: string): SlackDay | null {
  const scn = buildScenario(name);
  const target = scn.user.weeklySessions;
  if (target == null) return null;
  const monday = mondayOfDate(date);
  const trained = new Set(scn.sets.filter(x => !x.isWarmup).map(x => x.day));
  const done = [...trained].filter(d => d >= monday && d <= date).length;
  const daysLeft = 7 - dayDiff(date, monday);
  return done > 0 && done * 2 <= target && !weekFitsSessionTarget(done, target, daysLeft, trained.has(date)) ? { done, target, monday } : null;
}

/** True when `exercise` had a top set in [from, to] at 90% or more of its best top set in the 4 weeks before `from` (or none before). */
function trainedAtWorkingWeight(name: ScenarioName, exercise: string, from: string, to: string): boolean {
  const scn = buildScenario(name);
  const top = (a: string, b: string): number | null => {
    const loads = scn.sets.filter(s => s.exercise === exercise && !s.isWarmup && s.day >= a && s.day <= b && s.loadKg != null && s.loadKg > 0).map(s => s.loadKg as number);
    return loads.length > 0 ? Math.max(...loads) : null;
  };
  const now = top(from, to);
  const best = top(addDays(from, -28), addDays(from, -1));
  return now != null && (best == null || now >= best * 0.9 - 1e-9);
}

/** The exercise key a lift line or stat label names ("Squat est. 1RM …", "This week: Bench Press est. 1RM …"), or null. */
function exerciseNamed(name: ScenarioName, text: string): string | null {
  const scn = buildScenario(name);
  const hit = [...new Map(scn.sets.map(s => [s.display, s.exercise])).entries()].find(([display]) => plain(text).toLowerCase().includes(`${display.toLowerCase()} est. 1rm`));
  return hit ? hit[1] : null;
}

invariant(LIFTERS, 'in a slack week (at most half the sessions, week out of reach) the card leads with the week and shows no green lift or weight line for a lift not trained at working weight', (snaps, name) => {
  const out: Violation[] = [];
  let days = 0;
  for (const snap of snaps) {
    const card = snap.card;
    const slack = card ? slackCardDay(name, snap.date) : null;
    if (!card || !slack) continue;
    days++;
    const headline = plain(card.headline);
    if (card.liftReturn == null && !/^No sessions for/.test(headline) && card.verdict !== 'behind' && !SESSIONS_RE_WEEK.test(headline)) {
      out.push({ snap, detail: `${slack.done} of ${slack.target} sessions, week out of reach: headline "${visible(card.headline)}" should lead with the week ("Week short — ${slack.done} of ${slack.target} so far")` });
    }
    for (const r of card.reasons) {
      if (r.tone !== 'good') continue;
      if (r.kind === 'rate') out.push({ snap, detail: `green weight line in a slack week: "${visible(r.text)}"` });
      if (r.kind !== 'lift') continue;
      const exercise = exerciseNamed(name, r.text);
      if (exercise == null || !trainedAtWorkingWeight(name, exercise, slack.monday, snap.date)) out.push({ snap, detail: `green lift line in a slack week for a lift not trained at working weight this week: "${visible(r.text)}"` });
    }
  }
  if (name === 'lifter_short_week' || name === 'lifter_obedient') assert.ok(days >= 4, `${name}: only ${days} slack-week day(s) were stepped, so this invariant checked (almost) nothing`);
  return out;
});

invariant(LIFTERS, 'in a slack-week REVIEW the headline names the week, the weight stat is neutral, the win is the session she did and the push follows the headline', (snaps, name) => {
  const out: Violation[] = [];
  let checked = 0;
  for (const snap of snaps) {
    const rv = snap.review;
    const r = rv?.review;
    if (!rv || !r || r.weekGap?.kind !== 'sessions' || r.weekGap.done === 0 || r.weekGap.done * 2 > r.weekGap.target) continue;
    checked++;
    const weekEnd = addDays(r.weekStart, 6);
    const returning = rv.progress.liftReturn != null;
    for (const st of r.stats) {
      if (st.tone !== 'good') continue;
      const exercise = exerciseNamed(name, st.label);
      if (exercise == null && /weight/i.test(st.label)) out.push({ snap, detail: `green weight stat in a slack week: ${st.label} ${st.value} [good]` });
      else if (exercise != null && !trainedAtWorkingWeight(name, exercise, r.weekStart, weekEnd)) out.push({ snap, detail: `green lift stat in a slack week for a lift not trained at working weight: ${st.label} ${st.value}` });
    }
    if (r.win != null && /weight/i.test(plain(r.win))) out.push({ snap, detail: `review.win cites the scale in a slack week: "${visible(r.win)}"` });
    if (!returning && !/^\d+ of \d+ sessions last week — a short week$/.test(plain(r.headline)) && !r.stats.some(st => st.tone === 'good' && exerciseNamed(name, st.label) != null)) {
      out.push({ snap, detail: `review.headline "${visible(r.headline)}" should name the week ("${r.weekGap.done} of ${r.weekGap.target} sessions last week — a short week")` });
    }
    if (plain(rv.alert.body) !== plain(r.headline)) out.push({ snap, detail: `push body "${visible(rv.alert.body)}" does not follow the headline "${visible(r.headline)}"` });
  }
  if (name === 'lifter_short_week' || name === 'lifter_obedient') assert.ok(checked > 0, `${name}: no slack week was reviewed, so this invariant checked nothing`);
  return out;
});

// ── P3 copy. "(last: Apr 16)" on Apr 16 is "(last: today)" (and "yesterday" the day after); the rate is "about 0.4 lb/wk"; a rebuild's
// standing line is a lowercase list of est. 1RM shares, the same in kg and lb (no numbers on the line, so the % comes from kg); and
// when every lift is rebuilding the headline says which one is furthest behind.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDateOf = (day: string): string => `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

invariant(LIFTERS, 'a "(last: …)" never names today or yesterday by its date', (snaps, name) => {
  const out: Violation[] = [];
  let lasts = 0;
  for (const snap of snaps) {
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      const m = /\(last: ([A-Z][a-z]{2} \d{1,2})\)/.exec(plain(t.text));
      if (!m) continue;
      lasts++;
      if (m[1] === shortDateOf(snap.date)) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" should say "(last: today)"` });
      if (m[1] === shortDateOf(addDays(snap.date, -1))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" should say "(last: yesterday)"` });
    }
  }
  if (name === 'lifter_short_week') assert.ok(lasts > 0, `${name}: no "(last: …)" appeared, so this invariant checked nothing`);
  return out;
});

invariant(LIFTERS, 'a lean-gain weight rate is "about 0.4 kg/wk" (one decimal), not 0.37 lb/wk', snaps => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    for (const r of snap.card?.reasons ?? []) {
      if (r.kind !== 'rate') continue;
      const text = plain(r.text);
      if (/^Trend weight (?:up|down) /.test(text) && !/^Trend weight (?:up|down) about \d+(?:\.\d)? (?:kg|lb)\/wk/.test(text)) out.push({ snap, detail: `card.reasons (rate): "${visible(r.text)}"` });
    }
  }
  return out;
});

/** The lifts' standing line: lowercase short names, whole-kg percentages (unit-independent, the line shows no numbers). */
function standingLine(snap: DaySnapshot): string | null {
  const rets = snap.card?.liftReturns;
  if (!rets || rets.length < 2 || rets.some(r => r.regained)) return null;
  const others = rets.slice(1);
  const list = others.map(r => `${others.length > 1 ? liftShortName(r.exercise) : r.name} ${liftReturnDisplay(r, false).pct}%`).join(', ');
  return others.length > 1 ? `${list} of pre-break est. 1RM` : `${list} of its pre-break est. 1RM`;
}

invariant(LIFTERS, 'while every lift is rebuilding the standing line is "bench 95%, deadlift 94% of pre-break est. 1RM": lowercase, est. 1RM, the same % in kg and lb', (snaps, name) => {
  const out: Violation[] = [];
  let days = 0;
  for (const snap of snaps) {
    const want = standingLine(snap);
    if (want == null) continue;
    days++;
    const has = (snap.card?.reasons ?? []).some(r => plain(r.text) === want);
    if (!has) out.push({ snap, detail: `card.reasons has no "${want}": ${(snap.card?.reasons ?? []).map(r => `"${visible(r.text)}"`).join(' | ')}` });
  }
  if (name === 'lifter' || name === 'lifter_imperial') assert.ok(days > 0, `${name}: no all-rebuilding day with two or more lifts, so this invariant checked nothing`);
  return out;
});

test('lifter_imperial: a rebuild shows the same lift percentages as lifter on the same day (the line has no numbers, so they come from kg)', () => {
  const kg = runTimeline('lifter');
  const lb = runTimeline('lifter_imperial');
  let compared = 0;
  const bad: string[] = [];
  for (const [i, k] of kg.entries()) {
    const a = k.card?.reasons.find(r => / pre-break est\. 1RM$/.test(plain(r.text)))?.text;
    const b = lb[i].card?.reasons.find(r => / pre-break est\. 1RM$/.test(plain(r.text)))?.text;
    if (a == null && b == null) continue;
    compared++;
    if (a !== b) bad.push(`day ${i}: kg "${a}" vs lb "${b}"`);
  }
  assert.ok(compared > 0, 'no rebuild standing line was compared');
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} day(s) differ`);
});

invariant(LIFTERS, 'while every lift is rebuilding the card and review headlines say which lift is furthest behind when it is not the headline lift', (snaps, name) => {
  const out: Violation[] = [];
  let days = 0;
  const check = (snap: DaySnapshot, where: string, headline: string | undefined, rets: readonly GoalLiftReturn[] | null | undefined): void => {
    if (!rets || rets.length < 2 || rets.some(r => r.regained) || headline == null) return;
    const worst = rets.reduce((w, r) => (r.recentKg / r.preBreakKg < w.recentKg / w.preBreakKg - 1e-9 ? r : w), rets[0]);
    if (worst.exercise === rets[0].exercise) return;
    days++;
    if (!plain(headline).includes(`${liftShortName(worst.exercise)} furthest`)) out.push({ snap, detail: `${where} "${visible(headline)}" does not name ${worst.name} as furthest behind (${rets.map(r => `${r.name} ${liftReturnDisplay(r, false).pct}%`).join(', ')})` });
  };
  for (const snap of snaps) {
    check(snap, 'card.headline', snap.card?.headline, snap.card?.liftReturns);
    check(snap, 'review.headline', snap.review?.review.headline, snap.review?.progress.liftReturns);
  }
  if (name === 'lifter') assert.ok(days > 0, `${name}: no all-rebuilding day with the furthest lift behind the headline lift, so this invariant checked nothing`);
  return out;
});

// ── Imperial "~": a next-load cue says "~" exactly when its start is not the load she logged, and the start rounds DOWN to the grid, so the
// real step from her load is never more than 5 lb. lifter_imperial read "bench ~195 → 200" for a 193 lb bench (+7 from what she lifted).
// The logged load is one of that lift's weekly top sets (lb, to the whole pound) of the reviewed weeks.
invariant(['lifter_imperial'], 'every lb next-load cue starts at the grid below the load she logged, says "~" when it moved, and is at most 5 lb above what she lifted', (snaps, name) => {
  const scn = buildScenario(name);
  const exerciseOf: Record<string, string> = { squat: 'squat', bench: 'bench press', deadlift: 'deadlift' };
  const toLb = (kg: number): number => Math.round(kg * 2.20462);
  const out: Violation[] = [];
  let cues = 0;
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r) continue;
    for (const m of plain(r.nextWeek).matchAll(/\b(squat|bench|deadlift)\s+(~?)(\d+)\s?→\s?(\d+)\s?lb\b/gi)) {
      const exercise = exerciseOf[liftWord(m[1])];
      const tops = new Set<number>();
      for (let w = 0; w < 5; w++) {
        const from = addDays(r.weekStart, -7 * w);
        const loads = scn.sets.filter(x => x.exercise === exercise && !x.isWarmup && x.day >= from && x.day <= addDays(from, 6) && x.loadKg != null).map(x => toLb(x.loadKg as number));
        if (loads.length > 0) tops.add(Math.max(...loads));
      }
      const start = Number(m[3]);
      const to = Number(m[4]);
      cues++;
      const fits = [...tops].some(l => Math.floor(l / 5) * 5 === start && (l !== start) === (m[2] === '~') && to - l > 0 && to - l <= 5);
      if (!fits) out.push({ snap, detail: `review.nextWeek "${visible(r.nextWeek)}": ${m[0]} does not start at the grid below a logged load (${[...tops].join(', ')} lb), with "~" only when it moved, and at most 5 lb above it` });
    }
  }
  assert.ok(cues > 5, `${name}: only ${cues} lb next-load cues appeared, so this invariant checked (almost) nothing`);
  return out;
});

// ── Day 70: the Monday review said "2nd week off — book one easy session today at ~90% … (Squat ~102.5 kg)" on the Monday she had already
// squatted 110 kg. A review read on a day she has already lifted (the loader reads her sets relative to the real clock, and the review is
// recomputed when opened) never tells her to start today; after a week without a session it says she is already back, and names the session.
invariant(LIFTERS, 'a review read on a Monday she has already lifted does not say "today" (a week off: "You\'re already back — Monday\'s 110 kg squat was your first session; …")', (snaps, name) => {
  const scn = buildScenario(name);
  const trained = new Set(scn.sets.filter(x => !x.isWarmup).map(x => x.day));
  const out: Violation[] = [];
  let weeksOff = 0;
  for (const snap of snaps) {
    const r = snap.review?.review;
    if (!r || !trained.has(snap.date)) continue;
    if (/\btoday\b/i.test(plain(r.nextWeek))) out.push({ snap, detail: `she lifted on ${snap.date}, but review.nextWeek says "${visible(r.nextWeek)}"` });
    if (r.weekGap?.kind === 'sessions' && r.weekGap.done === 0) {
      weeksOff++;
      const imperial = scn.profile.units === 'imperial';
      const lifted = scn.sets.filter(x => !x.isWarmup && x.day === snap.date && x.loadKg != null).map(x => (imperial ? Math.round((x.loadKg as number) * 2.20462) : (x.loadKg as number)));
      const head = /^You're already back — Monday's (\d+(?:\.\d+)?)\s(?:kg|lb) \w+(?: and \d+(?:\.\d+)?\s(?:kg|lb) [\w ]+)? (?:was|were) your first session; /.exec(plain(r.nextWeek));
      if (!head) out.push({ snap, detail: `a week off, then a session on the review's Monday: review.nextWeek "${visible(r.nextWeek)}" should open "You're already back — Monday's … was your first session; …"` });
      else if (!lifted.includes(Number(head[1]))) out.push({ snap, detail: `review.nextWeek names ${head[1]} but she lifted ${lifted.join(', ')} that Monday` });
    }
  }
  if (name === 'lifter') assert.ok(weeksOff > 0, `${name}: no week off was followed by a session on the review's Monday, so this invariant checked nothing`);
  return out;
});

// ── The first time "est. 1RM" reaches a lifter it is explained, once: in the Next-week row of the first weekly review that shows an
// est. 1RM stat (iOS shows nextWeek verbatim, unlimited lines; the stat tile's comparison is capped at two lines and the card shows
// three reasons). Never on the card (that would repeat daily), never in a later review.
const EST_1RM_EXPLAINER = 'Est. 1RM = the most you could lift once, estimated from your sets and how hard they felt.';

invariant(LIFTERS, 'est. 1RM is explained once: in the first weekly review that shows an est. 1RM stat, never on the card and never again', (snaps, name) => {
  const out: Violation[] = [];
  const firstWithStat = snaps.find(s => s.review?.review.stats.some(st => st.label.endsWith('est. 1RM')));
  const holders: DaySnapshot[] = [];
  for (const snap of snaps) {
    for (const t of allTexts(snap)) {
      if (!/most you could lift once/.test(plain(t.text))) continue;
      if (!t.where.startsWith('review.')) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" explains est. 1RM outside the review` });
      else if (!holders.includes(snap)) holders.push(snap);
    }
  }
  assert.ok(firstWithStat, `${name}: no review showed an est. 1RM stat`);
  if (holders.length !== 1 || holders[0] !== firstWithStat) {
    out.push({ snap: firstWithStat, detail: `the explainer should be in the first review with an est. 1RM stat (${describeDay(firstWithStat)}) and nowhere else, found on: ${holders.map(describeDay).join(', ') || 'no day'}` });
  } else if (!plain(firstWithStat.review?.review.nextWeek ?? '').endsWith(EST_1RM_EXPLAINER)) {
    out.push({ snap: firstWithStat, detail: `review.nextWeek should end "${EST_1RM_EXPLAINER}": "${visible(firstWithStat.review?.review.nextWeek ?? '')}"` });
  }
  return out;
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// WAVE 23w - WEIGHT LOSS, ROUND 5 (4/4 -> 5). One block, at the END of the file, so merging the other waves' blocks stays trivial.
//   G-W   weight_loss_obedient: a user who does everything the card says is never contradicted on one card, and a stated kcal level
//         never moves without a sentence giving the reason.
//   P2-A  the maintenance loop: the step is given ONCE, stands as a level, is read 14+ days later from the weekly average; "held on ~X kcal"
//         names the target as soon as two held weeks exist; a user who logs no food gets the step as a food, never a kcal number.
//   P3    B coach "either side" claim · C one plateau cause figure · D stale card in the past tense · E the opener stays short ·
//         F rate precision, "N kg down", the congratulation once · G "weekly average has been flat" · H the carried-over items.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const W23_OBEDIENT: readonly ScenarioName[] = ['weight_loss_obedient'];
const W23_LOGGERS: readonly ScenarioName[] = ['weight_loss_logged', 'weight_loss_obedient'];

/** The full "add ~150-200 kcal a day" / "add a ~150-200 kcal snack" step sentence (not "add another ~150 kcal"). */
const W23_STEP_GIVEN = /\badd (?:a )?~[\d,]+(?:\s?[–-]\s?[\d,]+)?\s?kcal (?:a day|snack)/i;

/** Every user-visible string of a day: card, coach lines, opener, review. */
const w23Texts = (s: DaySnapshot): Text[] => allTexts(s);

/** Mondays of the weight scenarios (the day a plan week starts). */
const w23Mondays = (snaps: DaySnapshot[]): DaySnapshot[] => snaps.filter(s => s.weekday === 'Mon');

// ── G-W ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The obedient user eats what the card states. A stated level that moves between two plan weeks (2,150 -> 2,200 kcal, a maintenance target
// "named" twice with two different numbers) is a contradiction for her, whatever the logs say: it needs a sentence that replaces the old one.
const W23_LEVEL_REASON = /replaces|instead of|add another|back off|still (?:falling|dropping|drifting)|is rising|last week's trim|you'd need/i;

invariant(W23_OBEDIENT, 'G-W: a calorie level the plan stated never moves from one Monday to the next without a sentence giving the reason', (snaps, name) => {
  const out: Violation[] = [];
  let prev: { snap: DaySnapshot; kcal: number } | null = null;
  let compared = 0;
  for (const snap of w23Mondays(snaps)) {
    const plan = snap.card?.weightRead?.plan;
    const kcal = plan?.action.kcalTarget ?? null;
    if (prev != null && kcal != null && plan != null) {
      compared++;
      if (kcal !== prev.kcal && !W23_LEVEL_REASON.test(plain(plan.action.text))) {
        out.push({ snap, detail: `Mon ${prev.snap.date} stated ${prev.kcal} kcal, Mon ${snap.date} states ${kcal} kcal and gives no reason: "${visible(plan.action.text)}"` });
      }
    }
    prev = kcal != null ? { snap, kcal } : null;
  }
  assert.ok(compared > 0, `${name}: no two consecutive Mondays both stated a calorie level, so this invariant checked nothing`);
  return out;
});

// One card, one calorie story: the adherence line is judged against the level the plan asks for, not a budget the plan has just stepped past.
invariant(W23_OBEDIENT, 'G-W: the card never counts "within your 2,000 kcal target" next to a plan that states a different calorie level', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    const level = plan?.action.kcalTarget;
    const budget = snap.card?.weightRead?.intake?.targetKcal;
    const adherence = snap.card?.reasons.find(r => r.kind === 'calorie_adherence');
    if (plan == null || level == null || adherence == null || (plan.state !== 'maintenance' && plan.state !== 'reached' && !plan.nearlyThere)) continue;
    seen++;
    const m = /within your ([\d,]+)/.exec(plain(adherence.text));
    if (m != null && Number(m[1].replace(/,/g, '')) !== level && budget !== level) {
      out.push({ snap, detail: `adherence "${visible(adherence.text)}" vs the plan's level ${level} kcal: "${visible(plan.action.text)}"` });
    }
  }
  assert.ok(seen > 0, `${name}: no card had an adherence line next to a stated level, so this invariant checked nothing`);
  return out;
});

invariant(W23_OBEDIENT, 'G-W: the review never grades the week against a budget its own next-week level has moved past', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const rv = snap.review?.review;
    const plan = snap.card?.weightRead?.plan;
    if (rv == null || plan == null || plan.action.kcalTarget == null || (plan.state !== 'maintenance' && plan.state !== 'reached' && !plan.nearlyThere)) continue;
    seen++;
    const m = /\(([\d,]{4,}) kcal target\)/.exec(plain(`${rv.slip ?? ''} ${rv.headline}`));
    if (m != null && Number(m[1].replace(/,/g, '')) !== plan.action.kcalTarget) {
      out.push({ snap, detail: `review grades against ${m[1]} kcal: "${visible(rv.slip ?? '')}" while next week states ${plan.action.kcalTarget} kcal: "${visible(rv.nextWeek)}"` });
    }
  }
  assert.ok(seen > 0, `${name}: no review met a stated level, so this invariant checked nothing`);
  return out;
});

// ── P2-A ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

invariant(WEIGHT, 'P2-A: the maintenance step ("add ~150-200 kcal a day ... watch the weekly average") is given in ONE plan week, then it is a standing level', (snaps, name) => {
  const weeks = new Map<string, DaySnapshot>();
  for (const snap of snaps) {
    if (w23Texts(snap).some(t => W23_STEP_GIVEN.test(plain(t.text)))) {
      const monday = mondayOfDate(snap.date);
      if (!weeks.has(monday)) weeks.set(monday, snap);
    }
  }
  assert.ok(weeks.size > 0, `${name}: the step was never given, so this invariant checked nothing`);
  if (weeks.size <= 1) return [];
  return [...weeks.entries()].slice(1).map(([monday, snap]) => ({ snap, detail: `the step is given again in the week of ${monday} (first given in the week of ${[...weeks.keys()][0]})` }));
});

const W23_ADDS_CALORIES = /\badd (?:a |another )?~?[\d,]+/i;
const W23_ADD_EXPLAINED = /no longer need|still (?:falling|dropping)|is rising|another|back off|as you close in|you've held/i;

invariant(WEIGHT, 'P2-A: "Holding at ..." is never next to an instruction to add calories on the same card unless the instruction says why', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const reasons = snap.card?.reasons ?? [];
    const holding = reasons.find(r => r.kind === 'position' && /^Holding at/.test(plain(r.text)));
    if (holding == null) continue;
    seen++;
    for (const r of reasons) {
      if (r !== holding && r.kind !== 'position' && W23_ADDS_CALORIES.test(plain(r.text)) && !W23_ADD_EXPLAINED.test(plain(r.text))) {
        out.push({ snap, detail: `"${visible(holding.text)}" next to [${r.kind}] "${visible(r.text)}"` });
      }
    }
  }
  assert.ok(seen > 0, `${name}: no card said "Holding at", so this invariant checked nothing`);
  return out;
});

const W23_CONCLUDES = /your maintenance|add another|back off|keep your calorie target where it is|already at maintenance/i;

invariant(WEIGHT, 'P2-A: the step is read on the first Monday 14+ days after it was given, from the weekly average (keep it / add another / back off)', (snaps, name) => {
  const given = snaps.find(s => w23Texts(s).some(t => W23_STEP_GIVEN.test(plain(t.text))));
  assert.ok(given != null, `${name}: the step was never given, so this invariant checked nothing`);
  const read = w23Mondays(snaps).find(s => s.date >= addDays((given as DaySnapshot).date, 14));
  assert.ok(read != null, `${name}: the scenario ends before the step is read`);
  const texts = [...(read as DaySnapshot).card!.reasons.map(r => r.text), (read as DaySnapshot).review?.review.nextWeek ?? ''];
  return texts.some(t => W23_CONCLUDES.test(plain(t)))
    ? []
    : [{ snap: read as DaySnapshot, detail: `the step was given ${(given as DaySnapshot).date}; this Monday still says: ${texts.map(t => `"${visible(t)}"`).join(' | ')}` }];
});

// Two held weekly means (3+ weigh-ins each, within 1 kg of the target, within 0.5 kg of each other) and 8+ logged days in the 14 name the target.
invariant(W23_LOGGERS, 'P2-A: "You\'ve held about 84 kg on ~X kcal" names the maintenance target on the first Monday two held weeks exist (not 13 days after the reach)', (snaps, name) => {
  const scn = buildScenario(name);
  const target = scn.user.targetWeightKg as number;
  const out: Violation[] = [];
  let due = 0;
  for (const snap of w23Mondays(snaps)) {
    const plan = snap.card?.weightRead?.plan;
    if (plan == null || snap.card?.verdict !== 'reached' || plan.action.kind === 'next_target') continue;
    const asOf = addDays(snap.date, -1);
    const w2 = wlWeekMean(scn.weighIns, asOf);
    const w1 = wlWeekMean(scn.weighIns, addDays(asOf, -7));
    if (w1 == null || w2 == null || Math.abs(w2 - w1) > 0.5 || Math.abs(w1 - target) > 1 || Math.abs(w2 - target) > 1) continue;
    const logged = scn.intake.filter(i => i.day >= addDays(asOf, -13) && i.day <= asOf).length;
    if (logged < 8) continue;
    due++;
    const texts = [...(snap.card?.reasons ?? []).map(r => r.text), snap.review?.review.nextWeek ?? ''];
    // The first such Monday NAMES the target; the Mondays after it keep that level ("Stay at ~2,050 kcal - your maintenance").
    const re = due === 1 ? /you've held|keep your calorie target where it is|already at maintenance/i : /you've held|stay at ~[\d,]+\s?kcal — your maintenance|keep your calorie target where it is|already at maintenance/i;
    if (!texts.some(t => re.test(plain(t)))) {
      out.push({ snap, detail: `two held weeks (${w1.toFixed(1)}, ${w2.toFixed(1)} kg), ${logged} logged days of 14, but the card says: ${texts.map(t => `"${visible(t)}"`).join(' | ')}` });
    }
  }
  assert.ok(due > 0, `${name}: no Monday had two held weeks on logged intake, so this invariant checked nothing`);
  return out;
});

// No food log, no kcal target: the step is a food (a snack), and it is closed with "keep that snack".
const W23_KCAL_TARGET_NUMBER = /\d,\d{3}(?:\s?[–-]\s?\d,\d{3})?\s?kcal/;

invariant(['weight_loss'], 'P2-A: a user who logs no food gets the maintenance step as a food ("add a ~150-200 kcal snack"), never a kcal target number, and it closes with "keep that snack"', (snaps, name) => {
  const out: Violation[] = [];
  let snack = 0;
  let kept = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    if (plan == null || !(plan.state === 'reached' || plan.state === 'maintenance' || plan.nearlyThere)) continue;
    for (const t of w23Texts(snap)) {
      if (/snack/i.test(plain(t.text))) snack++;
      if (/keep that snack|keep the (?:daily )?snack/i.test(plain(t.text))) kept++;
      if (W23_KCAL_TARGET_NUMBER.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" states a kcal target number to a user who logs no food` });
    }
    if (plan.action.kcalTarget != null && plan.step != null) out.push({ snap, detail: `the step carries kcalTarget ${plan.action.kcalTarget} for a user who logs no food` });
  }
  assert.ok(snack > 0 && kept > 0, `${name}: no snack step / "keep that snack" appeared (snack ${snack}, kept ${kept}), so this invariant checked nothing`);
  return out;
});

// ── P3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// B: the coach's "(two weekly reads either side of the target date)" is true only when the two paces land on opposite sides of the date.
invariant(['weight_loss'], 'P3-B: the coach line says the two reads are "either side of the target date" only on a day they are (days 42-48 are not)', (snaps, name) => {
  const out: Violation[] = [];
  let ranges = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    const line = (snap.coach ?? []).find(l => /either side of the target date/.test(plain(l)));
    if (plan?.earlierPace != null) ranges++;
    if (line != null && plan?.earlierPaceStraddles !== true) out.push({ snap, detail: `"${visible(line.slice(0, 260))}" while both paces land on the same side (earlierPaceStraddles ${plan?.earlierPaceStraddles})` });
    if (plan?.earlierPace != null && plan.earlierPaceStraddles !== true && snap.idx >= 42 && snap.idx <= 48
      && !(snap.coach ?? []).some(l => /a week ago the pace was [\d.]+/.test(plain(l)))) {
      out.push({ snap, detail: 'the coach line does not say what the pace was a week ago' });
    }
  }
  assert.ok(ranges > 0, `${name}: no day showed a pace range, so this invariant checked nothing`);
  return out;
});

// C: one plateau cause, one figure. The flat fortnight names "weekends ~2,400"; the plateau a week later keeps that number.
invariant(['weight_loss_logged'], 'P3-C: a plateau cause named at the flat fortnight keeps its figure when the plateau is called (no ~2,400 then ~2,350)', (snaps, name) => {
  const out: Violation[] = [];
  let compared = 0;
  let prev: { snap: DaySnapshot; kcal: number; kind: string } | null = null;
  for (const snap of w23Mondays(snaps)) {
    const cause = snap.card?.weightRead?.plan?.plateauCause;
    const kcal = cause?.kind === 'weekends' ? cause.weekendAvgKcal : cause?.kind === 'intake' ? cause.avgKcal : null;
    if (prev != null && cause != null && kcal != null && cause.kind === prev.kind && dayDiff(snap.date, prev.snap.date) === 7) {
      compared++;
      if (Math.round(kcal / 50) !== Math.round(prev.kcal / 50)) out.push({ snap, detail: `Mon ${prev.snap.date} quoted ~${prev.kcal} kcal, Mon ${snap.date} quotes ~${kcal} kcal for the same ${cause.kind} cause` });
    }
    prev = cause != null && kcal != null ? { snap, kcal, kind: cause.kind } : null;
  }
  assert.ok(compared > 0, `${name}: no two consecutive Mondays named the same cause, so this invariant checked nothing`);
  return out;
});

// D: a card built on a stale read speaks in the past: "As of May 10: ...", neutral, and the coach is not told "the scale is moving again".
const W23_AS_OF = /^As of [A-Z][a-z]{2} \d{1,2}\b/;

invariant(WEIGHT, 'P3-D: while the newest weigh-in is a week old or more the card says "As of <date>: ..." in a neutral tone, and the coach gets no "moving again" rule', (snaps, name) => {
  const out: Violation[] = [];
  let stale = 0;
  for (const snap of snaps) {
    const plan = snap.card?.weightRead?.plan;
    if (plan?.staleSince == null || snap.card == null || snap.card.verdict === 'reached') continue;
    stale++;
    for (const r of snap.card.reasons) {
      if (r.kind === 'action' || r.kind === 'weigh_in_age' || r.kind === 'calorie_adherence' || r.kind === 'weekend_overeating') continue;
      if (!W23_AS_OF.test(plain(r.text)) || r.tone !== 'neutral') out.push({ snap, detail: `stale since ${plan.staleSince}: [${r.kind}/${r.tone}] "${visible(r.text)}"` });
    }
    if (!W23_AS_OF.test(plain(snap.card.headline))) out.push({ snap, detail: `stale since ${plan.staleSince}: headline "${visible(snap.card.headline)}"` });
    const rule = (snap.coach ?? []).find(l => /The scale is moving again after a plateau/.test(plain(l)));
    if (rule != null) out.push({ snap, detail: `the coach still gets "${visible(rule.slice(0, 120))}" next to the stale-weigh-in rule` });
  }
  if (name !== 'weight_loss_obedient' || stale > 0) assert.ok(stale > 0, `${name}: no stale day, so this invariant checked nothing`);
  return out;
});

// E: a reached opener after the question is one short clause, not "Target reached — add ~150-200 kcal a day (to ...) and watch ...; a drift of ...".
invariant(WEIGHT, 'P3-E: once the new-target question is over, the reached opener is one short sentence ("You\'re holding at 84 kg — stay around ~2,150-2,200 kcal this week and keep weighing in.")', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const line = plain(snap.opener?.required ?? '');
    if (snap.card?.verdict !== 'reached' || snap.card.weightRead?.plan?.action.kind === 'next_target' || line === '') continue;
    seen++;
    if (line.length > 125 || line.includes(';')) out.push({ snap, detail: `${line.length} characters: "${visible(line)}"` });
  }
  assert.ok(seen > 0, `${name}: no reached opener after the question, so this invariant checked nothing`);
  return out;
});

// F: precision. "about 0.6 kg a week" in the opener and the headline (the card's rate line keeps its decimals); "7.8 kg down", never "8 kg down" next to -7.8;
// the congratulation on the reach day and the following Monday only.
invariant(WEIGHT, 'P3-F: the headline and the opener say "about 0.6 kg a week" (one decimal), the same figure', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    for (const t of [{ where: 'card.headline', text: snap.card?.headline ?? '' }, { where: 'opener.required', text: snap.opener?.required ?? '' }]) {
      const m = /about ([\d.]+) (?:kg|lb) a week/.exec(plain(t.text));
      if (m == null) continue;
      seen++;
      if (!/^\d+(?:\.\d)?$/.test(m[1])) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
  }
  assert.ok(seen > 0, `${name}: no rate was quoted in a headline or opener, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'P3-F: the reach opener says how far down the weekly average is ("7.8 kg down"), the figure the card prints, not the size of the goal', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of snaps) {
    const m = /\(([\d.]+) kg down/.exec(plain(snap.opener?.required ?? ''));
    const change = snap.card?.current.changeKg;
    if (m == null || change == null) continue;
    seen++;
    if (Math.abs(Number(m[1]) + change) > 0.05) out.push({ snap, detail: `opener "${visible(snap.opener?.required ?? '')}" vs card changeKg ${change}` });
  }
  assert.ok(seen > 0, `${name}: no reach opener named an amount, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'P3-F: "Congratulations" is said on the reach day and on the following Monday, not every day of the question', (snaps, name) => {
  const out: Violation[] = [];
  let said = 0;
  for (const snap of snaps) {
    if (!/Congratulations/.test(plain(snap.opener?.required ?? ''))) continue;
    said++;
    const reachedAt = snap.card?.reachedAt;
    const ok = reachedAt != null && (snap.date === reachedAt || (snap.weekday === 'Mon' && dayDiff(snap.date, reachedAt) > 0 && dayDiff(snap.date, reachedAt) <= 6));
    if (!ok) out.push({ snap, detail: `reached ${reachedAt}: "${visible(snap.opener?.required ?? '')}"` });
  }
  assert.ok(said > 0, `${name}: the reach was never congratulated, so this invariant checked nothing`);
  return out;
});

// G: the scale can read 88.9 / 88.8 while "the scale has been flat for 3 weeks"; the plateau is a statement about the weekly average.
invariant(WEIGHT, 'P3-G: the opener says "your weekly average has been flat", not "the scale has been flat"', snaps =>
  textMatches(snaps, s => coachTexts(s), /the scale has been flat/i));

// H (carried over)
invariant(['weight_loss_logged'], 'P3-H: the "weekends average ..." watch is never a one-day flash', (snaps, name) => {
  const out: Violation[] = [];
  let runs = 0;
  let i = 0;
  const has = (s: DaySnapshot): boolean => (s.card?.reasons ?? []).some(r => r.kind === 'weekend_overeating');
  while (i < snaps.length) {
    if (!has(snaps[i])) { i++; continue; }
    let j = i;
    while (j + 1 < snaps.length && has(snaps[j + 1])) j++;
    runs++;
    if (j === i) out.push({ snap: snaps[i], detail: 'the weekend_overeating watch shows on this day only' });
    i = j + 1;
  }
  // The scenario's one flash (day 32: the weekend average tips over the threshold for a single day) must not show.
  const flash = snaps.find(s => s.idx === 32);
  assert.ok(flash != null && !has(flash), `${name}: the day-32 flash is shown (${runs} run(s) of the watch)`);
  return out;
});

invariant(['weight_loss'], 'P3-H: the welcome back that moves the progress weight from the old average to today\'s reading says so', (snaps, name) => {
  const out: Violation[] = [];
  let jumps = 0;
  snaps.forEach((snap, i) => {
    if (i === 0 || !/^Welcome back/.test(plain(snap.card?.headline ?? ''))) return;
    const before = snaps[i - 1].card?.current.changeKg;
    const now = snap.card?.current.changeKg;
    if (before == null || now == null || Math.abs(now - before) < 0.5) return;
    jumps++;
    const said = [...(snap.card?.reasons ?? []).map(r => r.text), snap.opener?.required ?? ''].some(t => /progress now counts from/i.test(plain(t)));
    if (!said) out.push({ snap, detail: `changeKg ${before} -> ${now}: "${visible(snap.card?.headline ?? '')}" / "${visible(snap.opener?.required ?? '')}"` });
  });
  assert.ok(jumps > 0, `${name}: no welcome back moved the progress weight, so this invariant checked nothing`);
  return out;
});

invariant(['weight_loss', 'weight_loss_logged'], 'P3-H: a review of a week with no weigh-ins says "No weigh-ins last week", not "Not enough data for a weekly review yet"', (snaps, name) => {
  const scn = buildScenario(name);
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of w23Mondays(snaps)) {
    const rv = snap.review;
    if (rv == null) continue;
    const week = scn.weighIns.filter(w => w.day >= rv.weekStart && w.day <= addDays(rv.weekStart, 6));
    if (week.length > 0) continue;
    seen++;
    if (!/^No weigh-ins last week/.test(plain(rv.review.headline)) || !/your plan picks up when you weigh in/i.test(plain(rv.review.headline + ' ' + rv.review.nextWeek))) {
      out.push({ snap, detail: `headline "${visible(rv.review.headline)}" / next "${visible(rv.review.nextWeek)}"` });
    }
  }
  assert.ok(seen > 0, `${name}: no review covered a week without weigh-ins, so this invariant checked nothing`);
  return out;
});

invariant(['weight_loss_logged'], 'P3-H: a tough plateau week\'s push leads with the plan, not with the stats', (snaps, name) => {
  const out: Violation[] = [];
  let seen = 0;
  for (const snap of w23Mondays(snaps)) {
    const rv = snap.review;
    if (rv == null || rv.review.weekRating !== 'tough') continue;
    seen++;
    if (/^(?:Weight flat|In budget|Down|Up)\b/.test(plain(rv.alert.body))) out.push({ snap, detail: `push body "${visible(rv.alert.body)}" (headline "${visible(rv.review.headline)}")` });
  }
  assert.ok(seen > 0, `${name}: no tough week, so this invariant checked nothing`);
  return out;
});

invariant(WEIGHT, 'P3-H: the coach is never told to "not blame water" outright; it is told to lead with the logged cause', snaps =>
  textMatches(snaps, s => coachTexts(s), /do not blame water/i));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ═══ WAVE 23e (ENDURANCE): STRUCTURAL GUARDS G1-G3 + ROUND-5 INVARIANTS ═══════════════════════════════════
// Endurance sat at 3/5 for two rounds because every wave's new rule collided with an older one on the same card. These guards stop
// that: a runner who does EXACTLY what the app says, day by day, is never criticised, never rated below good and never handed two
// instructions that cannot both be followed. Everything below is endurance-only and lives in this one block (keep it at the END).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const OBEDIENT = ['runner_on_plan_obedient', 'runner_comeback_obedient'] as const;

/** Days the comeback_obedient runner is ill (no run): their week is a rest week, not an obedient one. */
const w23IllDays = (name: ScenarioName): ReadonlySet<number> => (name === 'runner_comeback_obedient' ? COMEBACK_OBEDIENT_ILL_DAYS : new Set<number>());

// ── G1: the obedient runners really follow the app day by day ───────────────

invariant(OBEDIENT, 'G1: the runner follows the plan - each finished week is within 6% of the target the Monday card gave (race itself left out)', (snaps, name) => {
  const runKm = scenarioRunKm(name);
  const ill = w23IllDays(name);
  const scn = buildScenario(name);
  const out: Violation[] = [];
  let weeks = 0;
  for (const mon of snaps) {
    if (weekdayOf(mon.date) !== 'Mon' || mon.idx === 0) continue;
    const plan = mon.card?.distance?.plan;
    if (plan?.targetKm == null || /^On a break/.test(plain(mon.card?.headline ?? ''))) continue;
    if (Array.from({ length: 14 }, (_, i) => mon.idx + i).some(i => ill.has(i))) continue; // the week of an illness and the week the runner comes back
    if (addDays(mon.date, 6) > addDays(scn.day0, scn.lastDay)) continue;
    weeks++;
    const ran = kmThrough(runKm, mon.date, addDays(mon.date, 6));
    const target = plan.targetKm;
    if (Math.abs(ran - target) > Math.max(0.6, target * 0.06)) out.push({ snap: mon, detail: `the week of ${mon.date} was planned at ~${target} km (${plan.kind}) and the obedient runner ran ${Math.round(ran * 10) / 10} km` });
  }
  assert.ok(weeks > 8, `${name}: only ${weeks} weeks were compared, so this invariant checked (almost) nothing`);
  return out;
});

invariant(OBEDIENT, 'G1: the runner runs on a day only when the card is not asking for rest (no run on a "rest tomorrow" day, none after "skip the long run")', (snaps, name) => {
  const runKm = scenarioRunKm(name);
  const out: Violation[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const yesterday = snaps[i - 1];
    const text = [...cardTexts(yesterday), ...coachTexts(yesterday)].map(t => plain(t.text)).join(' | ');
    if (/rest tomorrow/i.test(text) && (runKm.get(snaps[i].date) ?? 0) > 0.05) out.push({ snap: snaps[i], detail: `ran ${runKm.get(snaps[i].date)} km the day after "${visible(text.match(/[^|]*rest tomorrow[^|]*/i)?.[0].trim() ?? '')}"` });
  }
  return out;
});

// ── "morning" views: the card as the runner reads it BEFORE a run ─────────────

/**
 * The snapshots only hold the END of each day (the run already logged). A runner reads the card before the run, so for every day with a
 * run the suite also steps the morning state: the same real functions over the rows of the days before. Cached per scenario.
 */
const w23MorningCache = new Map<ScenarioName, DaySnapshot[]>();
function w23Mornings(name: ScenarioName): DaySnapshot[] {
  const hit = w23MorningCache.get(name);
  if (hit) return hit;
  const scn = buildScenario(name);
  const runDays = new Set(scn.workouts.filter(w => w.type === 'Running').map(w => w.day));
  const out: DaySnapshot[] = [];
  for (let idx = 1; idx <= scn.lastDay; idx++) {
    const date = addDays(scn.day0, idx);
    if (!runDays.has(date) || weekdayOf(date) === 'Mon') continue;
    if (scn.dayFilter && !scn.dayFilter(idx, date)) continue;
    out.push(stepDay({ ...scn, workouts: scn.workouts.filter(w => w.day < date) }, idx));
  }
  w23MorningCache.set(name, out);
  return out;
}

/** A snapshot to check, the km already run this week at that moment and the longest run so far this week. */
interface W23View { snap: DaySnapshot; morning: boolean; doneKm: number; longestKm: number }

function w23Views(name: ScenarioName, snaps: DaySnapshot[], withMornings: boolean): W23View[] {
  const runKm = scenarioRunKm(name);
  const longestThrough = (monday: string, through: string): number => {
    let best = 0;
    for (let d = monday; d <= through; d = addDays(d, 1)) best = Math.max(best, runKm.get(d) ?? 0);
    return best;
  };
  // (On a Sunday evening a run logged that day IS the week's long run, whatever its length: nothing of it is still ahead.)
  const views: W23View[] = snaps.map(snap => ({
    snap,
    morning: false,
    doneKm: Math.round(kmThrough(runKm, mondayOfDate(snap.date), snap.date) * 10) / 10,
    longestKm: weekdayOf(snap.date) === 'Sun' && (runKm.get(snap.date) ?? 0) > 0 ? Infinity : longestThrough(mondayOfDate(snap.date), snap.date),
  }));
  if (withMornings) {
    for (const snap of w23Mornings(name)) {
      const through = addDays(snap.date, -1);
      views.push({ snap, morning: true, doneKm: Math.round(kmThrough(runKm, mondayOfDate(snap.date), through) * 10) / 10, longestKm: longestThrough(mondayOfDate(snap.date), through) });
    }
  }
  return views.sort((a, b) => a.snap.idx - b.snap.idx || Number(a.morning) - Number(b.morning));
}

const w23Where = (v: W23View, where: string): string => (v.morning ? `[morning, before the run] ${where}` : where);

// ── G2: the obedience invariant ─────────────────────────────────────────────

/** Words of criticism, a warning or a make-up: none belongs on a day of a runner who did exactly what the app said. */
const W23_CRITICISM = new RegExp([
  String.raw`\bwell over\b`, String.raw`\ba touch over\b`, String.raw`\bover the (?:safe step|ceiling|cutback|plan|cap|step)\b`,
  String.raw`\babove the (?:~?\d[\d.]*\s?(?:km|mi)\s)?(?:step|cutback|ceiling)\b`, String.raw`\bjump(?:ed|s)?\b`, String.raw`\bspike\b`,
  String.raw`\bbehind\b`, String.raw`\blight week\b`, String.raw`\blighter week\b`, String.raw`\bmake (?:it )?up\b`, String.raw`\bcatch up\b`,
  String.raw`\bshort of\b`, String.raw`[\d.]+\s?(?:km|mi) short\b`, String.raw`\ba bit under\b`, String.raw`\bwell under\b`, String.raw`\bunder the step\b`,
  String.raw`\bskipped\b`, String.raw`\beased off early\b`, String.raw`\beasing off\b`,
].join('|'), 'i');

invariant(OBEDIENT, 'G2: a runner who does exactly what the app says is never criticised - no slip, no amber (watch) tone, no "over / above / jump / spike / behind / light week / make up" on any card, coach line, opener or review, at any hour of a run day', (snaps, name) => {
  const out: Violation[] = [];
  const ill = w23IllDays(name);
  const illNear = (idx: number, back: number): boolean => Array.from({ length: back + 1 }, (_, i) => idx - i).some(i => ill.has(i));
  for (const v of w23Views(name, snaps, true)) {
    const snap = v.snap;
    // The days of an illness (and the first day back) are the runner's own break, not obedience.
    if (illNear(snap.idx, 3)) continue;
    const reviewOfIllWeek = illNear(snap.idx - 1, 7);
    for (const t of allTexts(snap)) {
      if (t.where.startsWith('review') && reviewOfIllWeek) continue;
      const m = W23_CRITICISM.exec(plain(t.text));
      if (m) out.push({ snap, detail: `${w23Where(v, t.where)} says "${m[0]}": "${visible(t.text)}"` });
    }
    // (The sessions line of the goal's first week is the one exception: "No training sessions logged" on the second morning, before the first run, is a
    // wave-20 rule with its own test; nothing is judged against a plan yet.)
    for (const r of snap.card?.reasons ?? []) if (r.tone === 'watch' && !(r.kind === 'sessions' && snap.idx < 7)) out.push({ snap, detail: `${w23Where(v, `card reason (${r.kind})`)} has a watch tone: "${visible(r.text)}"` });
    const rv = snap.review?.review;
    if (rv && !reviewOfIllWeek) {
      if (rv.slip) out.push({ snap, detail: `review slip: "${visible(rv.slip)}"` });
      if (rv.weekRating !== 'good') out.push({ snap, detail: `review rated ${rv.weekRating}: "${visible(rv.headline)}"` });
      for (const st of rv.stats) if (st.tone === 'watch') out.push({ snap, detail: `review stat ${st.label} has a watch tone: "${visible(st.value)} ${visible(st.comparison ?? '')}"` });
    }
    const verdict = snap.card?.verdict;
    if (verdict === 'holding' || verdict === 'behind') out.push({ snap, detail: `${w23Where(v, 'card verdict')} ${verdict}: "${visible(snap.card?.headline ?? '')}"` });
  }
  return out;
});

// ── G3: same-card instruction consistency (every runner scenario) ───────────

/** "Agree within 10%": a total may be this much over another (plus a tenth of a km of rounding). */
const W23_TOLERANCE = 1.1;
const W23_ABS_SLACK_KM = 0.1;

/** Why two instructions of one card cannot both be followed on `snap`. `done` = km this week so far, `targetKm` = the week's number. */
function w23Conflicts(snap: DaySnapshot, done: number, longestSoFarKm: number, targetKm: number | null): string[] {
  const out: string[] = [];
  const ins = extractInstructions(snap, { longestSoFarKm }).filter(i => i.kind !== 'rest_tomorrow');
  const km = (n: number): string => `${Math.round(n * 10) / 10} km`;
  for (const a of ins) {
    if (a.kind === 'long_run_cap') continue;
    for (const b of ins) {
      if (a === b || b.kind === 'long_run_cap') continue;
      // a asks for more than b allows: done + a's least remaining is over done + b's largest remaining by more than 10%.
      if (done + a.lo > (done + b.hi) * W23_TOLERANCE + W23_ABS_SLACK_KM) {
        out.push(`${a.where} "${visible(a.text)}" (${km(done)} + at least ${km(a.lo)} = ${km(done + a.lo)}) vs ${b.where} "${visible(b.text)}" (${km(done)} + at most ${km(b.hi)} = ${km(done + b.hi)})`);
      }
    }
    // The plan's long run is never longer than the long-run cap of the same card.
    for (const c of ins.filter(i => i.kind === 'long_run_cap')) {
      if (a.kind === 'long_run' && a.lo > c.hi * W23_TOLERANCE + 0.5) out.push(`${a.where} "${visible(a.text)}" vs ${c.where} "${visible(c.text)}"`);
    }
    if (targetKm != null && a.lo > 0.5 && done + a.lo > targetKm * W23_TOLERANCE + W23_ABS_SLACK_KM) {
      out.push(`${a.where} "${visible(a.text)}" asks for ${km(done)} + at least ${km(a.lo)} = ${km(done + a.lo)}, over the week's ~${km(targetKm)} x 1.10`);
    }
  }
  return [...new Set(out)];
}

invariant(RUNNERS, 'G3: on any day, the card (plan line, reasons, headline), the coach target line and the opener never give two instructions about the rest of the week that cannot both be followed (done + remaining agree within 10%, none over the week target x 1.10)', (snaps, name) => {
  const out: Violation[] = [];
  for (const v of w23Views(name, snaps, true)) {
    const card = v.snap.card;
    const dist = card?.distance;
    const plan = dist?.plan;
    if (!card || !dist || !plan || plan.targetKm == null) continue;
    const headline = plain(card.headline);
    // No week figure to be consistent with: a break (the restart number is its own), race eve and race day, the day the race is done.
    if (/^On a break|^Race tomorrow|^Race day|done — .*Congratulations|^Recovery week/i.test(headline) || (card.race?.daysToGo != null && card.race.phase !== 'recovery' && card.race.daysToGo <= 1)) continue;
    for (const detail of w23Conflicts(v.snap, v.doneKm, v.longestKm, dist.stepTargetKm)) out.push({ snap: v.snap, detail: v.morning ? `[morning, before the run] ${detail}` : detail });
  }
  return out;
});

// ── P1-2: a hold week he did not keep is not praised as held ─────────────────

/** The Sunday card of every week whose plan was a hold, with the km the week ran and its longest run (counted from the rows; the race itself left out). */
function holdWeeks(snaps: DaySnapshot[], name: ScenarioName): Array<{ monday: string; sunday: DaySnapshot; targetKm: number; heldLongKm: number | null; ranKm: number; longestKm: number; kept: boolean; cause: 'skipped_cutback' | 'ceiling' | 'spike' }> {
  const runKm = scenarioRunKm(name);
  const out: ReturnType<typeof holdWeeks> = [];
  for (const s of snaps) {
    const plan = s.card?.distance?.plan;
    if (weekdayOf(s.date) !== 'Sun' || plan?.kind !== 'hold' || plan.targetKm == null) continue;
    const monday = mondayOfDate(s.date);
    let longest = 0;
    for (let i = 0; i < 7; i++) longest = Math.max(longest, runKm.get(addDays(monday, i)) ?? 0);
    const ran = kmThrough(runKm, monday, s.date);
    const kept = ran <= plan.targetKm * 1.05 + 1e-9 && (plan.longRunKm == null || longest <= plan.longRunKm + 0.5 + 1e-9);
    out.push({ monday, sunday: s, targetKm: plan.targetKm, heldLongKm: plan.longRunKm, ranKm: ran, longestKm: longest, kept, cause: plan.skippedCutback ? 'skipped_cutback' : plan.overCapRead === 'well' ? 'ceiling' : 'spike' });
  }
  return out;
}

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_messy', 'runner_comeback_spike'], 'P1-2: a hold week is "on plan" and praised as held only if it kept to the hold (km <= target x 1.05 and the long run <= the held one + 0.5); otherwise the card and the review say "above the hold", the Volume stat is a neutral "+N% vs last week", there is no win and the slip is a factual "Built again instead of holding"', (snaps, name) => {
  const out: Violation[] = [];
  const byDate = new Map(snaps.map(s => [s.date, s]));
  let broken = 0;
  let kept = 0;
  for (const w of holdWeeks(snaps, name)) {
    const mondayAfter = byDate.get(addDays(w.monday, 7));
    const review = mondayAfter?.review?.weekStart === w.monday ? mondayAfter.review.review : null;
    const sundayHeadline = plain(w.sunday.card?.headline ?? '');
    if (!w.kept) {
      broken++;
      if (/on plan/.test(sundayHeadline)) out.push({ snap: w.sunday, detail: `Sunday card "${visible(w.sunday.card?.headline ?? '')}" after ${Math.round(w.ranKm * 10) / 10} km (long run ${Math.round(w.longestKm * 10) / 10}) against a hold of ~${w.targetKm} km (long run ${w.heldLongKm})` });
      if (review && mondayAfter) {
        const volume = review.stats.find(st => st.label === 'Volume');
        if (/held after/.test(plain(volume?.comparison ?? ''))) out.push({ snap: mondayAfter, detail: `Volume "${visible(volume?.value ?? '')} — ${visible(volume?.comparison ?? '')}" [${volume?.tone}] for a hold week that was not kept` });
        if (volume?.tone === 'good') out.push({ snap: mondayAfter, detail: `Volume is good-toned for a hold week that was not kept: "${visible(volume.comparison ?? '')}"` });
        if (/held back|held at|exactly right|right call/i.test(plain(review.win ?? ''))) out.push({ snap: mondayAfter, detail: `win "${visible(review.win ?? '')}" for a hold week that was not kept` });
        if (review.weekRating === 'good') out.push({ snap: mondayAfter, detail: `rated good: "${visible(review.headline)}"` });
        if (!/above the hold/.test(plain(review.headline))) out.push({ snap: mondayAfter, detail: `review headline "${visible(review.headline)}" does not say "above the hold"` });
        if (!/^(?:Built again instead of holding: [\d.]+ vs ~[\d.]+ (?:km|mi)|Held the km, but the long run was [\d.]+ (?:km|mi) against the held [\d.]+ (?:km|mi))$/.test(plain(review.slip ?? ''))) out.push({ snap: mondayAfter, detail: `slip "${visible(review.slip ?? '')}" is not the factual "Built again instead of holding: N vs ~M"` });
      }
    } else {
      kept++;
      if (review && mondayAfter) {
        const win = plain(review.win ?? '');
        if (w.cause === 'skipped_cutback' && !/^Held at ~[\d.]+ (?:km|mi) after the skipped cutback — right call\.$/.test(win)) out.push({ snap: mondayAfter, detail: `win "${visible(review.win ?? '')}" for a kept hold after a skipped cutback` });
        if (w.cause !== 'skipped_cutback' && /skipped the cutback/.test(win)) out.push({ snap: mondayAfter, detail: `win "${visible(review.win ?? '')}" names a skipped cutback for a ${w.cause} hold` });
        if (review.slip && /Built again/.test(plain(review.slip))) out.push({ snap: mondayAfter, detail: `slip "${visible(review.slip)}" for a kept hold week` });
      }
    }
  }
  assert.ok(broken + kept > 0, `${name}: no hold week was stepped, so this invariant checked nothing`);
  if (name === 'runner_on_plan' || name === 'runner_on_plan_half') assert.ok(broken > 0, `${name}: no hold week was broken, so this invariant checked nothing`);
  return out;
});

// ── P2-3: a skipped cutback is OWED - no runner goes more than 4 build weeks without a down week ─────────────

/** The week's kind for the down-week count, from the Monday card: 'down' (cutback, taper, race week, recovery, restart, rebuild), 'build' (a plain build / maintain week or any hold) or 'ramp' (a comeback rung, neutral). */
function weekShape(s: DaySnapshot): 'down' | 'build' | 'ramp' | null {
  const plan = s.card?.distance?.plan;
  if (!plan) return null;
  if (plan.cutback || ['taper', 'race_week', 'recovery', 'restart', 'rebuild', 'baseline'].includes(plan.kind)) return 'down';
  if (plan.kind === 'hold') return 'build';
  if ((plan.kind === 'build' || plan.kind === 'maintain') && plan.comebackKm != null) return 'ramp';
  return plan.kind === 'build' || plan.kind === 'maintain' ? 'build' : null;
}

invariant(RUNNERS, 'P2-3: between two down weeks (cutback / taper / race / recovery / restart / rebuild) there are at most 4 build or hold weeks', (snaps, name) => {
  const out: Violation[] = [];
  let streak = 0;
  let longest = 0;
  const mondays = snaps.filter(s => weekdayOf(s.date) === 'Mon');
  for (const m of mondays) {
    const plan = m.card?.distance?.plan;
    // A spike hold on the calendar's cutback week (the 4th, after 3+ build weeks) takes the cutback's place: the cut after the jump.
    const slotHold = plan?.kind === 'hold' && !plan.skippedCutback && Math.round(dayDiff(m.date, '1970-01-05') / 7) % 4 === 3 && streak >= 3;
    const shape = slotHold ? 'down' : weekShape(m);
    if (shape === 'down') streak = 0;
    else if (shape === 'build') {
      streak++;
      longest = Math.max(longest, streak);
      if (streak > 4) out.push({ snap: m, detail: `${streak} build / hold weeks in a row without a down week (this one: ${m.card?.distance?.plan?.kind} ~${m.card?.distance?.plan?.targetKm} km, "${visible(m.card?.distance?.plan?.purpose ?? '')}")` });
    }
  }
  if (name !== 'runner_on_plan_imperial') assert.ok(longest >= 2, `${name}: no build streak was stepped, so this invariant checked nothing`);
  return out;
});

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_no_race'], 'P2-3: a cutback that was skipped is owed - the next down week comes within 3 weeks of the hold that followed it, not at the end of a 4-week cycle', (snaps) => {
  const out: Violation[] = [];
  const mondays = snaps.filter(s => weekdayOf(s.date) === 'Mon');
  let sinceHold = -1;
  for (const m of mondays) {
    const plan = m.card?.distance?.plan;
    if (plan?.skippedCutback) { sinceHold = 0; continue; }
    if (sinceHold < 0) continue;
    sinceHold++;
    if (weekShape(m) === 'down') { sinceHold = -1; continue; }
    if (sinceHold > 3) { out.push({ snap: m, detail: `${sinceHold} weeks after the skip-hold with no down week yet` }); sinceHold = -1; }
  }
  return out;
});

// ── P2-4: after a cutback every surface quotes the weekly % against the week before the cutback (one base, named) ──────────

/** True for a plain build / maintain / hold week of a runner who is not coming back from a break (the weeks a "+N%" step is meant for). */
const isPlainBuildPlan = (plan: NonNullable<NonNullable<DaySnapshot['card']>['distance']>['plan'] | undefined): boolean =>
  plan != null && ['build', 'maintain', 'hold'].includes(plan.kind) && plan.comebackKm == null && plan.upTo !== true;

invariant(OBEDIENT, 'P2-4: no build-week "+N%" over 15% on any surface (card, coach, review) for a runner who does what the app says - after a cutback the base is the last full week, named', (snaps, name) => {
  const out: Violation[] = [];
  const bySunday = new Map(snaps.filter(s => weekdayOf(s.date) === 'Sun').map(s => [s.date, s]));
  const over = (t: string): RegExpMatchArray | null => {
    for (const m of plain(t).matchAll(/\+(\d+)%/g)) if (Number(m[1]) > 15) return m;
    return null;
  };
  let afterCutback = 0;
  for (const snap of snaps) {
    const plan = snap.card?.distance?.plan;
    if (isPlainBuildPlan(plan)) {
      for (const t of [...cardTexts(snap), ...coachTexts(snap)]) if (over(t.text)) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
    const rv = snap.review;
    if (rv) {
      const sunday = bySunday.get(addDays(rv.weekStart, 6));
      if (sunday && isPlainBuildPlan(sunday.card?.distance?.plan)) {
        for (const t of reviewTexts(snap)) if (over(t.text)) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
        if (sunday.card?.distance?.plan?.cutback !== true && snaps.find(s => s.date === addDays(rv.weekStart, -7))?.card?.distance?.plan?.cutback) afterCutback++;
      }
    }
  }
  assert.ok(afterCutback > 0, `${name}: no review of a week right after a cutback was stepped, so this invariant checked nothing`);
  return out;
});

// ── P2-5: a comeback's "Next week" names the ladder it climbs, not "then add ~10% a week" ──────────────────────

invariant(RUNNERS, 'P2-5: when the coming week is a comeback rung ("up to ~N km", back toward the usual week) the review\'s "Next week" names the ladder ("up to ~25% a week until you\'re back at your usual ~N km"), never "then add ~10% a week"', (snaps, name) => {
  const out: Violation[] = [];
  let comebackReviews = 0;
  for (const snap of snaps) {
    const rv = snap.review;
    const plan = snap.card?.distance?.plan;
    // (A rung that already reaches the usual week says "30 km the week after" and has no ladder left to name.)
    if (!rv || !plan || plan.comebackKm == null || plan.kind !== 'build' || (plan.targetKm ?? 0) >= plan.comebackKm - 0.5) continue;
    comebackReviews++;
    const next = plain(rv.review.nextWeek);
    if (/add ~10% a week/.test(next)) out.push({ snap, detail: `next week "${visible(rv.review.nextWeek)}" says +10% a week, the card's ceiling is ~${plan.targetKm} km (back toward ~${plan.comebackKm} km)` });
    else if (!/up to ~25% a week until you're back at your usual ~[\d.]+ (?:km|mi)/.test(next)) out.push({ snap, detail: `next week "${visible(rv.review.nextWeek)}" does not name the ladder` });
  }
  if (name === 'runner_comeback_spike' || name === 'runner_comeback_obedient' || name === 'runner_messy') assert.ok(comebackReviews > 0, `${name}: no comeback review was stepped, so this invariant checked nothing`);
  return out;
});

// ── P2-6: a skipped cutback is not guilt ─────────────────────────────────────

const SKIP_GUILT = /\bskipped\b|stays the bar|do not praise|ran well over|above the cutback|Cutback skipped/i;

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_no_race'], 'P2-6: a cutback that became a normal week is "fine": the week is rated good with no slip, the cards and the review say so in plain words ("Your cutback became a normal week - fine"), and "skipped" / "the week it replaced stays the bar" / "do not praise" are gone', (snaps, name) => {
  const out: Violation[] = [];
  const byDate = new Map(snaps.map(s => [s.date, s]));
  let seen = 0;
  for (const w of skippedCutbacks(snaps)) {
    seen++;
    if (SKIP_GUILT.test(plain(w.sunday.card?.headline ?? '')) || !/normal week/.test(plain(w.sunday.card?.headline ?? ''))) out.push({ snap: w.sunday, detail: `Sunday card "${visible(w.sunday.card?.headline ?? '')}" after ${w.ranKm} of ~${w.targetKm} km` });
    const monday = byDate.get(addDays(w.monday, 7));
    if (!monday) continue;
    const rv = monday.review?.weekStart === w.monday ? monday.review.review : null;
    if (rv) {
      if (rv.weekRating !== 'good') out.push({ snap: monday, detail: `review rated ${rv.weekRating}: "${visible(rv.headline)}"` });
      if (rv.slip) out.push({ snap: monday, detail: `slip "${visible(rv.slip)}"` });
      if (rv.weekGap) out.push({ snap: monday, detail: `weekGap ${JSON.stringify(rv.weekGap)}` });
      if (SKIP_GUILT.test(plain(rv.headline)) || !/normal week/.test(plain(rv.headline))) out.push({ snap: monday, detail: `review headline "${visible(rv.headline)}"` });
      if (plain(rv.win ?? '') !== 'Your cutback became a normal week — fine.') out.push({ snap: monday, detail: `win "${visible(rv.win ?? '')}"` });
      if (!/^Hold ~[\d.]+ (?:km|mi) next week.* — an easier week(?: before building again|, then (?:the taper|race week))/.test(plain(rv.nextWeek))) out.push({ snap: monday, detail: `next week "${visible(rv.nextWeek)}"` });
      if (rv.stats.some(st => st.tone === 'watch')) out.push({ snap: monday, detail: `a watch-toned stat: ${rv.stats.filter(st => st.tone === 'watch').map(st => `${st.label} ${visible(st.value)}`).join(', ')}` });
    }
    // The hold week: every card, coach line and opener of its days.
    for (let i = 0; i < 7; i++) {
      const day = byDate.get(addDays(monday.date, i));
      if (!day || day.card?.distance?.plan?.kind !== 'hold') continue;
      for (const t of [...cardTexts(day), ...coachTexts(day)]) {
        if (SKIP_GUILT.test(plain(t.text))) out.push({ snap: day, detail: `${t.where}: "${visible(t.text)}"` });
      }
      const planLine = day.card?.reasons.find(r => r.kind === 'plan')?.text ?? '';
      // (A light week / easing-off day keeps its own plan line: the hold's wording is for the weeks that are held.)
      if (day.card?.distance?.plan?.lightWeek || day.card?.distance?.plan?.easingOff) continue;
      if (!/^Your cutback became a normal week — fine\. Hold ~[\d.]+ (?:km|mi) this week/.test(plain(planLine))) out.push({ snap: day, detail: `plan line "${visible(planLine)}"` });
      if (day.card?.reasons.some(r => r.tone === 'watch' && /cutback/.test(plain(r.text)))) out.push({ snap: day, detail: 'a watch-toned reason about the cutback' });
    }
  }
  assert.ok(seen > 0, `${name}: no cutback was skipped, so this invariant checked nothing`);
  return out;
});

// ── P2-7: a planned drop or rise in a wind-down week is "as planned", like the cutback's ────────────────────

invariant(RUNNERS, 'P2-7: the Volume stat of a taper, race or recovery week that quotes a % vs last week says "as planned (taper / race week / recovery)" next to it', (snaps, name) => {
  const out: Violation[] = [];
  const bySunday = new Map(snaps.filter(s => weekdayOf(s.date) === 'Sun').map(s => [s.date, s]));
  let seen = 0;
  for (const snap of snaps) {
    const rv = snap.review;
    if (!rv) continue;
    const kind = bySunday.get(addDays(rv.weekStart, 6))?.card?.distance?.plan?.kind;
    if (kind !== 'taper' && kind !== 'race_week' && kind !== 'recovery') continue;
    const volume = rv.review.stats.find(st => st.label === 'Volume');
    if (!volume || !/[+−-]\d+%/.test(plain(volume.comparison ?? ''))) continue;
    seen++;
    const label = kind === 'race_week' ? 'race week' : kind;
    if (!new RegExp(`, as planned \\(${label}\\)$`).test(plain(volume.comparison ?? ''))) out.push({ snap, detail: `Volume "${visible(volume.value)}" — "${visible(volume.comparison ?? '')}" for a ${kind} week` });
  }
  if (name === 'runner_on_plan_half' || name === 'runner_on_plan_obedient' || name === 'runner_on_plan') assert.ok(seen > 0, `${name}: no wind-down week quoted a %, so this invariant checked nothing`);
  return out;
});

// ═══ Round-5 P3s (one invariant each, written BEFORE the fix) ═════════════════════════════════════════════════

// ── P3-a: "a touch over, fine" is said once ──────────────────────────────────

invariant(RUNNERS, 'P3-a: "a touch over, fine" is said once - on the Sunday the week ended and on the Monday after (card, review, coach, opener) - never from Tuesday on', (snaps, name) => {
  const out: Violation[] = [];
  for (const snap of snaps) {
    const wd = weekdayOf(snap.date);
    if (wd === 'Sun' || wd === 'Mon') continue;
    for (const t of [...cardTexts(snap), ...coachTexts(snap)]) {
      if (/touch over|a little over/i.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}"` });
    }
  }
  if (name === 'runner_messy') {
    // ... and it IS said on the Monday (day 77), with the quiet read from the Tuesday (day 78).
    const monday = snaps.find(s => s.idx === 77) as DaySnapshot;
    if (!/a touch over, fine/.test(plain(monday.card?.headline ?? ''))) out.push({ snap: monday, detail: `the Monday headline no longer says it once: "${visible(monday.card?.headline ?? '')}"` });
    const tuesday = snaps.find(s => s.idx === 78) as DaySnapshot;
    if (plain(tuesday.card?.headline ?? '') !== 'Building — 20 km last week, back after your break') out.push({ snap: tuesday, detail: `Tuesday headline "${visible(tuesday.card?.headline ?? '')}"` });
  }
  return out;
});
