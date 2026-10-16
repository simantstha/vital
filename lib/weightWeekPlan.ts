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
  PLATEAU_TOLERANCE_KG,
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
/** "Set a new target or switch to maintenance" is offered only this many days after the target was reached. */
export const REACHED_ASK_DAYS = 7;

/** A suggested trim is rounded to this many kcal a day (and never under it)... */
const TRIM_ROUND_KCAL = 50;
/** ...and one weekly step is never more than this. */
export const TRIM_MAX_KCAL_PER_STEP = 200;
/** kcal per kg of body weight lost, the usual rule of thumb. */
const KCAL_PER_KG = 7700;
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
  /** Within a kilo of the target and still losing fast: start easing toward maintenance. */
  | 'ease_to_maintenance'
  | 'plateau_water'
  | 'plateau_intake'
  | 'plateau_weekends'
  /** The scale is moving again after a plateau. */
  | 'keep_what_worked'
  /** The target was just reached: set a new one or switch to maintenance. */
  | 'next_target'
  /** Held the weight on real intake: make that the maintenance target. */
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
  /** Too fast, and within a kilo of the target. */
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
  /** Maintenance: the weekly average it held at. */
  heldKg: number | null;
  /** The first week a pace is read: the one place the smoothed trend gets its one-line explanation. */
  firstPaceWeek: boolean;
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

/** "Oct", or "Jan 2027" when the year differs: the month a projection lands in. */
function fmtMonth(day: string, todayKey: string): string {
  const [y, m] = day.split('-').map(Number);
  return y === Number(todayKey.slice(0, 4)) ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`;
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
): WeightPlateauCause | null {
  const logged = loggedInSpan(intake, addDays(anchor, -(PLATEAU_SPAN_DAYS - 1)), anchor);
  if (logged.length < PLATEAU_MIN_LOGGED_DAYS) return null;
  const mean = avg(logged.map(l => l.kcal));
  if (targetKcal != null && mean > targetKcal + PLATEAU_INTAKE_NEAR_KCAL) {
    return { kind: 'intake', namedAt: anchor, loggedDays: logged.length, avgKcal: Math.round(mean), targetKcal };
  }
  const wkend = logged.filter(l => isWeekend(l.day)).map(l => l.kcal);
  const wkday = logged.filter(l => !isWeekend(l.day)).map(l => l.kcal);
  if (wkend.length >= PLATEAU_MIN_WEEKEND_DAYS && wkday.length >= PLATEAU_MIN_WEEKDAY_DAYS) {
    const e = avg(wkend);
    const w = avg(wkday);
    if (e - w >= PLATEAU_WEEKEND_OVER_KCAL) {
      return {
        kind: 'weekends', namedAt: anchor, loggedDays: logged.length, avgKcal: Math.round(mean), targetKcal,
        weekendAvgKcal: Math.round(e), weekdayAvgKcal: Math.round(w),
      };
    }
  }
  return { kind: 'water', namedAt: anchor, loggedDays: logged.length, avgKcal: Math.round(mean), targetKcal };
}

// ── The plan ────────────────────────────────────────────────────────────────

interface Ctx {
  input: WeightPlanInput;
  days: WeightTrendDay[];
  weekStart: string;
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

function plateauAction(c: Ctx, cause: WeightPlateauCause): WeightPlanAction {
  const { input } = c;
  const kcal = input.targetKcal;
  const sessions = input.weeklySessions;
  const trim = `trim ~${kcalText(150)} a day`;
  if (cause.kind === 'intake' && cause.avgKcal != null && cause.targetKcal != null) {
    return {
      kind: 'plateau_intake',
      text: `Logged days averaged ~${kcalText(roundTo(cause.avgKcal, 10))} vs your ${kcalText(cause.targetKcal)} target — getting back to target is the first lever; if still flat 2 weeks after that, ${trim}`,
    };
  }
  if (cause.kind === 'weekends' && cause.weekendAvgKcal != null && cause.weekdayAvgKcal != null) {
    const back = cause.targetKcal != null ? `bring the weekends back toward your ${kcalText(cause.targetKcal)} target` : 'bring the weekends back toward your weekdays';
    return {
      kind: 'plateau_weekends',
      text: `Weekends averaged ~${kcalText(roundTo(cause.weekendAvgKcal, 50))} vs ${fmtKcal(roundTo(cause.weekdayAvgKcal, 50))} on weekdays — ${back} first; if still flat 2 weeks after that, ${trim}`,
    };
  }
  const keep = [
    kcal != null && kcal > 0 ? kcalText(kcal) : null,
    sessions != null && sessions > 0 ? `${sessions} ${plural(sessions, 'session')}` : null,
  ].filter((x): x is string => x != null);
  return {
    kind: 'plateau_water',
    text: `Common and often water: keep ${keep.length > 0 ? keep.join(' and ') : 'your routine'}; if still flat in 2 weeks, ${trim} or add two 30-minute walks`,
  };
}

/**
 * Behind pace: what the target date would take, said once for the week. The trim is
 * a weekly STEP — the gap between the pace needed and the pace now, in kcal, rounded to 50
 * and never more than 200 — and never takes the budget under the calorie floor.
 */
function behindAction(
  c: Ctx,
  opts: { pace: WeightPace | null; toGoKg: number; bodyKg: number; far: boolean; projected: string | null },
): WeightPlanAction {
  const { input, weekStart } = c;
  const { pace, toGoKg, bodyKg, far, projected } = opts;
  const targetDate = input.targetDate as string;
  const daysLeft = dayNumber(targetDate) - dayNumber(weekStart);
  const nowKgPerWeek = pace != null && pace.kgPerWeek < 0 ? -pace.kgPerWeek : 0;
  const budget = input.targetKcal != null && input.targetKcal > 0 ? input.targetKcal : null;
  const floor = calorieFloorKcal(input.floorKcal, input.sex);
  const date = fmtDate(targetDate, input.todayKey);

  // The step: what closing the gap would take, one weekly notch of it.
  const neededKgPerWeek = daysLeft > 0 && toGoKg > 0 ? toGoKg / (daysLeft / 7) : null;
  const wantedKcal = neededKgPerWeek != null && neededKgPerWeek > nowKgPerWeek
    ? ((neededKgPerWeek - nowKgPerWeek) * KCAL_PER_KG) / 7
    : TRIM_MAX_KCAL_PER_STEP;
  let step = Math.min(TRIM_MAX_KCAL_PER_STEP, Math.max(TRIM_ROUND_KCAL, roundTo(wantedKcal, TRIM_ROUND_KCAL)));
  // Never below the floor: a smaller step, or none.
  if (budget != null && budget - step < floor) {
    step = Math.floor(Math.max(0, budget - floor) / TRIM_ROUND_KCAL) * TRIM_ROUND_KCAL;
  }
  const trimText = step >= TRIM_ROUND_KCAL ? `trim ~${kcalText(step)} a day${budget != null ? ` (to ~${kcalText(budget - step)})` : ''}` : null;
  const kcalTarget = trimText != null && budget != null ? budget - step : undefined;

  if (far) {
    const month = projected != null ? ` to ~${fmtMonth(projected, input.todayKey)}` : '';
    if (trimText != null) return { kind: 'trim', text: `Move the date${month} or ${trimText}`, kcalTarget };
    return { kind: 'move_date', text: `Move the date${month} — your calories are already near the ${kcalText(floor)} floor` };
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
  const days = [...input.days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (days.length === 0) return null;
  const { todayKey, startDay, targetKg, targetDate } = input;
  const weekStart = weekStartKeyForDay(todayKey);
  const c: Ctx = { input, days, weekStart, read: { startDay, targetKg, targetDate } };
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
  // The plan reads the weigh-ins through the Sunday — and is re-made as of the day one of the week's events happens:
  // the welcome back ends (3 weigh-ins are back), the first pace becomes possible, "too fast" enters.
  let asOf = base;
  let prevDay = base;
  for (const d of scan) {
    if ((returningAt(prevDay) && !returningAt(d)) || (lacksPace(asOf) && !lacksPace(d)) || (!tooFastAt(asOf) && tooFastAt(d))) asOf = d;
    prevDay = d;
  }

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
    away: false, farBehind: false, projectedEta: null, plateauMeanKg: null, heldKg: null, firstPaceWeek: false,
  };

  // The target is reached (any day: the crossing is an event): a CTA for the first week, then maintenance.
  if (input.reached && targetKg != null) {
    return reachedPlan(c, blank, asOf);
  }
  if (anchor == null) return { ...blank, young: (ageAt(startDay, asOf) ?? PACE_SETTLE_DAYS) < PACE_SETTLE_DAYS };

  if (returning) {
    return {
      ...blank,
      state: 'returning',
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
    };
  }

  // Moving again: a plateau ended in the last 14 days and the weekly average is falling again. The 21-day line still
  // covers the flat weeks, so it would call this "behind"; it is not read until the plateau is two weeks behind.
  for (let back = 1; back <= MOVING_AGAIN_DAYS; back++) {
    const d = addDays(asOf, -back);
    const was = rawPlateau(through(days, d), d, ageAt(startDay, d));
    if (was == null) continue;
    const now = meanOver(known, asOf, 7);
    if (now != null && now.n >= WEEK_MEAN_MIN_WEIGH_INS && now.meanKg <= was.weeklyMeanKg - PLATEAU_TOLERANCE_KG) {
      return {
        ...blank,
        state: 'moving_again',
        verdict: 'progressing',
        action: { kind: 'keep_what_worked', text: 'Keep doing what restarted it' },
        plateauMeanKg: round1(was.weeklyMeanKg),
      };
    }
    break; // the most recent plateau day decides; a weekly average that is not falling is an ordinary pace
  }

  if (read.state === 'early' || pace == null) {
    const youngNote = 'Keep weighing in — your pace settles after 3 weeks of weigh-ins';
    const olderNote = 'Keep weighing in — a pace needs 6 weigh-ins spanning at least 2 weeks';
    return { ...blank, state: 'early', young: read.young, action: { kind: 'keep_weighing', text: read.young ? youngNote : olderNote } };
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
  const nearlyThere = tooFast && closestKg <= HOLDING_NEAR_TARGET_KG;
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
    action = {
      kind: 'ease_to_maintenance',
      text: targetKg != null ? `Start easing calories toward maintenance as you close in on ${planWeightText(input, targetKg)}` : 'Start easing calories toward maintenance',
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
    action = behindAction(c, { pace, toGoKg, bodyKg, far: farBehind, projected });
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

/** The plan for a week in which the target is reached: the CTA for its first days, then maintenance. */
function reachedPlan(c: Ctx, blank: WeightWeekPlan, asOf: string): WeightWeekPlan {
  const { input, days } = c;
  const targetKg = input.targetKg as number;
  const since = input.reachedAt ?? input.startDay;
  const daysSince = since != null ? dayNumber(input.todayKey) - dayNumber(since) : null;
  const asking = daysSince == null || daysSince <= REACHED_ASK_DAYS;

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
    const atMaintenance = input.targetKcal != null && input.formulaTdee != null && input.targetKcal >= input.formulaTdee - MAINTENANCE_BUDGET_MARGIN_KCAL;
    if (atMaintenance) {
      return {
        ...base,
        state: 'reached',
        action: { kind: 'hold', text: 'Your calorie target is already at maintenance — keep it there and the weight should hold.', kcalTarget: input.targetKcal as number },
      };
    }
    return { ...base, state: 'reached', action: { kind: 'next_target', text: 'Set a new target or switch to maintenance' } };
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
    // "Held 84 kg": whole units — the card's own line carries the weekly average to a decimal, this is the level it held at.
    const heldText = withUnit(Math.round(isImperial(input) ? held.kg * KG_TO_LB : held.kg), isImperial(input) ? 'lb' : 'kg');
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
  return {
    ...base,
    state: 'maintenance',
    action: {
      kind: 'hold',
      text: `Keep weighing in a few mornings a week; if your average drifts ${planWeightText(input, HOLDING_NEAR_TARGET_KG)} above your target, that is your cue to act.`,
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

