import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import path from 'path';
import * as realSchema from '../db/schema';

/**
 * lib/memoryFilesStore.ts generalizes lib/coreProfileStore.ts's fix (worker
 * Fly machine has no volume, so file-only memory content never reaches it)
 * to the rest of .vital-memory/<userId>/: health-conditions.json,
 * training-history.json, nutrition-habits.json, life-context.json,
 * lab-results.json, coach-observations.md, user-profile.md. This drives the
 * real readStoredMemoryFile/writeStoredMemoryFile against a fake `@/db` (no
 * Postgres) and a fake `@/lib/memory` (no filesystem) — same pattern as
 * lib/coreProfileStore.test.ts. `@/db` and `@/lib/memory` are mocked ONCE at
 * module scope; each test resets the shared `state` instead.
 *
 * Unlike coreProfileStore's single core_profile_md text column, the store
 * under test here writes into a `{ "<filename>": "<raw text>" }` jsonb map
 * (users.memory_files), merging ONE key at a time in SQL via
 * `jsonb || jsonb` so concurrent writes to different filenames can't clobber
 * each other.
 *
 * COVERAGE BOUNDARY — read before trusting a green run here. Sibling-key
 * preservation is guaranteed by Postgres's `jsonb ||` semantics under the
 * row lock, and is NOT covered behaviourally by these tests: there is no
 * Postgres in this suite, so the fake `@/db` below only *simulates* the
 * merge. What these tests genuinely prove is structural — that the store
 * emits a single-key jsonb concatenation against the live column value
 * rather than a whole-map overwrite built from a JS snapshot (the shape that
 * caused the lost-update bug). Any `state.column` assertion below is
 * therefore a check on the mock's own bookkeeping, not evidence about
 * Postgres.
 */

const state: {
  column: Record<string, Record<string, string> | null>;
  file: Record<string, Record<string, string | null>>;
} = { column: {}, file: {} };

const updateCalls: Array<{ userId: string; sql: string; patch: Record<string, string> }> = [];
const writeDiskCalls: Array<{ userId: string; filename: string; content: string }> = [];
/** Counts column SELECTs, so a test can prove a write path never pre-reads. */
let selectCount = 0;

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
            selectCount += 1;
            const userId = userIdFromCondition(condition);
            return [{ memory_files: state.column[userId] ?? null }];
          },
        }),
      };
    },
  }),
  update: (table: unknown) => ({
    // The store now assigns a drizzle `sql` expression, not a plain object:
    // `coalesce("users"."memory_files", '{}'::jsonb) || $1::jsonb`. Render it
    // so tests can assert on the real emitted SQL, then apply Postgres's
    // `jsonb || jsonb` right-biased key merge against whatever is in the row
    // AT WRITE TIME — which is the whole point of doing the merge in SQL: no
    // caller-held snapshot is involved, so it can't be stale.
    //
    // NOTE: this merge is a SIMULATION of Postgres semantics, not proof of
    // them. What the tests genuinely prove is structural — that the store
    // emits a single-key jsonb concatenation rather than a full-map
    // overwrite. The atomicity itself is Postgres's row-lock guarantee.
    set: (assigned: { memory_files: unknown }) => ({
      where: async (condition: unknown) => {
        if (table !== realSchema.users) throw new Error(`unexpected update() table: ${String(table)}`);
        const userId = userIdFromCondition(condition);
        const { sql: text, params } = new PgDialect().sqlToQuery(assigned.memory_files as never);
        const patch = JSON.parse(String(params[0])) as Record<string, string>;
        updateCalls.push({ userId, sql: text, patch });
        state.column[userId] = { ...(state.column[userId] ?? {}), ...patch };
      },
    }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/memory', {
  namedExports: {
    readMemoryFileFromDisk: (userId: string, filename: string): string | null => {
      return state.file[userId]?.[filename] ?? null;
    },
    writeMemoryFileToDisk: (userId: string, filename: string, content: string): void => {
      state.file[userId] ??= {};
      state.file[userId][filename] = content;
      writeDiskCalls.push({ userId, filename, content });
    },
    // Real fallback path (no VITAL_MEMORY_TEMPLATE_DIR / Docker seed dir in
    // the test environment) — resolves to the repo's tracked template dir so
    // isSeedTemplate compares against the exact same files seedUserMemory
    // would have copied from in production.
    resolveTemplateDir: (): string => path.join(process.cwd(), 'vital-memory-template'),
  },
});

const storePromise = import('./memoryFilesStore');

// Exact contents of the tracked template files (see vital-memory-template/),
// used to drive the seed-template guard the same way coreProfileStore.test.ts's
// BLANK_TEMPLATE drives isBlankTemplate.
const SEED_JSON = [
  '{',
  '  "PRs": {',
  '    "5K": null,',
  '    "10K": null,',
  '    "halfMarathon": null,',
  '    "marathon": null',
  '  },',
  '  "achievements": [],',
  '  "injuries": [],',
  '  "trainingNotes": []',
  '}',
  '',
].join('\n');

const SEED_MD = [
  '# Coach Observations',
  '',
  '(Coach will append one-sentence insights here after each brief. Rolling dated notes on patterns, trends, and athlete context.)',
  '',
].join('\n');

function reset() {
  state.column = {};
  state.file = {};
  updateCalls.length = 0;
  writeDiskCalls.length = 0;
  selectCount = 0;
}

test('isSeedTemplate matches the real training-history.json and coach-observations.md templates', async () => {
  const { isSeedTemplate } = await storePromise;
  assert.equal(isSeedTemplate('training-history.json', SEED_JSON), true);
  assert.equal(isSeedTemplate('coach-observations.md', SEED_MD), true);
  assert.equal(isSeedTemplate('training-history.json', '{"PRs":{}}'), false);
  assert.equal(isSeedTemplate('coach-observations.md', '# Coach Observations\n\nReal note.'), false);
});

test('lossless round-trip of malformed JSON', async () => {
  reset();
  const { readStoredMemoryFile, writeStoredMemoryFile } = await storePromise;
  const malformed = '{ "PRs": { "5K": "18:32" ,,, broken';

  await writeStoredMemoryFile('user-1', 'training-history.json', malformed);
  const result = await readStoredMemoryFile('user-1', 'training-history.json');

  assert.equal(result, malformed, 'malformed JSON must survive byte-for-byte, never parsed/reshaped');
});

test('lossless round-trip of a .md file', async () => {
  reset();
  const { readStoredMemoryFile, writeStoredMemoryFile } = await storePromise;
  const md = '# Coach Observations\n\n- [2026-09-16] Real insight, trailing spaces kept  \n';

  await writeStoredMemoryFile('user-1', 'coach-observations.md', md);
  const result = await readStoredMemoryFile('user-1', 'coach-observations.md');

  assert.equal(result, md);
});

test('readStoredMemoryFile prefers the DB column over the file', async () => {
  reset();
  const { readStoredMemoryFile } = await storePromise;
  state.column['user-1'] = { 'life-context.json': '{"stressEvents":["real"]}' };
  state.file['user-1'] = { 'life-context.json': '{"stressEvents":["stale file"]}' };

  const result = await readStoredMemoryFile('user-1', 'life-context.json');

  assert.equal(result, '{"stressEvents":["real"]}');
  assert.equal(updateCalls.length, 0, 'a populated column must never trigger a write');
});

test('a populated file backfills into the column via an atomic jsonb merge (not a whole-map overwrite)', async () => {
  reset();
  const { readStoredMemoryFile } = await storePromise;
  state.column['user-1'] = { 'lab-results.json': '{"already":"here"}' };
  state.file['user-1'] = { 'life-context.json': '{"stressEvents":["real, from disk"]}' };

  const result = await readStoredMemoryFile('user-1', 'life-context.json');

  assert.equal(result, '{"stressEvents":["real, from disk"]}');
  assert.equal(updateCalls.length, 1);
  // The load-bearing assertion: the backfill merges ONLY the backfilled
  // filename, so the pre-existing lab-results.json key is never part of the
  // payload and Postgres's `||` leaves it in place. (That it *survives* is a
  // Postgres guarantee — see the COVERAGE BOUNDARY note at the top of this
  // file — so assert on what we emit, not on the mock's merged result.)
  assert.match(updateCalls[0].sql, /coalesce\("users"\."memory_files", '\{\}'::jsonb\) \|\| \$1::jsonb/);
  assert.deepEqual(updateCalls[0].patch, { 'life-context.json': '{"stressEvents":["real, from disk"]}' });
});

test('seed template does NOT backfill', async () => {
  reset();
  const { readStoredMemoryFile } = await storePromise;
  state.column['user-1'] = null;
  state.file['user-1'] = { 'training-history.json': SEED_JSON }; // worker's freshly re-seeded, volume-less template

  const result = await readStoredMemoryFile('user-1', 'training-history.json');

  // Still returns the template — callers depend on getting *something* back —
  // but it must never be persisted.
  assert.equal(result, SEED_JSON);
  assert.equal(updateCalls.length, 0, 'a seed template must never be written to the column');
  assert.equal(state.column['user-1'], null);
});

test('seed template does NOT overwrite a populated column (symmetric guard)', async () => {
  reset();
  const { writeStoredMemoryFile } = await storePromise;
  state.column['user-1'] = { 'training-history.json': '{"trainingNotes":["real, already backfilled"]}' };

  // e.g. the worker re-deriving seed-shaped content and writing it back —
  // the exact hole an asymmetric (read-only) guard would leave open.
  await writeStoredMemoryFile('user-1', 'training-history.json', SEED_JSON);

  assert.equal(updateCalls.length, 0, 'no column write may happen on the seed-template path');
  assert.deepEqual(state.column['user-1'], { 'training-history.json': '{"trainingNotes":["real, already backfilled"]}' });
});

test('disk mirror is still written when the column write is refused', async () => {
  reset();
  const { writeStoredMemoryFile } = await storePromise;
  state.column['user-1'] = { 'training-history.json': '{"trainingNotes":["real"]}' };

  await writeStoredMemoryFile('user-1', 'training-history.json', SEED_JSON);

  assert.deepEqual(writeDiskCalls, [{ userId: 'user-1', filename: 'training-history.json', content: SEED_JSON }]);
  assert.equal(state.file['user-1']['training-history.json'], SEED_JSON);
});

test('writeStoredMemoryFile merges the column (source of truth) and writes the legacy file cache for real content', async () => {
  reset();
  const { writeStoredMemoryFile } = await storePromise;

  await writeStoredMemoryFile('user-1', 'nutrition-habits.json', '{"preferences":["vegetarian"]}');

  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0].sql, /coalesce\("users"\."memory_files", '\{\}'::jsonb\) \|\| \$1::jsonb/);
  assert.deepEqual(updateCalls[0].patch, { 'nutrition-habits.json': '{"preferences":["vegetarian"]}' });
  assert.deepEqual(writeDiskCalls, [{ userId: 'user-1', filename: 'nutrition-habits.json', content: '{"preferences":["vegetarian"]}' }]);
});

/**
 * Regression for the lost-update bug. An earlier revision of this store read
 * the whole memory_files map into JS, spread it, and wrote the whole map
 * back — so two interleaved writers each held a snapshot taken before the
 * other committed, and whichever UPDATE landed second silently reverted the
 * other's key.
 *
 * This is the live production interleaving, not a synthetic one: the
 * `worker` process writes user-profile.md via lib/claude.ts's appendCoachNote
 * on the daily-brief path while the `app` process writes
 * health-conditions.json from onboarding or a write_memory tool call.
 *
 * `Promise.all` puts both calls in flight before either resolves. What this
 * asserts is that NEITHER writer reads the map first (zero selects) and that
 * each emits only its own key — i.e. there is no snapshot that could go
 * stale. It deliberately does NOT assert that both keys are present
 * afterwards: that is Postgres's `jsonb ||` doing the work, and this suite
 * has no Postgres (see COVERAGE BOUNDARY at the top of this file).
 */
test('concurrent writes to different filenames each emit an isolated single-key merge (no stale snapshot)', async () => {
  reset();
  const { writeStoredMemoryFile } = await storePromise;

  await Promise.all([
    writeStoredMemoryFile('user-1', 'user-profile.md', '## Coach Notes\n- [2026-09-16] worker wrote this'),
    writeStoredMemoryFile('user-1', 'health-conditions.json', '{"allergies":["peanut"]}'),
  ]);

  assert.equal(selectCount, 0, 'a write must not pre-read the map — a read-then-write snapshot is what got lost');
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(
    updateCalls.map(c => c.patch).sort((a, b) => Object.keys(a)[0].localeCompare(Object.keys(b)[0])),
    [
      { 'health-conditions.json': '{"allergies":["peanut"]}' },
      { 'user-profile.md': '## Coach Notes\n- [2026-09-16] worker wrote this' },
    ],
    'each writer must send only its own filename, so neither payload can carry (and revert) the other',
  );
});

/**
 * Structural guarantee across BOTH column-writing paths: every update is a
 * single-key jsonb concatenation against the live column value, never a
 * full-map overwrite built in JS — the shape that made the lost update
 * possible.
 */
test('every column update is a single-key jsonb merge, not a full-map overwrite', async () => {
  reset();
  const { readStoredMemoryFile, writeStoredMemoryFile } = await storePromise;

  // Exercise both writing paths: the explicit write and the lazy backfill.
  await writeStoredMemoryFile('user-1', 'life-context.json', '{"stressEvents":["deadline"]}');
  state.file['user-2'] = { 'lab-results.json': '{"results":[{"marker":"ferritin"}]}' };
  await readStoredMemoryFile('user-2', 'lab-results.json');

  assert.equal(updateCalls.length, 2, 'both the write path and the backfill path must have hit the column');
  for (const call of updateCalls) {
    assert.match(
      call.sql,
      /coalesce\("users"\."memory_files", '\{\}'::jsonb\) \|\| \$1::jsonb/,
      'the update must merge in SQL via jsonb concatenation',
    );
    assert.equal(
      Object.keys(call.patch).length, 1,
      'the merged payload must carry exactly one filename, never a snapshot of the whole map',
    );
  }
});
