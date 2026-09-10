import type { CertifiedFinding, FindingKind } from './types';

export const SHORTLIST_SIZE = 3;
export const COOLDOWN_DAYS = 14;

export interface ArbiterContext {
  goal: string | null;
  /** finding kind -> days since it was last sent. Absent means never sent. */
  recentKinds: Map<string, number>;
}

/**
 * Base weight per kind. A broken training cadence outranks a statistical
 * curiosity because it is the thing the user actually asked to hear about, and
 * because it is the only finding that implies a question rather than a fact.
 */
const KIND_WEIGHT: Record<FindingKind, number> = {
  cadence_break: 100,
  level_shift: 60,
  cross_lag: 45,
  trend: 40,
  day_of_week: 20,
};

/** Goal keyword -> metrics that matter more for it. */
const GOAL_METRICS: Record<string, string[]> = {
  weight_loss: ['body_mass_kg', 'dietary_energy_kcal', 'active_energy_kcal', 'steps'],
  muscle: ['dietary_protein_g', 'exercise_min', 'whoop_recovery'],
  endurance: ['distance_m', 'exercise_min', 'whoop_day_strain', 'vo2_max'],
  general: [],
};

function score(finding: CertifiedFinding, context: ArbiterContext): number {
  let value = KIND_WEIGHT[finding.kind] ?? 0;

  // Effect size, normalised per kind so a rho and an SD aren't compared raw.
  const magnitude = finding.kind === 'cadence_break'
    ? Math.min(finding.effect / 7, 3)
    : Math.min(Math.abs(finding.effect), 3);
  value += magnitude * 10;

  // Relevance to the user's stated goal.
  const goalMetrics = context.goal ? GOAL_METRICS[context.goal] ?? [] : [];
  if (finding.metrics.some((metric) => goalMetrics.includes(metric))) value += 15;

  // Novelty: a kind not raised for a long time edges out one raised recently.
  const daysSince = context.recentKinds.get(finding.kind);
  if (daysSince !== undefined) value += Math.min(daysSince - COOLDOWN_DAYS, 10);

  return value;
}

/**
 * Deterministic top-N. Selection stays in code so a bad nudge traces to a rule;
 * the model's judgment is applied afterwards, over an already-certified set.
 * Ties break on signature so repeated calls agree.
 */
export function shortlist(
  findings: CertifiedFinding[],
  context: ArbiterContext,
): CertifiedFinding[] {
  return findings
    .filter((finding) => {
      const daysSince = context.recentKinds.get(finding.kind);
      return daysSince === undefined || daysSince >= COOLDOWN_DAYS;
    })
    .map((finding) => ({ finding, value: score(finding, context) }))
    .sort((a, b) =>
      b.value - a.value || a.finding.signature.localeCompare(b.finding.signature))
    .slice(0, SHORTLIST_SIZE)
    .map((entry) => entry.finding);
}
