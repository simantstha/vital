import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * Drives the real portionMemory functions against a fake `@/lib/memory`
 * (readMemoryFile/writeMemoryFile), so it never touches Postgres or disk.
 * The fake is an in-memory map keyed by userId, mirroring
 * nutrition-habits.json's real shape closely enough to exercise the
 * read-merge-write logic.
 */
const files = new Map<string, string>();

mock.module('@/lib/memory', {
  namedExports: {
    readMemoryFile: async (userId: string, filename: string) => {
      if (filename !== 'nutrition-habits.json') return null;
      return files.get(userId) ?? null;
    },
    writeMemoryFile: async (userId: string, filename: string, content: string) => {
      if (filename !== 'nutrition-habits.json') return;
      files.set(userId, content);
    },
  },
});

const portionMemoryPromise = import('./portionMemory');

test('recordPortionCorrection then loadPortionMemory round-trips grams for a food', async () => {
  files.clear();
  const { recordPortionCorrection, loadPortionMemory } = await portionMemoryPromise;

  await recordPortionCorrection('user-1', 'White rice, cooked', 380);
  const entries = await loadPortionMemory('user-1');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].food, 'White rice, cooked');
  assert.equal(entries[0].grams, 380);
  assert.ok(entries[0].updatedAt);
});

test('recordPortionCorrection rounds grams and overwrites a previous correction for the same normalized food', async () => {
  files.clear();
  const { recordPortionCorrection, loadPortionMemory } = await portionMemoryPromise;

  await recordPortionCorrection('user-1', 'white rice, cooked', 300);
  await recordPortionCorrection('user-1', '  White Rice, Cooked  ', 380.6);

  const entries = await loadPortionMemory('user-1');
  assert.equal(entries.length, 1); // same normalized key, not a second entry
  assert.equal(entries[0].grams, 381);
});

test('recordPortionCorrection preserves sibling top-level keys already in the file', async () => {
  files.clear();
  files.set('user-1', JSON.stringify({ preferences: ['vegetarian'], savedMeals: [] }));

  const { recordPortionCorrection } = await portionMemoryPromise;
  await recordPortionCorrection('user-1', 'oatmeal', 250);

  const habits = JSON.parse(files.get('user-1')!);
  assert.deepEqual(habits.preferences, ['vegetarian']);
  assert.equal(habits.portionMemory.oatmeal.grams, 250);
});

test('recordPortionCorrection is a no-op for a non-positive, non-finite, or missing-food correction', async () => {
  files.clear();
  const { recordPortionCorrection, loadPortionMemory } = await portionMemoryPromise;

  await recordPortionCorrection('user-1', 'rice', 0);
  await recordPortionCorrection('user-1', 'rice', -50);
  await recordPortionCorrection('user-1', 'rice', NaN);
  await recordPortionCorrection('user-1', '   ', 200);

  assert.deepEqual(await loadPortionMemory('user-1'), []);
});

test('getPortionMemoryFor matches by exact normalized name only and returns null otherwise', async () => {
  files.clear();
  const { recordPortionCorrection, getPortionMemoryFor } = await portionMemoryPromise;
  await recordPortionCorrection('user-1', 'White rice, cooked', 380);

  const hit = await getPortionMemoryFor('user-1', '  white   rice, cooked ');
  assert.ok(hit);
  assert.equal(hit!.grams, 380);

  assert.equal(await getPortionMemoryFor('user-1', 'white rice'), null);
  assert.equal(await getPortionMemoryFor('user-2', 'white rice, cooked'), null);
});

test('loadPortionMemory returns [] for a user with no file yet, or an unparsable file', async () => {
  files.clear();
  const { loadPortionMemory } = await portionMemoryPromise;
  assert.deepEqual(await loadPortionMemory('brand-new-user'), []);

  files.set('user-2', 'not json');
  assert.deepEqual(await loadPortionMemory('user-2'), []);
});
