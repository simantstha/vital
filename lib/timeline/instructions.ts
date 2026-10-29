/**
 * Wave 23e: ONE reading of "what should I run for the rest of this week?" over everything the app says on a day (the goal card's
 * headline / plan line / reasons, the coach's target and long-run lines, the opener). Pure, no clock, no DB.
 *
 * Two consumers share it so they can never drift apart:
 *  - the obedient runners (obedient.ts): each run day they read the card and run what it implies, every daily cap included;
 *  - the G3 invariant (timelineInvariants.test.ts): on any day the instructions of one card must agree.
 *
 * Wave 24e adds the budget's own wording: "6 km left this week" / "~2 km left - one short easy run [or rest, either is fine]" and a named weekday ("keep Saturday's run to ~4 km").
 *
 * An instruction is an interval of km still to run after the km already done this week ([lo, hi]; hi = Infinity for "at least").
 */
import { KM_PER_MILE } from '../metricFormat';
import type { DaySnapshot } from './types';

export type InstructionKind =
  /** "keep Sunday's run ≤ 4 km", "keep the rest of the week ≤ 8 km", "keep Sunday's long run to ~6 km": at most this much more. */
  | 'cap'
  /** "make Sunday's long run ~6 km easy": exactly this much more. */
  | 'exact'
  /** "long run 10 km" (the week's plan) while the long run is still ahead: at least this much more. */
  | 'long_run'
  /** "long run ≤ ~8 km" (a light week): the long run alone is at most this. */
  | 'long_run_cap'
  /** "this week's km are done", "skip the long run": nothing more. */
  | 'done'
  /** "rest tomorrow": tomorrow's run is zero (no km figure). */
  | 'rest_tomorrow';

export interface DayInstruction {
  where: string;
  /** The matched fragment, for failure messages. */
  text: string;
  kind: InstructionKind;
  /** Km still to run after what is done this week. */
  lo: number;
  hi: number;
}

/** The surfaces' strings with non-breaking spaces made plain. */
const plain = (s: string): string => s.replace(/ /g, ' ');

const NUM = '(\\d+(?:\\.\\d+)?)';
/** "6", "6 km", "11.5–15 km": the unit follows the last number. */
const AMOUNT = `~?${NUM}(?:\\s?[–-]\\s?~?${NUM})?\\s?(km|mi)\\b`;

function toKm(value: number, unit: string): number {
  return unit === 'mi' ? value * KM_PER_MILE : value;
}

function range(m: RegExpExecArray, first: number): { lo: number; hi: number } {
  const unit = m[first + 2];
  const a = toKm(Number(m[first]), unit);
  const b = m[first + 1] != null ? toKm(Number(m[first + 1]), unit) : a;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

// "keep Sunday's run ≤ 4 km" / "keep the rest of the week ≤ 8 km" / "keep tomorrow's run ≤ 3 km" / "keep the rest to ~4 km" / "keep Sunday's long run to ~6 km"
const CAP = new RegExp(`\\bkeep (?:the rest of the week|the rest|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)['’]s (?:long(?:est)? )?run|tomorrow['’]s (?:long(?:est)? )?run|today['’]s (?:long(?:est)? )?run|the long run|the days before the race)(?: to| ≤| at most| under) ${AMOUNT}`, 'gi');
// Wave 24e: "6 km left this week - one easy run of ~6 km, or two of ~3 km" and "~2 km left - one short easy run" (+ " or rest, either is fine"): the rest of the week.
const LEFT = new RegExp(`~?${NUM}\\s?(km|mi) left\\b(?:[^.;]*?\\bor rest, either is fine)?`, 'gi');
// Wave 24e: a restart that begins mid-week: "Starting today? ~10 km over the rest of this week in 2-3 easy runs, nothing over ~4 km; the restart week (~18 km) starts Monday".
const REST_OF_WEEK = new RegExp(`~?${NUM}\\s?(km|mi) over the rest of this week`, 'gi');
const NOTHING_OVER = new RegExp(`nothing over ~?${NUM}\\s?(km|mi)`, 'gi');
// "make Sunday's long run ~6 km easy"
const EXACT = new RegExp(`\\bmake (?:Sunday['’]s|the) (?:long(?:est)? )?run ${AMOUNT}`, 'gi');
// "long run 10 km", "next long run ~11 km", "keep the long run 11 km", "Sunday's long run ~11.5–15 km easy", "long run ≤ ~8 km"
const LONG_RUN = new RegExp(`\\b(?:long|longest) run (≤ )?${AMOUNT}`, 'gi');
const SUNDAY_LONG = new RegExp(`\\bSunday['’]s long run ${AMOUNT}`, 'gi');
const DONE = /\bthis week['’]s km are done\b|\bskip the long run\b(?! if you were ill)|\bweek['’]s km are done\b/i;
const REST_TOMORROW = /\brest tomorrow\b/i;

/** The strings of a day that carry instructions about the rest of THIS week (status lines such as "Longest run 3 km · build to 15 km" are not). */
export function instructionTexts(snap: Pick<DaySnapshot, 'card' | 'coach' | 'opener'>): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const card = snap.card;
  if (card) {
    out.push({ where: 'card.headline', text: card.headline });
    card.reasons.forEach((r, i) => {
      if (r.kind === 'plan' || r.kind === 'volume' || r.kind === 'race_phase') out.push({ where: `card.reasons[${i}] (${r.kind})`, text: r.text });
    });
    if (card.distance) out.push({ where: 'card.distance.text', text: card.distance.text });
  }
  (snap.coach ?? []).forEach((line, i) => {
    if (/^- (?:This week's target|Race phase|Long run)/.test(line)) out.push({ where: `coach[${i}]`, text: line });
  });
  if (snap.opener?.required) out.push({ where: 'opener.required', text: snap.opener.required });
  return out;
}

/**
 * Every instruction about the rest of the week on one day. `longestSoFarKm` is the longest run this week so far: a "long run 10 km" is km
 * still to run only while no run of (nearly) that length is in; once it is run it is history and implies nothing.
 */
export function extractInstructions(
  snap: Pick<DaySnapshot, 'card' | 'coach' | 'opener'>,
  opts: { longestSoFarKm: number },
): DayInstruction[] {
  // The long run is still ahead while no run of (nearly) its planned length is in: a 7 km Tuesday run is not the 9 km Sunday long run.
  const ahead = (longKm: number): boolean => opts.longestSoFarKm < longKm * 0.9;
  const out: DayInstruction[] = [];
  for (const { where, text: raw } of instructionTexts(snap)) {
    const text = plain(raw);
    let m: RegExpExecArray | null;
    CAP.lastIndex = 0;
    while ((m = CAP.exec(text)) != null) {
      const r = range(m, 1);
      out.push({ where, text: m[0], kind: 'cap', lo: 0, hi: r.hi });
    }
    EXACT.lastIndex = 0;
    while ((m = EXACT.exec(text)) != null) {
      const r = range(m, 1);
      out.push({ where, text: m[0], kind: 'exact', lo: r.lo, hi: r.hi });
    }
    LEFT.lastIndex = 0;
    while ((m = LEFT.exec(text)) != null) {
      const n = toKm(Number(m[1]), m[2]);
      // "... or rest, either is fine": resting is as good as the run, so it is a ceiling; otherwise the rest of the week is exactly this much.
      if (/or rest, either is fine/.test(m[0])) out.push({ where, text: m[0], kind: 'cap', lo: 0, hi: n });
      else out.push({ where, text: m[0], kind: 'exact', lo: n, hi: n });
    }
    REST_OF_WEEK.lastIndex = 0;
    while ((m = REST_OF_WEEK.exec(text)) != null) {
      const n = toKm(Number(m[1]), m[2]);
      out.push({ where, text: m[0], kind: 'exact', lo: n, hi: n });
    }
    NOTHING_OVER.lastIndex = 0;
    while ((m = NOTHING_OVER.exec(text)) != null) out.push({ where, text: m[0], kind: 'long_run_cap', lo: 0, hi: toKm(Number(m[1]), m[2]) });
    const capSpans: Array<[number, number]> = [];
    CAP.lastIndex = 0;
    while ((m = CAP.exec(text)) != null) capSpans.push([m.index, m.index + m[0].length]);
    LONG_RUN.lastIndex = 0;
    while ((m = LONG_RUN.exec(text)) != null) {
      // "keep Sunday's long run to ~6 km" is a cap (read above); a bare "long run 10 km" is the plan's long run.
      if (capSpans.some(([a, b]) => m != null && m.index >= a && m.index < b)) continue;
      const r = range(m, 2);
      if (m[1]) out.push({ where, text: m[0], kind: 'long_run_cap', lo: 0, hi: r.hi });
      else if (ahead(r.lo)) out.push({ where, text: m[0], kind: 'long_run', lo: r.lo, hi: Infinity });
    }
    SUNDAY_LONG.lastIndex = 0;
    while ((m = SUNDAY_LONG.exec(text)) != null) {
      if (/\b(?:to|make) $/i.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
      if (capSpans.some(([a, b]) => m != null && m.index >= a && m.index < b)) continue;
      const r = range(m, 1);
      if (!ahead(r.lo)) continue;
      out.push({ where, text: m[0], kind: 'long_run', lo: r.lo, hi: Infinity });
    }
    const done = DONE.exec(text);
    if (done) out.push({ where, text: done[0], kind: 'done', lo: 0, hi: 0 });
    const rest = REST_TOMORROW.exec(text);
    if (rest) out.push({ where, text: rest[0], kind: 'rest_tomorrow', lo: 0, hi: Infinity });
  }
  return out;
}

/** The most the rest of the week may add, by the tightest cap / "done" instruction; Infinity when none says. */
export function tightestCapKm(instructions: ReadonlyArray<DayInstruction>): number {
  let cap = Infinity;
  for (const i of instructions) if (i.kind === 'cap' || i.kind === 'done' || i.kind === 'exact') cap = Math.min(cap, i.hi);
  return cap;
}
