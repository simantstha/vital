import type { UnitSystem } from './units';

export interface DailyBriefContent {
  insight: string;
  plan: Array<{ name: string; kcal: number; why: string }>;
}

export interface DailyBriefPrewarmDeps {
  getUserUnitSystem(userId: string): Promise<UnitSystem>;
  getDailyBrief(userId: string, localDay: string, unitSystem: UnitSystem): Promise<DailyBriefContent | null>;
  generateDailyBriefFromDb(userId: string): Promise<{ body: string; meals: Array<{ k: string; kcal: number; why: string }> }>;
  upsertDailyBrief(userId: string, localDay: string, unitSystem: UnitSystem, brief: DailyBriefContent): Promise<void>;
}

/**
 * Pre-warms the Today-screen daily brief (distinct from the proactive
 * notification brief — see docs/superpowers/plans/
 * 2026-09-03-persist-and-prewarm-daily-brief.md's "two different morning
 * brief artifacts" note) for a claimed morning-brief slot, so it's already
 * in Postgres before the user opens the app. Called from
 * scripts/proactive-health-worker.ts's claim-morning-briefs stage, reusing
 * that stage's already-resolved user + local-day (claimDueMorningBriefs
 * handles the timezone/slot resolution — this function doesn't re-derive
 * it).
 *
 * Skips generation when a brief already exists for the tuple (userId,
 * localDay, unitSystem) — e.g. the user opened before their slot and
 * /api/today's on-demand fallback already wrote one — so a retried
 * notification slot doesn't re-spend a Claude call here. Returns true when a
 * brief was (re)generated, false when an existing one was left in place.
 */
export async function prewarmDailyBrief(
  userId: string,
  localDay: string,
  deps: DailyBriefPrewarmDeps,
): Promise<boolean> {
  const unitSystem = await deps.getUserUnitSystem(userId);
  const existing = await deps.getDailyBrief(userId, localDay, unitSystem);
  if (existing) return false;

  const dailyBrief = await deps.generateDailyBriefFromDb(userId);
  await deps.upsertDailyBrief(userId, localDay, unitSystem, {
    insight: dailyBrief.body,
    plan: dailyBrief.meals.map((m) => ({ name: m.k, kcal: m.kcal, why: m.why })),
  });
  return true;
}
