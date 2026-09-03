import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../../db/schema';

/**
 * The bug this whole feature fixes: the old in-memory `Map` cache
 * (lib/brain/briefCache.ts, now deleted) was empty on every cold start, so
 * a brief generated one day was thrown away and never seen. These tests
 * drive the real getDailyBrief/upsertDailyBrief against a genuinely
 * stateful in-memory fake table (not just a canned-response mock) so a
 * write-then-read round trip is actually exercised — proving the tuple
 * (user_id, local_day, unit_system) is honored on both sides, not just
 * that the functions call some db methods.
 *
 * The fake's `.where()` extracts real bound params from the drizzle
 * `and(eq(...), eq(...), eq(...))` condition via PgDialect().sqlToQuery() —
 * the same technique lib/streakRepository.test.ts uses to inspect a raw
 * drizzle SQL fragment without a live database. This relies on
 * dailyBriefRepository.ts's documented param order (user_id, local_day,
 * unit_system); if that order ever changes, update `PARAM_INDEX` below.
 *
 * `@/db` is mocked ONCE at module scope (not per-test): node's ESM module
 * cache means a module already imported in this process keeps referencing
 * whichever mock was active at its first import, so re-mocking mid-file
 * would silently do nothing for a module imported earlier — same reasoning
 * app/api/today/route.test.ts documents for its shared `state` object.
 * Each test resets the shared `rows` array instead.
 */

interface FakeRow {
  user_id: string;
  local_day: string;
  unit_system: string;
  insight: string;
  plan: unknown;
  generated_at: Date;
  updated_at: Date;
}

const PARAM_INDEX = { user_id: 0, local_day: 1, unit_system: 2 } as const;

const rows: FakeRow[] = [];

const fakeDb = {
  select: (_cols: unknown) => ({
    from: (_table: unknown) => ({
      where: (condition: unknown) => ({
        limit: async (_n: number) => {
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const match = rows.find(
            (r) =>
              r.user_id === params[PARAM_INDEX.user_id] &&
              r.local_day === params[PARAM_INDEX.local_day] &&
              r.unit_system === params[PARAM_INDEX.unit_system],
          );
          return match ? [{ insight: match.insight, plan: match.plan }] : [];
        },
      }),
    }),
  }),
  insert: (_table: unknown) => ({
    values: (row: FakeRow) => ({
      onConflictDoUpdate: async (config: { set: Partial<FakeRow> }) => {
        const existing = rows.find(
          (r) => r.user_id === row.user_id && r.local_day === row.local_day && r.unit_system === row.unit_system,
        );
        if (existing) Object.assign(existing, config.set);
        else rows.push({ ...row });
      },
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const repoPromise = import('./dailyBriefRepository');

test('a cold read finds a brief a prior write persisted — the actual bug being fixed', async () => {
  rows.length = 0;
  const { getDailyBrief, upsertDailyBrief } = await repoPromise;

  // Nothing generated yet — a fresh process (empty Map, in the old world)
  // must see a clean miss, not a stale/crashed read.
  assert.equal(await getDailyBrief('user-1', '2026-09-03', 'metric'), null);

  await upsertDailyBrief('user-1', '2026-09-03', 'metric', {
    insight: 'Recovery is strong today.',
    plan: [{ name: 'Oats', kcal: 420, why: 'Slow-release carbs before your run' }],
  });

  // A brand-new "process" (fresh call, same underlying store) reads it back —
  // this is the persistence guarantee the Map never gave.
  const found = await getDailyBrief('user-1', '2026-09-03', 'metric');
  assert.deepEqual(found, {
    insight: 'Recovery is strong today.',
    plan: [{ name: 'Oats', kcal: 420, why: 'Slow-release carbs before your run' }],
  });
});

test("a new local day gets a fresh miss, never yesterday's brief", async () => {
  rows.length = 0;
  const { getDailyBrief, upsertDailyBrief } = await repoPromise;

  await upsertDailyBrief('user-1', '2026-09-02', 'metric', {
    insight: "Yesterday's insight",
    plan: [{ name: 'Yesterday meal', kcal: 300, why: 'stale' }],
  });

  // Same user, same unit system, next local day: must miss, not return
  // yesterday's row — the local day is part of the lookup key, not just an
  // audit field.
  assert.equal(await getDailyBrief('user-1', '2026-09-03', 'metric'), null);

  // Yesterday's row is still there under its own key (upsert never deletes).
  assert.deepEqual(await getDailyBrief('user-1', '2026-09-02', 'metric'), {
    insight: "Yesterday's insight",
    plan: [{ name: 'Yesterday meal', kcal: 300, why: 'stale' }],
  });
});

test('a units flip on the same local day misses instead of serving the old-units brief', async () => {
  rows.length = 0;
  const { getDailyBrief, upsertDailyBrief } = await repoPromise;

  await upsertDailyBrief('user-1', '2026-09-03', 'metric', {
    insight: 'In kilometers',
    plan: [],
  });

  assert.equal(await getDailyBrief('user-1', '2026-09-03', 'imperial'), null);
});

test('upsertDailyBrief replaces the prior brief for the same tuple (idempotent, not append)', async () => {
  rows.length = 0;
  const { getDailyBrief, upsertDailyBrief } = await repoPromise;

  await upsertDailyBrief('user-1', '2026-09-03', 'metric', { insight: 'first', plan: [] });
  await upsertDailyBrief('user-1', '2026-09-03', 'metric', { insight: 'second (regenerated)', plan: [] });

  assert.equal(rows.length, 1, 'a second write for the same tuple must update in place, not add a row');
  assert.deepEqual(await getDailyBrief('user-1', '2026-09-03', 'metric'), { insight: 'second (regenerated)', plan: [] });
});
