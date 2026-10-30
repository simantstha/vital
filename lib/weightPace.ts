/**
 * Vital — weight pace (pure, no DB or Next.js imports)
 *
 * ONE place that answers "how fast is the scale moving?" and "has the target
 * been reached?" for a weight goal, from RAW weigh-ins. The smoothed trend line
 * in lib/weightTrend.ts (EWMA, alpha 0.1) stays exactly as it is — it draws the
 * charts. But it is seeded at the first reading and lags about ten days, so a
 * rate read off its slope swings from "24 weeks behind" to "1 week ahead" inside
 * a month. Decisions (pace, ETA, ahead/behind, too fast, plateau, reached) are
 * made here instead, and every surface reads the same numbers: the goal card
 * (lib/goalProgress.ts), the coach signals (lib/brain/weightSignals.ts), the
 * opener (lib/brain/openerText.ts) and the weekly review (lib/weeklyReview.ts).
 *
 *  - weightPace — ordinary least-squares slope over the raw weigh-ins of the
 *    last 21 days; needs 6 weigh-ins spanning 14 days, else there is no pace.
 *  - bridgedPace — weightPace, except that for up to 7 days after a valid pace
 *    the window widens to 28 days, so a gap in weigh-ins that slides the old
 *    ones out of the 21 days does not drop a settled pace back to an early read.
 *  - tooFastLoss — the "losing too fast" call, with hysteresis: entered only when
 *    the pace now AND the pace a week ago are over 1%/wk, left only below 0.9%.
 *  - weighInReturn — a gap of 7+ days without a weigh-in, and how many
 *    weigh-ins have come back since.
 *  - rawPlateau — three flat weeks of raw weekly means.
 *  - weightReachedRead — reached / reachedAt computed statelessly from history.
 */

import type { WeightTrendDay } from './weightTrend';

/** The raw part of a trend day — all the pace maths needs. */
export type RawWeightDay = Pick<WeightTrendDay, 'day' | 'rawKg'>;

// ── Thresholds ──────────────────────────────────────────────────────────────

/** A pace is a straight line through the raw weigh-ins of this many days. */
export const PACE_WINDOW_DAYS = 21;
/** ...and needs at least this many weigh-in days in the window... */
export const PACE_MIN_WEIGH_INS = 6;
/** ...spanning at least this many calendar days. */
export const PACE_MIN_SPAN_DAYS = 14;
/** A goal younger than this only gets an early read (the pace settles after 3 weeks). */
export const PACE_SETTLE_DAYS = 21;
/** The pace is checked again as of this many days ago, from the same readings; ahead/behind needs both to agree. */
export const PACE_RECHECK_DAYS = 7;
/** A valid pace within this many days back keeps a pace alive after a gap in weigh-ins (see bridgedPace)... */
export const PACE_BRIDGE_LOOKBACK_DAYS = 7;
/** ...by fitting the line over this many days instead of PACE_WINDOW_DAYS. */
export const PACE_BRIDGE_WINDOW_DAYS = 28;
/** Losing too fast: enter only when the pace now and the pace PACE_RECHECK_DAYS ago are both over this % of bodyweight per week... */
export const TOO_FAST_ENTER_PCT = 1.0;
/** ...and, once in, stay in until the pace falls below this (a pace between the two keeps the call, so it cannot flip day to day). */
export const TOO_FAST_EXIT_PCT = 0.9;
/** tooFastLoss walks the weigh-ins of this many days up to the day asked: a call older than that is re-made from the pace anyway. */
export const TOO_FAST_WALK_DAYS = 56;
/** An ETA within this many days of the target date reads as on pace — the one margin the card, the opener and iOS share. */
export const ON_PACE_MARGIN_DAYS = 7;

/** Days without a weigh-in that make the next one a "welcome back". */
export const WEIGH_IN_GAP_DAYS = 7;
/** Weigh-ins that must be back after a gap before too fast / behind may be called again. */
export const RETURN_WEIGH_INS_NEEDED = 3;

/** A plateau needs a goal at least this old... */
export const PLATEAU_MIN_GOAL_DAYS = 28;
/** ...three weekly raw means within this many kg of the first... */
export const PLATEAU_TOLERANCE_KG = 0.2;
/** ...with at least this many weigh-ins in each of the three weeks. */
export const PLATEAU_MIN_WEIGH_INS_PER_WEEK = 3;

/** Reached: the 7-day raw mean within this many kg of the target (needs REACHED_MIN_WEIGH_INS in the week)... */
export const REACHED_MEAN_MARGIN_KG = 0.3;
/** ...or the smoothed trend within this many kg. */
export const REACHED_TREND_MARGIN_KG = 0.1;
export const REACHED_MIN_WEIGH_INS = 3;

// ── Day arithmetic (calendar days, no timezone) ─────────────────────────────

export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function addDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
}

// ── Pace ────────────────────────────────────────────────────────────────────

export interface WeightPace {
  /** Slope of the raw weigh-ins, kg per week; negative = losing. */
  kgPerWeek: number;
  /** `kgPerWeek` as a signed % of the fitted weight, per week. */
  pctPerWeek: number;
  /** The fitted line's weight on the newest weigh-in day, kg. */
  fittedKg: number;
  /** Weigh-in days in the window. */
  weighIns: number;
  /** Calendar days from the oldest to the newest weigh-in in the window. */
  spanDays: number;
  oldestDay: string;
  newestDay: string;
  /** Days the line was fitted over: PACE_WINDOW_DAYS, or PACE_BRIDGE_WINDOW_DAYS while bridging a gap. */
  windowDays: number;
}

/**
 * Least-squares pace over the raw weigh-ins in the 21 days up to and including
 * `asOfDay` (`windowDays` widens it; bridgedPace is the one caller that does).
 * Null — "not enough data for a pace" — below 6 weigh-ins or under 14 days of
 * span. `days` is one raw reading per day (computeWeightTrend's `days`), any order.
 */
export function weightPace(
  days: ReadonlyArray<RawWeightDay>,
  asOfDay: string,
  windowDays = PACE_WINDOW_DAYS,
): WeightPace | null {
  const asOf = dayNumber(asOfDay);
  // ISO day strings sort as dates: the window is cut on them first so only its handful of readings are converted.
  const oldest = addDays(asOfDay, -(windowDays - 1));
  const pts = days
    .filter(d => d.day <= asOfDay && d.day >= oldest && Number.isFinite(d.rawKg))
    .map(d => ({ day: d.day, x: dayNumber(d.day) - asOf, y: d.rawKg }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < PACE_MIN_WEIGH_INS) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanDays = last.x - first.x;
  if (spanDays < PACE_MIN_SPAN_DAYS) return null;

  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx <= 0) return null;
  const slopePerDay = sxy / sxx;
  const fittedKg = my + slopePerDay * (last.x - mx);
  const kgPerWeek = slopePerDay * 7;
  return {
    kgPerWeek,
    pctPerWeek: fittedKg > 0 ? (kgPerWeek / fittedKg) * 100 : 0,
    fittedKg,
    weighIns: n,
    spanDays,
    oldestDay: first.day,
    newestDay: last.day,
    windowDays,
  };
}

/**
 * The pace the card states. It is weightPace over 21 days — except right after a
 * gap in weigh-ins: when the 21 days no longer hold a pace but one existed on one
 * of the last PACE_BRIDGE_LOOKBACK_DAYS days, the line is fitted over 28 days
 * instead, so the weigh-ins from before the gap keep carrying a pace while the
 * new ones build up. Without it the pace dropped to "not enough weigh-ins" for a
 * few days a week after every gap, and back again.
 */
export function bridgedPace(days: ReadonlyArray<RawWeightDay>, asOfDay: string): WeightPace | null {
  const direct = weightPace(days, asOfDay);
  if (direct != null) return direct;
  for (let back = 1; back <= PACE_BRIDGE_LOOKBACK_DAYS; back++) {
    if (weightPace(days, addDays(asOfDay, -back)) != null) return weightPace(days, asOfDay, PACE_BRIDGE_WINDOW_DAYS);
  }
  return null;
}

/** The loss a pace shows, as the % of bodyweight per week it prints (2 decimals); 0 when the scale is not falling. */
export function paceLossPct(pace: WeightPace): number {
  return pace.kgPerWeek < 0 ? Math.round(Math.abs(pace.pctPerWeek) * 100) / 100 : 0;
}

/**
 * Whether the loss is "too fast" as of `asOfDay`, computed statelessly by walking
 * the weigh-in days oldest to newest (like weightReachedRead). It is entered only
 * when the pace on a day AND the pace a week earlier both exceed TOO_FAST_ENTER_PCT,
 * and once in it ends only when the pace falls below TOO_FAST_EXIT_PCT, so a pace
 * that wobbles around 1.0% a week reads as one steady call instead of a flip every
 * few days. A gap of WEIGH_IN_GAP_DAYS+ without a weigh-in starts over, and
 * `settledFrom` (the goal's first day with a settled pace) keeps the early weeks'
 * water loss from starting the call.
 */
export function tooFastLoss(
  days: ReadonlyArray<RawWeightDay>,
  asOfDay: string,
  opts: { settledFrom?: string | null } = {},
): boolean {
  const sorted = days
    .filter(d => d.day <= asOfDay && Number.isFinite(d.rawKg))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const walkFrom = addDays(asOfDay, -(TOO_FAST_WALK_DAYS - 1));
  let on = false;
  let prevDay: string | null = null;
  for (const d of sorted) {
    if (d.day < walkFrom) continue;
    if (prevDay != null && dayNumber(d.day) - dayNumber(prevDay) - 1 >= WEIGH_IN_GAP_DAYS) on = false;
    prevDay = d.day;
    if (opts.settledFrom != null && d.day < opts.settledFrom) continue;
    const now = bridgedPace(sorted, d.day);
    if (now == null) continue;
    const nowPct = paceLossPct(now);
    if (on) {
      if (nowPct < TOO_FAST_EXIT_PCT) on = false;
    } else if (nowPct > TOO_FAST_ENTER_PCT) {
      const then = bridgedPace(sorted, addDays(d.day, -PACE_RECHECK_DAYS));
      if (then != null && paceLossPct(then) > TOO_FAST_ENTER_PCT) on = true;
    }
  }
  return on;
}

/** Mean of the raw weigh-ins in the `windowDays` days up to and including `endDay`; null with none. */
export function meanOver(
  days: ReadonlyArray<RawWeightDay>,
  endDay: string,
  windowDays = 7,
): { meanKg: number; n: number } | null {
  const oldest = addDays(endDay, -(windowDays - 1));
  const inWindow = days.filter(d => d.day <= endDay && d.day >= oldest);
  if (inWindow.length === 0) return null;
  return { meanKg: inWindow.reduce((s, d) => s + d.rawKg, 0) / inWindow.length, n: inWindow.length };
}

// ── Pace against a target date ──────────────────────────────────────────────

export type PaceRelation = 'ahead' | 'on_pace' | 'behind';

/**
 * Projected date the target is reached at `pace`, anchored to its newest
 * weigh-in. Null when the pace points the wrong way, is too flat, or lands
 * more than `maxDays` out. `fromKg` is the weight the distance is measured
 * from (defaults to the pace's fitted weight).
 */
export function paceEta(
  pace: WeightPace,
  targetKg: number,
  opts: { fromKg?: number; minPct?: number; maxDays?: number } = {},
): string | null {
  const needed = targetKg - (opts.fromKg ?? pace.fittedKg);
  if (needed === 0 || Math.sign(pace.kgPerWeek) !== Math.sign(needed)) return null;
  if (Math.abs(pace.pctPerWeek) <= (opts.minPct ?? 0)) return null;
  const daysToGo = Math.ceil((Math.abs(needed) / Math.abs(pace.kgPerWeek)) * 7);
  if (daysToGo > (opts.maxDays ?? 3650)) return null;
  return addDays(pace.newestDay, daysToGo);
}

/** Days the ETA beats the target date by (positive = ahead, negative = behind). */
export function etaDaysAhead(eta: string, targetDate: string): number {
  return dayNumber(targetDate) - dayNumber(eta);
}

/** The shared ahead / on pace / behind call: within ON_PACE_MARGIN_DAYS either side is on pace. */
export function relationForDays(daysAhead: number): PaceRelation {
  if (daysAhead > ON_PACE_MARGIN_DAYS) return 'ahead';
  if (daysAhead < -ON_PACE_MARGIN_DAYS) return 'behind';
  return 'on_pace';
}

/** Whole weeks (rounded, at least 1) behind a days-ahead figure — the figure the opener and iOS both print. */
export function weeksForDays(daysAhead: number): number {
  return Math.max(1, Math.round(Math.abs(daysAhead) / 7));
}

// ── Coming back after a gap ─────────────────────────────────────────────────

export interface WeighInReturn {
  /** Days with no weigh-in between the two readings. */
  gapDays: number;
  /** The last weigh-in before the gap. */
  lastBeforeDay: string;
  lastBeforeKg: number;
  /** The first weigh-in after it. */
  firstBackDay: string;
  firstBackKg: number;
  /** Weigh-in days from the first one back to the newest, inclusive. */
  weighInsSince: number;
}

/**
 * The newest gap of WEIGH_IN_GAP_DAYS or more days without a weigh-in, with how
 * many weigh-ins have come back since. Null when there is none. A gap that
 * starts before `notBefore` (the goal's first day — e.g. an old HealthKit
 * backfill reading) is not a return.
 */
export function weighInReturn(days: ReadonlyArray<RawWeightDay>, notBefore: string | null = null): WeighInReturn | null {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (let i = sorted.length - 1; i > 0; i--) {
    const without = dayNumber(sorted[i].day) - dayNumber(sorted[i - 1].day) - 1;
    if (without < WEIGH_IN_GAP_DAYS) continue;
    if (notBefore != null && sorted[i - 1].day < notBefore) return null;
    return {
      gapDays: without,
      lastBeforeDay: sorted[i - 1].day,
      lastBeforeKg: sorted[i - 1].rawKg,
      firstBackDay: sorted[i].day,
      firstBackKg: sorted[i].rawKg,
      weighInsSince: sorted.length - i,
    };
  }
  return null;
}

/** True while fewer than RETURN_WEIGH_INS_NEEDED weigh-ins are back after a gap. */
export function isReturning(ret: WeighInReturn | null): boolean {
  return ret != null && ret.weighInsSince < RETURN_WEIGH_INS_NEEDED;
}

// ── Plateau on raw data ─────────────────────────────────────────────────────

export interface RawPlateau {
  /** Raw mean of the newest of the three weeks, kg. */
  weeklyMeanKg: number;
  /** The three weekly means, oldest first. */
  meansKg: [number, number, number];
}

/**
 * Three flat weeks of RAW weigh-ins: the weekly means of the last two 7-day
 * blocks (ending at `asOfDay`) each within PLATEAU_TOLERANCE_KG of the block
 * before them, with PLATEAU_MIN_WEIGH_INS_PER_WEEK weigh-ins in every block. The
 * goal must be at least PLATEAU_MIN_GOAL_DAYS old (`goalAgeDays` null = unknown,
 * the weigh-in minimum then stands alone). Null otherwise.
 */
export function rawPlateau(
  days: ReadonlyArray<RawWeightDay>,
  asOfDay: string,
  goalAgeDays: number | null,
): RawPlateau | null {
  if (goalAgeDays != null && goalAgeDays < PLATEAU_MIN_GOAL_DAYS) return null;
  const blocks = [2, 1, 0].map(k => meanOver(days, addDays(asOfDay, -7 * k), 7));
  if (blocks.some(b => b == null || b.n < PLATEAU_MIN_WEIGH_INS_PER_WEEK)) return null;
  const [w1, w2, w3] = blocks.map(b => (b as { meanKg: number }).meanKg);
  const flat = (a: number, b: number): boolean => Math.abs(a - b) <= PLATEAU_TOLERANCE_KG + 1e-9;
  if (!flat(w2, w1) || !flat(w3, w1)) return null;
  return { weeklyMeanKg: w3, meansKg: [w1, w2, w3] };
}

// ── Reached ─────────────────────────────────────────────────────────────────

export interface ReachedRead {
  reached: boolean;
  /** First day of the current reached stretch; null when not reached or the crossing was not observed. */
  reachedAt: string | null;
}

/**
 * Whether a weight target is reached, computed statelessly from the readings.
 * Walking the weigh-in days oldest to newest, the target is reached on the
 * first day the 7-day raw mean is within REACHED_MEAN_MARGIN_KG of it (at least
 * REACHED_MIN_WEIGH_INS that week) OR the smoothed trend is within
 * REACHED_TREND_MARGIN_KG of it (or past it, for the goal's direction). Once
 * reached it stays reached until the trend moves back past the target by more
 * than `lapseKg` (and, with 3+ weigh-ins that week, the weekly mean has too —
 * the lagging trend alone must not undo a reach the scale already made).
 * `gain` mirrors every rule for a weight-gain target.
 *
 * `reachedAt` is the first day of the current reached stretch. It is null when
 * the crossing was not observed: the very first reading already met the target,
 * or the stretch began before `startDay` (the goal began at or past the target).
 */
export function weightReachedRead(
  days: ReadonlyArray<WeightTrendDay>,
  opts: { targetKg: number; gain: boolean; lapseKg: number; startDay: string | null },
): ReachedRead {
  const { targetKg, gain, lapseKg, startDay } = opts;
  const eps = 1e-9;
  let reached = false;
  let at: string | null = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const week = meanOver(days.slice(0, i + 1), d.day, 7);
    const meanOk = week != null && week.n >= REACHED_MIN_WEIGH_INS &&
      (gain ? week.meanKg >= targetKg - REACHED_MEAN_MARGIN_KG - eps : week.meanKg <= targetKg + REACHED_MEAN_MARGIN_KG + eps);
    const trendOk = gain ? d.trendKg >= targetKg - REACHED_TREND_MARGIN_KG - eps : d.trendKg <= targetKg + REACHED_TREND_MARGIN_KG + eps;
    if (!reached) {
      if (meanOk || trendOk) {
        reached = true;
        at = d.day;
      }
    } else if (gain ? d.trendKg < targetKg - lapseKg - eps : d.trendKg > targetKg + lapseKg + eps) {
      // The smoothed trend lags the scale by about ten days, so it can still sit past the line right after the weekly mean
      // got there. It only ends the stretch when the weekly mean (3+ weigh-ins) is past the line too.
      const meanPast = week != null && week.n >= REACHED_MIN_WEIGH_INS &&
        (gain ? week.meanKg < targetKg - lapseKg - eps : week.meanKg > targetKg + lapseKg + eps);
      if (meanPast || week == null || week.n < REACHED_MIN_WEIGH_INS) {
        reached = false;
        at = null;
      }
    }
  }
  if (!reached || at == null) return { reached: false, reachedAt: null };
  const unobserved = (days.length > 0 && at === days[0].day) || (startDay != null && at < startDay);
  return { reached: true, reachedAt: unobserved ? null : at };
}
