import { MIN_ABS_RHO } from './detectors';
import { benjaminiHochberg } from './stats';
import type { Finding } from './types';

/** False-discovery rate for the hypothesis family. */
export const FDR_Q = 0.10;

/** Minimum |effect| per finding kind, applied independently of significance. */
export const MIN_LEVEL_SHIFT_SD = 0.8;
/** Single source of truth lives in detectors.ts — do not fork this threshold. */
export const MIN_CROSS_LAG_RHO = MIN_ABS_RHO;
export const MIN_DAY_OF_WEEK_SPREAD = 0;   // magnitude is metric-specific; significance carries this one

function passesEffectFloor(finding: Finding): boolean {
  switch (finding.kind) {
    case 'level_shift': return Math.abs(finding.effect) >= MIN_LEVEL_SHIFT_SD;
    case 'cross_lag':   return Math.abs(finding.effect) >= MIN_CROSS_LAG_RHO;
    case 'day_of_week': return Math.abs(finding.effect) > MIN_DAY_OF_WEEK_SPREAD;
    case 'trend':       return finding.effect !== 0;
    case 'cadence_break': return true;      // the rule itself is the threshold
    default: return false;
  }
}

/**
 * The gate that makes this feature trustworthy.
 *
 * Order matters: establishment, then effect floor, then FDR across only the
 * hypothesis-shaped findings. `cadence_break` carries pValue: null and is
 * deliberately excluded from the BH vector — a null in that vector would
 * corrupt the ranks for every genuine p-value in the family.
 *
 * Anything that fails is dropped. There is no low-confidence tier, because a
 * low-confidence tier eventually gets spoken aloud.
 */
export function applyEvidenceGate(findings: Finding[], establishedMetrics: Set<string>): Finding[] {
  // Establishment is a VALIDITY filter: a metric with no established baseline
  // was never a testable hypothesis, so it never belonged to the family and
  // removing it does not bias the correction.
  const eligible = findings.filter((f) => f.metrics.every((metric) => establishedMetrics.has(metric)));

  const hypotheses = eligible.filter((f) => f.pValue !== null);
  const rules = eligible.filter((f) => f.pValue === null);

  if (hypotheses.length === 0) return rules.filter(passesEffectFloor);

  // ORDER IS LOAD-BEARING: correct over the FULL family first, then apply the
  // effect floor to the survivors. Applying the floor first would shrink m by
  // selecting on a quantity that moves with the p-value, which makes
  // Benjamini-Hochberg anti-conservative — the precise failure it exists to
  // prevent. Never reorder these two steps.
  const rejected = benjaminiHochberg(hypotheses.map((f) => f.pValue as number), FDR_Q);
  const survivors = hypotheses.filter((_, index) => rejected[index]).filter(passesEffectFloor);

  return [...rules.filter(passesEffectFloor), ...survivors];
}
