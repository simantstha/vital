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
import { trendSpanDays } from '../weightTrend';
import {
  PACE_RECHECK_DAYS,
  PACE_SETTLE_DAYS,
  TOO_FAST_ENTER_PCT,
  addDays,
  bridgedPace,
  dayNumber,
  isReturning,
  rawPlateau,
  tooFastLoss,
  weighInReturn,
} from '../weightPace';
import { LB_PER_KG, formatWeight } from '../metricFormat';
import type { UnitSystem } from '../units';

// ── Thresholds (named constants — see the module's spec for the evidence) ──

/** A weekly trend rate needs at least this many calendar days of trend span before it's quoted at all. */
export const RATE_RELIABLE_MIN_SPAN_DAYS = 7;

/**
 * too_fast_loss fires once the pace (and the pace a week earlier) exceeds this % of bodyweight per week, and
 * stays on until it falls below 0.9% (lib/weightPace.ts tooFastLoss) — the same call the goal card makes.
 */
export const TOO_FAST_LOSS_PCT_PER_WEEK = TOO_FAST_ENTER_PCT;
/** Above this %/wk (or sustained — see below), too_fast_loss escalates to 'watch'. */
export const TOO_FAST_LOSS_WATCH_PCT_PER_WEEK = 1.5;
/** "Sustained" for too_fast_loss's watch escalation: both the 7d AND 30d rates exceed this %/wk. */
export const TOO_FAST_LOSS_SUSTAINED_PCT_PER_WEEK = 1.0;

/**
 * plateau / too_fast_loss describe what the trend is doing NOW, so they need a
 * weigh-in within this many days of today (measured from today, not from the
 * last weigh-in): a user who stopped weighing in must not be told their trend
 * "has flattened" or is "dropping quickly" from weeks-old data.
 */
export const SIGNAL_MAX_WEIGH_IN_AGE_DAYS = 4;

/** The coach prompt's weight-trend line never quotes a weekly rate when the newest weigh-in is older than this. */
export const RATE_QUOTE_MAX_WEIGH_IN_AGE_DAYS = 7;

/**
 * plateau (lib/weightPace.ts rawPlateau): three flat weeks of RAW weekly means —
 * the last two within 0.2 kg of the week before them, 3+ weigh-ins in each week,
 * a goal at least 28 days old. The lagging smoothed trend no longer decides it.
 */
export const PLATEAU_MIN_SPAN_DAYS = 14;
export const PLATEAU_MIN_WEIGH_INS = 4;
/** A pace at/under this % of bodyweight per week is flat (the goal card's "stalled" and the floor for projecting a date). */
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
  /**
   * The user's current local day (YYYY-MM-DD). plateau and too_fast_loss look
   * back from THIS day and need a weigh-in within SIGNAL_MAX_WEIGH_IN_AGE_DAYS
   * of it. Every production caller passes it; when omitted (pure unit tests)
   * the newest weigh-in stands in for today, i.e. no freshness check.
   */
  todayKey?: string;
  /**
   * The local day the user's goal began (YYYY-MM-DD). With it, a goal under
   * 3 weeks old gets no too_fast_loss (its pace is still an early read) and a
   * plateau needs a goal at least 28 days old. Omitted: only the weigh-in
   * minimums apply.
   */
  goalStartDay?: string | null;
  /**
   * The weight-loss week plan the goal card shows (GoalProgress.weightRead.plan, lib/weightWeekPlan.ts). With it the
   * two signals that restate the scale's call follow the plan instead of re-reading the scale today: `plateau` only in
   * a plateau week, `too_fast_loss` only while the plan's "too fast" call is on, so the coach never says "plateau" or
   * "losing fast" on a day the card says otherwise. Absent (no card): the signals read the scale as before.
   */
  weekPlan?: { state: string; tooFast: boolean; flatWeeks?: number | null } | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DAY_MS = 86_400_000;

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Days from the newest weigh-in to `todayKey` (0 when `todayKey` is omitted:
 * the newest weigh-in stands in for today). Never negative.
 */
function weighInAgeDays(trend: WeightTrendResult, todayKey: string | undefined): number {
  if (trend.days.length === 0) return Infinity;
  if (!todayKey) return 0;
  const last = trend.days[trend.days.length - 1].day;
  return Math.max(0, Math.round((dayMs(todayKey) - dayMs(last)) / DAY_MS));
}

/** Calendar days a goal has run, counting the start day and today; null when the start is unknown. */
function goalAgeDays(todayKey: string | undefined, trend: WeightTrendResult, goalStartDay: string | null | undefined): number | null {
  if (!goalStartDay || !/^\d{4}-\d{2}-\d{2}$/.test(goalStartDay)) return null;
  const today = todayKey ?? trend.days[trend.days.length - 1]?.day;
  if (!today) return null;
  return Math.max(1, dayNumber(today) - dayNumber(goalStartDay) + 1);
}

// ── Rule 1: too_fast_loss ────────────────────────────────────────────────
// Called off the PACE (lib/weightPace.ts: a least-squares line through the raw
// weigh-ins of the last 21 days), the same rate the goal card quotes — never the
// lagging smoothed trend, whose 7-day slope across a gap of missed weigh-ins
// is a different, wrong number. And with the card's hysteresis (tooFastLoss):
// entered only when the pace now and a week ago are both over 1%/wk, left only
// below 0.9%, so the coach and the card never disagree about a pace near 1%.

function assessTooFastLoss(
  trend: WeightTrendResult,
  todayKey: string | undefined,
  goalStartDay: string | null | undefined,
): WeightSignal | null {
  if (!trend.established) return null;
  if (weighInAgeDays(trend, todayKey) > SIGNAL_MAX_WEIGH_IN_AGE_DAYS) return null;
  const age = goalAgeDays(todayKey, trend, goalStartDay);
  if (age != null && age < PACE_SETTLE_DAYS) return null;
  // Just back after 7+ days without a weigh-in: a few readings do not make a pace yet.
  if (isReturning(weighInReturn(trend.days, goalStartDay ?? null))) return null;

  const anchor = trend.days[trend.days.length - 1].day;
  const settledFrom = goalStartDay && /^\d{4}-\d{2}-\d{2}$/.test(goalStartDay) ? addDays(goalStartDay, PACE_SETTLE_DAYS - 1) : null;
  if (!tooFastLoss(trend.days, anchor, { settledFrom })) return null;
  const pace = bridgedPace(trend.days, anchor);
  if (pace == null || pace.kgPerWeek >= 0) return null; // no pace, or not losing

  // Judged on the figure that is printed (2 decimals), so "too fast — 1%" can never appear.
  const pct = Math.abs(pace.pctPerWeek);

  // Sustained: the pace one week earlier, from the same readings, was also past the ceiling.
  const earlier = bridgedPace(trend.days, addDays(anchor, -PACE_RECHECK_DAYS));
  const sustained = earlier != null && earlier.kgPerWeek < 0 && round2(Math.abs(earlier.pctPerWeek)) > TOO_FAST_LOSS_SUSTAINED_PCT_PER_WEEK;

  const severity: WeightSignalSeverity =
    pct > TOO_FAST_LOSS_WATCH_PCT_PER_WEEK || sustained ? 'watch' : 'info';

  return {
    kind: 'too_fast_loss',
    severity,
    facts: {
      rateKgPerWeek: round2(pace.kgPerWeek),
      pctPerWeek: round1(pct),
      sustained: sustained ? 'yes' : 'no',
    },
  };
}

// ── Rule 2: plateau ──────────────────────────────────────────────────────
// Three flat weeks of RAW weekly means (see rawPlateau). A trend-based test
// bottomed out at 0.101%/wk against a 0.10 threshold and never fired.

function assessPlateau(
  trend: WeightTrendResult,
  goal: string,
  todayKey: string | undefined,
  goalStartDay: string | null | undefined,
): WeightSignal | null {
  if (goal !== 'weight_loss') return null;
  if (!trend.established) return null;
  if (weighInAgeDays(trend, todayKey) > SIGNAL_MAX_WEIGH_IN_AGE_DAYS) return null;

  const anchor = trend.days[trend.days.length - 1].day;
  const plateau = rawPlateau(trend.days, anchor, goalAgeDays(todayKey, trend, goalStartDay));
  if (plateau == null) return null;

  const currentTrendKg = trend.days[trend.days.length - 1].trendKg;
  return {
    kind: 'plateau',
    severity: 'info',
    // trendKg: the weekly average, kept under the old key for readers of the facts
    // (lib/insights/goalDetectors.ts); the smoothed trend itself is `smoothedTrendKg`.
    facts: {
      weeklyMeanKg: round1(plateau.weeklyMeanKg),
      trendKg: round1(plateau.weeklyMeanKg),
      smoothedTrendKg: round1(currentTrendKg),
      weeks: 3,
    },
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
  const { trend, dailyIntakeKcal, floorKcal, goal, weekendPatternIntakeKcal, todayKey, goalStartDay, weekPlan } = input;

  const signals: WeightSignal[] = [];
  const tooFastLoss = weekPlan != null && !weekPlan.tooFast ? null : assessTooFastLoss(trend, todayKey, goalStartDay);
  if (tooFastLoss) signals.push(tooFastLoss);

  // A flat fortnight (the plan's state is 'plateau' with flatWeeks 2, wave 22w) is a calm hold, not yet a plateau: the card says "two flat weeks".
  const plateau = weekPlan != null && (weekPlan.state !== 'plateau' || weekPlan.flatWeeks === 2) ? null : assessPlateau(trend, goal, todayKey, goalStartDay);
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
 * The numbers a weight-loss goal card measures from, for the coach's weight line: the ONE displayed weight (the 7-day
 * average of 3+ weigh-ins, else the latest scale reading) and the pace the week's plan states
 * (lib/weightWeekPlan.ts), so the coach quotes exactly what the card does and never the chart's smoothed trend or
 * a pace re-fitted today.
 */
export interface WeeklyWeightRead {
  /** `GoalProgress.current.weightKg` of a weight-loss payload. */
  weightKg: number;
  /** 'average': the 7-day mean of 3+ weigh-ins; 'scale': the single latest reading. */
  basis: 'average' | 'scale';
  /** The week plan's pace in kg/wk (negative = losing); null when the card quotes no rate this week. */
  paceKgPerWeek: number | null;
}

/** The slice of a GoalProgress `weeklyWeightRead` needs (structural, so this module stays free of the goalProgress import cycle). */
export interface WeeklyWeightSource {
  goal: string;
  current: { weightKg: number | null; trendKg?: number | null };
  weightRead?: { weekMeanKg?: number | null; plan?: { state: string; pace: { kgPerWeek: number } | null } | null } | null;
}

/**
 * The weight-loss card's weight and weekly pace, or null for any other goal, a payload from before the one-weight
 * rule (no `current.trendKg`: its `weightKg` is still the smoothed trend) or one without a weight. The card quotes a
 * rate only in a pace week - a plateau, a return, "moving again" and an early read state none - so the coach does not
 * either.
 */
export function weeklyWeightRead(gp: WeeklyWeightSource | null | undefined): WeeklyWeightRead | null {
  if (gp == null || gp.goal !== 'weight_loss' || gp.current.trendKg === undefined || gp.current.weightKg == null) return null;
  const plan = gp.weightRead?.plan ?? null;
  return {
    weightKg: gp.current.weightKg,
    basis: gp.weightRead?.weekMeanKg != null ? 'average' : 'scale',
    paceKgPerWeek: plan != null && plan.state === 'pace' && plan.pace != null ? plan.pace.kgPerWeek : null,
  };
}

/** A weekly pace as the goal card prints it: two decimals, trailing zeros dropped ("0.47 kg", "1 lb"). */
function paceText(kgPerWeek: number, unitSystem: UnitSystem): string {
  const v = Math.abs(unitSystem === 'imperial' ? kgPerWeek * LB_PER_KG : kgPerWeek);
  return `${Math.round(v * 100) / 100} ${unitSystem === 'imperial' ? 'lb' : 'kg'}`;
}

/**
 * Renders the "Weight trend & energy signals" prompt lines shared by
 * assembleContext's buildPromptText (lib/brain/context.ts) and the daily
 * brief prompt (lib/claude.ts) so both surfaces describe the trend and
 * react to signals identically — a too_fast_loss signal must never be
 * praised by either.
 *
 * `weekly` (a weight-loss card's own numbers, `weeklyWeightRead`) swaps the smoothed "Trend weight" and its freshly
 * fitted pace for the "Weekly average weight" and the week's pace the card quotes: the user sees one weight.
 */
export function formatWeightSignalsSection(
  trend: Pick<WeightTrendResult, 'days' | 'established'>,
  signals: WeightSignal[],
  unitSystem: UnitSystem,
  /** The user's current local day. With it, a rate is never quoted off a weigh-in older than RATE_QUOTE_MAX_WEIGH_IN_AGE_DAYS. */
  todayKey?: string,
  weekly?: WeeklyWeightRead | null,
): string[] {
  const lines: string[] = [];
  const span = trendSpanDays(trend.days as WeightTrendDay[]);

  if (weekly != null) {
    const age = weighInAgeDays(trend as WeightTrendResult, todayKey);
    let rateStr: string;
    if (Number.isFinite(age) && age > RATE_QUOTE_MAX_WEIGH_IN_AGE_DAYS) {
      rateStr = `last weigh-in ${age} days ago — do not quote a weekly rate`;
    } else if (weekly.paceKgPerWeek == null) {
      rateStr = 'no weekly rate this week — do not quote one';
    } else {
      rateStr = `${paceText(weekly.paceKgPerWeek, unitSystem)}/wk ${weekly.paceKgPerWeek < 0 ? 'loss' : weekly.paceKgPerWeek > 0 ? 'gain' : 'flat'}`;
    }
    lines.push(`- ${weekly.basis === 'average' ? 'Weekly average weight' : 'Latest weigh-in'}: ${formatWeight(weekly.weightKg, unitSystem) ?? 'n/a'} (${rateStr})`);
  } else if (trend.established && span >= RATE_RELIABLE_MIN_SPAN_DAYS) {
    const last = trend.days[trend.days.length - 1];
    const trendStr = formatWeight(last.trendKg, unitSystem);
    const age = weighInAgeDays(trend as WeightTrendResult, todayKey);
    // The rate is the shared pace (a line through 3 weeks of raw weigh-ins), and only while the newest one is recent.
    const pace = age <= RATE_QUOTE_MAX_WEIGH_IN_AGE_DAYS ? bridgedPace(trend.days as WeightTrendDay[], last.day) : null;
    let rateStr: string;
    if (age > RATE_QUOTE_MAX_WEIGH_IN_AGE_DAYS) {
      rateStr = `last weigh-in ${age} days ago — do not quote a weekly rate`;
    } else if (pace == null) {
      rateStr = 'weekly rate not available yet — do not quote one';
    } else {
      const magnitude = formatWeight(Math.abs(pace.kgPerWeek), unitSystem);
      const direction = pace.kgPerWeek < 0 ? 'loss' : pace.kgPerWeek > 0 ? 'gain' : 'flat';
      rateStr = magnitude ? `${magnitude}/wk ${direction}` : 'weekly rate not available yet — do not quote one';
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
