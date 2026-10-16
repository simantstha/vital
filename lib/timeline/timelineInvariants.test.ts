/**
 * Timeline invariants: behaviours the persona-review waves fixed, locked in as tests over the day-by-day
 * simulation (lib/timeline/README.md). Each invariant runs once per relevant scenario; a failure names the
 * scenario, the day and the offending string. Add an invariant by writing a `find` function and one
 * `invariant(...)` call. Scenarios run once per process (runTimeline caches), not once per test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.ok(trims > 0, `${name}: no trim advice appeared, so this invariant checked nothing`);
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
