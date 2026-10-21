/**
 * Vital — the weight-loss WEEK PLAN (pure, no DB or Next.js imports)
 *
 * Endurance decides the week's job once, from the week's Monday
 * (lib/enduranceProgression.ts `enduranceWeekPlan`), and the card, the weekly
 * review and the coach all read that one plan. Weight loss had no such thing:
 * the verdict, the date and the calorie advice were recomputed DAILY from a
 * sliding 21-day window, so each round of fixes added a new swing (a date that
 * moved 30 weeks in a day, a trim that changed ten times in three weeks, a card
 * and a review giving opposite instructions).
 *
 * `weightWeekPlan` is that plan. It is computed from the weigh-ins through the
 * SUNDAY BEFORE the week (and, in the first days of a goal, as of the goal
 * start), so it is the same every day of the week:
 *  - `state`   early | pace | plateau | moving_again | returning | reached | maintenance
 *  - `call`    ahead | on_pace | behind | too_fast | none
 *  - `etaDate` / `weeksVsTarget` the date the week states (none when far behind)
 *  - `action`  the ONE thing to do this week (`kind`, `text`, `kcalTarget?`)
 *  - `plateauCause` why a plateau is flat, judged over the plateau's own weeks
 *    and kept for as long as it lasts
 *
 * Daily-changing FACTS still update daily on the card (the weekly average, the
 * kilos to go, the weigh-in count, today's scale): they are not part of the plan.
 *
 * The state may change mid-week only for events, each at most once a week:
 *  - the target is reached;
 *  - welcome back, after a gap of 7+ days without a weigh-in;
 *  - "losing too fast" enters (the existing hysteresis, lib/weightPace.ts);
 *  - a plan that had no pace for want of weigh-ins gets its first one (the plan
 *    is then made as of that day).
 *
 * The card (lib/goalProgress.ts), the opener (lib/brain/openerText.ts), the coach
 * lines (lib/goalPromptText.ts) and the weekly review (lib/weeklyReview.ts) read
 * this plan and nothing else for the call and the action.
 */

import type { GoalVerdict } from './goalProgress';
import { withUnit } from './displayText';
import { weekStartKeyForDay } from './localDay';
import type { WeightTrendDay } from './weightTrend';
import {
  PACE_RECHECK_DAYS,
  PACE_SETTLE_DAYS,
  PLATEAU_MIN_WEIGH_INS_PER_WEEK,
  PLATEAU_TOLERANCE_KG,
  WEIGH_IN_GAP_DAYS,
  addDays,
  bridgedPace,
  dayNumber,
  etaDaysAhead,
  isReturning,
  meanOver,
  paceEta,
  rawPlateau,
  relationForDays,
  tooFastLoss,
  weeksForDays,
  weighInReturn,
  type PaceRelation,
  type RawPlateau,
  type WeighInReturn,
  type WeightPace,
} from './weightPace';
import { PARTIAL_LOG_KCAL_THRESHOLD, PLATEAU_MAX_PCT_PER_WEEK, TOO_FAST_LOSS_PCT_PER_WEEK } from './brain/weightSignals';

// ── Thresholds ──────────────────────────────────────────────────────────────

/** The safe weekly loss band, % of bodyweight per week (the ceiling is the "too fast" line). */
export const FAT_LOSS_MIN_PCT = 0.25;
export const FAT_LOSS_MAX_PCT = TOO_FAST_LOSS_PCT_PER_WEEK;
/** A projection beyond this many days is not a date. */
const MAX_ETA_DAYS = 3650;
/** Weigh-ins in the 7 days up to a day needed before a weekly mean is quoted. */
export const WEEK_MEAN_MIN_WEIGH_INS = 3;
/** The call a weigh-in day states is settled by the weigh-ins of this many days up to it (about six weeks). */
const CLAIM_WALK_DAYS = 42;
/** A projection this many days past the target date (8 weeks) is not worth quoting: the date will not hold. */
export const FAR_BEHIND_DAYS = 56;
/** "Moving again" lasts this many days after the last day of a plateau. */
export const MOVING_AGAIN_DAYS = 14;
/** A reached weight within this many kg of the target is "holding" (goalProgress HOLDING_NEAR_TARGET_KG). */
export const HOLDING_NEAR_TARGET_KG = 1;
/**
 * "Set a new target or switch to maintenance" is asked in every plan week whose Monday is less than this many days after the target was
 * reached (the week it was reached in included): it ends on a Sunday night, never on a day in the middle of a week (wave 22w).
 */
export const REACHED_ASK_DAYS = 7;
/** "Nearly there" is called on the week's Monday, not only once "too fast" enters: within a kilo of the target while losing this % of bodyweight a week or more. */
export const NEARLY_THERE_MIN_PCT_PER_WEEK = 0.75;

/** A suggested trim is rounded to this many kcal a day (and never under it)... */
const TRIM_ROUND_KCAL = 50;
/** ...one weekly step is never more than this... */
export const TRIM_MAX_KCAL_PER_STEP = 200;
/**
 * ...and it is ONE size: the behind pace's trim and a plateau's trim are both this step, so a week that says "trim ~200" is never
 * followed by one that says "trim ~150" (wave 22w). Only a budget near its floor shrinks it.
 */
export const TRIM_STEP_KCAL = 150;
/** A flat fortnight: two flat 7-day means after a loss pace that was confirmed this many days before (wave 22w). */
export const FLAT_FORTNIGHT_DAYS = 14;
/** A user "logs food" when this many days in the 3 weeks up to the plan's Sunday carry a logged intake; below it a kcal trim cannot be checked. */
export const LOGGING_MIN_DAYS = 3;
const LOGGING_LOOKBACK_DAYS = 21;
/** The calorie floor when the budget carries none: men, women, and when the profile says neither. */
const FLOOR_KCAL_MALE = 1500;
const FLOOR_KCAL_FEMALE = 1200;
const FLOOR_KCAL_UNKNOWN = 1400;

/** A plateau's cause is judged over its own span: the three weeks it was flat. */
export const PLATEAU_SPAN_DAYS = 21;
/** Logged days (in that span) needed before the logs are allowed to name a cause. */
export const PLATEAU_MIN_LOGGED_DAYS = 8;
/** Logged days within this many kcal of the target (on average) are not the cause. */
export const PLATEAU_INTAKE_NEAR_KCAL = 150;
/** Weekends this many kcal over the weekdays are the cause. */
export const PLATEAU_WEEKEND_OVER_KCAL = 300;
const PLATEAU_MIN_WEEKEND_DAYS = 3;
const PLATEAU_MIN_WEEKDAY_DAYS = 6;
/** The plateau's anchors are looked for this many weeks back (the intake history is about ten weeks). */
const PLATEAU_MAX_WEEKS_BACK = 8;

/** The weekly average that has held within a kilo for this many days, with logged intake on this many, names a maintenance target. */
export const MAINTENANCE_HELD_DAYS = 14;
export const MAINTENANCE_MIN_LOGGED_DAYS = 8;
/** A budget this close to the intake the weight held on (after rounding to 50) already is the maintenance target. */
const MAINTENANCE_ALREADY_KCAL = 25;
/** A calorie target within this many kcal of the formula maintenance estimate (or above it) is already a maintenance budget. */
const MAINTENANCE_BUDGET_MARGIN_KCAL = 100;
/** The step toward maintenance (wave 22w): add this many kcal a day to the budget (capped at the TDEE estimate), then watch the weekly average. */
export const MAINTENANCE_STEP_LO_KCAL = 150;
export const MAINTENANCE_STEP_HI_KCAL = 200;
/** The step is the plan's instruction until this many days after the target was reached (counted on the week's Monday): add, watch 2 weeks, once more. */
export const MAINTENANCE_STEP_DAYS = 21;

const KG_TO_LB = 2.20462;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Types ───────────────────────────────────────────────────────────────────

export type WeightPlanState = 'early' | 'pace' | 'plateau' | 'moving_again' | 'returning' | 'reached' | 'maintenance';
export type WeightPlanCall = 'ahead' | 'on_pace' | 'behind' | 'too_fast' | 'none';

export type WeightPlanActionKind =
  /** Nothing to change: keep weighing in (early read, welcome back, a pace that is not confirmed yet). */
  | 'keep_weighing'
  /** The first pace is read; the date shows once another week confirms it. */
  | 'confirm_pace'
  /** Ahead / on pace: keep the routine. */
  | 'keep_going'
  /** Behind: move the date or trim a step. */
  | 'trim'
  | 'move_date'
  /** Losing too fast: eat up to the full calorie target. */
  | 'eat_to_target'
  /** Within a kilo of the target and still losing fast: start easing toward maintenance (with the step: "add ~150-200 kcal a day"). */
  | 'ease_to_maintenance'
  | 'plateau_water'
  | 'plateau_intake'
  | 'plateau_weekends'
  /** The scale is moving again after a plateau. */
  | 'keep_what_worked'
  /** The target was just reached: set a new one or switch to maintenance. */
  | 'next_target'
  /** Held the weight on real intake: make that the maintenance target - or, before there is intake to read, the step toward it (wave 22w). */
  | 'maintenance_target'
  /** Nothing to do: hold. */
  | 'hold';

export interface WeightPlanAction {
  kind: WeightPlanActionKind;
  text: string;
  /** The daily calorie target the action lands on ("trim to ~1,800", "eat 2,000", "maintain 2,050"). */
  kcalTarget?: number;
}

export type PlateauCauseKind = 'water' | 'intake' | 'weekends';

/** Why a plateau is flat, as the logs of its own weeks read; kept for as long as the plateau lasts. */
export interface WeightPlateauCause {
  kind: PlateauCauseKind;
  /** The Sunday the cause was named at (the plateau's first week, or the first one with enough logs). */
  namedAt: string;
  /** Logged days the judgement rests on (0 for water). */
  loggedDays: number;
  /** Days of logs the judgement covers: PLATEAU_SPAN_DAYS for a plateau, FLAT_FORTNIGHT_DAYS for a flat fortnight (additive, wave 22w). */
  spanDays?: number;
  /** Mean of the logged days, kcal; null for water. */
  avgKcal: number | null;
  targetKcal: number | null;
  /** Weekends only. */
  weekendAvgKcal?: number;
  weekdayAvgKcal?: number;
}

export interface WeightPlanPace {
  kgPerWeek: number;
  pctPerWeek: number;
  /** Days the line was fitted over (21; 28 while a gap is bridged). */
  windowDays: number;
}

export interface WeightWeekPlan {
  /** Monday of the week the plan covers. */
  weekStart: string;
  /** The last day of weigh-ins the plan read: the Sunday before the week, or the day an in-week event re-made it. */
  asOf: string;
  state: WeightPlanState;
  call: WeightPlanCall;
  /** The goal-card verdict this plan makes (an iOS-known value). */
  verdict: GoalVerdict;
  /** The date the week states; null when none is (early, plateau, moving again, far behind...). */
  etaDate: string | null;
  /** Weeks the stated date is ahead (+) / behind (−) the target date; null when no date is stated. */
  weeksVsTarget: number | null;
  action: WeightPlanAction;
  plateauCause: WeightPlateauCause | null;
  /** The pace the week states (kg/wk): null for an early read, a return, "moving again". */
  pace: WeightPlanPace | null;
  /** A pace that a pace a week earlier confirms (the date may be stated). */
  confirmed: boolean;
  /** The goal is younger than 3 weeks as of `asOf`: only an early read. */
  young: boolean;
  /** On pace for the target date (false: behind or the wrong way); null without a target date. */
  onPace: boolean | null;
  tooFast: boolean;
  /** Within a kilo of the target while losing fast (too fast, or 0.75%+ a week): start easing toward maintenance. Called on the Monday. */
  nearlyThere: boolean;
  /** No target date: both paces are under the safe band's floor. */
  slow: boolean;
  /** The pace points away from the target. */
  away: boolean;
  /** The projection is more than 8 weeks past the target date: no date is stated. */
  farBehind: boolean;
  /** The month the projection lands in (far behind only, and only when it can be projected). */
  projectedEta: string | null;
  /** Plateau / moving again: the weekly average the plateau held at (rounded to 0.1 kg once, here, as every surface prints it). */
  plateauMeanKg: number | null;
  /**
   * Plateau only (additive, wave 22w): how many flat weekly means the state rests on: 3 for a plateau, 2 for a flat fortnight (two flat
   * weeks after a confirmed loss: a calm hold, not "behind"). Null in every other state.
   */
  flatWeeks: number | null;
  /** Maintenance: the weekly average it held at. */
  heldKg: number | null;
  /** The first week a pace is read: the one place the smoothed trend gets its one-line explanation. */
  firstPaceWeek: boolean;
  /**
   * Additive (wave 22w). The plan was re-made INSIDE its calendar week by an event (target reached, welcome back, "too fast" entering,
   * the first pace, the plateau ending, closing in on the target): the day it happened and why, in a few words ("losing over 1%/wk").
   * The coach lines say "updated Tue Jun 9: ..." instead of "the same all week". Null for a plan decided on its Monday.
   */
  updated: { day: string; why: string } | null;
  /**
   * Additive (wave 22w). The week began with no weigh-in for 7+ days: the plan is the one from the day of that last weigh-in (its call
   * and colour kept - a plan is never remade from stale data), with the neutral "no weigh-in since..." action. The last weigh-in's day;
   * null when the week began with fresh data.
   */
  staleSince: string | null;
}

export interface WeightPlanIntakeDay {
  day: string;
  kcal: number | null;
  source: 'logged' | 'healthkit' | 'none';
}

export interface WeightPlanInput {
  /** User-local today. The plan covers the calendar week this day falls in. */
  todayKey: string;
  /** One raw reading (and its trend) per weigh-in day, as lib/weightTrend.ts computeWeightTrend returns them. */
  days: ReadonlyArray<WeightTrendDay>;
  /** Local day the goal began; null when unknown. */
  startDay: string | null;
  /** The goal's start weight (kg); null when unknown. */
  startKg: number | null;
  targetKg: number | null;
  targetDate: string | null;
  /** The target is reached (lib/weightPace.ts weightReachedRead, sticky) and the day it first was. */
  reached: boolean;
  reachedAt: string | null;
  unitSystem?: 'metric' | 'imperial' | null;
  /** Resolved daily intake; the longer the history, the longer a plateau cause stays put. */
  intakeDays: ReadonlyArray<WeightPlanIntakeDay>;
  /** Today's calorie target (kcal) and the floor under any trim. */
  targetKcal: number | null;
  floorKcal: number | null;
  /** The formula maintenance estimate (kcal); a target at or above it (within 100) is already a maintenance budget. */
  formulaTdee?: number | null;
  /** The maintenance learned from the user's own logs (kcal), passed only at medium / high confidence; preferred over the formula (wave 22w). */
  learnedTdee?: number | null;
  /** Biological sex from the profile; only used when the budget carries no floor. */
  sex?: string | null;
  weeklySessions: number | null;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function isImperial(input: Pick<WeightPlanInput, 'unitSystem'>): boolean {
  return input.unitSystem === 'imperial';
}

/** "84 kg" / "185.2 lb" with a non-breaking space; one decimal (two with `digits` 2), trailing ".0" dropped. */
export function planWeightText(input: Pick<WeightPlanInput, 'unitSystem'>, kg: number, digits: 1 | 2 = 1): string {
  const v = isImperial(input) ? kg * KG_TO_LB : kg;
  return withUnit(digits === 2 ? round2(v) : round1(v), isImperial(input) ? 'lb' : 'kg');
}

function fmtKcal(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function kcalText(n: number): string {
  return withUnit(fmtKcal(n), 'kcal');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function dowOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Dec 10", or "Dec 10, 2027" when the year differs from today's. */
function fmtDate(day: string, todayKey: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const base = `${MONTHS[m - 1]} ${d}`;
  return y === Number(todayKey.slice(0, 4)) ? base : `${base}, ${y}`;
}

/** "Mon, Mar 30" — the day the next plan lands on. */
export function fmtWeekday(day: string, todayKey: string): string {
  return `${WEEKDAYS[dowOf(day)]}, ${fmtDate(day, todayKey)}`;
}

function isWeekend(day: string): boolean {
  const dow = dowOf(day);
  return dow === 0 || dow === 6;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** The calorie floor under any trim: the budget's own, else 1,500 (men) / 1,200 (women) from the profile, else 1,400. */
export function calorieFloorKcal(floorKcal: number | null | undefined, sex?: string | null): number {
  if (floorKcal != null && floorKcal > 0) return floorKcal;
  const s = (sex ?? '').trim().toLowerCase();
  if (s === 'male' || s === 'm' || s === 'man') return FLOOR_KCAL_MALE;
  if (s === 'female' || s === 'f' || s === 'woman') return FLOOR_KCAL_FEMALE;
  return FLOOR_KCAL_UNKNOWN;
}

// ── Reading the scale at one weigh-in day (moved here from lib/goalProgress.ts) ─

/** weight_loss: what the raw weigh-ins say as of one day (see lib/weightPace.ts). */
export interface WeightLossRead {
  /** 'unconfirmed': a pace exists but the pace 7 days ago cannot confirm it yet; 'confirmed': both exist. */
  state: 'returning' | 'plateau' | 'early' | 'unconfirmed' | 'confirmed';
  pace: WeightPace | null;
  ret: WeighInReturn | null;
  plateau: RawPlateau | null;
  /** The goal is younger than PACE_SETTLE_DAYS (null age = unknown = not young). */
  young: boolean;
  /** Ahead / on pace / behind as the card states it ('confirmed' with a target date); null otherwise. */
  relation: PaceRelation | null;
  /** Weeks the stated ETA is ahead (+) / behind (−) the target date; null when no claim is made. */
  weeksVsTarget: number | null;
  /** No target date: both the pace now and 7 days ago are under the safe-band floor. */
  slow: boolean;
  /** The pace points away from the target (the scale is going the wrong way). */
  away: boolean;
  /** Losing too fast, with hysteresis (lib/weightPace.ts tooFastLoss); only ever true for a pace state. */
  tooFast: boolean;
}

interface ReadCtx {
  startDay: string | null;
  targetKg: number | null;
  targetDate: string | null;
}

/** What the paces say about the target date as of one weigh-in day (before any debouncing). */
interface PaceClaim {
  relation: PaceRelation | null;
  /** Weeks the stated ETA is ahead (+) / behind (−) the target date, 0 = on pace; null when no ahead/behind figure is stated. */
  weeks: number | null;
  /** The date the card states: the target date itself while on pace, the projection when ahead or behind; null when none. */
  eta: string | null;
  onPace: boolean | null;
}

interface WeightLossEval {
  read: WeightLossRead;
  claim: PaceClaim;
  /** Both paces exist and a target date is set, so `claim` is a real pace call. */
  claims: boolean;
  /** No target date: the ETA from the pace alone. */
  eta: string | null;
}

type DayPoint = Pick<WeightTrendDay, 'day' | 'rawKg'>;

/** The weight a pace is measured from: its week's raw mean when there is one, else the fitted line's end. */
function paceCurrentKg(days: ReadonlyArray<DayPoint>, pace: WeightPace): number {
  const week = meanOver(days, pace.newestDay, 7);
  return week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : pace.fittedKg;
}

/**
 * The read of the scale as of one weigh-in day `anchor`. One function decides
 * the state, the pace and the date claim. The date (and "N weeks ahead/behind")
 * is only STATED when the pace as of `anchor` AND the pace as of 7 days before
 * it, from the same readings, land on the same side of the target date. Two
 * paces on opposite sides of it do not drop the date: the card says it is on
 * track for the target date itself.
 */
function evaluateAt(
  ctx: ReadCtx,
  days: ReadonlyArray<DayPoint>,
  anchor: string,
  withTooFast = false,
): WeightLossEval {
  const { startDay: start, targetKg, targetDate } = ctx;
  const goalAge = start != null ? Math.max(1, dayNumber(anchor) - dayNumber(start) + 1) : null;
  const young = goalAge != null && goalAge < PACE_SETTLE_DAYS;
  const known = days.filter(d => d.day <= anchor);
  const ret = weighInReturn(known, start);
  const plateau = rawPlateau(known, anchor, goalAge);
  const pace = bridgedPace(known, anchor);
  const earlier = bridgedPace(known, addDays(anchor, -PACE_RECHECK_DAYS));
  const week = meanOver(known, anchor, 7);
  const weekMeanKg = week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : null;

  let state: WeightLossRead['state'];
  if (isReturning(ret)) state = 'returning';
  else if (plateau) state = 'plateau';
  else if (young || pace == null) state = 'early';
  else if (earlier == null) state = 'unconfirmed';
  else state = 'confirmed';

  const fromKg = pace != null ? (weekMeanKg ?? pace.fittedKg) : null;
  const away = pace != null && fromKg != null && targetKg != null
    && Math.sign(pace.kgPerWeek) !== Math.sign(targetKg - fromKg);
  const etaOpts = { minPct: PLATEAU_MAX_PCT_PER_WEEK, maxDays: MAX_ETA_DAYS };
  const tooFast = withTooFast && (state === 'unconfirmed' || state === 'confirmed') && pace != null && pace.kgPerWeek < 0
    && tooFastLoss(known, anchor, { settledFrom: start != null ? addDays(start, PACE_SETTLE_DAYS - 1) : null });

  let eta: string | null = null;
  let relation: PaceRelation | null = null;
  let weeks: number | null = null;
  let slow = false;
  let onPace: boolean | null = null;
  let claims = false;

  if (state === 'confirmed' && pace != null && earlier != null && targetKg != null && fromKg != null) {
    const etaNow = paceEta(pace, targetKg, { ...etaOpts, fromKg });
    const etaThen = paceEta(earlier, targetKg, { ...etaOpts, fromKg: paceCurrentKg(known, earlier) });
    // A pace under the safe band's floor is never "on pace" just because the pace a week ago said something else.
    const slowNow = Math.abs(pace.pctPerWeek) < FAT_LOSS_MIN_PCT;
    if (targetDate != null) {
      claims = true;
      const dNow = etaNow != null ? etaDaysAhead(etaNow, targetDate) : null;
      const dThen = etaThen != null ? etaDaysAhead(etaThen, targetDate) : null;
      if (dNow != null && dThen != null && (dNow >= 0) === (dThen >= 0)) {
        // Both projections land on the same side of the target date: state the one nearer it, so a single reading
        // never moves the claim by more than the two agree on.
        const stated = Math.abs(dNow) <= Math.abs(dThen) ? dNow : dThen;
        relation = relationForDays(stated);
        weeks = relation === 'on_pace' ? 0 : (relation === 'ahead' ? 1 : -1) * weeksForDays(stated);
        eta = relation === 'on_pace' ? targetDate : stated === dNow ? etaNow : etaThen;
      } else if (dNow == null && dThen == null) {
        relation = 'behind'; // no date can be projected from either pace
      } else {
        // The two paces disagree about which side of the target date they land on (or only one projects a date).
        // Opposite sides is no ahead/behind call: on track for the target date itself. A pace under the floor, or one
        // that lands behind, is behind and states the date its own pace projects.
        relation = (dNow != null && dThen != null ? slowNow : ((dNow ?? dThen) as number) < 0 || slowNow) ? 'behind' : 'on_pace';
        if (relation === 'on_pace') {
          weeks = 0;
          eta = targetDate;
        } else if (dNow != null && relationForDays(dNow) === 'behind') {
          weeks = -weeksForDays(dNow);
          eta = etaNow;
        }
      }
      onPace = relation !== 'behind';
    } else {
      eta = etaNow;
      slow = Math.abs(pace.pctPerWeek) < FAT_LOSS_MIN_PCT && Math.abs(earlier.pctPerWeek) < FAT_LOSS_MIN_PCT;
    }
  }
  // The scale going the wrong way is "not on pace" whatever the date.
  if (onPace == null && targetDate != null && away && (state === 'unconfirmed' || state === 'confirmed')) onPace = false;

  return {
    read: { state, pace, ret, plateau, young, relation, weeksVsTarget: weeks, slow, away, tooFast },
    claim: { relation, weeks, eta, onPace },
    claims,
    eta,
  };
}

/** Two claims make the same call: the same ahead / on pace / behind relation, and both state a date or neither does. */
function sameCall(a: PaceClaim, b: PaceClaim): boolean {
  return a.relation === b.relation && (a.eta == null) === (b.eta == null);
}

/**
 * The read as of the weigh-in day `anchor`. The call it states (ahead / on pace
 * / behind, with or without a date) changes only after two consecutive weigh-in
 * days make the new call: walking the weigh-ins oldest to newest, a day whose
 * call differs from the one stated keeps the stated one unless the day before
 * made the same new call. So a date never comes and goes, and the call never
 * flips, off a single reading. While the call holds, its weeks and date follow
 * the pace (a behind date moves as the pace does).
 */
function buildRead(
  ctx: ReadCtx,
  days: ReadonlyArray<DayPoint>,
  anchor: string,
): { read: WeightLossRead; eta: string | null; onPace: boolean | null } {
  const now = evaluateAt(ctx, days, anchor, true);
  let { read, eta } = now;
  let onPace = now.claim.onPace;

  if (now.claims) {
    let stated: PaceClaim | null = null;
    let previous: PaceClaim | null = null;
    const walkFrom = addDays(anchor, -(CLAIM_WALK_DAYS - 1));
    for (const d of days.filter(x => x.day <= anchor && x.day >= walkFrom)) {
      const ev = d.day === anchor ? now : evaluateAt(ctx, days, d.day, false);
      if (!ev.claims) {
        stated = null;
        previous = null;
        continue;
      }
      if (stated == null || sameCall(ev.claim, stated) || (previous != null && sameCall(ev.claim, previous))) stated = ev.claim;
      previous = ev.claim;
    }
    if (stated != null) {
      read = { ...read, relation: stated.relation, weeksVsTarget: stated.weeks };
      eta = stated.eta;
      onPace = stated.onPace;
    }
  }
  if (onPace == null && ctx.targetDate != null && read.away && (read.state === 'unconfirmed' || read.state === 'confirmed')) onPace = false;
  return { read, eta, onPace };
}

// ── The intake behind a plateau, and behind a held weight ───────────────────

function loggedKcal(day: WeightPlanIntakeDay): number | null {
  return day.source !== 'none' && day.kcal != null && day.kcal >= PARTIAL_LOG_KCAL_THRESHOLD ? day.kcal : null;
}

function loggedInSpan(intake: ReadonlyArray<WeightPlanIntakeDay>, from: string, to: string): Array<{ day: string; kcal: number }> {
  const out: Array<{ day: string; kcal: number }> = [];
  for (const d of intake) {
    const kcal = loggedKcal(d);
    if (kcal != null && d.day >= from && d.day <= to) out.push({ day: d.day, kcal });
  }
  return out;
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The cause of a plateau read off the logs of one 21-day span ending at `anchor`
 * (the plateau's own three weeks). Logged days averaging within 150 kcal of the
 * target are not the cause; weekends running 300 kcal or more over the
 * weekdays are; logged days averaging more than 150 over are; otherwise it is
 * the plain "often water" plateau. Null when the span has too few logged days to say.
 */
function judgeSpan(
  intake: ReadonlyArray<WeightPlanIntakeDay>,
  anchor: string,
  targetKcal: number | null,
  spanDays = PLATEAU_SPAN_DAYS,
): WeightPlateauCause | null {
  const logged = loggedInSpan(intake, addDays(anchor, -(spanDays - 1)), anchor);
  // A shorter span (the flat fortnight's 14 days) needs its share of the logged days.
  if (logged.length < Math.ceil((PLATEAU_MIN_LOGGED_DAYS * spanDays) / PLATEAU_SPAN_DAYS)) return null;
  const mean = avg(logged.map(l => l.kcal));
  if (targetKcal != null && mean > targetKcal + PLATEAU_INTAKE_NEAR_KCAL) {
    return { kind: 'intake', namedAt: anchor, spanDays, loggedDays: logged.length, avgKcal: Math.round(mean), targetKcal };
  }
  const wkend = logged.filter(l => isWeekend(l.day)).map(l => l.kcal);
  const wkday = logged.filter(l => !isWeekend(l.day)).map(l => l.kcal);
  if (wkend.length >= PLATEAU_MIN_WEEKEND_DAYS && wkday.length >= PLATEAU_MIN_WEEKDAY_DAYS) {
    const e = avg(wkend);
    const w = avg(wkday);
    if (e - w >= PLATEAU_WEEKEND_OVER_KCAL) {
      return {
        kind: 'weekends', namedAt: anchor, spanDays, loggedDays: logged.length, avgKcal: Math.round(mean), targetKcal,
        weekendAvgKcal: Math.round(e), weekdayAvgKcal: Math.round(w),
      };
    }
  }
  return { kind: 'water', namedAt: anchor, spanDays, loggedDays: logged.length, avgKcal: Math.round(mean), targetKcal };
}

// ── The plan ────────────────────────────────────────────────────────────────

interface Ctx {
  input: WeightPlanInput;
  days: WeightTrendDay[];
  weekStart: string;
  /** The last day of weigh-ins the plan reads (set once the plan's events are settled). */
  asOf: string;
  read: ReadCtx;
}

function through(days: ReadonlyArray<WeightTrendDay>, day: string): WeightTrendDay[] {
  return days.filter(d => d.day <= day);
}

function ageAt(startDay: string | null, day: string): number | null {
  return startDay != null ? Math.max(1, dayNumber(day) - dayNumber(startDay) + 1) : null;
}

/** The weight the week measures progress from at `day`: the 7-day raw mean (3+ weigh-ins), else the newest reading. */
function progressAt(days: ReadonlyArray<WeightTrendDay>, day: string): number | null {
  const known = through(days, day);
  if (known.length === 0) return null;
  const week = meanOver(known, known[known.length - 1].day, 7);
  return week != null && week.n >= WEEK_MEAN_MIN_WEIGH_INS ? week.meanKg : known[known.length - 1].rawKg;
}

/**
 * The Sundays (and the day itself) the plan reads, newest first, for as long as a
 * plateau held at each one in a row. The last of them is the plateau's first week.
 */
function plateauRun(c: Ctx, asOf: string): string[] {
  const run: string[] = [];
  for (let k = 0; k <= PLATEAU_MAX_WEEKS_BACK; k++) {
    const a = addDays(asOf, -7 * k);
    if (rawPlateau(through(c.days, a), a, ageAt(c.read.startDay, a)) == null) break;
    run.push(a);
  }
  return run;
}

/** The plateau's cause: judged at its first week (so it does not flip while the plateau lasts), else the first later week with enough logs. */
function plateauCauseFor(c: Ctx, asOf: string): WeightPlateauCause {
  const run = plateauRun(c, asOf);
  const intake = c.input.intakeDays;
  for (let i = run.length - 1; i >= 0; i--) {
    const cause = judgeSpan(intake, run[i], c.input.targetKcal);
    if (cause) return cause;
  }
  return { kind: 'water', namedAt: asOf, loggedDays: 0, avgKcal: null, targetKcal: c.input.targetKcal };
}

/**
 * A flat fortnight as of day `d` (wave 22w): the two 7-day raw means up to it (3+ weigh-ins each) are within PLATEAU_TOLERANCE_KG, and a
 * loss pace inside the safe band was confirmed FLAT_FORTNIGHT_DAYS before. Returns the newest week's mean; null when it is not one.
 */
function flatFortnightAt(c: Ctx, d: string): { weeklyMeanKg: number; olderMeanKg: number } | null {
  const known = through(c.days, d);
  const w2 = meanOver(known, d, 7);
  const w1 = meanOver(known, addDays(d, -7), 7);
  if (w1 == null || w2 == null || w1.n < PLATEAU_MIN_WEIGH_INS_PER_WEEK || w2.n < PLATEAU_MIN_WEIGH_INS_PER_WEEK) return null;
  if (Math.abs(w2.meanKg - w1.meanKg) > PLATEAU_TOLERANCE_KG + 1e-9) return null;
  const earlier = through(known, addDays(d, -FLAT_FORTNIGHT_DAYS));
  if (earlier.length === 0) return null;
  const then = evaluateAt(c.read, earlier, earlier[earlier.length - 1].day, false).read;
  const pace = then.pace;
  if (then.state !== 'confirmed' || pace == null || pace.kgPerWeek >= 0 || Math.abs(pace.pctPerWeek) < FAT_LOSS_MIN_PCT) return null;
  return { weeklyMeanKg: w2.meanKg, olderMeanKg: w1.meanKg };
}

/**
 * The weight a plateau (three flat weeks) or a flat fortnight held at as of day `d`, or null when there is none: the mean of its OLDER
 * weeks, so a plateau whose newest week has started to fall is still measured against where it held, not against the falling week.
 */
function plateauHeldKg(c: Ctx, d: string): number | null {
  const plateau = rawPlateau(through(c.days, d), d, ageAt(c.read.startDay, d));
  if (plateau != null) return (plateau.meansKg[0] + plateau.meansKg[1]) / 2;
  return flatFortnightAt(c, d)?.olderMeanKg ?? null;
}

/** True when the user's food log has at least LOGGING_MIN_DAYS logged days in the 3 weeks up to the plan's Sunday: a kcal trim can be checked. */
function logsFood(c: Ctx): boolean {
  return loggedInSpan(c.input.intakeDays, addDays(c.asOf, -(LOGGING_LOOKBACK_DAYS - 1)), c.asOf).length >= LOGGING_MIN_DAYS;
}

/** The one trim step in kcal a day (TRIM_STEP_KCAL, shrunk near the floor: 0 when the budget has no room under it). */
function trimStepKcal(c: Ctx): number {
  const { input } = c;
  const budget = input.targetKcal != null && input.targetKcal > 0 ? input.targetKcal : null;
  const floor = calorieFloorKcal(input.floorKcal, input.sex);
  if (budget == null || budget - TRIM_STEP_KCAL >= floor) return TRIM_STEP_KCAL;
  return Math.floor(Math.max(0, budget - floor) / TRIM_ROUND_KCAL) * TRIM_ROUND_KCAL;
}

/** The activity-or-logging step for someone who logs no food: what to do first when a kcal trim is not something they can check. */
const NO_LOGS_STEP = 'add two 30-minute walks and log a few days so we can see where the calories go';

/** The trim a plateau offers as its second step ("trim ~150 kcal a day"), else (no room under the floor, or no food log to check it against) the walks. */
function plateauSecondStep(c: Ctx): string {
  const step = logsFood(c) ? trimStepKcal(c) : 0;
  return step >= TRIM_ROUND_KCAL ? `trim ~${kcalText(step)} a day` : 'add two 30-minute walks';
}

function plateauAction(c: Ctx, cause: WeightPlateauCause): WeightPlanAction {
  const { input } = c;
  const kcal = input.targetKcal != null && input.targetKcal > 0 ? input.targetKcal : null;
  const sessions = input.weeklySessions;
  const second = plateauSecondStep(c);
  if (cause.kind === 'intake' && cause.avgKcal != null && cause.targetKcal != null) {
    return {
      kind: 'plateau_intake',
      text: `Logged days averaged ~${kcalText(roundTo(cause.avgKcal, 10))} vs your ${kcalText(cause.targetKcal)} target — getting back to target is the first lever; if still flat 2 weeks after that, ${second}`,
      kcalTarget: cause.targetKcal,
    };
  }
  if (cause.kind === 'weekends' && cause.weekendAvgKcal != null && cause.weekdayAvgKcal != null) {
    const back = cause.targetKcal != null ? `bring the weekends back toward your ${kcalText(cause.targetKcal)} target` : 'bring the weekends back toward your weekdays';
    return {
      kind: 'plateau_weekends',
      text: `Weekends averaged ~${kcalText(roundTo(cause.weekendAvgKcal, 50))} vs ${fmtKcal(roundTo(cause.weekdayAvgKcal, 50))} on weekdays — ${back} first; if still flat 2 weeks after that, ${second}`,
      ...(cause.targetKcal != null ? { kcalTarget: cause.targetKcal } : {}),
    };
  }
  const keep = [
    kcal != null ? kcalText(kcal) : null,
    sessions != null && sessions > 0 ? `${sessions} ${plural(sessions, 'session')}` : null,
  ].filter((x): x is string => x != null);
  // Someone who logs no food gets activity and logging first - there is no calorie figure they could check a trim against.
  const then = logsFood(c) ? `${second}${second.startsWith('trim') ? ' or add two 30-minute walks' : ''}` : NO_LOGS_STEP;
  return {
    kind: 'plateau_water',
    text: `Common and often water: keep ${keep.length > 0 ? keep.join(' and ') : 'your routine'}; if still flat in 2 weeks, ${then}`,
    ...(kcal != null ? { kcalTarget: kcal } : {}),
  };
}

/**
 * Two flat weeks after a confirmed loss: a calm hold, not "behind". The cause is judged over those two weeks' logs; there is no
 * date and no trim - one more flat week makes it a plateau (plateauAction), and a week that moves again is "moving again".
 */
function fortnightAction(c: Ctx, cause: WeightPlateauCause): WeightPlanAction {
  const { input } = c;
  const kcal = input.targetKcal != null && input.targetKcal > 0 ? input.targetKcal : null;
  if (cause.kind === 'intake' && cause.avgKcal != null && cause.targetKcal != null) {
    return {
      kind: 'plateau_intake',
      text: `Logged days averaged ~${kcalText(roundTo(cause.avgKcal, 10))} vs your ${kcalText(cause.targetKcal)} target — getting back to target is the lever`,
      kcalTarget: cause.targetKcal,
    };
  }
  if (cause.kind === 'weekends' && cause.weekendAvgKcal != null && cause.weekdayAvgKcal != null) {
    const back = cause.targetKcal != null ? `back toward your ${kcalText(cause.targetKcal)} target` : 'back toward your weekdays';
    return {
      kind: 'plateau_weekends',
      text: `Weekends averaged ~${kcalText(roundTo(cause.weekendAvgKcal, 50))} vs ${fmtKcal(roundTo(cause.weekdayAvgKcal, 50))} on weekdays — bring them ${back}`,
      ...(cause.targetKcal != null ? { kcalTarget: cause.targetKcal } : {}),
    };
  }
  return {
    kind: 'plateau_water',
    text: `Keep ${kcal != null ? kcalText(kcal) : 'your routine'}; we'll look again next Monday`,
    ...(kcal != null ? { kcalTarget: kcal } : {}),
  };
}

/**
 * Behind pace: what the target date would take, said once for the week. The trim is the ONE step (TRIM_STEP_KCAL, never under the
 * calorie floor), the same as a plateau's. It never names the month the pace projects to - that projection is a guess off a noisy
 * line - only that the date has to move. A user who logs no food gets activity and logging first, not a trim they cannot check.
 */
function behindAction(
  c: Ctx,
  opts: { pace: WeightPace | null; toGoKg: number; bodyKg: number; far: boolean },
): WeightPlanAction {
  const { input, weekStart } = c;
  const { pace, toGoKg, bodyKg, far } = opts;
  const targetDate = input.targetDate as string;
  const daysLeft = dayNumber(targetDate) - dayNumber(weekStart);
  const nowKgPerWeek = pace != null && pace.kgPerWeek < 0 ? -pace.kgPerWeek : 0;
  const budget = input.targetKcal != null && input.targetKcal > 0 ? input.targetKcal : null;
  const floor = calorieFloorKcal(input.floorKcal, input.sex);
  const date = fmtDate(targetDate, input.todayKey);

  const neededKgPerWeek = daysLeft > 0 && toGoKg > 0 ? toGoKg / (daysLeft / 7) : null;
  const logs = logsFood(c);
  const step = logs ? trimStepKcal(c) : 0;
  const trimText = step >= TRIM_ROUND_KCAL ? `trim ~${kcalText(step)} a day${budget != null ? ` (to ~${kcalText(budget - step)})` : ''}` : null;
  const kcalTarget = trimText != null && budget != null ? budget - step : undefined;

  if (far) {
    if (trimText != null) return { kind: 'trim', text: `Move the date or ${trimText}`, kcalTarget };
    if (!logs) return { kind: 'move_date', text: `Move the date, or ${NO_LOGS_STEP}` };
    return { kind: 'move_date', text: `Move the date — your calories are already near the ${kcalText(floor)} floor` };
  }
  if (daysLeft <= 0 || toGoKg <= 0 || neededKgPerWeek == null) {
    return { kind: 'move_date', text: `Your ${date} date has passed — move it to a date this pace can keep` };
  }
  const needed = `~${planWeightText(input, neededKgPerWeek, 2)}/wk`;
  const ceilingKgPerWeek = (bodyKg * FAT_LOSS_MAX_PCT) / 100;
  if (neededKgPerWeek > ceilingKgPerWeek) {
    return { kind: 'move_date', text: `To make ${date} you'd need ${needed} — faster than is comfortable to keep; move the date` };
  }
  if (neededKgPerWeek <= nowKgPerWeek) {
    return { kind: 'keep_going', text: 'Keep your routine — your pace is close to what the date needs' };
  }
  if (trimText == null) {
    if (!logs) return { kind: 'move_date', text: `To make ${date} you'd need ${needed} — move the date, or ${NO_LOGS_STEP}` };
    return { kind: 'move_date', text: `To make ${date} you'd need ${needed} — that is more than your calories can safely give; move the date` };
  }
  return { kind: 'trim', text: `To make ${date} you'd need ${needed} — move the date or ${trimText}`, kcalTarget };
}

function paceOf(read: WeightLossRead): WeightPlanPace | null {
  const p = read.pace;
  return p == null ? null : { kgPerWeek: p.kgPerWeek, pctPerWeek: p.pctPerWeek, windowDays: p.windowDays };
}

/**
 * The weight-loss week plan for the calendar week `input.todayKey` falls in
 * (see the file header). Null without a single weigh-in.
 */
export function weightWeekPlan(input: WeightPlanInput): WeightWeekPlan | null {
  const plan = makeWeekPlan(input);
  return plan == null ? null : saidBackFromTrim(input, plan);
}

/**
 * When this week's plan states a calorie level ABOVE the trim last week's plan asked for, it says so: "Go back to 2,000 kcal - last
 * week's trim isn't needed". A calorie target never moves back up on the next Monday in silence (wave 22w). Last week's plan is the
 * one made as of that week's Sunday (the plan the user was left with); it is read once, never recursively.
 */
function saidBackFromTrim(input: WeightPlanInput, plan: WeightWeekPlan): WeightWeekPlan {
  const a = plan.action;
  if ((plan.state !== 'plateau' && plan.state !== 'pace') || a.kcalTarget == null || a.kind === 'trim') return plan;
  const previous = makeWeekPlan({ ...input, todayKey: addDays(plan.weekStart, -1), reached: false, reachedAt: null });
  const was = previous?.action;
  if (was == null || was.kind !== 'trim' || was.kcalTarget == null || a.kcalTarget <= was.kcalTarget) return plan;
  return { ...plan, action: { ...a, text: `Go back to ${kcalText(a.kcalTarget)} — last week's trim isn't needed. ${a.text}` } };
}

/**
 * The verdict the card had on the last weigh-in day before a gap, when it was a good one (on track, ahead, progressing): a welcome back
 * keeps its colour instead of downgrading it. Never "behind" or "too fast" - those are not called again until 3 weigh-ins are back.
 */
function verdictBeforeGap(input: WeightPlanInput, ret: WeighInReturn | null): GoalVerdict | null {
  if (ret == null) return null;
  const v = makeWeekPlan({ ...input, todayKey: ret.lastBeforeDay })?.verdict;
  return v === 'on_track' || v === 'ahead' || v === 'progressing' ? v : null;
}

/** Where the plan's core notes the event that re-made it inside its week (see WeightWeekPlan.updated). */
interface UpdateNote { day: string | null; why: string | null }

function makeWeekPlan(input: WeightPlanInput): WeightWeekPlan | null {
  const note: UpdateNote = { day: null, why: null };
  const plan = planCore(input, note);
  if (plan == null || plan.staleSince != null || note.day == null || note.why == null || note.day <= plan.weekStart) return plan;
  // The goal being reached is its own news; every other event only counts when it changed what the week asks (an event that re-makes the
  // plan into the same call and action - "too fast" entering on a week that already said "nearly there" - is not an update).
  if (plan.verdict === 'reached' && note.why !== 'target reached') return plan;
  // (The Monday's plan is made without a reach that happened after it.)
  const reachedByMonday = input.reached && input.reachedAt != null && input.reachedAt <= plan.weekStart;
  const monday = planCore(
    { ...input, todayKey: plan.weekStart, reached: reachedByMonday, reachedAt: reachedByMonday ? input.reachedAt : null },
    { day: null, why: null },
  );
  if (monday != null && monday.state === plan.state && monday.verdict === plan.verdict && monday.action.text === plan.action.text) return plan;
  return { ...plan, updated: { day: note.day, why: note.why } };
}

function planCore(input: WeightPlanInput, note: UpdateNote): WeightWeekPlan | null {
  const days = [...input.days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (days.length === 0) return null;
  const { todayKey, startDay, targetKg, targetDate } = input;
  const weekStart = weekStartKeyForDay(todayKey);
  const c: Ctx = { input, days, weekStart, asOf: addDays(weekStart, -1), read: { startDay, targetKg, targetDate } };
  const settledFrom = startDay != null ? addDays(startDay, PACE_SETTLE_DAYS - 1) : null;

  // The data the plan reads: through the Sunday before the week, or — in the first days of a goal — as of the goal start.
  const base = startDay != null && startDay >= weekStart && startDay <= todayKey ? startDay : addDays(weekStart, -1);
  const scan: string[] = [];
  for (let d = addDays(base, 1); d <= todayKey; d = addDays(d, 1)) scan.push(d);

  // Welcome back: a gap of 7+ days ends with a weigh-in on any day of the week (an event), until 3 weigh-ins are back.
  const returningAt = (d: string): boolean => isReturning(weighInReturn(through(days, d), startDay));
  const returning = returningAt(todayKey);

  const lastDayThrough = (d: string): string | null => {
    const k = through(days, d);
    return k.length > 0 ? k[k.length - 1].day : null;
  };
  // A plan with no pace for want of weigh-ins (a goal past its 3 weeks) is made as of the first day it can have one.
  const lacksPace = (d: string): boolean => {
    const age = ageAt(startDay, d);
    if (age != null && age < PACE_SETTLE_DAYS) return false;
    const a = lastDayThrough(d);
    return a == null || bridgedPace(through(days, a), a) == null;
  };
  // "Losing too fast" entering (the existing hysteresis) re-makes the plan as of the day it enters.
  const tooFastAt = (d: string): boolean => {
    const a = lastDayThrough(d);
    if (a == null) return false;
    const age = ageAt(startDay, a);
    if (age != null && age < PACE_SETTLE_DAYS) return false;
    const known = through(days, a);
    if (rawPlateau(known, a, age) != null) return false;
    const pace = bridgedPace(known, a);
    return pace != null && pace.kgPerWeek < 0 && tooFastLoss(known, a, { settledFrom });
  };
  // "Moving again" entering (wave 22w): the plan as of `a` is a plateau (or a flat fortnight) and the 7-day mean up to `d` (3+ weigh-ins)
  // is a full tolerance under where it held. The scale falling inside the week ends the plateau message in the week, not the Monday after.
  const movedFrom = (a: string, d: string): number | null => {
    const at = lastDayThrough(a);
    if (at == null) return null;
    const held = plateauHeldKg(c, at);
    if (held == null) return null;
    const now = meanOver(through(days, d), d, 7);
    return now != null && now.n >= WEEK_MEAN_MIN_WEIGH_INS && now.meanKg <= held - PLATEAU_TOLERANCE_KG ? held : null;
  };
  // The plan reads the weigh-ins through the Sunday — and is re-made as of the day one of the week's events happens:
  // the welcome back ends (3 weigh-ins are back), the first pace becomes possible, "too fast" enters, the plateau ends.
  let asOf = base;
  let prevDay = base;
  let plateauEndedFrom: number | null = null; // the plateau mean the plan as of `asOf` moved away from (set only by that event)
  const remade = (d: string, why: string): void => {
    asOf = d;
    plateauEndedFrom = null;
    note.day = d;
    note.why = why;
  };
  for (const d of scan) {
    const moved = movedFrom(asOf, d);
    if (returningAt(prevDay) && !returningAt(d)) remade(d, 'your third weigh-in is back');
    else if (lacksPace(asOf) && !lacksPace(d)) remade(d, 'a first pace can be read');
    else if (!tooFastAt(asOf) && tooFastAt(d)) remade(d, 'losing over 1%/wk');
    else if (!input.reached && moved != null && movedFrom(asOf, prevDay) == null) {
      remade(d, 'the weekly average is falling again');
      plateauEndedFrom = moved;
    }
    prevDay = d;
  }

  c.asOf = asOf;
  const known = through(days, asOf);
  const anchor = known.length > 0 ? known[known.length - 1].day : null;
  const progressKg = anchor != null ? progressAt(days, anchor) : null;
  const startKg = input.startKg;
  const scaleDown = startKg != null && progressKg != null ? startKg - progressKg : null;
  const down = scaleDown != null && scaleDown >= 0.1;
  const nextMonday = addDays(weekStart, 7);

  const blank: WeightWeekPlan = {
    weekStart, asOf, state: 'early', call: 'none', verdict: down ? 'progressing' : 'holding',
    etaDate: null, weeksVsTarget: null,
    action: { kind: 'keep_weighing', text: 'Keep weighing in — your pace settles after 3 weeks of weigh-ins' },
    plateauCause: null, pace: null, confirmed: false, young: false, onPace: null, tooFast: false, nearlyThere: false, slow: false,
    away: false, farBehind: false, projectedEta: null, plateauMeanKg: null, flatWeeks: null, heldKg: null, firstPaceWeek: false, updated: null, staleSince: null,
  };

  // The target is reached (any day: the crossing is an event): a CTA for the first week, then maintenance.
  if (input.reached && targetKg != null) {
    if (input.reachedAt != null && input.reachedAt > weekStart && input.reachedAt <= todayKey) {
      note.day = input.reachedAt;
      note.why = 'target reached';
    }
    return reachedPlan(c, blank, asOf);
  }
  // Stale data (wave 22w): the week began with the newest weigh-in 7+ days old and none since. A plan made now would be made from the same
  // readings the last plan saw, only older - and its pace, bridged over the gap, can flip "moving again" to "on track" on a day nothing
  // happened. So the plan is the one the day of that last weigh-in made, call and colour kept, with a neutral action. The first weigh-in
  // back is the welcome-back event below; three of them make the new pace call.
  const newest = lastDayThrough(todayKey);
  if (newest != null && newest < weekStart && dayNumber(weekStart) - dayNumber(newest) >= WEIGH_IN_GAP_DAYS) {
    const last = makeWeekPlan({ ...input, todayKey: newest });
    if (last != null) {
      return {
        ...last,
        weekStart,
        staleSince: newest,
        action: {
          kind: 'keep_weighing',
          text: `No weigh-in since ${fmtDate(newest, todayKey)} — step on the scale when you can; your plan picks up from there`,
        },
      };
    }
  }

  if (anchor == null) return { ...blank, young: (ageAt(startDay, asOf) ?? PACE_SETTLE_DAYS) < PACE_SETTLE_DAYS };

  if (returning) {
    const ret = weighInReturn(through(days, todayKey), startDay);
    if (ret != null) {
      note.day = ret.firstBackDay;
      note.why = `weighed in again after ${ret.gapDays} days`;
    }
    return {
      ...blank,
      state: 'returning',
      verdict: verdictBeforeGap(input, ret) ?? blank.verdict,
      action: {
        kind: 'keep_weighing',
        text: 'Keep weighing in so your trend catches up — your pace is read again once 3 weigh-ins are back',
      },
    };
  }

  const built = buildRead(c.read, days.filter(d => d.day <= asOf), anchor);
  const { read } = built;
  const pace = read.pace;
  const absPct = pace != null ? Math.abs(pace.pctPerWeek) : 0;

  if (read.state === 'returning') {
    // The newest gap (as of the anchor) is still open: the same welcome back.
    return {
      ...blank,
      state: 'returning',
      verdict: verdictBeforeGap(input, read.ret) ?? blank.verdict,
      action: {
        kind: 'keep_weighing',
        text: 'Keep weighing in so your trend catches up — your pace is read again once 3 weigh-ins are back',
      },
    };
  }

  if (read.state === 'plateau' && read.plateau != null) {
    const cause = plateauCauseFor(c, asOf);
    return {
      ...blank,
      state: 'plateau',
      verdict: 'holding',
      action: plateauAction(c, cause),
      plateauCause: cause,
      pace: paceOf(read),
      plateauMeanKg: round1(read.plateau.weeklyMeanKg),
      flatWeeks: 3,
    };
  }

  // Moving again: a plateau ended in the last 14 days and the weekly average is falling again. The 21-day line still
  // covers the flat weeks, so it would call this "behind"; it is not read until the plateau is two weeks behind.
  if (plateauEndedFrom != null) {
    // It entered inside the week (the event above): the plan is made as of that day, against the mean the plateau held at.
    return {
      ...blank,
      state: 'moving_again',
      verdict: 'progressing',
      action: { kind: 'keep_what_worked', text: 'Keep doing what restarted it' },
      plateauMeanKg: round1(plateauEndedFrom),
    };
  }
  for (let back = 1; back <= MOVING_AGAIN_DAYS; back++) {
    const d = addDays(asOf, -back);
    // A plateau, or a flat fortnight (wave 22w): either one ending and the weekly average falling again is "moving again".
    const heldKg = plateauHeldKg(c, d);
    if (heldKg == null) continue;
    const now = meanOver(known, asOf, 7);
    if (now != null && now.n >= WEEK_MEAN_MIN_WEIGH_INS && now.meanKg <= heldKg - PLATEAU_TOLERANCE_KG) {
      return {
        ...blank,
        state: 'moving_again',
        verdict: 'progressing',
        action: { kind: 'keep_what_worked', text: 'Keep doing what restarted it' },
        plateauMeanKg: round1(heldKg),
      };
    }
    break; // the most recent plateau day decides; a weekly average that is not falling is an ordinary pace
  }

  if (read.state === 'early' || pace == null) {
    const youngNote = 'Keep weighing in — your pace settles after 3 weeks of weigh-ins';
    const olderNote = 'Keep weighing in — a pace needs 6 weigh-ins spanning at least 2 weeks';
    return { ...blank, state: 'early', young: read.young, action: { kind: 'keep_weighing', text: read.young ? youngNote : olderNote } };
  }

  // A flat fortnight: the last two weekly means are flat after a loss pace that was confirmed two weeks ago. The 21-day line still
  // holds the good weeks before the stall, so read alone it says "behind" and "the date won't hold" a week before the third flat week
  // makes it a plateau. It is a calm hold instead: common, the plan holds, no date, no trim.
  const fortnight = !read.tooFast && !(pace.kgPerWeek >= 0 && Math.abs(pace.pctPerWeek) > PLATEAU_MAX_PCT_PER_WEEK)
    ? flatFortnightAt(c, anchor)
    : null;
  if (fortnight != null) {
    const cause = judgeSpan(input.intakeDays, asOf, input.targetKcal, FLAT_FORTNIGHT_DAYS)
      ?? { kind: 'water' as const, namedAt: asOf, spanDays: FLAT_FORTNIGHT_DAYS, loggedDays: 0, avgKcal: null, targetKcal: input.targetKcal };
    return {
      ...blank,
      state: 'plateau',
      verdict: 'holding',
      action: fortnightAction(c, cause),
      plateauCause: cause,
      plateauMeanKg: round1(fortnight.weeklyMeanKg),
      flatWeeks: 2,
    };
  }

  // ── A pace ('unconfirmed' or 'confirmed') ──
  const unconfirmed = read.state === 'unconfirmed';
  const tooFast = read.tooFast;
  const bodyKg = progressKg ?? pace.fittedKg;
  const toGoKg = progressKg != null && targetKg != null ? Math.abs(targetKg - progressKg) : 0;
  // Closing in on the target is an event too: once the week's weekly average is within a kilo of it the call is "nearly
  // there" for the rest of the week (the loss is about to stop on its own), however the average wobbles after.
  let closestKg = toGoKg;
  if (targetKg != null) {
    for (const d of days) {
      if (d.day <= asOf || d.day > todayKey) continue;
      const pk = progressAt(days, d.day);
      if (pk != null) closestKg = Math.min(closestKg, Math.abs(targetKg - pk));
    }
  }
  // Decided on the Monday from closeness (within a kilo of the target while losing 0.75%+ a week), not only once "too fast" enters.
  const losingFast = tooFast || (pace.kgPerWeek < 0 && absPct >= NEARLY_THERE_MIN_PCT_PER_WEEK);
  const nearlyThere = losingFast && closestKg <= HOLDING_NEAR_TARGET_KG;
  if (nearlyThere && toGoKg > HOLDING_NEAR_TARGET_KG) {
    // The weekly average closed in on the target inside the week: an event, noted with the first day it was within a kilo.
    for (const d of days) {
      if (d.day <= asOf || d.day > todayKey) continue;
      const pk = progressAt(days, d.day);
      if (pk != null && targetKg != null && Math.abs(targetKg - pk) <= HOLDING_NEAR_TARGET_KG) {
        note.day = d.day;
        note.why = 'within a kilo of the target';
        break;
      }
    }
  }
  const wrongWay = pace.kgPerWeek >= 0 && absPct > PLATEAU_MAX_PCT_PER_WEEK;
  const flat = pace.kgPerWeek >= 0 || absPct <= PLATEAU_MAX_PCT_PER_WEEK;

  let call: WeightPlanCall = 'none';
  if (tooFast) call = 'too_fast';
  else if (wrongWay) call = 'behind';
  else if (flat) call = 'none';
  else if (!unconfirmed) {
    if (targetDate != null) call = read.relation === 'ahead' ? 'ahead' : read.relation === 'behind' ? 'behind' : 'on_pace';
    else call = built.eta == null || read.slow ? 'behind' : 'on_pace';
  }

  // Far behind: the projection is more than 8 weeks past the target date — the date is not quoted.
  let etaDate = built.eta;
  let weeks = read.weeksVsTarget;
  let farBehind = false;
  let projected: string | null = null;
  if (!tooFast && !flat && !unconfirmed && targetDate != null && read.relation === 'behind') {
    const days_ = built.eta != null ? etaDaysAhead(built.eta, targetDate) : null;
    if (days_ == null || days_ < -FAR_BEHIND_DAYS) {
      farBehind = true;
      projected = built.eta;
      etaDate = null;
      weeks = null;
    }
  }

  // The verdict, and the ONE action.
  let verdict: GoalVerdict;
  if (tooFast && !nearlyThere) verdict = 'too_fast';
  else {
    let base: GoalVerdict;
    if (flat) base = wrongWay ? 'behind' : 'stalled';
    else if (unconfirmed) base = 'progressing';
    else if (targetDate != null) base = read.relation === 'ahead' ? 'ahead' : read.relation === 'behind' ? 'behind' : 'on_track';
    else if (built.eta == null) base = 'behind';
    else base = read.slow ? 'behind' : 'on_track';
    verdict = nearlyThere && (base === 'behind' || base === 'stalled') ? 'progressing' : base;
  }

  let action: WeightPlanAction;
  if (nearlyThere) {
    // The step is a number (wave 22w): "Start easing calories toward maintenance" alone gave no figure to ease to.
    const step = maintenanceStep(input);
    const lead = targetKg != null ? `Start easing calories toward maintenance as you close in on ${planWeightText(input, targetKg)}` : 'Start easing calories toward maintenance';
    action = {
      kind: 'ease_to_maintenance',
      text: step != null ? `${lead} — ${step.text}` : lead,
      ...(step?.kcalTarget != null ? { kcalTarget: step.kcalTarget } : {}),
    };
  } else if (tooFast) {
    const t = input.targetKcal;
    action = {
      kind: 'eat_to_target',
      text: `Eat up to ${t != null && t > 0 ? `your full ${kcalText(t)} target` : 'your full calorie target'} — a slower loss is easier to keep`,
      ...(t != null && t > 0 ? { kcalTarget: t } : {}),
    };
  } else if (unconfirmed && !flat) {
    action = {
      kind: 'confirm_pace',
      text: `Your projected date shows on ${fmtWeekday(nextMonday, todayKey)} once another week of weigh-ins confirms this pace`,
    };
  } else if (call === 'behind' && targetDate != null && !wrongWay && !flat) {
    action = behindAction(c, { pace, toGoKg, bodyKg, far: farBehind });
  } else if (call === 'ahead' || call === 'on_pace') {
    action = { kind: 'keep_going', text: 'Keep your routine — it is working' };
  } else {
    action = { kind: 'hold', text: 'Keep logging your meals and weigh-ins so the trend reads clearly' };
  }

  return {
    ...blank,
    state: 'pace',
    call,
    verdict,
    etaDate,
    weeksVsTarget: read.state === 'confirmed' && etaDate != null ? weeks : null,
    action,
    pace: paceOf(read),
    confirmed: !unconfirmed,
    onPace: farBehind ? false : built.onPace,
    tooFast,
    nearlyThere,
    slow: read.slow,
    away: read.away,
    farBehind,
    projectedEta: projected,
    firstPaceWeek: unconfirmed,
  };
}

/** The maintenance estimate the step may land on: the learned one when the caller has it, else the formula's; null when neither is known. */
function tdeeEstimate(input: WeightPlanInput): number | null {
  return input.learnedTdee ?? input.formulaTdee ?? null;
}

/** A calorie target that already is (within 100 kcal of, or above) the maintenance estimate has nothing to step toward. */
function budgetIsMaintenance(input: WeightPlanInput): boolean {
  const tdee = tdeeEstimate(input);
  return input.targetKcal != null && tdee != null && input.targetKcal >= tdee - MAINTENANCE_BUDGET_MARGIN_KCAL;
}

/**
 * The concrete step toward maintenance (wave 22w): "add ~150-200 kcal a day (to ~2,150-2,200 kcal) and watch the weekly average for 2
 * weeks". From the budget, capped at the maintenance estimate when there is one; with no budget only the amounts are named.
 * `kcalTarget` is the first notch (budget + 150). Null when the budget already is at or past the estimate.
 */
function maintenanceStep(input: WeightPlanInput): { text: string; kcalTarget: number | null } | null {
  const watch = 'and watch the weekly average for 2 weeks';
  const budget = input.targetKcal != null && input.targetKcal > 0 ? input.targetKcal : null;
  if (budget == null) return { text: `add ~${fmtKcal(MAINTENANCE_STEP_LO_KCAL)}–${kcalText(MAINTENANCE_STEP_HI_KCAL)} a day ${watch}`, kcalTarget: null };
  const tdee = tdeeEstimate(input);
  let hi = budget + MAINTENANCE_STEP_HI_KCAL;
  let lo = budget + MAINTENANCE_STEP_LO_KCAL;
  if (tdee != null) {
    hi = Math.min(hi, roundTo(tdee, TRIM_ROUND_KCAL));
    lo = Math.min(lo, hi);
  }
  if (hi <= budget) return null;
  const amount = lo === hi ? kcalText(hi - budget) : `${fmtKcal(lo - budget)}–${kcalText(hi - budget)}`;
  const landing = lo === hi ? kcalText(hi) : `${fmtKcal(lo)}–${kcalText(hi)}`;
  return { text: `add ~${amount} a day (to ~${landing}) ${watch}`, kcalTarget: lo };
}

/** The plan for a week in which the target is reached: the CTA for its first days, then maintenance. */
function reachedPlan(c: Ctx, blank: WeightWeekPlan, asOf: string): WeightWeekPlan {
  const { input, days } = c;
  const targetKg = input.targetKg as number;
  const since = input.reachedAt ?? input.startDay;
  // The question runs to the end of a calendar week: every week whose Monday is under REACHED_ASK_DAYS after the reach asks it (wave 22w).
  const mondaysAfter = since != null ? dayNumber(c.weekStart) - dayNumber(since) : null;
  const asking = mondaysAfter == null || mondaysAfter < REACHED_ASK_DAYS;

  // Still losing past the ceiling after the target: the card's one safety watch (only while the "too fast" call is on).
  // Reaching the target is an event that re-makes the plan, so that call reads the newest weigh-ins, not last Sunday's.
  let tooFast = false;
  let pace: WeightPlanPace | null = null;
  const newest = days.filter(d => d.day <= input.todayKey);
  if (newest.length > 0) {
    const built = buildRead(c.read, newest, newest[newest.length - 1].day);
    tooFast = built.read.tooFast;
    pace = paceOf(built.read);
  }
  const base: WeightWeekPlan = { ...blank, call: 'none', verdict: 'reached', pace, tooFast };
  if (asking) {
    // A calorie target that already is maintenance has nothing to "switch" to: keep it there (the review says the same).
    if (budgetIsMaintenance(input)) {
      return {
        ...base,
        state: 'reached',
        action: { kind: 'hold', text: 'Your calorie target is already at maintenance — keep it there and the weight should hold.', kcalTarget: input.targetKcal as number },
      };
    }
    // Switching to maintenance is a number: the step from the budget (the TDEE estimate caps it) and how long to watch.
    const step = maintenanceStep(input);
    return {
      ...base,
      state: 'reached',
      action: {
        kind: 'next_target',
        text: step != null ? `Set a new target or switch to maintenance — ${step.text}` : 'Set a new target or switch to maintenance',
        ...(step?.kcalTarget != null ? { kcalTarget: step.kcalTarget } : {}),
      },
    };
  }

  // Maintenance: the weekly average has held within a kilo for 2+ weeks, on logged intake — make that the target.
  let held: { kg: number; kcal: number } | null = null;
  const known = through(days, asOf);
  const w2 = meanOver(known, asOf, 7);
  const w1 = meanOver(known, addDays(asOf, -7), 7);
  const reachedLongEnough = input.reachedAt == null || dayNumber(asOf) - dayNumber(input.reachedAt) >= MAINTENANCE_HELD_DAYS - 1;
  if (reachedLongEnough && w1 != null && w2 != null && w1.n >= WEEK_MEAN_MIN_WEIGH_INS && w2.n >= WEEK_MEAN_MIN_WEIGH_INS
    && Math.abs(w1.meanKg - targetKg) <= HOLDING_NEAR_TARGET_KG && Math.abs(w2.meanKg - targetKg) <= HOLDING_NEAR_TARGET_KG) {
    const logged = loggedInSpan(input.intakeDays, addDays(asOf, -(MAINTENANCE_HELD_DAYS - 1)), asOf);
    if (logged.length >= MAINTENANCE_MIN_LOGGED_DAYS) {
      held = { kg: (w1.meanKg + w2.meanKg) / 2, kcal: roundTo(avg(logged.map(l => l.kcal)), TRIM_ROUND_KCAL) };
    }
  }
  if (held != null) {
    // "Held about 84 kg": whole units, said as approximate - the card's own lines carry the weekly average to a decimal ("Holding at 83.7 kg"),
    // and a bare "84 kg" next to it read as a second, different number.
    const heldText = `about ${withUnit(Math.round(isImperial(input) ? held.kg * KG_TO_LB : held.kg), isImperial(input) ? 'lb' : 'kg')}`;
    const already = input.targetKcal != null && Math.abs(input.targetKcal - held.kcal) <= MAINTENANCE_ALREADY_KCAL;
    return {
      ...base,
      state: 'maintenance',
      heldKg: held.kg,
      action: already
        ? { kind: 'hold', text: `You've held ${heldText} on ~${kcalText(held.kcal)} — keep your calorie target where it is`, kcalTarget: held.kcal }
        : { kind: 'maintenance_target', text: `You've held ${heldText} on ~${kcalText(held.kcal)} — make that your maintenance target`, kcalTarget: held.kcal },
    };
  }
  // No held intake to name yet. The watch is two-sided: a weekly average 1 kg above OR below the target is the cue.
  const cue = `${planWeightText(input, HOLDING_NEAR_TARGET_KG)} above or below your target`;
  if (budgetIsMaintenance(input)) {
    return {
      ...base,
      state: 'maintenance',
      action: {
        kind: 'hold',
        text: `Your calorie target is already at maintenance — keep it there and watch the weekly average; a drift of ${cue} is your cue to act.`,
        kcalTarget: input.targetKcal as number,
      },
    };
  }
  // Still on the deficit budget for the first weeks of maintenance (counted on the week's Monday, so the plan is one thing all week).
  const sinceMonday = since != null ? dayNumber(c.weekStart) - dayNumber(since) : null;
  const step = sinceMonday != null && sinceMonday > MAINTENANCE_STEP_DAYS ? null : maintenanceStep(input);
  if (step != null) {
    return {
      ...base,
      state: 'maintenance',
      action: {
        kind: 'maintenance_target',
        text: `Target reached — ${step.text}; a drift of ${cue} is your cue to act`,
        ...(step.kcalTarget != null ? { kcalTarget: step.kcalTarget } : {}),
      },
    };
  }
  return {
    ...base,
    state: 'maintenance',
    action: {
      kind: 'hold',
      text: `Keep weighing in a few mornings a week; if your average drifts ${cue}, that is your cue to act.`,
    },
  };
}

/**
 * Whether a plan's action is an instruction: the weekly review's "Next week" is then that same text, and the card
 * shows it as a reason. (Keep going, hold, keep weighing and "the date shows on Monday" instruct nothing.)
 */
export function isInstruction(action: WeightPlanAction): boolean {
  return action.kind !== 'keep_going' && action.kind !== 'hold' && action.kind !== 'keep_weighing' && action.kind !== 'confirm_pace';
}

