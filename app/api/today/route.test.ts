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
 * `@/db` (directly, and transitively via lib/brain/tools/baselines),
 * `@/lib/brain/brief` (Claude), and `@/lib/memory` (filesystem) must be
 * mocked before the route module's first import — same constraint documented
 * in lib/brain/dietBudget.test.ts and lib/brain/brief.test.ts.
 */

const state: { userRow: Record<string, unknown> } = {
  userRow: {
    id: 'user-1', goal: 'general', target_kcal: null,
    protein_target_g: null, carbs_target_g: null, fat_target_g: null,
    timezone: 'UTC',
  },
};

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
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
  execute: async () => [], // getCalibration
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/brief', {
  namedExports: { generateDailyBriefFromDb: async () => ({ body: '', meals: [] }) },
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
