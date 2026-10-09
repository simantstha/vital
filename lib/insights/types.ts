/** Shared shapes for the insight engine. */

export type StatFindingKind = 'cadence_break' | 'level_shift' | 'trend' | 'cross_lag' | 'day_of_week';

/**
 * Rule-shaped, goal-aware findings (lib/insights/goalDetectors.ts). Like
 * cadence_break they carry `pValue: null` and `metrics: []` — they are rules
 * about a known pattern, not hypothesis tests, so they skip the FDR family and
 * the baseline-establishment filter — but they flow through the same
 * confirmation / arbiter / cooldown / caps pipeline as every other finding.
 */
export const GOAL_FINDING_KINDS = [
  'weight_plateau',
  'too_fast_loss',
  'stalled_lift',
  'low_protein_streak',
  'inactivity_streak',
  'off_pace',
] as const;
export type GoalFindingKind = (typeof GOAL_FINDING_KINDS)[number];

export type FindingKind = StatFindingKind | GoalFindingKind;

/** Deterministic, pre-written nudge text (goal findings only — see Finding.copy). */
export interface NudgeCopy {
  title: string;
  body: string;
  /** Coach handoff: what the coach says first when the user taps the nudge. */
  openingMessage: string;
}

/** One local day. `value` is null when the day exists in the window but has
 *  no observation — absence is never coerced to zero. */
export interface DayPoint {
  date: string;        // 'YYYY-MM-DD', the user's local day
  value: number | null;
}

export interface MetricSeries {
  metric: string;
  points: DayPoint[];  // dense over the window, ascending by date, nulls preserved
}

/**
 * A candidate produced by a detector, before any gating.
 *
 * `signature` is the stable identity of the claim (kind + metrics + direction),
 * used for cross-run confirmation and cooldown. It must NOT include the effect
 * size, or the same finding would get a new identity every day as the number
 * drifts.
 *
 * `pValue` is null for rule-shaped findings (cadence_break), which are not
 * hypothesis tests and must not enter the FDR family.
 */
export interface Finding {
  kind: FindingKind;
  signature: string;
  metrics: string[];
  effect: number;          // signed, in the detector's natural units
  effectLabel: string;     // human-readable magnitude, e.g. '1.4 SD below baseline'
  n: number;               // observations behind the claim
  pValue: number | null;
  detail: Record<string, string | number>;  // grounded facts the voice layer may cite
  /**
   * Goal findings ship their own unit-aware, safety-reviewed wording. When
   * present, runInsightPass delivers this text instead of model-written copy
   * (the model still picks WHICH finding to speak, as for every kind).
   */
  copy?: NudgeCopy;
}

/** A finding that has passed every gate and is allowed to be spoken about. */
export interface CertifiedFinding extends Finding {
  confirmedOnRuns: number; // >= 2 by construction
}
