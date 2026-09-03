import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

/**
 * GET /api/today drops `lowEnergyWarning` (lib/brain/dietBudget.ts's
 * DietBudget field) onto the wire so the iOS CautionBanner (APIClient.swift,
 * TodayView.swift) can render it. This exercises the real route + real
 * resolveDietBudget, asserting both the pinned-under-threshold case and the
 * ordinary null case.
 *
 * Also exercises the daily_briefs persistence path (2026-09-03 plan: "Make
 * the morning brief actually appear") — a cold process (no in-memory cache;
 * the old `Map` cache is gone) reading a persisted row must return it
 * without regenerating, and a miss must return empty without blocking the
 * response on the background Claude call.
 *
 * `@/db` (directly, and transitively via lib/brain/tools/baselines),
 * `@/lib/brain/brief` (Claude), and `@/lib/memory` (filesystem) must be
 * mocked before the route module's first import — same constraint documented
 * in lib/brain/dietBudget.test.ts and lib/brain/brief.test.ts.
 */

const state: {
  userRow: Record<string, unknown>;
  dailyBriefRow: { insight: string; plan: unknown } | null;
  generateDailyBriefImpl: () => Promise<{ body: string; meals: Array<{ k: string; kcal: number; why: string }> }>;
} = {
  userRow: {
    id: 'user-1', goal: 'general', target_kcal: null,
    protein_target_g: null, carbs_target_g: null, fat_target_g: null,
    timezone: 'UTC',
  },
  dailyBriefRow: null,
  generateDailyBriefImpl: async () => ({ body: '', meals: [] }),
};

let generateDailyBriefCallCount = 0;
const dailyBriefUpserts: unknown[] = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.events) {
        return { where: () => ({ orderBy: async () => [] }) };
      }
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => [state.userRow] }) };
      }
      if (table === realSchema.daily_metrics) {
        return { where: () => ({ orderBy: async () => [] }) };
      }
      if (table === realSchema.daily_briefs) {
        return { where: () => ({ limit: async () => (state.dailyBriefRow ? [state.dailyBriefRow] : []) }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
  insert: (table: unknown) => {
    if (table === realSchema.daily_briefs) {
      return {
        values: (row: unknown) => ({
          onConflictDoUpdate: async () => { dailyBriefUpserts.push(row); },
        }),
      };
    }
    throw new Error(`unexpected table in insert(): ${String(table)}`);
  },
  execute: async () => [], // getCalibration
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/brief', {
  namedExports: {
    generateDailyBriefFromDb: async (_userId: string) => {
      generateDailyBriefCallCount += 1;
      return state.generateDailyBriefImpl();
    },
  },
});
mock.module('@/lib/memory', {
  namedExports: { readMemoryFile: () => null },
});

const routePromise = import('./route');

function req(): Request {
  return new Request('http://local/api/today', { headers: { 'x-user-id': 'user-1' } });
}

test('a pinned budget under the low-energy floor surfaces lowEnergyWarning', async () => {
  const { GET } = await routePromise;
  state.userRow = {
    id: 'user-1', goal: 'weight_loss', target_kcal: 1000,
    protein_target_g: 120, carbs_target_g: 80, fat_target_g: 30,
    timezone: 'UTC',
  };

  const response = await GET(req());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.dietBudget.lowEnergyWarning, {
    thresholdKcal: 1200,
    appliedFloor: false,
    message:
      "This is below the ~1,200 kcal a day that's generally considered a safe floor. Since you've set this manually, we've kept your number but wanted to flag it.",
  });
});

test('a budget above the floor reports lowEnergyWarning: null', async () => {
  const { GET } = await routePromise;
  state.userRow = {
    id: 'user-1', goal: 'general', target_kcal: 2400,
    protein_target_g: 150, carbs_target_g: 250, fat_target_g: 80,
    timezone: 'UTC',
  };

  const response = await GET(req());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.dietBudget.lowEnergyWarning, null);
});

test('a cold process with a persisted brief returns it, and never regenerates — this is the bug the daily_briefs table fixes', async () => {
  state.dailyBriefRow = {
    insight: 'Recovery is strong — lean into today\'s long run.',
    plan: [{ name: 'Oats + berries', kcal: 420, why: 'Slow-release carbs before your run' }],
  };
  generateDailyBriefCallCount = 0;

  const { GET } = await routePromise;
  const response = await GET(req());
  assert.equal(response.status, 200);
  const body = await response.json();

  // Previously (empty in-memory Map on a cold Fly machine) this would have
  // been '' and [] regardless of what Postgres held — the whole point of
  // persisting is that a cold process finds what an earlier process wrote.
  assert.equal(body.insight, "Recovery is strong — lean into today's long run.");
  assert.deepEqual(body.plan, [{ name: 'Oats + berries', kcal: 420, why: 'Slow-release carbs before your run' }]);
  assert.equal(generateDailyBriefCallCount, 0, 'a persisted hit must short-circuit background regeneration');
});

test('a cold process with no persisted brief returns empty immediately without blocking on generation', async () => {
  state.dailyBriefRow = null;
  generateDailyBriefCallCount = 0;
  dailyBriefUpserts.length = 0;

  // The background generation promise is held open under test control — if
  // the route awaited it, this test would hang instead of resolving.
  let resolveGeneration: (() => void) | undefined;
  state.generateDailyBriefImpl = () =>
    new Promise((resolve) => {
      resolveGeneration = () => resolve({ body: 'generated late', meals: [] });
    });

  const { GET } = await routePromise;
  const response = await GET(req());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.insight, '');
  assert.deepEqual(body.plan, []);
  // Background generation WAS kicked off (the miss triggers a warm)...
  assert.equal(generateDailyBriefCallCount, 1);
  // ...but hadn't settled when the response above was already returned.
  assert.equal(dailyBriefUpserts.length, 0);

  // Let the background generation finish so it doesn't leak into later tests.
  resolveGeneration?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dailyBriefUpserts.length, 1);

  // Reset for any tests that run after this one.
  state.generateDailyBriefImpl = async () => ({ body: '', meals: [] });
});
