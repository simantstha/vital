/**
 * Timeline invariants: behaviours the persona-review waves fixed, locked in as tests over the day-by-day
 * simulation (lib/timeline/README.md). Each invariant runs once per relevant scenario; a failure names the
 * scenario, the day and the offending string. Add an invariant by writing a `find` function and one
 * `invariant(...)` call. Scenarios run once per process (runTimeline caches), not once per test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TAPER_GOOD_MIN_FRACTION } from '../enduranceProgression';
import { liftLapseMinDays } from '../liftChange';
import { KM_PER_MILE } from '../metricFormat';
import { calorieFloorKcal, isInstruction, TRIM_MAX_KCAL_PER_STEP } from '../weightWeekPlan';
import { runTimeline } from './engine';
import { SCENARIO_NAMES, buildScenario, type ScenarioName } from './scenarios';
import { addDays, dayDiff, weekdayOf, type DaySnapshot } from './types';

const ALL: readonly ScenarioName[] = SCENARIO_NAMES;
const RUNNERS = ALL.filter(n => n.startsWith('runner_'));
const LIFTERS = ALL.filter(n => n.startsWith('lifter'));
const WEIGHT: readonly ScenarioName[] = ['weight_loss', 'weight_loss_logged'];

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

invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_imperial', 'runner_messy'], 'race eve shows no km-of-the-week figure (card, coach lines, opener)', (snaps, name) => {
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
        if (!KCAL_FIGURE.test(plain(t.text)) && !/This week's plan|Nearly there/.test(plain(t.text))) out.push({ snap, detail: `${t.where}: "${visible(t.text)}" names no calorie figure` });
      }
    }
    if (plan.action.kind === 'ease_to_maintenance' && !KCAL_FIGURE.test(plain(plan.action.text))) out.push({ snap, detail: `plan action [ease_to_maintenance] "${visible(plan.action.text)}" names no calorie figure` });
    const reachedDaysAgo = snap.card?.weightRead?.reachedDaysAgo;
    if (snap.card?.verdict === 'reached' && reachedDaysAgo != null && reachedDaysAgo <= MAINTENANCE_STEP_WINDOW_DAYS) {
      reachedChecked++;
      if (!KCAL_FIGURE.test(plain(plan.action.text))) out.push({ snap, detail: `reached ${reachedDaysAgo} days ago, plan action [${plan.action.kind}] "${visible(plan.action.text)}" names no calorie figure` });
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

// A careful comeback week's "up to ~18 km" is a ceiling. Running more than the shared 10% ceiling slack over it is "a little over the cap" -
// never "on plan" / "on track", never a green Volume stat or a "Back on the way up" win, on the Monday card or in the review - and the
// week after is not lifted by the overshoot: it holds at what was run ("hold here") - never a step or a 1.25x rung up from it
// (runner_messy week of 2026-05-11: 20 of up to ~18 km, then "Up to ~25 km").
const COMEBACK_CAP_SLACK = 1.1;

invariant(RUNNERS, 'a comeback week more than 10% over its "up to" cap reads "over the cap" (not "on plan") on the card and in the review, and next week holds at what was run', (snaps, name) => {
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
      if (!/over the cap/i.test(rv.review.headline)) out.push({ snap: reviewSnap, detail: `review.headline "${visible(rv.review.headline)}" does not say the week went over its cap (${d.thisWeekKm} of up to ~${d.stepTargetKm} km)` });
      const volume = rv.review.stats.find(st => st.label === 'Volume');
      if (volume?.tone === 'good') out.push({ snap: reviewSnap, detail: `review stat Volume "${visible(volume.value)}" is good-toned for ${d.thisWeekKm} of up to ~${d.stepTargetKm} km` });
    }
    // The card of the week after: about last week until the next one is run.
    for (let i = 0; i < 7; i++) {
      const next = byDate.get(addDays(nextMonday, i));
      const nd = next?.card?.distance;
      if (!next || !nd || nd.plan?.kind !== 'build') continue;
      if (ON_TRACK_WORDS.test(plain(next.card?.headline ?? ''))) out.push({ snap: next, detail: `card.headline "${visible(next.card?.headline ?? '')}" after a week of ${d.thisWeekKm} of up to ~${d.stepTargetKm} km` });
      else if (!/over the cap/i.test(next.card?.headline ?? '')) out.push({ snap: next, detail: `card.headline "${visible(next.card?.headline ?? '')}" does not say last week went over its cap (${d.thisWeekKm} of up to ~${d.stepTargetKm} km)` });
      if (nd.stepTargetKm > d.thisWeekKm + 0.5 + 1e-9) {
        out.push({ snap: next, detail: `target ~${nd.stepTargetKm} km steps up from the overshoot: last week ran ${d.thisWeekKm} of up to ~${d.stepTargetKm} km and this week should hold there` });
      }
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
invariant(['runner_on_plan', 'runner_on_plan_half', 'runner_on_plan_imperial', 'runner_messy'], 'a weekend taper card says "on plan" only when the week can land in the taper band (run so far + the long run still to come)', (snaps, name) => {
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
