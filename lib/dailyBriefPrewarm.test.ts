import assert from 'node:assert/strict';
import test from 'node:test';
import { prewarmDailyBrief, type DailyBriefContent, type DailyBriefPrewarmDeps } from './dailyBriefPrewarm';

/**
 * prewarmDailyBrief is what scripts/proactive-health-worker.ts's
 * claim-morning-briefs stage calls once it has already claimed a user's
 * morning slot (timezone/slot resolution reused from claimDueMorningBriefs —
 * this function never re-derives it, it's just handed userId + localDay).
 * Pure dependency injection, no @/db mocking needed — these tests drive the
 * real function against a tiny in-memory store standing in for Postgres.
 */

function makeStore() {
  const rows = new Map<string, DailyBriefContent>();
  const key = (userId: string, localDay: string, unitSystem: string) => `${userId}:${localDay}:${unitSystem}`;
  const calls = { generate: 0, upsert: 0 };

  const deps: DailyBriefPrewarmDeps = {
    getUserUnitSystem: async () => 'metric',
    getDailyBrief: async (userId, localDay, unitSystem) => rows.get(key(userId, localDay, unitSystem)) ?? null,
    generateDailyBriefFromDb: async (_userId) => {
      calls.generate += 1;
      return {
        body: 'Fresh insight from the worker.',
        meals: [{ k: 'Salmon bowl', kcal: 550, why: 'Recovery protein after today\'s long run' }],
      };
    },
    upsertDailyBrief: async (userId, localDay, unitSystem, brief) => {
      calls.upsert += 1;
      rows.set(key(userId, localDay, unitSystem), brief);
    },
  };

  return { deps, rows, calls, key };
}

test("the worker's pre-warm writes a brief a later cold read finds", async () => {
  const { deps, calls } = makeStore();

  // Nothing warmed yet for this user/day.
  assert.equal(await deps.getDailyBrief('user-1', '2026-09-03', 'metric'), null);

  const generated = await prewarmDailyBrief('user-1', '2026-09-03', deps);
  assert.equal(generated, true);
  assert.equal(calls.generate, 1);
  assert.equal(calls.upsert, 1);

  // A later, independent read (standing in for a cold /api/today process
  // hours after the worker ran) finds exactly what the worker generated.
  const found = await deps.getDailyBrief('user-1', '2026-09-03', 'metric');
  assert.deepEqual(found, {
    insight: 'Fresh insight from the worker.',
    plan: [{ name: 'Salmon bowl', kcal: 550, why: "Recovery protein after today's long run" }],
  });
});

test('pre-warm skips regeneration when a brief already exists for the slot', async () => {
  const { deps, rows, calls, key } = makeStore();
  rows.set(key('user-1', '2026-09-03', 'metric'), { insight: 'Already warmed (e.g. on-demand fallback)', plan: [] });

  const generated = await prewarmDailyBrief('user-1', '2026-09-03', deps);

  assert.equal(generated, false);
  assert.equal(calls.generate, 0, 'must not spend a Claude call when today is already warm');
  assert.equal(calls.upsert, 0);
});

test('pre-warm for a new local day does not reuse yesterday\'s cached generation', async () => {
  const { deps, calls } = makeStore();

  await prewarmDailyBrief('user-1', '2026-09-02', deps);
  assert.equal(calls.generate, 1);

  // Next morning: different localDay key, so this is treated as a fresh
  // miss and generated again — not silently skipped because *a* brief
  // exists for the user under a different day.
  const generated = await prewarmDailyBrief('user-1', '2026-09-03', deps);
  assert.equal(generated, true);
  assert.equal(calls.generate, 2);

  assert.deepEqual(await deps.getDailyBrief('user-1', '2026-09-02', 'metric'), {
    insight: 'Fresh insight from the worker.',
    plan: [{ name: 'Salmon bowl', kcal: 550, why: "Recovery protein after today's long run" }],
  });
});
