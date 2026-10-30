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
import { liftLapseMinDays } from '../liftChange';
import { KM_PER_MILE, LB_PER_KG } from '../metricFormat';
import { PACE_SETTLE_DAYS, relationForDays, weeksForDays } from '../weightPace';
import { REACHED_ASK_DAYS, stepVerb } from '../weightWeekPlan';
import type { UnitSystem } from '../units';

/**
 * The one on-pace margin (lib/weightPace.ts ON_PACE_MARGIN_DAYS, 7 days): the goal
 * card's verdict, iOS GoalProgressLogic.onPaceToleranceDays and this opener all
 * call an ETA within it "on pace", so the three can never word one date differently.
 */
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

/** A weekly rate to one decimal, "about 0.6 kg a week" (wave 23w) - the very figure the card's headline prints; the rate line keeps its two decimals. */
function rateAmount(kgPerWeek: number, units: UnitSystem): string {
  return weightAmount(Math.abs(kgPerWeek), units);
}

/** One fixed decimal ("84.0"), for the weight a reached goal holds at. */
function weightFixed(kg: number, units: UnitSystem): string {
  return Math.abs(units === 'imperial' ? kg * LB_PER_KG : kg).toFixed(1);
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

/** A reached weight inside this many kg of the target is "within 1 kg of 84 kg" (goalProgress HOLDING_NEAR_TARGET_KG). */
const HOLDING_RANGE_KG = 1;

/**
 * "right on pace for your Dec 30 target" / "about 2 weeks ahead of ..." / "... behind ...".
 * Read off the card's stated ETA with the card's own margin (ON_PACE_MARGIN_DAYS, via
 * relationForDays) and the same whole-week rounding iOS prints, so the opener and the
 * card say the same thing. A weight-loss card that made no ahead/behind call (early read,
 * too fast, stalled, pace not yet confirmed...) states no ETA, so no clause.
 */
function paceClause(gp: GoalProgress): string | null {
  const target = shortDate(gp.target.date);
  const eta = ymdToUtc(gp.eta);
  const tdate = ymdToUtc(gp.target.date);
  if (!target || eta == null || tdate == null) return null;
  // Only the verdicts that are a pace call may carry one.
  if (gp.goal === 'weight_loss' && gp.verdict !== 'on_track' && gp.verdict !== 'ahead' && gp.verdict !== 'behind') return null;
  const days = Math.round((tdate - eta) / DAY_MS); // positive = ETA earlier than target
  const relation = relationForDays(days);
  if (relation === 'on_pace') return `right on pace for your ${target} target`;
  const weeks = weeksForDays(days);
  const w = weeks === 1 ? 'week' : 'weeks';
  return relation === 'ahead'
    ? `about ${weeks} ${w} ahead of your ${target} target`
    : `about ${weeks} ${w} behind your ${target} target`;
}

/** The ONE progress weight (the card's, the coach's): the 7-day average, else the latest scale reading, else the smoothed trend of an older payload. */
function progressKg(gp: GoalProgress): number | null {
  const read = gp.weightRead;
  return read?.weekMeanKg ?? read?.scaleKg ?? gp.current.weightKg;
}

/**
 * Where the progress weight sits against the start, in one clause: "Your weekly average is 0.9 kg below your start" once there is a weekly average,
 * and "You're 0.9 of 8 kg down on the scale" for a single reading - never "0.9 of 8 kg down on your weekly average" (an average of a week is not
 * "down" a share of the goal). `base` is "You're X of Y kg down".
 */
function averageAgainstStart(gp: GoalProgress, done: number, base: string, units: UnitSystem): string {
  if (gp.weightRead?.weekMeanKg == null) return `${base} on the scale`;
  return `Your weekly average is ${weightAmount(done, units)} ${units === 'imperial' ? 'lb' : 'kg'} below your start`;
}

/** The reach, in a few words, for the opener that congratulates: how much is down and how far ahead of the target date it came. */
function reachCelebration(gp: GoalProgress, target: number, units: UnitSystem): string {
  const parts: string[] = [];
  const start = gp.current.startWeightKg;
  // How far down the weekly average really is (the figure the card prints as "-7.8 kg since start"), never the size of the goal (wave 23w).
  const down = gp.current.changeKg != null && gp.current.changeKg < 0 ? -gp.current.changeKg : start != null ? start - target : 0;
  if (down > 0) parts.push(`${weightAmount(down, units)} ${units === 'imperial' ? 'lb' : 'kg'} down`);
  const reached = ymdToUtc(gp.reachedAt);
  const dated = ymdToUtc(gp.target.date);
  const early = reached != null && dated != null ? Math.round((dated - reached) / DAY_MS / 7) : 0;
  const date = shortDate(gp.target.date);
  if (early >= 1 && date) parts.push(`${early} ${early === 1 ? 'week' : 'weeks'} ahead of your ${date} date`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** What comes next while the pace is not read: a young goal's pace settles after 3 weeks, an older one is a few weigh-ins away. */
function paceWaitClause(gp: GoalProgress): string {
  const age = gp.weightRead?.goalAgeDays;
  // The week's plan is made on the Monday: a goal that turned 3 weeks old since reads its pace on the next one.
  if (gp.weightRead?.plan?.young && age != null && age >= PACE_SETTLE_DAYS) return 'your pace is read on Monday';
  return age != null && age >= PACE_SETTLE_DAYS ? 'a few more weigh-ins and your pace is back' : 'your pace settles after 3 weeks';
}

/**
 * True when the reached opener still asks about a new target or maintenance (so it ends in its own question). The week's plan
 * (lib/weightWeekPlan.ts) owns that window - REACHED_ASK_DAYS after the reach - and the card, the coach lines and the weekly review
 * read it from there: the opener asks exactly when the plan's action is the new-target one, never on a window of its own.
 */
function reachedAsks(gp: GoalProgress | null | undefined): boolean {
  if (!gp || gp.verdict !== 'reached' || gp.target.weightKg == null) return false;
  // Payloads from before `weightRead` always ask.
  if (gp.weightRead == null) return true;
  const plan = gp.weightRead.plan;
  if (plan != null) return plan.action.kind === 'next_target';
  // A payload with `weightRead` but no plan: the same window, from the same constant.
  const daysAgo = gp.weightRead.reachedDaysAgo;
  return daysAgo != null && daysAgo <= REACHED_ASK_DAYS;
}

/** "2,150–2,200 kcal" / "2,150 kcal": a daily level in the opener's plain spaces. */
function kcalRange(lo: number, hi: number): string {
  const f = (n: number): string => Math.round(n).toLocaleString('en-US');
  return lo === hi ? `${f(hi)} kcal` : `${f(lo)}–${f(hi)} kcal`;
}

/**
 * The reach is congratulated on the day it happens and on the Monday after it (wave 23w) - the question stays open all week, the
 * confetti does not. The payload has no date of its own: today is the reach day plus `reachedDaysAgo`.
 */
function celebratesReach(gp: GoalProgress): boolean {
  const reachedAt = ymdToUtc(gp.reachedAt);
  const daysAgo = gp.weightRead?.reachedDaysAgo;
  if (reachedAt == null || daysAgo == null) return true; // a payload from before the date: the plain celebration it always had
  if (daysAgo === 0) return true;
  const weekday = new Date(reachedAt + daysAgo * DAY_MS).getUTCDay();
  return weekday === 1 && daysAgo <= 6;
}

/** The question a lapse check-in ends in. */
const LAPSE_ASK = 'Want to plan how to get back in?';

/**
 * A lifter past the lapse threshold (the card's "No sessions for 4 days",
 * verdict holding; the threshold scales to the weekly target, 4 days for 4 a
 * week, a week for 2 or none): the opener states the lapse and ends in its own
 * question, for as long as the lifter is away — "Welcome back" waits for the
 * first session back (`firstSessionBack`).
 */
function lapseAsks(gp: GoalProgress | null | undefined): boolean {
  const days = gp?.lastSessionDaysAgo;
  return gp?.goal === 'muscle' && gp.verdict === 'holding' && days != null && days >= liftLapseMinDays(gp.target.weeklySessions);
}

/**
 * The lifter's first session back after a break (the payload's `liftReturn`:
 * 10+ days off, ended yesterday relative to that session): the only moment a
 * muscle opener says "Welcome back". It lasts until the second session, and at
 * most through the next day.
 */
function firstSessionBack(gp: GoalProgress): number | null {
  const ret = gp.liftReturn;
  const last = ymdToUtc(gp.lastSessionOn);
  const ended = ymdToUtc(ret?.endedOn);
  if (!ret || last == null || ended == null || gp.lastSessionDaysAgo == null || gp.lastSessionDaysAgo > 1) return null;
  return Math.round((last - ended) / DAY_MS) === 1 ? ret.breakDays : null;
}

/**
 * One line stating the goal status, or null when there is no real progress
 * to state (needs_target / insufficient_data / nothing usable). Weight goals
 * with start, current and target compose "You're 1.7 of 7.7 kg down and about
 * 2 weeks ahead of your Dec 30 target."; every other state falls back to the
 * card's headline. Early reads, a return after a gap and a plateau say so
 * instead of naming a pace; a reached goal asks about a new target or
 * maintenance for its first days only, then reports where the weight holds.
 */
export function goalOpenerLine(gp: GoalProgress | null | undefined, units: UnitSystem): string | null {
  if (!gp || gp.verdict === 'needs_target' || gp.verdict === 'insufficient_data') return null;
  const target = gp.target.weightKg;
  const start = gp.current.startWeightKg;
  const unit = units === 'imperial' ? 'lb' : 'kg';
  // Goal reached: congratulate and move on — never "0 of 0 down" or a pace clause.
  if (gp.verdict === 'reached' && target != null) {
    if (reachedAsks(gp)) {
      // A fat-loss reach is celebrated, with how far it came (wave 22w) - on the reach day and the Monday after it, not every day of the
      // question (wave 23w); the other days it is the plain ask, as for other goals' weight targets.
      if (gp.goal === 'weight_loss' && celebratesReach(gp)) {
        return `Congratulations — you've reached ${weightAmount(target, units)} ${unit}${reachCelebration(gp, target, units)}. Want to set a new target or switch to maintenance?`;
      }
      return `You've reached ${weightAmount(target, units)} ${unit} — want to set a new target or switch to maintenance?`;
    }
    const plan = gp.weightRead?.plan;
    const holdKg = gp.weightRead?.weekMeanKg ?? gp.weightRead?.scaleKg ?? gp.current.weightKg;
    // The step toward maintenance (or the level it settled on) stands from the week after it was given (wave 23w): one short sentence, not the
    // plan's whole instruction again.
    const step = plan?.step;
    if (plan != null && step != null && (step.phase === 'standing' || step.phase === 'settled') && holdKg != null && Math.abs(holdKg - target) <= HOLDING_RANGE_KG) {
      const at = Math.round(holdKg * 10) === Math.round(target * 10) ? weightAmount(target, units) : weightFixed(holdKg, units);
      // "Stay around" a level the logs show (or the named maintenance it settled on), "aim for" it until they do (wave 25w: the plan's own `step.logsShow`).
      const verb = stepVerb(step.phase === 'settled' || step.logsShow === true) === 'stay at' ? 'stay around' : 'aim for';
      const level = step.loKcal != null && step.hiKcal != null ? `${verb} ~${kcalRange(step.loKcal, step.hiKcal)}` : 'keep your daily snack';
      return `You're holding at ${at} ${unit} — ${level} this week and keep weighing in.`;
    }
    // The plan has a calorie instruction for a reached goal (a held weight on real intake made the maintenance target, or the
    // target already is maintenance): say it in the plan's words, as the card's last reason does (lib/weightWeekPlan.ts) - without the
    // date the step is read on, which the card carries.
    if (plan != null && (plan.action.kind === 'maintenance_target' || (plan.action.kind === 'hold' && plan.action.kcalTarget != null))) {
      return `${plan.action.text.replace(/;\s*we'll read it on .*$/, '').replace(/[.\s]+$/, '')}.`;
    }
    if (holdKg != null) {
      const diff = holdKg - target;
      if (Math.abs(diff) <= HOLDING_RANGE_KG) {
        // Exactly on the target "within 1 kg of 84 kg" says it twice (wave 22w).
        if (Math.round(holdKg * 10) === Math.round(target * 10)) return `Holding at your ${weightAmount(target, units)} ${unit} target.`;
        return `Holding at ${weightFixed(holdKg, units)} ${unit}, within ${weightAmount(HOLDING_RANGE_KG, units)} ${unit} of ${weightAmount(target, units)} ${unit}.`;
      }
      return `At ${weightFixed(holdKg, units)} ${unit}, ${weightAmount(Math.abs(diff), units)} ${unit} ${diff < 0 ? 'under' : 'over'} your ${weightAmount(target, units)} ${unit} target.`;
    }
  }
  const read = gp.weightRead;
  // Back after 7+ days without a weigh-in: lead with what the scale says since.
  // (Until 3 weigh-ins are back — the card's "returning" state — not only on the very first one.)
  if (gp.goal === 'weight_loss' && read?.state === 'returning' && read.returned && read.scaleKg != null) {
    const since = shortDate(read.returned.sinceDay);
    const delta = read.returned.sinceKg - read.scaleKg;
    if (since) {
      // One short clause (wave 24w): where the scale stands against the last weigh-in, and what to do. "Progress now counts from your latest
      // reading" is the card's own pace note, not the opener's.
      const change = Math.abs(delta) < 0.1
        ? `your weight is about the same as on ${since}`
        : `you're ${weightAmount(Math.abs(delta), units)} ${unit} ${delta > 0 ? 'lighter' : 'heavier'} than on ${since}`;
      return `Welcome back — ${change}; weigh in a couple more mornings.`;
    }
  }
  const current = progressKg(gp);
  if (target != null && start != null && current != null) {
    const losing = target < start;
    const total = Math.abs(start - target);
    const done = Math.max(0, losing ? start - current : current - start);
    if (total > 0 && done > 0) {
      const base = `You're ${weightAmount(done, units)} of ${weightAmount(total, units)} ${unit} ${losing ? 'down' : 'up'}`;
      if (gp.goal === 'weight_loss') {
        // The week began with no weigh-in for 7+ days (wave 22w): say so, whatever the plan carried from before.
        const staleSince = shortDate(read?.plan?.staleSince);
        if (staleSince) return `${averageAgainstStart(gp, done, base, units)} as of ${staleSince}; step on the scale when you can.`;
        if (read?.state === 'early' || read?.state === 'returning') return `${averageAgainstStart(gp, done, base, units)}; ${paceWaitClause(gp)}.`;
        if (read?.state === 'plateau') {
          // Two flat weeks after a confirmed loss (wave 22w) are common and not yet a plateau.
          // It is the weekly average that is flat (wave 23w): the scale itself still wiggles by a few hundred grams.
          return read.plan?.flatWeeks === 2
            ? `${base}; your weekly average has been flat for 2 weeks, which is common.`
            : `${base}, though your weekly average has been flat for 3 weeks.`;
        }
        // The week's plan (lib/weightWeekPlan.ts) says what the scale is doing; the opener only repeats it.
        if (read?.state === 'moving_again') return `${base}, and your weekly average is moving down again.`;
        if (read?.plan?.farBehind && target != null) {
          const date = shortDate(gp.target.date);
          if (date) return `${base}, but at this rate your ${date} date won't hold.`;
        }
        if (gp.verdict === 'too_fast') return `${base}, but losing faster than is easy to keep.`;
        if (gp.verdict === 'stalled') return `${base}, but your weight has been flat lately.`;
        if (gp.verdict === 'progressing' && gp.ratePerWeek.kg != null && gp.ratePerWeek.kg < 0) {
          return `${base} and losing about ${rateAmount(gp.ratePerWeek.kg, units)} ${unit} a week.`;
        }
      }
      const pace = paceClause(gp);
      return pace ? `${base} and ${pace}.` : `${base}.`;
    }
  }
  const headline = gp.headline?.trim().replace(/[.\s]+$/, '');
  if (!headline) return null;
  // A week or more without a session: the check-in is the lapse, and it asks about getting back in.
  if (lapseAsks(gp)) return `Goal check-in: ${headline}. ${LAPSE_ASK}`;
  // A runner on a break: say "On a break" once and where to restart — the card counts the days, the opener does not.
  const breakLine = onBreakOpener(gp, headline);
  if (breakLine) return breakLine;
  // A headline that ends in its own "!" ("... Congratulations!") keeps it; no "!." after it.
  const endsLoud = gp.headline.trim().endsWith('!');
  return endsLoud ? `Goal check-in: ${gp.headline.trim()}` : `Goal check-in: ${headline}.`;
}

/**
 * The opener for an endurance runner on a break or in the restart week after one. The card's headline counts the
 * break up day by day ("On a break — 8 days since your last run. Restart at ~13 km."); the opener says it once, with
 * no count, and welcomes the runner back only after the first run back ("Building back — restart at ~13 km this week").
 */
function onBreakOpener(gp: GoalProgress, headline: string): string | null {
  if (gp.goal !== 'endurance') return null;
  const onBreak = /^On a break — \d+ days? since your last run\.\s*(Restart at .+)$/.exec(headline);
  if (onBreak) return `Goal check-in: On a break — ${lowerFirst(onBreak[1])}.`;
  const back = /^Building back — (restart at .+)$/.exec(headline);
  if (back) {
    // Welcome back means a run is back; before the week's first run it is still the plain restart line.
    const ran = (gp.distance?.thisWeekKm ?? 0) > 0;
    return ran ? `Welcome back — ${back[1]}.` : `Goal check-in: Building back — ${back[1]}.`;
  }
  return null;
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
 * quick reset, not a status line about a trend that has gone cold. A lifter
 * (muscle goal) is welcomed back only on the first session after a break; while
 * still away the opener is the lapse check-in, or a plain "it's been N days"
 * offer when the card has no lift to date. Null for everyone else. Ends in a
 * question.
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
  // A runner whose card already shows the restart plan (on a break, or in the restart week) is not offered another one.
  if (gp.goal === 'endurance' && (gp.distance?.plan?.kind === 'restart' || /^(On a break|Building back)\b/.test(gp.headline ?? ''))) return null;
  if (gp.goal === 'muscle') {
    // "Welcome back" is for the first session back, never for a lifter still away: a lapse keeps the lapse check-in
    // ("No sessions for 15 days — Squat was … Want to plan how to get back in?", goalOpenerLine), and a lapse the card
    // has no lift to date (no e1RM yet) gets the plain "it has been N days" reset offer.
    const away = gp.lastSessionDaysAgo;
    const brokeDays = firstSessionBack(gp);
    if (brokeDays != null) return `Welcome back — your first session after ${brokeDays} days off. Want a quick plan to build back up?`;
    if (away != null && away > RETURNING_AFTER_DAYS && !lapseAsks(gp)) return `It's been ${away} days since your last session. Want a quick reset plan?`;
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
  // A race that is already done (recovery) is not a target the user still has.
  if (race && raceDay && race.phase !== 'recovery') parts.push(`the ${lowerFirst(race.label)} on ${raceDay}`);
  return parts;
}

/**
 * The closing clause of the new-user opener. A lifter who has already logged
 * sessions is no longer "yet to log a few days": the muscle card is waiting on
 * its first 4-week lift trend, so say how many sessions are in and when the
 * trend starts (the date is the one in the card's own headline, "4-week lift
 * trend from Mar 30").
 */
function newUserTail(kind: GoalKind, gp?: GoalProgress | null): string {
  const generic = "Once you've logged a few days I'll tell you how it's going";
  const sessions = gp?.dataSufficiency?.sessionsLast28d ?? 0;
  if (kind !== 'muscle' || gp?.goal !== 'muscle' || sessions < 2) return generic;
  const date = /^4-week lift trend from (.+?)\s*$/.exec(gp.headline)?.[1] ?? null;
  const logged = `You've logged ${sessions} sessions so far`;
  return date ? `${logged} — your 4-week lift trend starts ${date}` : `${logged}, so I'll have a read on how it's going soon`;
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
  const tail = newUserTail(kind, gp);
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
  // These two already end in their own question (a reached goal's only while it still asks); no second invitation.
  const own = returningUserOpener(gp) ?? (reachedAsks(gp) || lapseAsks(gp) ? goalOpenerLine(gp, units) : null);
  if (own) return own;
  const line = goalOpenerLine(gp, units);
  if (line) return `${line} ${OPENER_INVITE}`;
  return newUserGoalOpener(gp?.goal ?? goal, gp, units);
}
