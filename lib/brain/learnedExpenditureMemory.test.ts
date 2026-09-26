import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/**
 * Drives the real learnedExpenditureMemory functions against a fake
 * `@/lib/memory` (readMemoryFile/writeMemoryFile), mirroring
 * lib/nutrition/portionMemory.test.ts's pattern exactly (same underlying
 * nutrition-habits.json file, a different top-level key).
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

const memoryPromise = import('./learnedExpenditureMemory');

test('loadLearnedExpenditureMemory returns null when nothing was ever recorded', async () => {
  files.clear();
  const { loadLearnedExpenditureMemory } = await memoryPromise;

  assert.equal(await loadLearnedExpenditureMemory('user-1'), null);
});

test('saveLearnedExpenditureMemory then loadLearnedExpenditureMemory round-trips tdee + timestamp', async () => {
  files.clear();
  const { saveLearnedExpenditureMemory, loadLearnedExpenditureMemory } = await memoryPromise;

  const at = new Date('2026-08-15T12:00:00.000Z');
  await saveLearnedExpenditureMemory('user-1', 2213.6, at);

  const memory = await loadLearnedExpenditureMemory('user-1');
  assert.ok(memory);
  assert.equal(memory!.tdee, 2214); // rounded
  assert.equal(memory!.at, at.toISOString());
});

test('saveLearnedExpenditureMemory overwrites a previous value for the same user', async () => {
  files.clear();
  const { saveLearnedExpenditureMemory, loadLearnedExpenditureMemory } = await memoryPromise;

  await saveLearnedExpenditureMemory('user-1', 2200, new Date('2026-08-01T00:00:00.000Z'));
  await saveLearnedExpenditureMemory('user-1', 2260, new Date('2026-08-08T00:00:00.000Z'));

  const memory = await loadLearnedExpenditureMemory('user-1');
  assert.equal(memory!.tdee, 2260);
  assert.equal(memory!.at, '2026-08-08T00:00:00.000Z');
});

test('saveLearnedExpenditureMemory preserves sibling top-level keys already in the file (e.g. portionMemory)', async () => {
  files.clear();
  files.set('user-1', JSON.stringify({ portionMemory: { rice: { food: 'Rice', grams: 200, updatedAt: 'x' } } }));

  const { saveLearnedExpenditureMemory } = await memoryPromise;
  await saveLearnedExpenditureMemory('user-1', 2300, new Date('2026-08-15T00:00:00.000Z'));

  const habits = JSON.parse(files.get('user-1')!);
  assert.ok(habits.portionMemory.rice);
  assert.equal(habits.learnedExpenditure.tdee, 2300);
});

test('two different users never see each other\'s learned-expenditure anchor', async () => {
  files.clear();
  const { saveLearnedExpenditureMemory, loadLearnedExpenditureMemory } = await memoryPromise;

  await saveLearnedExpenditureMemory('user-a', 2000, new Date('2026-08-15T00:00:00.000Z'));
  await saveLearnedExpenditureMemory('user-b', 2600, new Date('2026-08-15T00:00:00.000Z'));

  assert.equal((await loadLearnedExpenditureMemory('user-a'))!.tdee, 2000);
  assert.equal((await loadLearnedExpenditureMemory('user-b'))!.tdee, 2600);
});

test('a malformed learnedExpenditure shape in the file is treated as null, not thrown', async () => {
  files.clear();
  files.set('user-1', JSON.stringify({ learnedExpenditure: { tdee: 'not-a-number', at: 'not-a-date' } }));

  const { loadLearnedExpenditureMemory } = await memoryPromise;
  assert.equal(await loadLearnedExpenditureMemory('user-1'), null);
});

test('a corrupt (non-JSON) nutrition-habits.json is treated as empty, not thrown', async () => {
  files.clear();
  files.set('user-1', '{not valid json');

  const { loadLearnedExpenditureMemory, saveLearnedExpenditureMemory } = await memoryPromise;
  assert.equal(await loadLearnedExpenditureMemory('user-1'), null);

  // Writing afterwards should still succeed and not propagate the corruption.
  await saveLearnedExpenditureMemory('user-1', 2100, new Date('2026-08-15T00:00:00.000Z'));
  assert.equal((await loadLearnedExpenditureMemory('user-1'))!.tdee, 2100);
});
