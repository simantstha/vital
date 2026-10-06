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
