/**
 * Vital — the injury check-in (pure, no DB or Next.js imports)
 *
 * A logged Injury fact ("Knee pain since Oct 20") used to reach only the chat coach (lib/brain/context.ts's NEVER
 * VIOLATE block). The plan surfaces — the goal card's reasons, the weekly review's "Next week", the coach brief and the
 * opener — kept prescribing intervals and heavier squats. This module is the ONE definition they all share:
 *
 *  - which fact counts (`pickInjuryCheckIn`): the most recently logged Injury fact inside INJURY_CHECK_IN_WINDOW_DAYS;
 *  - which goals get a line (`injuryCheckInApplies`): endurance and strength always, general only when it trains,
 *    weight loss never;
 *  - the wording (`injuryCheckInLine`): one neutral sentence per goal, identical on every surface (G3).
 *
 * The line never claims the injury still hurts and never changes a plan number: it sits beside the plan and asks.
 * Loading the fact is lib/injuryCheckInLoader.ts; this file only decides.
 */

import type { GoalKind } from './goalProgress';

/**
 * How long after the user logged an Injury fact the plan surfaces still ask about it. A fact has no resolve date of its
 * own beyond the "resolved" status (a healed injury is retired with resolve_fact), so age is the only other signal:
 * 28 days is four training weeks — long enough to cover the usual soft-tissue recovery (2–6 weeks) while the user
 * is still likely to be managing it, short enough that a note nobody ever resolved stops nagging a runner months
 * later. The chat coach is unaffected: it keeps honouring every ACTIVE injury as a hard constraint with no age limit.
 */
export const INJURY_CHECK_IN_WINDOW_DAYS = 28;

/** The reason `kind` the goal card uses for the check-in. */
export const INJURY_REASON_KIND = 'injury';

/** The longest injury text quoted in the line (the line is a sentence, not the whole memory fact). */
const INJURY_TEXT_MAX_CHARS = 40;

/** What the surfaces quote: the body part / short text, and the local day the user logged it. */
export interface InjuryCheckIn {
  /** Lower-case short text, e.g. "knee pain". */
  text: string;
  /** User-local day (YYYY-MM-DD) the fact was logged. */
  since: string;
}

export interface InjuryFactDay {
  label: string;
  /** User-local day (YYYY-MM-DD) the fact was logged (nodes.created_at). */
  loggedDay: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * The short text of an Injury fact's label: "Knee pain since Oct 20" -> "knee pain". The "since" clause is dropped (the
 * line dates the note by when it was logged, which is what "you noted" means), the first letter is lower-cased unless
 * the word is an acronym ("ACL tear"), and a long label is cut at a word. Null when nothing is left.
 */
export function injuryText(label: string): string | null {
  let text = label.replace(/\s+/g, ' ').trim();
  text = text.replace(/[\s,;:–—-]*\bsince\b.*$/i, '').trim();
  if (text === '') return null;
  const [first, second] = text;
  if (!(second !== undefined && second === second.toUpperCase() && second !== second.toLowerCase())) {
    text = first.toLowerCase() + text.slice(1);
  }
  if (text.length > INJURY_TEXT_MAX_CHARS) {
    const cut = text.slice(0, INJURY_TEXT_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    text = (space > 12 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '');
  }
  return text === '' ? null : text;
}

/**
 * The most recently logged injury inside the window, as of `todayKey`: logged on or before that day and no more than
 * INJURY_CHECK_IN_WINDOW_DAYS before it. Callers pass only ACTIVE, non-superseded facts about the user themself;
 * nothing is invented — no rows, blank labels and malformed days give null.
 */
export function pickInjuryCheckIn(rows: readonly InjuryFactDay[], todayKey: string): InjuryCheckIn | null {
  if (!DAY_RE.test(todayKey)) return null;
  const today = dayNumber(todayKey);
  let best: InjuryCheckIn | null = null;
  for (const row of rows) {
    if (!DAY_RE.test(row.loggedDay)) continue;
    const age = today - dayNumber(row.loggedDay);
    if (age < 0 || age > INJURY_CHECK_IN_WINDOW_DAYS) continue;
    const text = injuryText(row.label);
    if (text == null) continue;
    if (best == null || row.loggedDay > best.since) best = { text, since: row.loggedDay };
  }
  return best;
}

/**
 * Whether a goal's surfaces carry the line. Endurance and strength prescribe the sessions an injury changes (intervals,
 * long runs, heavy sets). General health only does when the user trains (a weekly sessions target or a logged session):
 * its card otherwise counts days active, meals and sleep. Weight loss never: its card and review speak of calories and the
 * scale — no session is prescribed, so a swap has nothing to attach to (the chat coach still knows about the injury).
 */
export function injuryCheckInApplies(goal: GoalKind, cues: { hasTrainingCues: boolean }): boolean {
  switch (goal) {
    case 'endurance':
    case 'muscle':
      return true;
    case 'general':
      return cues.hasTrainingCues;
    default:
      return false;
  }
}

const HARD_SESSIONS: Record<GoalKind, string> = {
  endurance: 'hard sessions (intervals, long runs)',
  muscle: 'hard sessions (heavy lifts)',
  general: 'hard sessions',
  weight_loss: 'hard sessions',
};

const CHECK_IN_TAIL = 'and see a professional if it persists.';

/**
 * The ONE check-in sentence, worded the same on the goal card, the weekly review, the coach brief and the opener.
 * "You noted" because the app only knows the user said it; "if it still hurts" because it does not know it does.
 */
export function injuryCheckInLine(goal: GoalKind, checkIn: InjuryCheckIn): string {
  return `You noted ${checkIn.text} on ${shortDay(checkIn.since)} — if it still hurts, swap ${HARD_SESSIONS[goal]} for easy work or rest, ${CHECK_IN_TAIL}`;
}

/**
 * `text` without the check-in sentence a surface appended to it. The weekly review stores its "Next week" text, and the next
 * review compares its own tip with it so no tip repeats two weeks running; the injury sentence is not a tip.
 */
export function stripInjuryCheckIn(text: string): string {
  const at = text.lastIndexOf(' You noted ');
  return at >= 0 && text.endsWith(CHECK_IN_TAIL) ? text.slice(0, at) : text;
}

/** `text` followed by the check-in sentence (a lone sentence when `text` is empty). */
export function appendInjuryCheckIn(text: string, line: string): string {
  return text.trim() === '' ? line : `${text} ${line}`;
}
