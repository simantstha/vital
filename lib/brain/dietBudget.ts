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
  estimateTDEE,
  macrosForGoal,
  queryMetricPoints,
  queryWorkouts,
  type WorkoutInput,
} from '@/lib/brain/tools';

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

export function normalizeGoal(goal: string | null | undefined): DietGoal {
  return (DIET_GOALS as readonly string[]).includes(goal ?? '')
    ? (goal as DietGoal)
    : 'general';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Split a PINNED target calorie figure into protein/carbs/fat grams, using the
 * same per-goal protein-g/kg + fat-fraction ratios `macrosForGoal` (tools.ts)
 * uses for its TDEE-derived target — but WITHOUT re-applying the goal's
 * calorie adjustment (±400/+200/+100/±0). Shared by `macrosForGoal` (auto
 * path) and `applyDietBudgetUpdate` (custom path, when macros are omitted)
 * so the two stay identical.
 */
export function splitMacrosForKcal(
  goal: string,
  weightKg: number,
  targetKcal: number,
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

  const protein  = Math.round(proteinGPerKg * weightKg);
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
}

/** The four override columns we read/write on `users`. */
export interface DietGoalRow {
  goal:             string | null;
  target_kcal:      number | null;
  protein_target_g: number | null;
  carbs_target_g:   number | null;
  fat_target_g:     number | null;
}

/** Auto budget from goal + latest known weight + last 7 days of workouts. */
export async function computeAutoBudget(userId: string, goal: DietGoal): Promise<DietBudget> {
  const [weightPts, workoutRows] = await Promise.all([
    queryMetricPoints(userId, 'body_mass_kg', 90),
    queryWorkouts(userId, 7),
  ]);

  const weightKg = weightPts.at(-1)?.value ?? DEFAULT_WEIGHT_KG;

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const workouts: WorkoutInput[] = workoutRows.map(w => ({
    type:        String(w.type ?? w.workoutType ?? 'workout'),
    durationMin: num(w.durationMin) ?? (num(w.duration_s) != null ? num(w.duration_s)! / 60 : undefined),
    calories:    num(w.kcal) ?? num(w.calories),
    distanceKm:  num(w.distance_m) != null ? num(w.distance_m)! / 1000 : num(w.distanceKm),
  }));

  const tdee = estimateTDEE(weightKg, workouts);
  const { targetCal, c, p, f } = macrosForGoal(goal, weightKg, tdee);
  return { mode: 'auto', goal, targetKcal: targetCal, protein: p, carbs: c, fat: f, tdee };
}

/**
 * Effective budget for a user: their pinned override if set, else the auto
 * calculation. `target_kcal != null` is the switch that means "custom".
 */
export async function resolveDietBudget(user: DietGoalRow, userId: string): Promise<DietBudget> {
  const goal = normalizeGoal(user.goal);

  if (user.target_kcal != null) {
    const kcal = user.target_kcal;
    return {
      mode:       'custom',
      goal,
      targetKcal: kcal,
      // A macro should normally be set alongside kcal; fall back to a 30/40/30
      // split of the pinned kcal if one is somehow missing.
      protein: user.protein_target_g ?? Math.round((kcal * 0.30) / 4),
      carbs:   user.carbs_target_g   ?? Math.round((kcal * 0.40) / 4),
      fat:     user.fat_target_g     ?? Math.round((kcal * 0.30) / 9),
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
 * Validate + write a goal/override change to `users`, then resolve the new
 * effective budget. Throws a plain Error with a user-facing message on any
 * validation failure — callers map that to an HTTP status ('User not found.'
 * → 404, everything else → 400).
 */
export async function applyDietBudgetUpdate(
  userId: string,
  body: DietBudgetUpdateBody,
): Promise<{ current: DietBudget; auto: DietBudget }> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new Error('User not found.');

  const update: Partial<typeof schema.users.$inferInsert> = {};

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

    const protein = num(body.protein);
    const carbs   = num(body.carbs);
    const fat     = num(body.fat);

    // Explicit macros (editor path) — use verbatim, no re-derivation. Macros
    // omitted (coach path) — derive from the goal + latest known weight.
    const macros =
      protein != null && carbs != null && fat != null
        ? { protein, carbs, fat }
        : splitMacrosForKcal(
            normalizeGoal(update.goal ?? user.goal),
            (await queryMetricPoints(userId, 'body_mass_kg', 90)).at(-1)?.value ?? DEFAULT_WEIGHT_KG,
            Math.round(kcal),
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

    update.target_kcal = Math.round(kcal);
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
  const auto = current.mode === 'auto' ? current : await computeAutoBudget(userId, current.goal);
  return { current, auto };
}
