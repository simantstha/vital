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
const DEFAULT_WEIGHT_KG = 75;

export function normalizeGoal(goal: string | null | undefined): DietGoal {
  return (DIET_GOALS as readonly string[]).includes(goal ?? '')
    ? (goal as DietGoal)
    : 'general';
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
