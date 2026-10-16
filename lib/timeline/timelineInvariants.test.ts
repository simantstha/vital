/**
 * Timeline invariants: behaviours the persona-review waves fixed, locked in as tests over the day-by-day
 * simulation (lib/timeline/README.md). Each invariant runs once per relevant scenario; a failure names the
 * scenario, the day and the offending string. Add an invariant by writing a `find` function and one
 * `invariant(...)` call. Scenarios run once per process (runTimeline caches), not once per test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { KM_PER_MILE } from '../metricFormat';
import { runTimeline } from './engine';
import { SCENARIO_NAMES, type ScenarioName } from './scenarios';
import type { DaySnapshot } from './types';

const ALL: readonly ScenarioName[] = SCENARIO_NAMES;
const RUNNERS = ALL.filter(n => n.startsWith('runner_'));
const LIFTERS: readonly ScenarioName[] = ['lifter'];
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

// Not yet listed: runner_on_plan, runner_on_plan_half, runner_on_plan_imperial, runner_messy. The taper line's race-pace
// reps ("3×1 km", "3×0.5 mi") still use an ASCII space; add those scenarios here once that is fixed.
invariant(['runner_no_race', ...LIFTERS, ...WEIGHT], 'numbers and units in card and review text are joined by U+00A0 (no ASCII space before kg, km, mi, lb, kcal)', snaps => {
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

const LIFT_LAPSE_DAYS = 7;
const inLapse = (s: DaySnapshot): boolean => (s.card?.lastSessionDaysAgo ?? 0) >= LIFT_LAPSE_DAYS;

invariant(LIFTERS, 'never "Progressing" on a day with no strength session for 7+ days', snaps => {
  const out = textMatches(snaps, s => [...cardTexts(s), ...coachTexts(s)], /\bprogressing\b/i, inLapse);
  for (const snap of snaps) {
    if (inLapse(snap) && snap.card?.verdict === 'progressing') out.push({ snap, detail: `verdict progressing, last session ${snap.card.lastSessionDaysAgo} days ago` });
  }
  return out;
});

invariant(LIFTERS, 'never a positive lift change on a day with no strength session for 7+ days', snaps => {
  const liftTexts = (s: DaySnapshot): Text[] => [
    ...cardTexts(s).filter(t => t.where === 'card.headline' || t.where.endsWith('(lift)')),
    ...coachTexts(s).filter(t => /1RM/.test(t.text)),
  ];
  return textMatches(snaps, liftTexts, /\+\s?\d/, inLapse);
});

invariant(LIFTERS, 'never a lift "win" on a day with no strength session for 7+ days', snaps => {
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
