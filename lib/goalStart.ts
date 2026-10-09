/**
 * Vital — goal-start snapshot
 *
 * When the goal type or target weight changes, progress is re-anchored: the
 * start timestamp becomes "now" and the start weight becomes the user's latest
 * smoothed trend weight (lib/weightTrend.ts), else null (never a guessed
 * default — progress is simply unknown until a weigh-in exists).
 */

import { getWeightReadings } from '@/lib/weightRepository';
import { computeWeightTrend } from '@/lib/weightTrend';

/** Latest trend weight in kg (1 decimal), or null when the user has no weigh-ins. Never throws. */
export async function resolveGoalStartWeightKg(userId: string): Promise<number | null> {
  try {
    const readings = await getWeightReadings(userId, 90, null);
    if (readings.length === 0) return null;
    const trend = computeWeightTrend(readings);
    const last = trend.days[trend.days.length - 1];
    return last ? Math.round(last.trendKg * 10) / 10 : null;
  } catch (err) {
    console.error(`[goalStart] start-weight lookup failed for user ${userId}:`, err);
    return null;
  }
}

/** Column values that re-anchor goal progress to this moment. */
export async function buildGoalRestart(userId: string, now: Date = new Date()): Promise<{
  goal_started_at: Date;
  goal_start_weight_kg: number | null;
}> {
  return { goal_started_at: now, goal_start_weight_kg: await resolveGoalStartWeightKg(userId) };
}

/** Direction of travel from `fromKg` to `targetKg`. */
export type TargetDirection = 'loss' | 'gain' | 'hold';

export function targetDirection(fromKg: number, targetKg: number): TargetDirection {
  const diff = targetKg - fromKg;
  if (Math.abs(diff) < 0.1) return 'hold';
  return diff < 0 ? 'loss' : 'gain';
}

/**
 * Pure: should changing the target weight from `prevTargetKg` to `newTargetKg`
 * re-anchor goal progress? Only when there was no previous target (a goal is
 * starting) or the direction of travel from the current weight flips
 * (loss <-> gain). A same-direction edit keeps the start weight and start
 * date, so "lost so far" is not wiped. With no known current weight the
 * direction can't be judged, so progress is kept.
 */
export function shouldReanchorForTargetChange(
  prevTargetKg: number | null,
  newTargetKg: number,
  currentKg: number | null,
): boolean {
  if (prevTargetKg == null) return true;
  if (prevTargetKg === newTargetKg) return false;
  if (currentKg == null) return false;
  const before = targetDirection(currentKg, prevTargetKg);
  const after = targetDirection(currentKg, newTargetKg);
  return before !== after && before !== 'hold' && after !== 'hold';
}

/** DB-facing: loads the current trend weight and applies shouldReanchorForTargetChange. */
export async function shouldReanchorGoalForTarget(
  userId: string,
  prevTargetKg: number | null,
  newTargetKg: number,
): Promise<boolean> {
  if (prevTargetKg == null) return true;
  if (prevTargetKg === newTargetKg) return false;
  return shouldReanchorForTargetChange(prevTargetKg, newTargetKg, await resolveGoalStartWeightKg(userId));
}
