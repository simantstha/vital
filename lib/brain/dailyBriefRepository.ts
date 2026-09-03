/**
 * Vital Brain — daily brief repository (Postgres-backed)
 *
 * Replaces the old lib/brain/briefCache.ts module-level `Map`. That cache was
 * empty on every cold start (Fly suspends the machine overnight), so the
 * Today-screen brief the worker or an earlier request generated was thrown
 * away every day and the user never saw one — see
 * docs/superpowers/plans/2026-09-03-persist-and-prewarm-daily-brief.md.
 *
 * getDailyBrief/upsertDailyBrief read/write the `daily_briefs` table, keyed
 * on the same tuple the old briefCacheKey() used: (user_id, local-day,
 * unit_system) — see db/schema.ts. A single indexed row lookup is fast enough
 * to await directly (unlike the 15–27s Claude generation it fronts), so
 * callers no longer need an in-process cache in front of it.
 */

import { db, schema } from '@/db';
import { and, eq } from 'drizzle-orm';
import type { UnitSystem } from '../units';

export interface CachedBrief {
  insight: string;
  plan: Array<{ name: string; kcal: number; why: string }>;
}

/**
 * Reads the persisted brief for (userId, localDay, unitSystem). Returns null
 * on a miss (never generated yet, or generated under different units) — the
 * caller must not block its response on filling the gap; see /api/today's
 * background-generation fallback.
 */
export async function getDailyBrief(
  userId: string,
  localDay: string,
  unitSystem: UnitSystem,
): Promise<CachedBrief | null> {
  const [row] = await db
    .select({ insight: schema.daily_briefs.insight, plan: schema.daily_briefs.plan })
    .from(schema.daily_briefs)
    // Param order (user_id, local_day, unit_system) is depended on by
    // lib/brain/dailyBriefRepository.test.ts's in-memory fake — keep it
    // stable if this condition ever changes shape.
    .where(and(
      eq(schema.daily_briefs.user_id, userId),
      eq(schema.daily_briefs.local_day, localDay),
      eq(schema.daily_briefs.unit_system, unitSystem),
    ))
    .limit(1);
  if (!row) return null;
  return { insight: row.insight, plan: row.plan as CachedBrief['plan'] };
}

/**
 * Upserts the brief for (userId, localDay, unitSystem). Called from two
 * paths: the proactive worker's morning pre-warm (claims the user's morning
 * slot via claimDueMorningBriefs, then generates and writes here — see
 * scripts/proactive-health-worker.ts) and the on-demand fallback in
 * /api/today for a user who opens before their slot or whose pre-warm
 * failed. Idempotent by construction — a later write for the same tuple
 * replaces the earlier one rather than erroring.
 */
export async function upsertDailyBrief(
  userId: string,
  localDay: string,
  unitSystem: UnitSystem,
  brief: CachedBrief,
): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.daily_briefs)
    .values({
      user_id:      userId,
      local_day:    localDay,
      unit_system:  unitSystem,
      insight:      brief.insight,
      plan:         brief.plan,
      generated_at: now,
      updated_at:   now,
    })
    .onConflictDoUpdate({
      target: [schema.daily_briefs.user_id, schema.daily_briefs.local_day, schema.daily_briefs.unit_system],
      set: { insight: brief.insight, plan: brief.plan, generated_at: now, updated_at: now },
    });
}
