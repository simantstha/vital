/**
 * Recovery score — weighted multi-component model, no data fabrication.
 *
 * Replaces the two-line formula in the old lib/brain/brief.ts (was: hrvScore
 * = min(100, round(hrv/baselineHrv * 70)) + sleepScore = round((sleepEff ??
 * 85) / 100 * 30)). That formula had four confirmed defects:
 *   1. The HRV term was budgeted at 70 points but clamped at `min(100, ...)`,
 *      so it overflowed its own budget — HRV just 4% above baseline scored
 *      73/70.
 *   2. The sleep term used *efficiency* (asleep/(asleep+awake)) and was
 *      blind to sleep *duration*, so 4h50m at 90% efficiency scored
 *      identically to 8h30m. This shipped a brief that called recovery "a
 *      perfect 100%" in the same paragraph as "you've slept under 5 hours
 *      for three straight days."
 *   3. Missing sleep efficiency was imputed as 85%, fabricating ~26 of 30
 *      points from no data.
 *   4. The 7-day history defaulted a missing HRV reading to the baseline
 *      itself, manufacturing a ~97% recovery day out of nothing.
 *
 * This module fixes all four: every sub-score is clamped to [0, 1] and
 * combined via fixed weights (HRV 60, sleep duration 30, sleep efficiency
 * 10); a component that has no data is dropped from BOTH the numerator and
 * the denominator (never imputed); confidence is 'high' only when all three
 * components are present and the HRV baseline is both established and not
 * from a short window, else 'provisional'; and 'insufficient' when there's
 * no HRV/baseline pair to work from at all.
 *
 * Pure (no DB, no `@/db` import) so it's directly unit-testable without a
 * DATABASE_URL, same split as lib/brain/whoopContext.ts. Callers (brief.ts,
 * context.ts, the Today recovery card's API route) fetch the daily_metrics
 * rows / baseline / calibration status and pass plain values in.
 */

export type HrvMetric = 'hrv_sdnn' | 'whoop_hrv_rmssd';
export type RecoveryConfidence = 'high' | 'provisional' | 'insufficient';
export type RecoveryGap =
  | 'no_hrv'
  | 'no_sleep_duration'
  | 'no_sleep_efficiency'
  | 'baseline_calibrating'
  | 'baseline_from_short_window';

export interface RecoveryComponent {
  factor: number; // unrounded, clamped to [0, 1] — the score math uses this, not `points`
  points: number;  // round(factor * weight), for display only
  weight: number;
}

export interface RecoveryScore {
  score: number | null;
  confidence: RecoveryConfidence;
  band: 'green' | 'amber' | 'red' | null;
  hrvSource: HrvMetric | null;
  hrvSourceLabel: string | null;
  hrvRatio: number | null;
  components: {
    hrv: RecoveryComponent | null;
    sleepDuration: RecoveryComponent | null;
    sleepEfficiency: RecoveryComponent | null;
  };
  gaps: RecoveryGap[];
}

export interface RecoveryInput {
  hrvSource: HrvMetric | null;
  hrv: number | null;
  hrvBaseline: number | null;
  hrvBaselineEstablished: boolean;
  hrvBaselineFromShortWindow: boolean;
  asleepMinutes: number | null;
  sleepEfficiencyPct: number | null;
  sleepGoalMinutes: number;
}

export interface RecoveryHistoryDay {
  date: string;
  recovery: number;
  confidence: RecoveryConfidence;
  hrv: number;
  rhr: number | null;
  sleepMinutes: number | null;
  sleepEfficiencyPct: number | null;
}

// ── Weights + sub-score curves ──────────────────────────────────────────────

const HRV_WEIGHT = 60;
const SLEEP_DURATION_WEIGHT = 30;
const SLEEP_EFFICIENCY_WEIGHT = 10;

/** Default sleep goal (minutes) used when the caller has no user-specific goal. */
export const DEFAULT_SLEEP_GOAL_MIN = 480;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** r = today's HRV / baseline HRV. 0.70 (recovering) → 0, 1.10 (well recovered) → 1. */
function hrvFactor(ratio: number): number {
  return clamp01((ratio - 0.70) / (1.10 - 0.70));
}

/** m = minutes asleep. 60% of goal → 0, 100% of goal → 1. No bonus past 100% (no oversleep credit). */
function sleepDurationFactor(minutes: number, goalMinutes: number): number {
  return clamp01((minutes / goalMinutes - 0.60) / (1.00 - 0.60));
}

/** e = sleep efficiency in percent. 70% → 0, 90% → 1. */
function sleepEfficiencyFactor(efficiencyPct: number): number {
  return clamp01((efficiencyPct - 70) / (90 - 70));
}

function labelForHrvSource(source: HrvMetric): string {
  return source === 'whoop_hrv_rmssd' ? 'WHOOP HRV (RMSSD)' : 'HealthKit HRV (SDNN)';
}

// ── Payload helpers (local copies — see lib/brain/whoopContext.ts's `pl()`
//    for the same pattern; not imported from brief.ts so this module stays
//    DB-free and brief.ts stays untouched) ──────────────────────────────────

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ── Core scorer ──────────────────────────────────────────────────────────────

/**
 * Computes the recovery score from already-fetched inputs. A component with
 * no data (missing HRV, missing sleep duration, missing sleep efficiency) is
 * dropped from BOTH the numerator and the denominator of the weighted
 * average — it is never imputed with a default value. score = round(100 *
 * sum(weight_i * factor_i) / sum(weight_i)) over present components only.
 */
export function computeRecovery(input: RecoveryInput): RecoveryScore {
  const {
    hrvSource,
    hrv,
    hrvBaseline,
    hrvBaselineEstablished,
    hrvBaselineFromShortWindow,
    asleepMinutes,
    sleepEfficiencyPct,
    sleepGoalMinutes,
  } = input;

  if (hrv == null || hrvBaseline == null || hrvBaseline <= 0 || hrvSource == null) {
    return {
      score: null,
      confidence: 'insufficient',
      band: null,
      hrvSource: null,
      hrvSourceLabel: null,
      hrvRatio: null,
      components: { hrv: null, sleepDuration: null, sleepEfficiency: null },
      gaps: ['no_hrv'],
    };
  }

  const ratio = hrv / hrvBaseline;
  const hrvF = hrvFactor(ratio);
  const hrvComponent: RecoveryComponent = {
    factor: hrvF,
    points: Math.round(hrvF * HRV_WEIGHT),
    weight: HRV_WEIGHT,
  };

  const gaps: RecoveryGap[] = [];

  let sleepDurationComponent: RecoveryComponent | null = null;
  if (asleepMinutes != null) {
    const f = sleepDurationFactor(asleepMinutes, sleepGoalMinutes);
    sleepDurationComponent = { factor: f, points: Math.round(f * SLEEP_DURATION_WEIGHT), weight: SLEEP_DURATION_WEIGHT };
  } else {
    gaps.push('no_sleep_duration');
  }

  let sleepEfficiencyComponent: RecoveryComponent | null = null;
  if (sleepEfficiencyPct != null) {
    const f = sleepEfficiencyFactor(sleepEfficiencyPct);
    sleepEfficiencyComponent = { factor: f, points: Math.round(f * SLEEP_EFFICIENCY_WEIGHT), weight: SLEEP_EFFICIENCY_WEIGHT };
  } else {
    gaps.push('no_sleep_efficiency');
  }

  const allThreePresent = sleepDurationComponent != null && sleepEfficiencyComponent != null;
  let confidence: RecoveryConfidence;
  if (allThreePresent && hrvBaselineEstablished && !hrvBaselineFromShortWindow) {
    confidence = 'high';
  } else {
    confidence = 'provisional';
    if (!hrvBaselineEstablished) gaps.push('baseline_calibrating');
    if (hrvBaselineFromShortWindow) gaps.push('baseline_from_short_window');
  }

  const presentComponents = [hrvComponent, sleepDurationComponent, sleepEfficiencyComponent]
    .filter((c): c is RecoveryComponent => c != null);
  const weightedSum = presentComponents.reduce((sum, c) => sum + c.factor * c.weight, 0);
  const totalWeight = presentComponents.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((weightedSum / totalWeight) * 100);
  const band: 'green' | 'amber' | 'red' = score >= 67 ? 'green' : score >= 34 ? 'amber' : 'red';

  return {
    score,
    confidence,
    band,
    hrvSource,
    hrvSourceLabel: labelForHrvSource(hrvSource),
    hrvRatio: ratio,
    components: {
      hrv: hrvComponent,
      sleepDuration: sleepDurationComponent,
      sleepEfficiency: sleepEfficiencyComponent,
    },
    gaps,
  };
}

// ── HRV source selection ─────────────────────────────────────────────────────

/**
 * Picks which HRV metric to score recovery from when both HealthKit and
 * WHOOP are available. WHOOP wins whenever it has fresh data (a connected
 * WHOOP is the more authoritative recovery signal — it's purpose-built for
 * this, HealthKit HRV is a side effect of a workout app), and a
 * baseline-only source (no recent point yet, but enough history to have a
 * baseline) is preferred over no source at all. Evaluated top-down; the
 * first matching rule wins.
 */
export function selectHrvSource(input: {
  whoopConnected: boolean;
  whoopRecentPointDays: number;
  whoopBaselineDataDays: number;
  healthkitRecentPointDays: number;
  healthkitBaselineDataDays: number;
}): HrvMetric | null {
  const {
    whoopConnected,
    whoopRecentPointDays,
    whoopBaselineDataDays,
    healthkitRecentPointDays,
    healthkitBaselineDataDays,
  } = input;

  if (whoopConnected && whoopRecentPointDays >= 1) return 'whoop_hrv_rmssd';
  if (healthkitRecentPointDays >= 1) return 'hrv_sdnn';
  if (whoopConnected && whoopBaselineDataDays > 0) return 'whoop_hrv_rmssd';
  if (healthkitBaselineDataDays > 0) return 'hrv_sdnn';
  return null;
}

// ── Sleep efficiency derivation ──────────────────────────────────────────────

/**
 * Sleep efficiency isn't a stored metric on the HealthKit side, so derive it
 * from the stage payload (asleep vs asleep+awake) when available. Mirrors
 * the logic previously inlined in lib/brain/brief.ts (sleepEfficiency()) —
 * reimplemented locally rather than importing from brief.ts so this module
 * stays DB-free.
 */
export function sleepEfficiencyFromHealthKitStages(asleepMin: number, stages: unknown): number | null {
  const s = pl(stages);
  const awake = num(s.awake) ?? num(s.awakeMinutes);
  if (awake == null || asleepMin + awake <= 0) return null;
  return Math.round((asleepMin / (asleepMin + awake)) * 100);
}

/**
 * WHOOP's `whoop_sleep_min` daily_metrics value is IN-BED time, not asleep
 * time (see lib/whoop/mapping.ts's mapSleeps — it's the raw sleep.start→end
 * span). Deriving asleep minutes and efficiency from the stage summary's
 * `total_awake_time_milli` avoids silently treating in-bed time as asleep
 * time (which would overstate the sleep-duration component for every WHOOP
 * user). Returns null when the stage summary has no awake-time field yet
 * (unscored sleep) or when the derived asleep time is non-positive.
 */
export function sleepFromWhoopStageSummary(
  inBedMin: number,
  stages: unknown,
): { asleepMinutes: number; efficiencyPct: number } | null {
  const s = pl(stages);
  const awakeMilli = num(s.total_awake_time_milli);
  if (awakeMilli == null) return null;

  const awakeMin = awakeMilli / 60_000;
  const asleepMinutes = inBedMin - awakeMin;
  if (asleepMinutes <= 0) return null;

  const efficiencyPct = Math.round((asleepMinutes / (asleepMinutes + awakeMin)) * 100);
  return { asleepMinutes: Math.round(asleepMinutes), efficiencyPct };
}

// ── History + trend ──────────────────────────────────────────────────────────

/**
 * Scores a run of days from already-fetched per-day values plus the fields
 * shared across the whole window (HRV source/baseline/calibration state,
 * sleep goal). A day whose computeRecovery() comes back with score === null
 * (no HRV for that day) is OMITTED rather than backfilled with a fabricated
 * ~97 — the old brief.ts history builder defaulted missing HRV to the
 * baseline itself, which silently manufactured a near-perfect recovery day
 * out of no data at all. Sorted newest-first by date.
 */
export function buildRecoveryHistory(
  days: Array<{ date: string; hrv?: number; rhr?: number; asleepMinutes?: number; sleepEfficiencyPct?: number }>,
  shared: Omit<RecoveryInput, 'hrv' | 'asleepMinutes' | 'sleepEfficiencyPct'>,
): RecoveryHistoryDay[] {
  const history: RecoveryHistoryDay[] = [];

  for (const day of days) {
    const result = computeRecovery({
      ...shared,
      hrv: day.hrv ?? null,
      asleepMinutes: day.asleepMinutes ?? null,
      sleepEfficiencyPct: day.sleepEfficiencyPct ?? null,
    });
    if (result.score == null) continue; // no HRV that day — omit, never fabricate

    history.push({
      date: day.date,
      recovery: result.score,
      confidence: result.confidence,
      hrv: day.hrv as number, // guaranteed present — result.score is only non-null when hrv was
      rhr: day.rhr ?? null,
      sleepMinutes: day.asleepMinutes ?? null,
      sleepEfficiencyPct: day.sleepEfficiencyPct ?? null,
    });
  }

  return history.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Summarizes a recovery history into an average + trend direction. Trend
 * compares the mean of the most recent 3 days against the mean of the 3
 * days before that, and only calls it 'improving'/'declining' when BOTH
 * windows have at least 2 days of data — otherwise 'unknown' rather than
 * guessing a direction off a single data point.
 */
export function summarizeRecoveryTrend(history: RecoveryHistoryDay[]): {
  avgRecovery: number | null;
  avgHrv: number | null;
  trend: 'improving' | 'declining' | 'stable' | 'unknown';
} {
  if (history.length === 0) {
    return { avgRecovery: null, avgHrv: null, trend: 'unknown' };
  }

  const avgRecovery = Math.round(history.reduce((sum, d) => sum + d.recovery, 0) / history.length);
  const avgHrv = Math.round(history.reduce((sum, d) => sum + d.hrv, 0) / history.length);

  const recentWindow = history.slice(0, 3);
  const olderWindow = history.slice(3, 6);
  let trend: 'improving' | 'declining' | 'stable' | 'unknown' = 'unknown';
  if (recentWindow.length >= 2 && olderWindow.length >= 2) {
    const avg = (arr: RecoveryHistoryDay[]) => arr.reduce((sum, d) => sum + d.recovery, 0) / arr.length;
    const diff = avg(recentWindow) - avg(olderWindow);
    trend = diff > 5 ? 'improving' : diff < -5 ? 'declining' : 'stable';
  }

  return { avgRecovery, avgHrv, trend };
}
