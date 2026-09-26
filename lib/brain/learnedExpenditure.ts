/**
 * Vital Brain — learned (adaptive) TDEE
 *
 * Stage 2 of the calorie-target roadmap. Today's Diet Budget (dietBudget.ts)
 * only ever estimates maintenance calories from a Mifflin-St Jeor FORMULA
 * (weight/height/age/sex + an activity multiplier) — it never learns whether
 * that formula is actually right for a given person. Two people with
 * identical stats can have real TDEEs 300-500 kcal apart (NEAT variance,
 * thyroid function, gut efficiency, etc.), and the formula has no way to see
 * that.
 *
 * This module estimates the user's REAL average daily expenditure from their
 * own logged data, MacroFactor-style: energy balance says
 *
 *   avg daily intake − avg daily expenditure = net kcal/day stored (or lost)
 *
 * and a change in body-fat mass converts to kcal via the classic Wishnofsky
 * rule (~7700 kcal ≈ 1 kg of adipose tissue, from Wishnofsky 1958 — see
 * KCAL_PER_KG below for the caveats on that number). Rearranged:
 *
 *   learnedTDEE ≈ avg logged intake − (Δ trend weight kg × KCAL_PER_KG) / days
 *
 * Pure, DB-free (like weightTrend.ts / weightSignals.ts) so it's cheap to
 * unit test exhaustively — see learnedExpenditure.test.ts. Callers
 * (dietBudget.ts, lib/brain/context.ts, lib/brain/brief.ts) own loading the
 * daily-intake and weight-trend data.
 *
 * ── Evidence & assumptions (read before touching a constant) ───────────────
 *
 * 1. KCAL_PER_KG = 7700 — the Wishnofsky (1958) approximation that 1 kg of
 *    adipose tissue stores ~7700 kcal (454 g fat ≈ 3500 kcal, scaled to kg).
 *    This is a population AVERAGE, not a per-person constant: real tissue
 *    lost/gained is a mix of fat and lean mass (more lean early in a diet,
 *    more fat later), and the true energy density of an individual's
 *    composition change can run 7000-9500 kcal/kg. We accept this error
 *    because (a) it's the same constant every mainstream adaptive-TDEE tool
 *    (MacroFactor, MyFitnessPal Premium) uses, so our number is at least
 *    comparable to what a user may have seen elsewhere, and (b) the
 *    downstream CLAMP_FRACTION bounds how far a bad estimate can push the
 *    actual calorie target.
 * 2. Water-weight noise — day-to-day scale weight swings ±1-2 kg from sodium,
 *    carbs, hydration, and (for women) cycle-related fluid retention have
 *    nothing to do with energy balance. We never feed raw weight into this
 *    formula: `trend` must be the EWMA-smoothed series from
 *    lib/weightTrend.ts's computeWeightTrend, and MIN_TREND_SPAN_DAYS (14)
 *    requires enough smoothing history that a single bad night doesn't
 *    dominate the delta.
 * 3. Under-reporting bias — self-logged intake is well documented to run
 *    10-50% below true intake (omitted snacks/condiments/alcohol, optimistic
 *    portion sizes), and the bias grows with days spent dieting. If
 *    unaddressed, a chronic under-reporter's learned TDEE would be biased
 *    LOW (avg logged intake understates real intake, so the formula infers
 *    "you must burn less than we thought" when really "you ate more than you
 *    logged"). Two mitigations, neither perfect: (a) PARTIAL_LOG_KCAL_FRACTION
 *    drops days that look like an incomplete log rather than a real low-kcal
 *    day (see below — this catches the worst case, a day logged for 300 kcal
 *    when the person's formula TDEE is 2200, but does nothing for someone who
 *    consistently under-logs by 15% every day); (b) CLAMP_FRACTION keeps the
 *    final number within ±35% of the formula estimate, so sustained
 *    under-reporting biases the target but can't run away to something
 *    dangerous. This is a documented, accepted limitation — not something
 *    this module can fully correct for without a ground-truth food scale.
 * 4. Confidence is about DATA QUANTITY, not data accuracy — 'high' confidence
 *    means "we have a full, dense window of logged days and a well-spanned
 *    trend", not "this number is definitely right". persona.ts's guidance
 *    must keep this distinction ("looks like ~2,250" not "your real TDEE is
 *    2,250").
 */

import type { WeightTrendResult, WeightTrendDay } from '../weightTrend';
import { trendSpanDays } from '../weightTrend';

// ── Constants (every one named + justified) ────────────────────────────────

/** Trailing window of daily intake this module ever looks at — MacroFactor-style adaptive TDEE typically uses 2-4 weeks; we use the wide end for stability. Callers may pass a longer history; only the trailing WINDOW_DAYS is used. */
export const WINDOW_DAYS = 28;

/** Minimum number of non-partial LOGGED days required in the window before a learned estimate is trusted at all. Below this, confidence is 'none'. */
export const MIN_LOGGED_DAYS = 10;

/** Minimum fraction of the window's calendar days that must have a usable logged day. Guards against 10 logged days scattered across a 90-day window (too sparse to represent "typical" eating) even though MIN_LOGGED_DAYS alone would pass. */
export const MIN_LOGGED_FRACTION = 0.6;

/** Minimum calendar days the (EWMA-smoothed) trend must span, within the intake window, before a weight-based expenditure delta is trusted — mirrors weightSignals.ts's RATE_RELIABLE_MIN_SPAN_DAYS reasoning: a shorter span lets water-weight noise dominate the delta. */
export const MIN_TREND_SPAN_DAYS = 14;

/** Wishnofsky (1958) approximation: kcal stored/released per kg of body-mass change. See module doc §1 for why this is an average, not a precise per-person constant. */
export const KCAL_PER_KG = 7700;

/** A logged day whose kcal is below this fraction of the FORMULA tdee is treated as a partial/incomplete log (forgot to log a meal, logged breakfast only, etc.) and excluded from the average — not as evidence of genuine very-low intake. Distinct from weightSignals.ts's fixed PARTIAL_LOG_KCAL_THRESHOLD (300 kcal): that threshold flags an under-eating SIGNAL for the coach to raise gently; this one protects the TDEE MATH from being skewed by a day that was never really logged. */
export const PARTIAL_LOG_KCAL_FRACTION = 0.5;

/** The learned estimate is clamped to within this fraction of the formula estimate either way — bounds how far under-reporting, over-reporting, or a short bad-luck window can push the number. */
export const CLAMP_FRACTION = 0.35;

/** Absolute floor below which no TDEE is ever reported, learned or formula — matches dietBudget.ts's KCAL_MIN (the same "not a plausible human maintenance number" floor used for calorie targets generally). Kept as a local literal, not an import, to keep this module dependency-free of dietBudget.ts (dietBudget.ts imports FROM here, not the reverse). */
export const ABSOLUTE_MIN_TDEE = 800;

/** Maximum fraction the learned TDEE is allowed to move, per call, relative to a previously-reported learned TDEE — the "don't let one noisy week whipsaw the target" guard. Named "weekly" because callers are expected to recompute at most ~daily and this bounds cumulative drift to a sane rate; see computeLearnedExpenditure's doc comment for the stated assumption this relies on. */
export const MAX_WEEKLY_MOVE_FRACTION = 0.05;

/** Bayesian-style blend strength, in "equivalent days of formula evidence", used only at 'low' confidence: weight = loggedDays / (loggedDays + this). A larger prior means more logged days are needed before the learned number dominates the blend. 21 ≈ MIN_TREND_SPAN_DAYS + a week of slack, chosen so 'low' confidence (10-17 logged days) blends roughly 35-45% learned / 55-65% formula, and the blend converges toward pure-learned as logged days climb toward the 'medium' threshold. */
export const LOW_CONFIDENCE_PRIOR_DAYS = 21;

/** Logged-days / trend-span thresholds for 'medium' confidence — meaningfully past the bare minimum, e.g. two-plus weeks of dense logging. */
export const MEDIUM_MIN_LOGGED_DAYS = 18;
export const MEDIUM_MIN_SPAN_DAYS = 21;

/** Logged-days / trend-span thresholds for 'high' confidence — a near-full WINDOW_DAYS of dense logging and a full trend span. */
export const HIGH_MIN_LOGGED_DAYS = 25;
export const HIGH_MIN_SPAN_DAYS = 28;

// ── Types ────────────────────────────────────────────────────────────────

export type LearnedExpenditureConfidence = 'none' | 'low' | 'medium' | 'high';
export type LearnedExpenditureMethod = 'formula' | 'blend' | 'learned';

/** One day of resolved intake — same shape weightSignals.ts's DailyIntakeKcalPoint uses, so callers can share one resolveDailyIntake() pass. */
export interface DailyIntakeKcalPoint {
  day: string; // YYYY-MM-DD local day
  kcal: number | null;
  source: 'logged' | 'healthkit' | 'none';
}

export interface LearnedExpenditureResult {
  /** The resulting TDEE estimate — always a finite, clamped, plausible number regardless of confidence (falls back to formulaTdee at 'none'). */
  tdee: number;
  confidence: LearnedExpenditureConfidence;
  /** Calendar days spanned by the intake window actually considered (<= WINDOW_DAYS). */
  daysUsed: number;
  /** Count of non-partial logged/healthkit days within that window — the number the coach should cite ("learned from N days"). */
  loggedDays: number;
  method: LearnedExpenditureMethod;
  /** Human-readable notes on what happened (excluded days, clamping, capping) — for logs/debugging and optionally surfacing to the user, never required for correctness. */
  notes: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Estimates the user's real average daily expenditure from their own logged
 * intake + smoothed weight trend, blended/clamped against a formula
 * (Mifflin-St Jeor) estimate. See the module doc comment for the algorithm
 * and every constant's justification.
 *
 * `dailyIntakeKcal` may be longer than WINDOW_DAYS — only the trailing
 * WINDOW_DAYS calendar days (by `day` key) are used. `trend` should be the
 * full computeWeightTrend() result covering at least that window; only the
 * portion overlapping the intake window is used.
 *
 * `previousTdee`, if supplied, caps how far the new estimate may move from
 * it (MAX_WEEKLY_MOVE_FRACTION) — pass the last learned/blended tdee this
 * user was shown. ASSUMPTION: callers recompute at most about once/day (the
 * cap is expressed as a per-CALL fraction, not a true per-elapsed-week
 * fraction, because this pure function has no clock and is not told how long
 * ago `previousTdee` was computed) — calling it much more often than daily
 * would make the effective per-week cap tighter than intended, which is the
 * safe direction (slower movement, not faster), never the reverse.
 */
export function computeLearnedExpenditure(
  dailyIntakeKcal: DailyIntakeKcalPoint[],
  trend: WeightTrendResult,
  formulaTdee: number,
  opts: { previousTdee?: number } = {},
): LearnedExpenditureResult {
  const notes: string[] = [];

  const sorted = [...dailyIntakeKcal].sort((a, b) => a.day.localeCompare(b.day));
  const windowIntake = sorted.slice(-WINDOW_DAYS);

  if (windowIntake.length === 0) {
    return {
      tdee: Math.round(formulaTdee),
      confidence: 'none',
      daysUsed: 0,
      loggedDays: 0,
      method: 'formula',
      notes: ['No intake data available.'],
    };
  }

  const minDay = windowIntake[0].day;
  const maxDay = windowIntake[windowIntake.length - 1].day;
  const daysUsed = dayNumber(maxDay) - dayNumber(minDay) + 1;

  const partialThreshold = formulaTdee * PARTIAL_LOG_KCAL_FRACTION;
  const withData = windowIntake.filter(d => d.source !== 'none' && d.kcal != null);
  const partialLogs = withData.filter(d => (d.kcal as number) < partialThreshold);
  const included = withData.filter(d => !partialLogs.includes(d));

  if (partialLogs.length > 0) {
    notes.push(
      `Excluded ${partialLogs.length} day(s) logged under ${Math.round(partialThreshold)} kcal ` +
      `(< ${Math.round(PARTIAL_LOG_KCAL_FRACTION * 100)}% of the formula estimate) as likely partial logs, not real intake.`,
    );
  }

  const loggedDays = included.length;
  const loggedFraction = loggedDays / daysUsed;

  // Trend points strictly within the intake window's calendar span.
  const trendWindow = trend.days.filter(d => d.day >= minDay && d.day <= maxDay);
  const trendSpanInWindow = trendWindow.length >= 2 ? trendSpanDays(trendWindow as WeightTrendDay[]) : 0;

  const meetsMinimums =
    loggedDays >= MIN_LOGGED_DAYS &&
    loggedFraction >= MIN_LOGGED_FRACTION &&
    trend.established &&
    trendSpanInWindow >= MIN_TREND_SPAN_DAYS;

  if (!meetsMinimums) {
    if (loggedDays < MIN_LOGGED_DAYS) notes.push(`Only ${loggedDays} usable logged day(s), need >= ${MIN_LOGGED_DAYS}.`);
    else if (loggedFraction < MIN_LOGGED_FRACTION) notes.push(`Only ${Math.round(loggedFraction * 100)}% of the window logged, need >= ${Math.round(MIN_LOGGED_FRACTION * 100)}%.`);
    if (!trend.established || trendSpanInWindow < MIN_TREND_SPAN_DAYS) {
      notes.push(`Weight trend spans only ${Math.round(trendSpanInWindow)} day(s) in this window, need >= ${MIN_TREND_SPAN_DAYS}.`);
    }
    notes.push('Falling back to the formula estimate.');
    return {
      tdee: Math.round(formulaTdee),
      confidence: 'none',
      daysUsed: Math.round(daysUsed),
      loggedDays,
      method: 'formula',
      notes,
    };
  }

  // ── Energy-balance math ──────────────────────────────────────────────
  const avgIntake = included.reduce((sum, d) => sum + (d.kcal as number), 0) / included.length;
  const firstTrend = trendWindow[0];
  const lastTrend = trendWindow[trendWindow.length - 1];
  const deltaKg = lastTrend.trendKg - firstTrend.trendKg;
  // Net kcal/day stored (positive) or lost (negative) implied by the weight
  // change; learnedTDEE = avg intake − net surplus/day (a deficit, i.e.
  // negative deltaKg, means TDEE is HIGHER than avg intake).
  const netSurplusPerDay = (deltaKg * KCAL_PER_KG) / trendSpanInWindow;
  const rawLearnedTdee = avgIntake - netSurplusPerDay;

  notes.push(
    `Avg intake ${Math.round(avgIntake)} kcal/day over ${loggedDays} logged day(s); ` +
    `trend weight moved ${deltaKg >= 0 ? '+' : ''}${deltaKg.toFixed(2)} kg over ${Math.round(trendSpanInWindow)} days.`,
  );

  const clampLow = formulaTdee * (1 - CLAMP_FRACTION);
  const clampHigh = formulaTdee * (1 + CLAMP_FRACTION);
  let clampedLearned = clamp(rawLearnedTdee, clampLow, clampHigh);
  clampedLearned = Math.max(clampedLearned, ABSOLUTE_MIN_TDEE);
  if (clampedLearned !== rawLearnedTdee) {
    notes.push(
      `Raw learned estimate ${Math.round(rawLearnedTdee)} kcal clamped to ${Math.round(clampedLearned)} ` +
      `(formula ${Math.round(formulaTdee)} kcal ± ${Math.round(CLAMP_FRACTION * 100)}%).`,
    );
  }

  // ── Confidence tier (data quantity only — see module doc §4) ─────────
  let confidence: LearnedExpenditureConfidence;
  if (loggedDays >= HIGH_MIN_LOGGED_DAYS && trendSpanInWindow >= HIGH_MIN_SPAN_DAYS) {
    confidence = 'high';
  } else if (loggedDays >= MEDIUM_MIN_LOGGED_DAYS && trendSpanInWindow >= MEDIUM_MIN_SPAN_DAYS) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // ── Blend at low confidence ────────────────────────────────────────────
  let tdee: number;
  let method: LearnedExpenditureMethod;
  if (confidence === 'low') {
    const weight = loggedDays / (loggedDays + LOW_CONFIDENCE_PRIOR_DAYS);
    tdee = weight * clampedLearned + (1 - weight) * formulaTdee;
    method = 'blend';
    notes.push(
      `Low confidence — blended ${Math.round(weight * 100)}% learned / ${Math.round((1 - weight) * 100)}% formula.`,
    );
  } else {
    tdee = clampedLearned;
    method = 'learned';
  }

  // ── Cap week-to-week movement ─────────────────────────────────────────
  if (opts.previousTdee != null && Number.isFinite(opts.previousTdee) && opts.previousTdee > 0) {
    const maxDelta = opts.previousTdee * MAX_WEEKLY_MOVE_FRACTION;
    const bounded = clamp(tdee, opts.previousTdee - maxDelta, opts.previousTdee + maxDelta);
    if (bounded !== tdee) {
      notes.push(`Capped movement from previous ${Math.round(opts.previousTdee)} kcal to ${Math.round(bounded)} kcal (max ${Math.round(MAX_WEEKLY_MOVE_FRACTION * 100)}% per update).`);
    }
    tdee = bounded;
  }

  tdee = Math.max(ABSOLUTE_MIN_TDEE, Math.round(tdee));

  return {
    tdee,
    confidence,
    daysUsed: Math.round(daysUsed),
    loggedDays,
    method,
    notes,
  };
}
