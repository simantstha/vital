/**
 * Diet budget resolution — the single source of truth for a user's daily
 * calorie + macro target, shared by GET /api/today and the /api/diet-goal
 * editor route.
 *
 * Two modes:
 *  - auto:   recompute from the user's goal + latest known weight + recent
 *            workouts, using the same Mifflin-St Jeor TDEE + goal-adjustment
 *            math the coach's calculate_macros tool uses (lib/brain/tools.ts).
 *  - custom: the user has pinned their own numbers (target_kcal set on `users`).
 *
 * This replaces the old hardcoded `const TARGET_KCAL = 2400` and the iOS-side
 * fixed 30/40/30 macro split.
 */

import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import {
  activityMultiplierForFrequency,
  estimateTDEE,
  macrosForGoal,
  normalizeBiologicalSex,
  queryWorkouts,
  type WorkoutInput,
} from '@/lib/brain/tools';
import { readMemoryFile } from '@/lib/memory';
import { readCoreProfile } from '@/lib/coreProfileStore';
import { parseProfileDetails } from '@/lib/profileDetails';
import { getWeightReadings } from '@/lib/weightRepository';
import { computeWeightTrend } from '@/lib/weightTrend';
import { proteinBasisWeightKg, PROTEIN_GRAMS_CAP } from '@/lib/brain/proteinWeight';

export type DietGoal = 'weight_loss' | 'muscle' | 'endurance' | 'general';
export const DIET_GOALS: readonly DietGoal[] = ['weight_loss', 'muscle', 'endurance', 'general'];

/** Fallback weight when the user has no body_mass_kg metric yet (kg). */
export const DEFAULT_WEIGHT_KG = 75;

export const KCAL_MIN = 800;
export const KCAL_MAX = 6000;
// A single macro can legitimately be large at a high calorie target — e.g. a
// ~4,300 kcal general-goal budget puts carbs around 650 g, and an all-carb
// 6,000 kcal budget is ~1,500 g. Cap only to reject obvious typos, not real
// auto-calculated values (600 g was too low and rejected valid budgets).
export const GRAMS_MAX = 1500;

// Low-energy-availability floor: below these thresholds, sustained deficits
// carry real physiological risk (hormonal disruption, bone density loss —
// "RED-S"), independent of how the number was arrived at. Sex-specific
// because typical energy needs differ; unknown sex uses the LOWER threshold
// so we never under-protect on a guess.
export const LOW_ENERGY_KCAL_FEMALE = 1200;
export const LOW_ENERGY_KCAL_MALE = 1500;

export function normalizeGoal(goal: string | null | undefined): DietGoal {
  return (DIET_GOALS as readonly string[]).includes(goal ?? '')
    ? (goal as DietGoal)
    : 'general';
}

/**
 * iOS onboarding (OnboardingFlowView.swift) sends `basics.goal` as one of its
 * own four ids — lose_fat | build_muscle | improve_endurance | general_health
 * — which do NOT match the canonical DietGoal ids Profile > Goal
 * (GoalDetailView.swift) and this module use. Before this mapping existed,
 * onboarding wrote the raw onboarding id into the free-text core-profile
 * only and never touched `users.goal`, so a fresh "Lose fat" signup silently
 * got the 'general' (maintenance) auto budget — normalizeGoal's unknown-goal
 * fallback — until the user separately visited Profile > Goal and re-picked.
 *
 * Maps an onboarding goal id to the canonical DietGoal. Canonical ids pass
 * through unchanged (defensive, in case a caller already has one). Anything
 * else unrecognised returns null so the caller can choose to leave
 * `users.goal` untouched rather than write a wrong value.
 */
const ONBOARDING_GOAL_MAP: Readonly<Record<string, DietGoal>> = {
  lose_fat:          'weight_loss',
  build_muscle:      'muscle',
  improve_endurance: 'endurance',
  general_health:    'general',
};

export function goalFromOnboarding(raw: string): DietGoal | null {
  if ((DIET_GOALS as readonly string[]).includes(raw)) return raw as DietGoal;
  return ONBOARDING_GOAL_MAP[raw] ?? null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Height/sex needed to dose protein off adjusted body weight for a BMI >= 30 user — see lib/brain/proteinWeight.ts. Both optional so existing callers without a profile on hand fall back to current weight, unchanged. */
export interface ProteinWeightOpts {
  heightCm?: number | null;
  biologicalSex?: string | null;
}

/**
 * Split a PINNED target calorie figure into protein/carbs/fat grams, using the
 * same per-goal protein-g/kg + fat-fraction ratios `macrosForGoal` (tools.ts)
 * uses for its TDEE-derived target — but WITHOUT re-applying the goal's
 * calorie adjustment (±400/+200/+100/±0). Shared by `macrosForGoal` (auto
 * path) and `applyDietBudgetUpdate` (custom path, when macros are omitted)
 * so the two stay identical.
 *
 * Protein grams are dosed off `proteinBasisWeightKg` (lib/brain/
 * proteinWeight.ts) — current weight, UNLESS height is known and BMI >= 30,
 * in which case it's adjusted body weight — and capped at PROTEIN_GRAMS_CAP.
 * Carbs still absorb whatever calorie remainder is left after protein and
 * fat, so the result stays internally consistent with targetKcal even when
 * the protein basis weight differs from `weightKg`.
 */
export function splitMacrosForKcal(
  goal: string,
  weightKg: number,
  targetKcal: number,
  proteinWeightOpts: ProteinWeightOpts = {},
): { protein: number; carbs: number; fat: number } {
  let proteinGPerKg: number;
  let fatFraction: number;

  switch (goal) {
    case 'weight_loss':
      proteinGPerKg = 2.2;
      fatFraction   = 0.27;
      break;
    case 'muscle':
      proteinGPerKg = 2.0;
      fatFraction   = 0.26;
      break;
    case 'endurance':
      proteinGPerKg = 1.6;
      fatFraction   = 0.22;
      break;
    default: // 'general'
      proteinGPerKg = 1.6;
      fatFraction   = 0.27;
  }

  const proteinBasisKg = proteinBasisWeightKg(
    weightKg,
    proteinWeightOpts.heightCm ?? null,
    proteinWeightOpts.biologicalSex ?? null,
  );
  const protein  = Math.min(PROTEIN_GRAMS_CAP, Math.round(proteinGPerKg * proteinBasisKg));
  const fatKcal  = Math.round(targetKcal * fatFraction);
  const fat      = Math.round(fatKcal / 9);
  const carbKcal = Math.max(0, targetKcal - protein * 4 - fatKcal);
  const carbs    = Math.round(carbKcal / 4);

  return { protein, carbs, fat };
}

export interface DietBudget {
  mode:       'auto' | 'custom';
  goal:       DietGoal;
  targetKcal: number;
  protein:    number;   // grams
  carbs:      number;   // grams
  fat:        number;   // grams
  /** Present only for auto — the raw maintenance TDEE before the goal adjustment. */
  tdee?:      number;
  /**
   * Present when targetKcal is at/under the sex-aware low-energy-availability
   * threshold (see LOW_ENERGY_KCAL_FEMALE/MALE). Optional and additive so
   * existing iOS Codable clients that don't know this field are unaffected.
   * appliedFloor === true means targetKcal was raised to the threshold
   * rather than serving a lower number: always true for 'auto' budgets that
   * hit the floor, and true for a 'custom' budget written by the app editor
   * (PATCH /api/diet-goal) below the floor — see applyDietBudgetUpdate's
   * DietBudgetUpdateOrigin. A 'custom' budget written by the coach can never
   * land below the floor at all (rejected outright), and a pre-existing
   * custom pin that's below the floor (set before this floor existed, or
   * read straight from resolveDietBudget without a write) reports
   * appliedFloor: false — informational only, value preserved.
   */
  lowEnergyWarning?: { thresholdKcal: number; appliedFloor: boolean; message: string } | null;
}

/**
 * Sex-aware low-energy-availability threshold — unknown sex uses the lower
 * (safer) value. Exported so tools.ts's calculate_macros can floor its own
 * output using the same threshold (see that tool's handler) without
 * duplicating the sex-aware logic.
 */
export function lowEnergyThresholdKcal(biologicalSex: string | null): number {
  return normalizeBiologicalSex(biologicalSex) === 'male' ? LOW_ENERGY_KCAL_MALE : LOW_ENERGY_KCAL_FEMALE;
}

export function lowEnergyMessage(thresholdKcal: number, appliedFloor: boolean): string {
  return appliedFloor
    ? `This is below the ~${thresholdKcal.toLocaleString()} kcal a day that's generally considered a safe floor, so we've eased the deficit rather than cut further.`
    : `This is below the ~${thresholdKcal.toLocaleString()} kcal a day that's generally considered a safe floor. Since you've set this manually, we've kept your number but wanted to flag it.`;
}

/** The four override columns we read/write on `users`. */
export interface DietGoalRow {
  goal:             string | null;
  target_kcal:      number | null;
  protein_target_g: number | null;
  carbs_target_g:   number | null;
  fat_target_g:     number | null;
}

/** Number of trailing days of workouts computeAutoBudget looks at. */
const WORKOUT_WINDOW_DAYS = 7;

/**
 * Weight used for budget math (auto TDEE + the coach's custom-kcal macro
 * split): prefers the smoothed EWMA trend weight once it's established (>= 3
 * weigh-in days spanning >= 5 calendar days — lib/weightTrend.ts), else the
 * single latest reading from ANY source (manual, coach, or HealthKit), else
 * DEFAULT_WEIGHT_KG. This merges manual/coach weigh-ins (lib/weightRepository.ts's
 * getWeightReadings) instead of the old `queryMetricPoints(userId,
 * 'body_mass_kg', ...)`, which only ever saw HealthKit readings — someone
 * who logged a manual/coach weigh-in and never synced HealthKit body mass
 * had their budget computed off DEFAULT_WEIGHT_KG (75kg) or a stale
 * HealthKit value forever.
 */
export async function resolveBudgetWeightKg(userId: string): Promise<number> {
  // timezone is a no-op inside getWeightReadings (HealthKit rows are already
  // day-keyed by ingest, manual rows carry their own localDay) — see that
  // function's doc comment — so it's safe to pass null here rather than
  // fetch the user's row just for this.
  const readings = await getWeightReadings(userId, 90, null);
  if (readings.length === 0) return DEFAULT_WEIGHT_KG;

  const trend = computeWeightTrend(readings);
  if (trend.established && trend.days.length > 0) {
    return trend.days[trend.days.length - 1].trendKg;
  }

  // Not established yet — use the single latest raw reading by measuredAt,
  // regardless of source.
  const latest = [...readings].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt)).at(-1)!;
  return latest.valueKg;
}

/** Auto budget from goal + latest known weight + last 7 days of workouts. */
export async function computeAutoBudget(userId: string, goal: DietGoal): Promise<DietBudget> {
  const [weightKg, workoutRows] = await Promise.all([
    resolveBudgetWeightKg(userId),
    queryWorkouts(userId, WORKOUT_WINDOW_DAYS),
  ]);

  const profile = parseProfileDetails(await readCoreProfile(userId));

  // training-history.json's `frequency` may be missing, malformed, a number
  // (iOS sends Int), or a numeric string (the TS type says string) —
  // activityMultiplierForFrequency tolerates all of that and falls back to
  // the unchanged default (1.3) on anything it can't parse.
  let frequency: unknown;
  try {
    const raw = await readMemoryFile(userId, 'training-history.json');
    frequency = raw ? JSON.parse(raw)?.frequency : undefined;
  } catch {
    frequency = undefined;
  }
  const activityMultiplier = activityMultiplierForFrequency(frequency);

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const workouts: WorkoutInput[] = workoutRows.map(w => ({
    type:        String(w.type ?? w.workoutType ?? 'workout'),
    durationMin: num(w.durationMin) ?? (num(w.duration_s) != null ? num(w.duration_s)! / 60 : undefined),
    calories:    num(w.kcal) ?? num(w.calories),
    distanceKm:  num(w.distance_m) != null ? num(w.distance_m)! / 1000 : num(w.distanceKm),
  }));

  // workouts spans WORKOUT_WINDOW_DAYS (7) trailing days, not a single day —
  // estimateTDEE must average their kcal across that window rather than sum
  // them onto one day's TDEE (see its doc comment for the bug this fixes:
  // 4x/week workouts at 400 kcal each used to add all 1,600 kcal to one
  // day's target, erasing the deficit).
  const tdee = estimateTDEE({
    weightKg,
    heightCm:      profile.heightCm,
    age:           profile.age,
    biologicalSex: profile.biologicalSex,
    activityMultiplier,
  }, workouts, WORKOUT_WINDOW_DAYS);
  const { targetCal, c, p, f } = macrosForGoal(goal, weightKg, tdee, {
    heightCm: profile.heightCm, biologicalSex: profile.biologicalSex,
  });

  // Low-energy-availability floor: an AUTO budget never prescribes a target
  // below the sex-aware safe threshold — ease the deficit (raise targetKcal
  // to the threshold) rather than let a small/older/female user land below
  // their own BMR with no warning. Macros are re-split off the floored kcal
  // so protein/carb/fat stay internally consistent with targetKcal.
  const thresholdKcal = lowEnergyThresholdKcal(profile.biologicalSex);
  if (targetCal < thresholdKcal) {
    const floored = splitMacrosForKcal(goal, weightKg, thresholdKcal, {
      heightCm: profile.heightCm, biologicalSex: profile.biologicalSex,
    });
    return {
      mode: 'auto', goal, targetKcal: thresholdKcal,
      protein: floored.protein, carbs: floored.carbs, fat: floored.fat,
      tdee,
      lowEnergyWarning: { thresholdKcal, appliedFloor: true, message: lowEnergyMessage(thresholdKcal, true) },
    };
  }

  return {
    mode: 'auto', goal, targetKcal: targetCal, protein: p, carbs: c, fat: f, tdee,
    lowEnergyWarning: null,
  };
}

/**
 * Effective budget for a user: their pinned override if set, else the auto
 * calculation. `target_kcal != null` is the switch that means "custom".
 */
export async function resolveDietBudget(user: DietGoalRow, userId: string): Promise<DietBudget> {
  const goal = normalizeGoal(user.goal);

  if (user.target_kcal != null) {
    const kcal = user.target_kcal;
    // Custom (user/coach-pinned) budgets are never blocked or floored — the
    // person deliberately chose this number. We only attach an informational
    // warning when it's under the sex-aware low-energy-availability threshold.
    const profile = parseProfileDetails(await readCoreProfile(userId));
    const thresholdKcal = lowEnergyThresholdKcal(profile.biologicalSex);
    return {
      mode:       'custom',
      goal,
      targetKcal: kcal,
      // A macro should normally be set alongside kcal; fall back to a 30/40/30
      // split of the pinned kcal if one is somehow missing.
      protein: user.protein_target_g ?? Math.round((kcal * 0.30) / 4),
      carbs:   user.carbs_target_g   ?? Math.round((kcal * 0.40) / 4),
      fat:     user.fat_target_g     ?? Math.round((kcal * 0.30) / 9),
      lowEnergyWarning: kcal < thresholdKcal
        ? { thresholdKcal, appliedFloor: false, message: lowEnergyMessage(thresholdKcal, false) }
        : null,
    };
  }

  return computeAutoBudget(userId, goal);
}

// ── Shared budget-write path ──────────────────────────────────────────────────
// Backs both PATCH /api/diet-goal (the editor, explicit macros) and the coach's
// update_diet_budget tool (lib/brain/tools.ts, kcal-only — macros derived here).

export interface DietBudgetUpdateBody {
  goal?:       unknown;
  mode?:       unknown;
  targetKcal?: unknown;
  protein?:    unknown;
  carbs?:      unknown;
  fat?:        unknown;
}

/**
 * Who initiated a custom-budget write — governs how a below-the-safe-floor
 * targetKcal is handled (see the 'custom' branch below):
 *  - 'coach':  the update_diet_budget tool (lib/brain/tools.ts). REJECTED
 *              outright with a clear Error the model can relay in chat —
 *              the coach should never silently pin someone to a risky
 *              number on their behalf.
 *  - 'app':    PATCH /api/diet-goal (the iOS Daily Budget editor). The
 *              shipped iOS client (DietBudgetViewModel.swift) saves
 *              optimistically and only shows a post-save confirm banner —
 *              it has no retry-with-acknowledgment path, so rejecting the
 *              write here would just look like "Couldn't save" with no way
 *              forward. Instead we CLAMP to the floor and return an
 *              appliedFloor:true warning, which the existing banner already
 *              knows how to render.
 * Defaults to 'app' (the more permissive, back-compatible behavior) so any
 * caller that forgets to pass this explicitly doesn't start hard-rejecting
 * writes.
 */
export type DietBudgetUpdateOrigin = 'coach' | 'app';

/**
 * Validate + write a goal/override change to `users`, then resolve the new
 * effective budget. Throws a plain Error with a user-facing message on any
 * validation failure — callers map that to an HTTP status ('User not found.'
 * → 404, everything else → 400).
 */
export async function applyDietBudgetUpdate(
  userId: string,
  body: DietBudgetUpdateBody,
  origin: DietBudgetUpdateOrigin = 'app',
): Promise<{ current: DietBudget; auto: DietBudget }> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new Error('User not found.');

  const update: Partial<typeof schema.users.$inferInsert> = {};
  // Set when the 'custom' branch below clamps a below-floor targetKcal for
  // the app-editor path — attached to `current.lowEnergyWarning` after the
  // write, since resolveDietBudget() has no way to know we just floored it
  // (the stored target_kcal is already at/above the threshold by then).
  let appliedFloorWarning: { thresholdKcal: number; message: string } | null = null;

  // ── goal ──────────────────────────────────────────────────────────────────
  if (body.goal !== undefined) {
    if (typeof body.goal !== 'string' || !(DIET_GOALS as readonly string[]).includes(body.goal)) {
      throw new Error(`goal must be one of: ${DIET_GOALS.join(', ')}.`);
    }
    update.goal = body.goal as DietGoal;
  }

  // ── override mode ────────────────────────────────────────────────────────
  if (body.mode === 'auto') {
    update.target_kcal = null;
    update.protein_target_g = null;
    update.carbs_target_g = null;
    update.fat_target_g = null;
  } else if (body.mode === 'custom') {
    const kcal = num(body.targetKcal);
    if (kcal == null) {
      throw new Error('custom mode requires targetKcal.');
    }
    if (kcal < KCAL_MIN || kcal > KCAL_MAX) {
      throw new Error(`targetKcal must be between ${KCAL_MIN} and ${KCAL_MAX}.`);
    }

    // Low-energy-availability floor (see the module header for why). Custom
    // budgets used to accept anything with only an informational warning —
    // now a coach-initiated write below the floor is rejected outright, and
    // an app-editor write is clamped up to the floor. See DietBudgetUpdateOrigin.
    const profile = parseProfileDetails(await readCoreProfile(userId));
    const thresholdKcal = lowEnergyThresholdKcal(profile.biologicalSex);
    let kcalToStore = Math.round(kcal);
    let flooredKcal = false;

    if (kcalToStore < thresholdKcal) {
      if (origin === 'coach') {
        throw new Error(
          `I can't set a target below ${thresholdKcal.toLocaleString()} kcal/day — that's under the ` +
          `safe low-energy floor for this profile. Let's pick a number at or above that.`,
        );
      }
      kcalToStore = thresholdKcal;
      flooredKcal = true;
      appliedFloorWarning = { thresholdKcal, message: lowEnergyMessage(thresholdKcal, true) };
    }

    const protein = num(body.protein);
    const carbs   = num(body.carbs);
    const fat     = num(body.fat);

    // Explicit macros (editor path) — use verbatim, no re-derivation, UNLESS
    // we just floored the kcal target: the editor's macros were computed
    // against the original (below-floor) number, so re-derive them off the
    // floored kcal instead to keep protein/carb/fat internally consistent
    // with the stored target_kcal. Macros omitted entirely (coach path) —
    // always derive from the goal + budget weight (merged manual/HealthKit
    // readings, see resolveBudgetWeightKg).
    const macros =
      !flooredKcal && protein != null && carbs != null && fat != null
        ? { protein, carbs, fat }
        : splitMacrosForKcal(
            normalizeGoal(update.goal ?? user.goal),
            await resolveBudgetWeightKg(userId),
            kcalToStore,
            { heightCm: profile.heightCm, biologicalSex: profile.biologicalSex },
          );

    for (const [label, g] of [
      ['protein', macros.protein],
      ['carbs', macros.carbs],
      ['fat', macros.fat],
    ] as const) {
      if (g < 0 || g > GRAMS_MAX) {
        throw new Error(`${label} must be between 0 and ${GRAMS_MAX} g.`);
      }
    }

    update.target_kcal = kcalToStore;
    update.protein_target_g = Math.round(macros.protein);
    update.carbs_target_g = Math.round(macros.carbs);
    update.fat_target_g = Math.round(macros.fat);
  } else if (body.mode !== undefined) {
    throw new Error("mode must be 'auto' or 'custom'.");
  }

  if (Object.keys(update).length === 0) {
    throw new Error('Nothing to update.');
  }

  const [updated] = await db
    .update(schema.users)
    .set(update)
    .where(eq(schema.users.id, userId))
    .returning();

  const current = await resolveDietBudget(updated, userId);
  if (appliedFloorWarning) {
    current.lowEnergyWarning = { ...appliedFloorWarning, appliedFloor: true };
  }
  const auto = current.mode === 'auto' ? current : await computeAutoBudget(userId, current.goal);
  return { current, auto };
}
