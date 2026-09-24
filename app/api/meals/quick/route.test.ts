import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';
import type { QuickLogResult } from '@/lib/nutrition/quickLog';

/**
 * Drives the real POST handler against fakes for `@/db`,
 * `@/lib/nutrition/quickLog`, `@/lib/brain/dietBudget` and
 * `@/lib/brain/nutritionIntake` (no Postgres, no network). mock.module()
 * must run before ./route is first imported; node:test isolates each test
 * file in its own subprocess.
 *
 * Focus: auth, validation, response shape, slot inference, and that
 * quickLogMeal is always called with source: 'quick' (never 'coach') and no
 * coach reaction is ever produced (this route never imports the Anthropic
 * SDK at all).
 */

const state: {
  usersRow: Array<{ timezone: string | null; id?: string }>;
  quickLogResult: QuickLogResult;
} = {
  usersRow: [{ timezone: 'America/Los_Angeles' }],
  quickLogResult: { ok: false },
};

let quickLogCalls: Array<{ userId: string; text: string; options: { source: string; slot?: string } }> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.usersRow }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/nutrition/quickLog', {
  namedExports: {
    quickLogMeal: async (userId: string, text: string, options: { source: string; slot?: string }) => {
      quickLogCalls.push({ userId, text, options });
      return state.quickLogResult;
    },
  },
});
mock.module('@/lib/brain/dietBudget', {
  namedExports: {
    resolveDietBudget: async () => ({
      mode: 'auto', goal: 'maintain', targetKcal: 2400, protein: 150, carbs: 250, fat: 80,
    }),
  },
});
mock.module('@/lib/brain/nutritionIntake', {
  namedExports: {
    resolveDailyIntake: async (_userId: string, dayKeys: string[]) => {
      const map = new Map();
      for (const key of dayKeys) {
        map.set(key, { date: key, kcal: 500, protein: 20, carbs: 40, fat: 15, source: 'logged', sourceName: null });
      }
      return map;
    },
  },
});

const routePromise = import('./route');

function req(body: unknown, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request('http://localhost/api/meals/quick', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST returns 401 with no x-user-id header', async () => {
  const { POST } = await routePromise;
  const res = await POST(req({ text: 'two eggs' }, {}));
  assert.equal(res.status, 401);
});

test('POST returns 400 for missing/empty text', async () => {
  const { POST } = await routePromise;
  const res1 = await POST(req({}));
  assert.equal(res1.status, 400);

  const res2 = await POST(req({ text: '   ' }));
  assert.equal(res2.status, 400);
});

test('POST returns 400 for text over the max length', async () => {
  const { POST } = await routePromise;
  const res = await POST(req({ text: 'a'.repeat(301) }));
  assert.equal(res.status, 400);
});

test('POST returns 400 for an invalid slot', async () => {
  const { POST } = await routePromise;
  const res = await POST(req({ text: 'two eggs', slot: 'brunch' }));
  assert.equal(res.status, 400);
});

test('POST returns 404 { error: "not_found" } when quickLogMeal finds no candidate', async () => {
  quickLogCalls = [];
  state.quickLogResult = { ok: false };

  const { POST } = await routePromise;
  const res = await POST(req({ text: 'unobtainium soup' }));
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.deepEqual(json, { error: 'not_found' });
});

test('POST calls quickLogMeal with source "quick" and returns { id, name, kcal, p, c, f, slot, kcalLeft }', async () => {
  quickLogCalls = [];
  state.quickLogResult = {
    ok: true, id: 'event-quick', name: '2 eggs and toast', kcal: 320, p: 18, c: 30, f: 15,
    isEstimate: true, origin: 'estimate', foods: [],
  };

  const { POST } = await routePromise;
  const res = await POST(req({ text: 'two eggs and toast', slot: 'breakfast' }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, {
    id: 'event-quick', name: '2 eggs and toast', kcal: 320, p: 18, c: 30, f: 15,
    slot: 'breakfast', kcalLeft: 1900,
  });

  assert.equal(quickLogCalls.length, 1);
  assert.equal(quickLogCalls[0].options.source, 'quick');
  assert.equal(quickLogCalls[0].options.slot, 'breakfast');
});

test('POST infers slot from local time via tz when slot is omitted', async () => {
  quickLogCalls = [];
  state.quickLogResult = {
    ok: true, id: 'event-2', name: 'salad', kcal: 200, p: 5, c: 20, f: 8, isEstimate: false, origin: 'usda',
  };

  // 20:00 UTC == 12:00 PT (no DST edge case needed) → lunch window (11-15).
  const fixedNow = new Date('2026-01-15T20:00:00.000Z');
  const RealDate = Date;
  // @ts-expect-error test-only Date override
  global.Date = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) { super(fixedNow.getTime()); return; }
      // @ts-expect-error forwarding varargs to the real constructor
      super(...args);
    }
    static now() { return fixedNow.getTime(); }
  };

  try {
    const { POST } = await routePromise;
    const res = await POST(req({ text: 'chicken salad', tz: 'America/Los_Angeles' }));
    assert.equal(res.status, 200);
    assert.equal(quickLogCalls[0].options.slot, 'lunch');
  } finally {
    global.Date = RealDate;
  }
});
