import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../db/schema';
import { localDayKey } from '../localDay';

/**
 * assembleContext() fetches "today's" events with a UTC-anchored window, then
 * (as of this fix) refines them down to the user's exact local day in JS by
 * comparing localDayKey values — never timezone offset arithmetic. Before the
 * fix, the raw UTC-windowed events were handed straight to buildDaySnapshot
 * with no local-day refinement, so a non-UTC user's "### Today" prompt block
 * could include yesterday's events or omit this morning's, depending on how
 * far their timezone sits from UTC.
 *
 * This is a SEPARATE file from context.test.ts on purpose: that file installs
 * a throwing-Proxy `@/db` (it only exercises the pure `buildPromptText` half)
 * which cannot coexist with the working fake `@/db` this file needs to drive
 * the full assembleContext(). node:test isolates each test file in its own
 * subprocess, so mock.module() here has no effect on context.test.ts's run.
 *
 * assembleContext fans out to ~10 db operations plus several helper modules;
 * per the task, the helper modules (conversationWindow, baselines, tools,
 * dietBudget) are mocked wholesale rather than modeling every table they'd
 * otherwise touch (raw db.execute for calibration, calendar_blocks, etc).
 * Only events/nodes/messages/users/daily_metrics/daily_briefs need a real
 * fake `@/db` table-branch, copied from app/api/today/route.test.ts's shape.
 * (daily_briefs joined that list when the Today-screen brief moved from an
 * in-process Map to Postgres — see lib/brain/dailyBriefRepository.ts.)
 *
 * Determinism: all fixture timestamps are built relative to a computed
 * UTC-midnight anchor, and the wall clock is pinned with node:test's
 * mock.timers (see lib/brain/brief.test.ts on this branch) — a live clock
 * makes boundary tests flaky depending on what wall-clock time the suite
 * happens to run at.
 */

const state: {
  userRow: Array<{ timezone: string | null; unit_system?: string | null }>;
  events: Array<{ type: string; timestamp: Date; payload: unknown }>;
} = {
  userRow: [{ timezone: null }],
  events: [],
};

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.events) {
        return { where: () => ({ orderBy: async () => state.events }) };
      }
      if (table === realSchema.nodes) {
        return { where: () => ({ orderBy: async () => [] }) };
      }
      if (table === realSchema.messages) {
        return { where: () => ({ orderBy: () => ({ limit: async () => [] }) }) };
      }
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.userRow }) };
      }
      if (table === realSchema.daily_metrics) {
        return { where: async () => [] };
      }
      if (table === realSchema.daily_briefs) {
        // Empty → getDailyBrief returns null → ctx.cachedBrief is undefined,
        // byte-identical to what the old in-memory Map returned in a fresh
        // test process (it was always cold here). These tests pin local-day /
        // timezone behavior, not brief content, so a miss is the right fixture.
        return { where: () => ({ limit: async () => [] }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/conversationWindow', {
  namedExports: { getConversationStart: async () => null },
});
mock.module('@/lib/brain/baselines', {
  namedExports: { getCalibration: async () => ({ status: 'ready', metrics: {} }) },
});
mock.module('@/lib/brain/tools', {
  namedExports: {
    queryAllBaselines: async () => [],
    queryScheduleWindow: async () => [],
    // context.ts imports these two directly from './tools' as well —
    // re-export them so that import doesn't fail.
    metricLabel: (metric: string) => metric,
    formatScheduleLine: () => '',
  },
});
mock.module('@/lib/brain/dietBudget', {
  namedExports: { resolveDietBudget: async () => undefined },
});

const contextPromise = import('./context');

test('a UTC+9 user\'s local-today event is kept and local-yesterday event is dropped (FAILS on main — no local-day refine)', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 2, 10, 10, 0, 0) });
  try {
    const now = new Date();
    const utcMidnightToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tz = 'Asia/Tokyo'; // UTC+9

    state.userRow = [{ timezone: tz }];
    state.events = [
      // utcMidnightToday - 2h = ~07:00 JST *today* — must be kept.
      {
        type: 'meal_logged',
        timestamp: new Date(utcMidnightToday.getTime() - 2 * 3_600_000),
        payload: { kcal: 500, c: 50, p: 20, f: 10, description: 'local-today breakfast' },
      },
      // utcMidnightToday - 20h = ~13:00 JST *yesterday* — must be dropped.
      {
        type: 'meal_logged',
        timestamp: new Date(utcMidnightToday.getTime() - 20 * 3_600_000),
        payload: { kcal: 700, c: 60, p: 30, f: 20, description: 'local-yesterday dinner' },
      },
    ];

    const { assembleContext } = await contextPromise;
    const ctx = await assembleContext('user-1');

    assert.equal(ctx.today.meals.length, 1);
    assert.equal(ctx.today.meals[0].description, 'local-today breakfast');
    assert.equal(ctx.today.date, localDayKey(now, tz));
  } finally {
    mock.timers.reset();
  }
});

test('a null stored timezone falls back to UTC byte-identically (backward-compat contract)', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 5, 15, 12, 0, 0) });
  try {
    const now = new Date();
    const utcMidnightToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    state.userRow = [{ timezone: null }];
    state.events = [
      // utcMidnight + 1h — today in UTC — must be kept.
      {
        type: 'meal_logged',
        timestamp: new Date(utcMidnightToday.getTime() + 1 * 3_600_000),
        payload: { kcal: 400, c: 40, p: 15, f: 10, description: 'utc-today snack' },
      },
      // utcMidnight - 1h — yesterday in UTC — must be dropped.
      {
        type: 'meal_logged',
        timestamp: new Date(utcMidnightToday.getTime() - 1 * 3_600_000),
        payload: { kcal: 600, c: 55, p: 25, f: 15, description: 'utc-yesterday snack' },
      },
    ];

    const { assembleContext } = await contextPromise;
    const ctx = await assembleContext('user-1');

    assert.equal(ctx.timezone, 'UTC');
    assert.equal(ctx.today.date, now.toISOString().slice(0, 10));
    assert.equal(ctx.today.meals.length, 1);
    assert.equal(ctx.today.meals[0].description, 'utc-today snack');
  } finally {
    mock.timers.reset();
  }
});

test('an invalid stored timezone falls back to UTC without throwing', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 7, 1, 9, 0, 0) });
  try {
    state.userRow = [{ timezone: 'Not/AZone' }];
    state.events = [];

    const { assembleContext } = await contextPromise;
    const ctx = await assembleContext('user-1');

    assert.equal(ctx.timezone, 'UTC');
  } finally {
    mock.timers.reset();
  }
});
