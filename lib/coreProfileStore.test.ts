import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realSchema from '../db/schema';

/**
 * lib/coreProfileStore.ts is the fix for the bug where the worker Fly
 * machine (no volume mounted — see fly.toml / db/schema.ts's core_profile_md
 * comment) read back a freshly re-seeded blank core-profile.md template
 * instead of the user's real profile. This drives the real
 * readCoreProfile/writeCoreProfile against a fake `@/db` (no Postgres) and a
 * fake `@/lib/memory` (no filesystem) — same pattern as
 * lib/brain/dailyBriefRepository.test.ts. `@/db` and `@/lib/memory` are
 * mocked ONCE at module scope; each test resets the shared `state` instead.
 */

const state: {
  column: Record<string, string | null>;
  file: Record<string, string | null>;
} = { column: {}, file: {} };

const updateCalls: Array<{ userId: string; core_profile_md: string }> = [];
const writeMemoryCalls: Array<{ userId: string; content: string }> = [];

function userIdFromCondition(condition: unknown): string {
  const { params } = new PgDialect().sqlToQuery(condition as never);
  return String(params[0]);
}

const fakeDb = {
  select: (_cols: unknown) => ({
    from: (table: unknown) => {
      if (table !== realSchema.users) throw new Error(`unexpected select().from(): ${String(table)}`);
      return {
        where: (condition: unknown) => ({
          limit: async (_n: number) => {
            const userId = userIdFromCondition(condition);
            return [{ core_profile_md: state.column[userId] ?? null }];
          },
        }),
      };
    },
  }),
  update: (table: unknown) => ({
    set: (assigned: { core_profile_md: string }) => ({
      where: async (condition: unknown) => {
        if (table !== realSchema.users) throw new Error(`unexpected update() table: ${String(table)}`);
        const userId = userIdFromCondition(condition);
        updateCalls.push({ userId, core_profile_md: assigned.core_profile_md });
        state.column[userId] = assigned.core_profile_md;
      },
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/memory', {
  namedExports: {
    readMemoryFile: (userId: string, filename: string): string | null => {
      if (filename !== 'core-profile.md') return null;
      return state.file[userId] ?? null;
    },
    writeMemoryFile: (userId: string, filename: string, content: string): void => {
      if (filename !== 'core-profile.md') return;
      state.file[userId] = content;
      writeMemoryCalls.push({ userId, content });
    },
  },
});

const storePromise = import('./coreProfileStore');

// Faithful copy of the relevant lines of vital-memory-template/core-profile.md
// — in particular the `HRV baseline: 0ms (updated never)` line, which is what
// makes the write-path regression below fire.
const BLANK_TEMPLATE = [
  '# Vital — Core Profile',
  '',
  '## Identity',
  '- Age: [to be filled]',
  '- Sex: [to be filled]',
  '- Height: [to be filled]',
  '- Current weight: [to be filled] — last updated',
  '',
  '## Baselines — auto-updated by coach',
  '- HRV baseline: 0ms (updated never)',
  '- Resting HR: [to be filled]',
].join('\n');

function reset() {
  state.column = {};
  state.file = {};
  updateCalls.length = 0;
  writeMemoryCalls.length = 0;
}

test('readCoreProfile prefers the DB column over the file', async () => {
  reset();
  const { readCoreProfile } = await storePromise;
  state.column['user-1'] = '## Identity\n- Age: 41';
  state.file['user-1'] = '## Identity\n- Age: 99 (stale file)';

  const result = await readCoreProfile('user-1');

  assert.equal(result, '## Identity\n- Age: 41');
  assert.equal(updateCalls.length, 0, 'a populated column must never trigger a write');
});

test('readCoreProfile backfills a real file profile into a null column', async () => {
  reset();
  const { readCoreProfile } = await storePromise;
  state.column['user-1'] = null;
  state.file['user-1'] = '## Identity\n- Age: 41\n- Sex: Female';

  const result = await readCoreProfile('user-1');

  assert.equal(result, '## Identity\n- Age: 41\n- Sex: Female');
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], { userId: 'user-1', core_profile_md: '## Identity\n- Age: 41\n- Sex: Female' });
  assert.equal(state.column['user-1'], '## Identity\n- Age: 41\n- Sex: Female', 'backfill must actually land in the column');
});

test('a blank template never clobbers a null column (leaves room for the real write to land)', async () => {
  reset();
  const { readCoreProfile } = await storePromise;
  state.column['user-1'] = null;
  state.file['user-1'] = BLANK_TEMPLATE; // e.g. the worker machine's freshly re-seeded, volume-less template

  const result = await readCoreProfile('user-1');

  // Still returns the template — onboarding's `readCoreProfile() ?? ''` fill
  // flow depends on getting *something* back — but must not persist it.
  assert.equal(result, BLANK_TEMPLATE);
  assert.equal(updateCalls.length, 0, 'a blank template must never be written to the column');
  assert.equal(state.column['user-1'], null);
});

test('a populated column is never re-read from a stale blank-template file', async () => {
  reset();
  const { readCoreProfile } = await storePromise;
  state.column['user-1'] = '## Identity\n- Age: 41 (real, already backfilled)';
  state.file['user-1'] = BLANK_TEMPLATE; // e.g. a worker machine's ephemeral re-seed, out of sync with the column

  const result = await readCoreProfile('user-1');

  assert.equal(result, '## Identity\n- Age: 41 (real, already backfilled)');
  assert.equal(updateCalls.length, 0);
});

test('writeCoreProfile updates the column (source of truth) and the legacy file cache', async () => {
  reset();
  const { writeCoreProfile } = await storePromise;

  await writeCoreProfile('user-1', '## Identity\n- Age: 42');

  assert.equal(state.column['user-1'], '## Identity\n- Age: 42');
  assert.deepEqual(writeMemoryCalls, [{ userId: 'user-1', content: '## Identity\n- Age: 42' }]);
});

test('writeCoreProfile refuses to put blank-template content in the column but still writes the legacy file', async () => {
  reset();
  const { writeCoreProfile } = await storePromise;

  await writeCoreProfile('user-1', BLANK_TEMPLATE);

  assert.equal(state.column['user-1'], undefined, 'the column must stay unset');
  assert.equal(updateCalls.length, 0);
  assert.deepEqual(writeMemoryCalls, [{ userId: 'user-1', content: BLANK_TEMPLATE }]);
});

/**
 * The exact hole a read-only guard would leave, driven through the REAL
 * lib/brain/baselines.ts writeHrvBaselineToProfile rather than a simulation:
 * on the worker (column null, blank re-seeded template on its ephemeral
 * disk), the template's own `HRV baseline: 0ms (updated never)` line makes
 * `stored = 0`, which clears the `Math.abs(currentAvg - stored) <= 3` early
 * return for any real HRV — so the function DOES reach its write. That write
 * must not poison the column, or readCoreProfile short-circuits on blank
 * content forever and the user's real profile on the app volume is stranded.
 */
test('worker HRV write against a blank template never poisons a null column', async () => {
  reset();
  const { writeHrvBaselineToProfile } = await import('./brain/baselines');
  state.column['user-1'] = null;      // never backfilled — real profile lives on the app machine's volume
  state.file['user-1'] = BLANK_TEMPLATE; // worker's volume-less, re-seeded template

  await writeHrvBaselineToProfile('user-1', 45); // a real HRV; 0 + 3 < 45, so the early return does NOT fire

  assert.equal(state.column['user-1'], null, 'the column must remain null so the real profile can still backfill');
  assert.equal(updateCalls.length, 0, 'no column write may happen on the blank-template path');

  // And prove the consequence: a later read still falls through to the file,
  // so once the app machine's real profile is reachable it backfills normally.
  const { readCoreProfile } = await storePromise;
  state.file['user-1'] = '## Identity\n- Age: 41 (the real profile, from the app volume)';
  const result = await readCoreProfile('user-1');
  assert.equal(result, '## Identity\n- Age: 41 (the real profile, from the app volume)');
  assert.equal(state.column['user-1'], '## Identity\n- Age: 41 (the real profile, from the app volume)');
});
