/**
 * Vital Brain — protein basis weight (pure, no DB imports)
 *
 * A registered-dietitian review found protein targets were computed as
 * g/kg of CURRENT body weight for every user, including a BMI >= 30 user —
 * 2.2 g/kg at 130 kg is 286 g/day, an unrealistic target that overweights
 * fat mass as if it needed the same protein-per-kg as lean mass does.
 * Standard clinical practice for an obese individual is to dose protein off
 * an ADJUSTED body weight instead: ABW = IBW + 0.4 * (current − IBW), where
 * IBW is the Devine formula. This module is the ONE place that decision is
 * made, shared by lib/brain/dietBudget.ts's splitMacrosForKcal (which
 * lib/brain/tools.ts's macrosForGoal already calls for its split, so both
 * the auto TDEE-derived budget and the coach's custom-kcal path stay
 * identical automatically).
 */

/** Hard cap — no protein target this app computes may exceed this, regardless of body weight. */
export const PROTEIN_GRAMS_CAP = 200;

/** BMI at/above which protein is dosed off adjusted body weight instead of current weight. */
export const OBESITY_BMI_THRESHOLD = 30;

/** The 0.4 "correction factor" applied to the current-minus-ideal weight gap for ABW. */
export const ADJUSTED_BODY_WEIGHT_FACTOR = 0.4;

function bmi(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

/**
 * Devine ideal body weight (kg) from height. Sex-aware: unknown/unrecognized
 * sex uses the LOWER female formula (never defaults to male — same
 * unknown-sex convention as lib/brain/tools.ts's estimateTDEE, which uses
 * the midpoint sex offset rather than assuming male). Not exported —
 * ADJUSTED body weight (below) is the only thing callers need.
 */
function devineIdealBodyWeightKg(heightCm: number, biologicalSex: string | null): number {
  const heightInches = heightCm / 2.54;
  const inchesOver5Feet = Math.max(0, heightInches - 60);
  const sex = biologicalSex?.trim().toLowerCase();
  const isMale = sex === 'male' || sex === 'm' || sex === 'man';
  const base = isMale ? 50 : 45.5;
  return base + 2.3 * inchesOver5Feet;
}

/**
 * The body weight (kg) protein targets should be dosed off. Current weight
 * unless height is known AND BMI >= OBESITY_BMI_THRESHOLD, in which case
 * this returns the adjusted body weight (IBW + 0.4 * (current − IBW)) —
 * always <= current weight (since IBW < current for anyone with BMI >= 30),
 * so this never INCREASES the protein target versus using current weight.
 */
export function proteinBasisWeightKg(
  weightKg: number,
  heightCm: number | null,
  biologicalSex: string | null,
): number {
  if (heightCm == null || heightCm <= 0) return weightKg;
  if (bmi(weightKg, heightCm) < OBESITY_BMI_THRESHOLD) return weightKg;

  const ibw = devineIdealBodyWeightKg(heightCm, biologicalSex);
  return ibw + ADJUSTED_BODY_WEIGHT_FACTOR * (weightKg - ibw);
}
