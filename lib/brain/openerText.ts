/**
 * Vital — goal-aware coach opener text (pure, no DB or Next.js imports)
 *
 * The coach's opening line (GET /api/coach/opener) must say where the user
 * stands against their goal, in one line, using the SAME deterministic
 * verdict the Trends/Today goal cards show (lib/goalProgress.ts). The line is
 * composed here — never by the model — so the numbers can't drift; the opener
 * route hands it to the model as the required first sentence and uses it
 * verbatim as the fallback when generation fails.
 */

import type { GoalKind, GoalProgress } from '../goalProgress';
import { KM_PER_MILE, LB_PER_KG } from '../metricFormat';
import type { UnitSystem } from '../units';

/** Same tolerance as iOS GoalProgressLogic.onPaceToleranceDays. */
const ON_PACE_TOLERANCE_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;
export const OPENER_INVITE = 'What would you like to dig into?';
/** A last weigh-in / session older than this makes the user a returning one: offer a reset, not a status line. */
export const RETURNING_AFTER_DAYS = 14;

function trimmed(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function weightAmount(kg: number, units: UnitSystem): string {
  return trimmed(Math.abs(units === 'imperial' ? kg * LB_PER_KG : kg));
}

function ymdToUtc(ymd: string | null | undefined): number | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** "Dec 30" from YYYY-MM-DD, or null. */
export function shortDate(ymd: string | null | undefined): string | null {
  const t = ymdToUtc(ymd);
  if (t == null) return null;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function paceClause(gp: GoalProgress): string | null {
  const target = shortDate(gp.target.date);
  const eta = ymdToUtc(gp.eta);
  const tdate = ymdToUtc(gp.target.date);
  if (!target || eta == null || tdate == null) return null;
  const days = Math.round((tdate - eta) / DAY_MS); // positive = ETA earlier than target
  if (Math.abs(days) <= ON_PACE_TOLERANCE_DAYS) return `right on pace for your ${target} target`;
  const weeks = Math.max(1, Math.round(Math.abs(days) / 7));
  const w = weeks === 1 ? 'week' : 'weeks';
  return days > 0
    ? `about ${weeks} ${w} ahead of your ${target} target`
    : `about ${weeks} ${w} behind your ${target} target`;
}

/**
 * One line stating the goal status, or null when there is no real progress
 * to state (needs_target / insufficient_data / nothing usable). Weight goals
 * with start, current and target compose "You're 1.7 of 7.7 kg down and about
 * 2 weeks ahead of your Dec 30 target."; every other state falls back to the
 * card's headline.
 */
export function goalOpenerLine(gp: GoalProgress | null | undefined, units: UnitSystem): string | null {
  if (!gp || gp.verdict === 'needs_target' || gp.verdict === 'insufficient_data') return null;
  const target = gp.target.weightKg;
  const start = gp.current.startWeightKg;
  const current = gp.current.weightKg;
  // Goal reached: congratulate and move on — never "0 of 0 down" or a pace clause.
  if (gp.verdict === 'reached' && target != null) {
    const unit = units === 'imperial' ? 'lb' : 'kg';
    return `You've reached ${weightAmount(target, units)} ${unit} — want to set a new target or switch to maintenance?`;
  }
  if (target != null && start != null && current != null) {
    const losing = target < start;
    const total = Math.abs(start - target);
    const done = Math.max(0, losing ? start - current : current - start);
    if (total > 0 && done > 0) {
      const unit = units === 'imperial' ? 'lb' : 'kg';
      const base = `You're ${weightAmount(done, units)} of ${weightAmount(total, units)} ${unit} ${losing ? 'down' : 'up'}`;
      const pace = paceClause(gp);
      return pace ? `${base} and ${pace}.` : `${base}.`;
    }
  }
  const headline = gp.headline?.trim().replace(/[.\s]+$/, '');
  return headline ? `Goal check-in: ${headline}.` : null;
}

const NEW_USER_GOAL: Record<GoalKind, { lead: string; ask: string }> = {
  weight_loss: { lead: 'Your goal is to lose weight.', ask: 'want to set a target weight?' },
  muscle: { lead: 'Your goal is to build muscle.', ask: 'want to set a target weight or a weekly session goal?' },
  endurance: { lead: 'Your goal is to build endurance.', ask: 'want to set a weekly distance goal?' },
  general: { lead: 'Your goal is general health.', ask: 'what would you like to start with?' },
};

/** Normalises a raw goal string to a GoalKind, or null when unknown/absent. */
export function parseGoalKind(raw: unknown): GoalKind | null {
  return raw === 'weight_loss' || raw === 'muscle' || raw === 'endurance' || raw === 'general' ? raw : null;
}

/**
 * Returning-user opener: the last weigh-in (weight-loss goals) or session (every
 * other goal) is more than RETURNING_AFTER_DAYS ago, so the useful move is a
 * quick reset, not a status line about a trend that has gone cold. Null for
 * everyone else. Ends in a question.
 */
export function returningUserOpener(gp: GoalProgress | null | undefined): string | null {
  if (!gp) return null;
  if (gp.goal === 'weight_loss') {
    const days = gp.lastWeighInDaysAgo;
    if (days != null && days > RETURNING_AFTER_DAYS) {
      return `Welcome back — your last weigh-in was ${days} days ago. Want a quick reset plan?`;
    }
    return null;
  }
  const days = gp.lastSessionDaysAgo;
  if (days != null && days > RETURNING_AFTER_DAYS) {
    return `Welcome back — your last session was ${days} days ago. Want a quick reset plan?`;
  }
  return null;
}

function distanceAmount(km: number, units: UnitSystem): string {
  return trimmed(units === 'imperial' ? km / KM_PER_MILE : km);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "a", "a and b", "a, b and c". */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Every target the user already has, as short phrases: the target weight (with
 * its date), a weekly distance, sessions a week and an upcoming race. Empty when
 * none is set (or there is no progress object).
 */
function existingTargetPhrases(gp: GoalProgress | null | undefined, units: UnitSystem): string[] {
  if (!gp) return [];
  const parts: string[] = [];
  const { weightKg, date, weeklyDistanceKm, weeklySessions } = gp.target;
  if (weightKg != null) {
    const by = shortDate(date);
    parts.push(`${weightAmount(weightKg, units)} ${units === 'imperial' ? 'lb' : 'kg'}${by ? ` by ${by}` : ''}`);
  }
  if (weeklyDistanceKm != null) parts.push(`${distanceAmount(weeklyDistanceKm, units)} ${units === 'imperial' ? 'mi' : 'km'} a week`);
  if (weeklySessions != null) parts.push(`${weeklySessions} ${weeklySessions === 1 ? 'session' : 'sessions'} a week`);
  const race = gp.race;
  const raceDay = shortDate(race?.date);
  if (race && raceDay) parts.push(`the ${lowerFirst(race.label)} on ${raceDay}`);
  return parts;
}

/**
 * Opener for a user with no progress to report yet but a known goal (collected
 * in onboarding): states the goal and every target already set (weight, weekly
 * distance, sessions a week, race) instead of asking for them. It only asks for
 * a target the goal needs and the user has not set (a weight-loss goal without a
 * target weight, or any goal with no target at all). Null when the goal is unknown.
 */
export function newUserGoalOpener(goal: unknown, gp?: GoalProgress | null, units: UnitSystem = 'metric'): string | null {
  const kind = parseGoalKind(goal);
  if (!kind) return null;
  const g = NEW_USER_GOAL[kind];
  const targets = existingTargetPhrases(gp, units);
  const tail = "Once you've logged a few days I'll tell you how it's going";
  if (targets.length > 0) {
    // Only a weight-loss goal without a target weight still needs asking; any
    // other goal with a target set has what it needs.
    const stillAsk = kind === 'weight_loss' && gp?.target.weightKg == null;
    return `Your goal: ${joinList(targets)}. ${tail}${stillAsk ? ` — ${g.ask}` : '.'}`;
  }
  return `${g.lead} ${tail} — ${g.ask}`;
}

/** The required first sentence(s) of the opener, or null when nothing goal-specific is known. */
export function requiredOpenerLine(gp: GoalProgress | null | undefined, goal: unknown, units: UnitSystem): string | null {
  return returningUserOpener(gp) ?? goalOpenerLine(gp, units) ?? newUserGoalOpener(gp?.goal ?? goal, gp, units);
}

/** Deterministic opener used when the model call fails. Null means the caller keeps its generic fallback. */
export function goalFallbackOpener(gp: GoalProgress | null | undefined, goal: unknown, units: UnitSystem): string | null {
  // These two already end in their own question; no second invitation.
  const own = returningUserOpener(gp) ?? (gp?.verdict === 'reached' ? goalOpenerLine(gp, units) : null);
  if (own) return own;
  const line = goalOpenerLine(gp, units);
  if (line) return `${line} ${OPENER_INVITE}`;
  return newUserGoalOpener(gp?.goal ?? goal, gp, units);
}
