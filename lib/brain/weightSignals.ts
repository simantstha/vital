/**
 * Vital Brain — weight trend & energy signals (pure, no DB or Next.js imports)
 *
 * A registered-dietitian review found the coach could see today's raw
 * weight but not the smoothed trend (lib/weightTrend.ts), so it couldn't
 * spot a plateau, a too-fast loss, or chronic under-eating — and once
 * praised a −1.2 kg/wk (~1.5%/wk) loss, which is a rate worth flagging, not
 * celebrating. This module turns a `computeWeightTrend` result plus a week
 * of resolved daily intake into a short list of signals the coach prompt
 * can render and persona.ts can give response guidance for.
 *
 * Deliberately pure and DB-free (like lib/weightTrend.ts) so it's cheap to
 * unit test exhaustively — see weightSignals.test.ts. Callers (lib/brain/
 * context.ts, lib/brain/brief.ts) own loading the trend + intake data.
 */

import type { WeightTrendResult, WeightTrendDay } from '../weightTrend';
import { trendDeltaKgPerWeek, trendSpanDays } from '../weightTrend';
import { formatWeight } from '../metricFormat';
import type { UnitSystem } from '../units';

// ── Thresholds (named constants — see the module's spec for the evidence) ──

/** A weekly trend rate needs at least this many calendar days of trend span before it's quoted at all. */
export const RATE_RELIABLE_MIN_SPAN_DAYS = 7;

/** too_fast_loss fires once the 7-day rate exceeds this % of current trend weight, per week. */
export const TOO_FAST_LOSS_PCT_PER_WEEK = 1.0;
/** Above this %/wk (or sustained — see below), too_fast_loss escalates to 'watch'. */
export const TOO_FAST_LOSS_WATCH_PCT_PER_WEEK = 1.5;
/** "Sustained" for too_fast_loss's watch escalation: both the 7d AND 30d rates exceed this %/wk. */
export const TOO_FAST_LOSS_SUSTAINED_PCT_PER_WEEK = 1.0;

/** plateau requires at least this many calendar days of trend span. */
export const PLATEAU_MIN_SPAN_DAYS = 14;
/** plateau fires when the 14-day trend change is at/under this % of trend weight, per week. */
export const PLATEAU_MAX_PCT_PER_WEEK = 0.1;

/** under_eating requires at least this many of the trailing 7 days to have non-'none' intake. */
export const UNDER_EATING_MIN_DAYS_WITH_DATA = 3;
/** A 'logged' day under this many kcal is treated as a partial/incomplete log and excluded from the under_eating average. */
export const PARTIAL_LOG_KCAL_THRESHOLD = 300;

/** weekend_overeating looks at this many trailing calendar days — long enough (3-4 weeks) to average out any single wild weekend, short enough to still reflect a CURRENT pattern rather than one from months ago. */
export const WEEKEND_PATTERN_WINDOW_DAYS = 28;
/** Minimum number of logged weekday days required within the window before the pattern is trusted. */
export const WEEKEND_PATTERN_MIN_WEEKDAY_DAYS = 6;
/** Minimum number of logged weekend days required within the window before the pattern is trusted — lower than the weekday minimum because a 4-week window has at most 8 weekend days total (Sat+Sun × 4). */
export const WEEKEND_PATTERN_MIN_WEEKEND_DAYS = 4;
/** weekend_overeating fires when weekend average intake exceeds weekday average by more than this fraction... */
export const WEEKEND_OVEREATING_PCT_THRESHOLD = 0.25;
/** ...AND by more than this many absolute kcal/day — both conditions must hold, so a small base intake (e.g. a very lean small person) whose weekend is 25%+ higher but only +150 kcal doesn't fire on a difference that isn't actionable. */
export const WEEKEND_OVEREATING_KCAL_THRESHOLD = 400;

// ── Types ────────────────────────────────────────────────────────────────

export type WeightSignalKind =
  | 'too_fast_loss'
  | 'plateau'
  | 'under_eating'
  | 'rate_not_yet_reliable'
  | 'weekend_overeating';
export type WeightSignalSeverity = 'info' | 'watch';

export interface WeightSignal {
  kind: WeightSignalKind;
  severity: WeightSignalSeverity;
  facts: Record<string, number | string>;
}

export interface DailyIntakeKcalPoint {
  day: string;
  kcal: number | null;
  source: 'logged' | 'healthkit' | 'none';
}

export interface AssessWeightSignalsInput {
  trend: WeightTrendResult;
  /** Last 7 local days of resolved intake — order doesn't matter. */
  dailyIntakeKcal: DailyIntakeKcalPoint[];
  /** Sex-aware low-energy-availability floor — see dietBudget.ts's lowEnergyThresholdKcal(). */
  floorKcal: number;
  /** The user's diet goal, as used by dietBudget.ts (e.g. 'weight_loss'). */
  goal: string;
  /**
   * Trailing WEEKEND_PATTERN_WINDOW_DAYS (28) local days of resolved intake,
   * for the weekend_overeating signal — a WIDER window than
   * `dailyIntakeKcal`'s 7 days, since a weekday/weekend split needs several
   * weeks to average out one wild weekend. Optional: omit (or pass []) to
   * skip the weekend_overeating check entirely, e.g. for a caller that
   * hasn't loaded the wider window.
   */
  weekendPatternIntakeKcal?: DailyIntakeKcalPoint[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Absolute value of `deltaKgPerWeek` as a percentage of `trendKg` per week, or null if trendKg is 0/invalid. */
function pctPerWeek(deltaKgPerWeek: number | null, trendKg: number): number | null {
  if (deltaKgPerWeek == null || !Number.isFinite(trendKg) || trendKg <= 0) return null;
  return Math.abs(deltaKgPerWeek) / trendKg * 100;
}

// ── Rule 1: too_fast_loss ────────────────────────────────────────────────

function assessTooFastLoss(trend: WeightTrendResult): WeightSignal | null {
  if (!trend.established) return null;
  const span = trendSpanDays(trend.days);
  if (span < RATE_RELIABLE_MIN_SPAN_DAYS) return null;

  const currentTrendKg = trend.days[trend.days.length - 1].trendKg;
  const rate7d = trend.delta7dKgPerWeek;
  if (rate7d == null || rate7d >= 0) return null; // not losing

  const pct7d = pctPerWeek(rate7d, currentTrendKg);
  if (pct7d == null || pct7d <= TOO_FAST_LOSS_PCT_PER_WEEK) return null;

  const rate30d = trend.delta30dKgPerWeek;
  const pct30d = rate30d != null && rate30d < 0 ? pctPerWeek(rate30d, currentTrendKg) : null;
  const sustained = pct30d != null && pct30d > TOO_FAST_LOSS_SUSTAINED_PCT_PER_WEEK;

  const severity: WeightSignalSeverity =
    pct7d > TOO_FAST_LOSS_WATCH_PCT_PER_WEEK || sustained ? 'watch' : 'info';

  const facts: Record<string, number | string> = {
    rateKgPerWeek: round2(rate7d),
    pctPerWeek: round1(pct7d),
    sustained: sustained ? 'yes' : 'no',
  };
  if (pct30d != null) facts.pct30dPerWeek = round1(pct30d);

  return { kind: 'too_fast_loss', severity, facts };
}

// ── Rule 2: plateau ──────────────────────────────────────────────────────

function assessPlateau(trend: WeightTrendResult, goal: string): WeightSignal | null {
  if (goal !== 'weight_loss') return null;
  if (!trend.established) return null;
  const span = trendSpanDays(trend.days);
  if (span < PLATEAU_MIN_SPAN_DAYS) return null;

  const currentTrendKg = trend.days[trend.days.length - 1].trendKg;
  const delta14d = trendDeltaKgPerWeek(trend.days, 14);
  const pct14d = pctPerWeek(delta14d, currentTrendKg);
  if (pct14d == null || pct14d > PLATEAU_MAX_PCT_PER_WEEK) return null;

  return {
    kind: 'plateau',
    severity: 'info',
    facts: { pctPerWeek: round2(pct14d), trendKg: round1(currentTrendKg) },
  };
}

// ── Rule 3: under_eating ─────────────────────────────────────────────────

function assessUnderEating(dailyIntakeKcal: DailyIntakeKcalPoint[], floorKcal: number): WeightSignal | null {
  const withData = dailyIntakeKcal.filter(d => d.source !== 'none' && d.kcal != null);
  if (withData.length < UNDER_EATING_MIN_DAYS_WITH_DATA) return null;

  const partialLogs = withData.filter(
    d => d.source === 'logged' && (d.kcal as number) < PARTIAL_LOG_KCAL_THRESHOLD,
  );
  const included = withData.filter(d => !partialLogs.includes(d));
  if (included.length === 0) return null;

  const avgKcal = included.reduce((sum, d) => sum + (d.kcal as number), 0) / included.length;
  if (avgKcal >= floorKcal) return null;

  return {
    kind: 'under_eating',
    severity: 'watch',
    facts: {
      avgKcal: Math.round(avgKcal),
      floorKcal,
      daysCounted: included.length,
      excludedPartialLogs: partialLogs.length,
    },
  };
}

// ── Rule 4: rate_not_yet_reliable ────────────────────────────────────────

function assessRateNotYetReliable(trend: WeightTrendResult): WeightSignal | null {
  if (!trend.established) return null;
  const span = trendSpanDays(trend.days);
  if (span >= RATE_RELIABLE_MIN_SPAN_DAYS) return null;

  return {
    kind: 'rate_not_yet_reliable',
    severity: 'info',
    facts: { spanDays: span },
  };
}

// ── Rule 5: weekend_overeating ───────────────────────────────────────────

/** Sunday=0 ... Saturday=6, computed purely from the YYYY-MM-DD calendar day (UTC-anchored — day-of-week doesn't depend on time zone). */
function isWeekendDay(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

function assessWeekendOvereating(weekendPatternIntakeKcal: DailyIntakeKcalPoint[] | undefined): WeightSignal | null {
  if (!weekendPatternIntakeKcal || weekendPatternIntakeKcal.length === 0) return null;

  const withData = weekendPatternIntakeKcal.filter(d => d.source !== 'none' && d.kcal != null);
  const weekdayDays = withData.filter(d => !isWeekendDay(d.day));
  const weekendDays = withData.filter(d => isWeekendDay(d.day));

  if (weekdayDays.length < WEEKEND_PATTERN_MIN_WEEKDAY_DAYS) return null;
  if (weekendDays.length < WEEKEND_PATTERN_MIN_WEEKEND_DAYS) return null;

  const weekdayAvg = weekdayDays.reduce((sum, d) => sum + (d.kcal as number), 0) / weekdayDays.length;
  const weekendAvg = weekendDays.reduce((sum, d) => sum + (d.kcal as number), 0) / weekendDays.length;

  if (weekdayAvg <= 0) return null;

  const diffKcal = weekendAvg - weekdayAvg;
  const diffPct = diffKcal / weekdayAvg;

  if (diffPct <= WEEKEND_OVEREATING_PCT_THRESHOLD) return null;
  if (diffKcal <= WEEKEND_OVEREATING_KCAL_THRESHOLD) return null;

  return {
    kind: 'weekend_overeating',
    severity: 'info',
    facts: {
      weekdayAvgKcal: Math.round(weekdayAvg),
      weekendAvgKcal: Math.round(weekendAvg),
      diffKcal: Math.round(diffKcal),
      diffPct: round1(diffPct * 100),
      weekdayDaysCounted: weekdayDays.length,
      weekendDaysCounted: weekendDays.length,
    },
  };
}

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Assesses the small set of evidence-based weight/energy signals the coach
 * should be aware of. Returns an empty array when nothing is notable. No
 * signal depends on DB access — every input is already-resolved data.
 */
export function assessWeightSignals(input: AssessWeightSignalsInput): WeightSignal[] {
  const { trend, dailyIntakeKcal, floorKcal, goal, weekendPatternIntakeKcal } = input;

  const signals: WeightSignal[] = [];
  const tooFastLoss = assessTooFastLoss(trend);
  if (tooFastLoss) signals.push(tooFastLoss);

  const plateau = assessPlateau(trend, goal);
  if (plateau) signals.push(plateau);

  const underEating = assessUnderEating(dailyIntakeKcal, floorKcal);
  if (underEating) signals.push(underEating);

  const rateNotYetReliable = assessRateNotYetReliable(trend);
  if (rateNotYetReliable) signals.push(rateNotYetReliable);

  const weekendOvereating = assessWeekendOvereating(weekendPatternIntakeKcal);
  if (weekendOvereating) signals.push(weekendOvereating);

  return signals;
}

// ── Prompt rendering (shared by lib/brain/context.ts and lib/claude.ts) ────

const SIGNAL_LABEL: Record<WeightSignalKind, string> = {
  too_fast_loss: 'Losing faster than recommended',
  plateau: 'Weight plateau',
  under_eating: 'Average intake below the safe floor',
  rate_not_yet_reliable: 'Not enough history yet for a reliable weekly rate',
  weekend_overeating: 'Weekend intake notably higher than weekdays',
};

function formatFacts(facts: Record<string, number | string>): string {
  return Object.entries(facts).map(([k, v]) => `${k}=${v}`).join(', ');
}

/**
 * Renders the "Weight trend & energy signals" prompt lines shared by
 * assembleContext's buildPromptText (lib/brain/context.ts) and the daily
 * brief prompt (lib/claude.ts) so both surfaces describe the trend and
 * react to signals identically — a too_fast_loss signal must never be
 * praised by either.
 */
export function formatWeightSignalsSection(
  trend: Pick<WeightTrendResult, 'days' | 'established'>,
  signals: WeightSignal[],
  unitSystem: UnitSystem,
): string[] {
  const lines: string[] = [];
  const span = trendSpanDays(trend.days as WeightTrendDay[]);

  if (trend.established && span >= RATE_RELIABLE_MIN_SPAN_DAYS) {
    const last = trend.days[trend.days.length - 1];
    const trendStr = formatWeight(last.trendKg, unitSystem);
    const rate7d = trendDeltaKgPerWeek(trend.days as WeightTrendDay[], 7);
    let rateStr = 'rate not available';
    if (rate7d != null) {
      const magnitude = formatWeight(Math.abs(rate7d), unitSystem);
      const direction = rate7d < 0 ? 'loss' : rate7d > 0 ? 'gain' : 'flat';
      rateStr = magnitude ? `${magnitude}/wk ${direction}` : rateStr;
    }
    lines.push(`- Trend weight: ${trendStr ?? 'n/a'} (${rateStr})`);
  } else {
    lines.push('- Trend weight: not reliable yet — do not quote a weekly rate.');
  }

  for (const signal of signals) {
    lines.push(`- [${signal.severity.toUpperCase()}] ${SIGNAL_LABEL[signal.kind]}: ${formatFacts(signal.facts)}`);
  }

  return lines;
}
