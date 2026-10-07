/**
 * Small per-process cache for the coach's goal-progress context.
 *
 * assembleContext() runs loadGoalProgress (~11 queries) on every coach turn
 * and opener. The verdict moves slowly, so a 2-minute TTL keyed by
 * (user, timezone, local day) is plenty. Failures are never cached, and an
 * in-flight load is shared so concurrent turns trigger one computation.
 *
 * Process-local: the Next app and the proactive worker are separate
 * processes, so invalidateGoalProgress() in one does not reach the other, and
 * app replicas each hold their own copy. The TTL is the real bound on
 * staleness; invalidation is a best-effort shortcut for same-process writes.
 */

export const GOAL_PROGRESS_CACHE_TTL_MS = 2 * 60_000;
const MAX_ENTRIES = 500;

export interface GoalProgressCache<T> {
  get(userId: string, tz: string, localDay: string, load: () => Promise<T>): Promise<T>;
  invalidate(userId: string): void;
  clear(): void;
  size(): number;
}

export function createGoalProgressCache<T>(
  opts: { ttlMs?: number; clock?: () => number } = {},
): GoalProgressCache<T> {
  const ttlMs = opts.ttlMs ?? GOAL_PROGRESS_CACHE_TTL_MS;
  const clock = opts.clock ?? (() => Date.now());
  const entries = new Map<string, { userId: string; expiresAt: number; promise: Promise<T> }>();

  return {
    async get(userId, tz, localDay, load) {
      const key = `${userId}|${tz}|${localDay}`;
      const now = clock();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now) return hit.promise;

      if (entries.size >= MAX_ENTRIES) {
        for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      }
      const promise = load();
      const entry = { userId, expiresAt: now + ttlMs, promise };
      entries.set(key, entry);
      try {
        return await promise;
      } catch (err) {
        if (entries.get(key) === entry) entries.delete(key); // never cache a failure
        throw err;
      }
    },
    invalidate(userId) {
      for (const [k, v] of entries) if (v.userId === userId) entries.delete(k);
    },
    clear() { entries.clear(); },
    size() { return entries.size; },
  };
}

// Typed loosely on purpose: the loader result type stays owned by
// lib/goalProgressLoader.ts and is only ever passed straight through.
const shared = createGoalProgressCache<unknown>();

export function getCachedGoalProgress<T>(userId: string, tz: string, localDay: string, load: () => Promise<T>): Promise<T> {
  return shared.get(userId, tz, localDay, load as () => Promise<unknown>) as Promise<T>;
}

/** Drop a user's cached goal progress (call after weight/meal/workout/target writes in this process). */
export function invalidateGoalProgress(userId: string): void {
  shared.invalidate(userId);
}
