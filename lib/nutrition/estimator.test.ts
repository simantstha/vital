import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampPer100g,
  estimateMeal,
  groundItem,
  namesOverlap,
  parseReportToolInput,
  pickHistoryPer100g,
  MAX_KCAL_PER_100G,
  MIN_KCAL_PER_100G,
  type EstimatorDeps,
  type GroundingMatch,
  type ParsedItem,
} from './estimator';

// ─── parseReportToolInput ───────────────────────────────────────────────────

test('parseReportToolInput reads a well-formed report_meal_items call', () => {
  const items = parseReportToolInput({
    items: [
      {
        food: 'white rice, cooked', grams: 380, prep: 'steamed', confidence: 'high',
        portionNote: 'full dinner plate, ~2 cups',
        fallbackKcal100g: 130, fallbackC100g: 28, fallbackP100g: 2.7, fallbackF100g: 0.3,
      },
    ],
  });

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    food: 'white rice, cooked',
    grams: 380,
    prep: 'steamed',
    confidence: 'high',
    portionNote: 'full dinner plate, ~2 cups',
    fallbackPer100g: { kcal: 130, c: 28, p: 2.7, f: 0.3 },
  });
});

test('parseReportToolInput drops entries with no food name or a non-positive/garbage grams', () => {
  const items = parseReportToolInput({
    items: [
      { food: '', grams: 100, prep: '', confidence: 'low', portionNote: '', fallbackKcal100g: 0, fallbackC100g: 0, fallbackP100g: 0, fallbackF100g: 0 },
      { food: 'ghost food', grams: 0, prep: '', confidence: 'low', portionNote: '', fallbackKcal100g: 0, fallbackC100g: 0, fallbackP100g: 0, fallbackF100g: 0 },
      { food: 'also ghost', grams: 'a lot', prep: '', confidence: 'low', portionNote: '', fallbackKcal100g: 0, fallbackC100g: 0, fallbackP100g: 0, fallbackF100g: 0 },
      { food: 'real food', grams: 50, prep: '', confidence: 'low', portionNote: '', fallbackKcal100g: 0, fallbackC100g: 0, fallbackP100g: 0, fallbackF100g: 0 },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].food, 'real food');
});

test('parseReportToolInput defaults an invalid/missing confidence to "low" and handles a non-array/missing items field', () => {
  const items = parseReportToolInput({
    items: [
      { food: 'mystery item', grams: 50, prep: '', confidence: 'extremely sure', portionNote: '', fallbackKcal100g: 0, fallbackC100g: 0, fallbackP100g: 0, fallbackF100g: 0 },
    ],
  });
  assert.equal(items[0].confidence, 'low');

  assert.deepEqual(parseReportToolInput({}), []);
  assert.deepEqual(parseReportToolInput(null), []);
  assert.deepEqual(parseReportToolInput({ items: 'not an array' }), []);
});

// ─── namesOverlap ────────────────────────────────────────────────────────────

test('namesOverlap: true when the two names share a normalized word', () => {
  assert.equal(namesOverlap('White rice, cooked', 'white rice'), true);
  assert.equal(namesOverlap('Chicken Breast, Grilled, Skinless', 'grilled chicken breast'), true);
});

test('namesOverlap: false for genuinely unrelated names', () => {
  assert.equal(namesOverlap('White rice, cooked', 'grilled chicken breast'), false);
  assert.equal(namesOverlap('Banana, raw', 'french fries'), false);
});

// ─── clampPer100g ────────────────────────────────────────────────────────────

test('clampPer100g leaves plausible values untouched', () => {
  assert.deepEqual(clampPer100g({ kcal: 130, c: 28, p: 2.7, f: 0.3 }), { kcal: 130, c: 28, p: 2.7, f: 0.3 });
});

test('clampPer100g clamps an absurd kcal/100g into [0, 900]', () => {
  assert.equal(clampPer100g({ kcal: 5000, c: 0, p: 0, f: 0 }).kcal, MAX_KCAL_PER_100G);
  assert.equal(clampPer100g({ kcal: -50, c: 0, p: 0, f: 0 }).kcal, MIN_KCAL_PER_100G);
  assert.equal(clampPer100g({ kcal: NaN, c: 0, p: 0, f: 0 }).kcal, MIN_KCAL_PER_100G);
});

test('clampPer100g clamps macro grams to [0, 100] and treats negative/NaN as 0', () => {
  const clamped = clampPer100g({ kcal: 100, c: 250, p: -5, f: NaN });
  assert.equal(clamped.c, 100);
  assert.equal(clamped.p, 0);
  assert.equal(clamped.f, 0);
});

// ─── groundItem (source fallback order + mismatch guard) ─────────────────────

function parsedItem(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    food: 'white rice, cooked',
    grams: 200,
    prep: 'steamed',
    confidence: 'med',
    portionNote: '~1 cup',
    fallbackPer100g: { kcal: 130, c: 28, p: 2.7, f: 0.3 },
    ...overrides,
  };
}

test('groundItem prefers a history match when its name overlaps the parsed food', () => {
  const history: GroundingMatch = { name: 'White rice, cooked', per100g: { kcal: 140, c: 30, p: 3, f: 0.5 }, source: 'history' };
  const provider: GroundingMatch = { name: 'Rice, white, cooked', per100g: { kcal: 129, c: 28, p: 2.4, f: 0.2 }, source: 'usda' };

  const grounded = groundItem(parsedItem(), history, provider);

  assert.equal(grounded.source, 'history');
  // 140 kcal/100g * 200g = 280
  assert.equal(grounded.kcal, 280);
  assert.equal(grounded.c, 60);
});

test('groundItem falls back to the provider match when there is no history match', () => {
  const provider: GroundingMatch = { name: 'Rice, white, cooked', per100g: { kcal: 129, c: 28, p: 2.4, f: 0.2 }, source: 'usda' };
  const grounded = groundItem(parsedItem(), null, provider);

  assert.equal(grounded.source, 'usda');
  assert.equal(grounded.kcal, 258); // 129 * 2
});

test('groundItem falls back to the model\'s own per-100g estimate when neither lookup has a match', () => {
  const grounded = groundItem(parsedItem(), null, null);

  assert.equal(grounded.source, 'model');
  assert.equal(grounded.kcal, 260); // 130 * 2
});

test('groundItem rejects a clear name mismatch and falls back to the model estimate (sanity check)', () => {
  // A history/provider lookup can return the wrong food (e.g. a bad ILIKE
  // match) — groundItem must not silently trust a match that shares no word
  // with what the model actually parsed.
  const wrongHistory: GroundingMatch = { name: 'Grilled chicken breast', per100g: { kcal: 165, c: 0, p: 31, f: 3.6 }, source: 'history' };
  const wrongProvider: GroundingMatch = { name: 'French fries', per100g: { kcal: 312, c: 41, p: 3.4, f: 15 }, source: 'usda' };

  const grounded = groundItem(parsedItem(), wrongHistory, wrongProvider);

  assert.equal(grounded.source, 'model');
  assert.equal(grounded.kcal, 260);
});

test('groundItem clamps an absurd matched per-100g value before scaling', () => {
  const badMatch: GroundingMatch = { name: 'White rice, cooked', per100g: { kcal: 9000, c: 0, p: 0, f: 0 }, source: 'usda' };
  const grounded = groundItem(parsedItem({ grams: 100 }), null, badMatch);

  assert.equal(grounded.kcal, MAX_KCAL_PER_100G); // clamped to 900, * 1.0 scale
});

test('groundItem carries the parsed item\'s confidence and portionNote through unchanged', () => {
  const grounded = groundItem(parsedItem({ confidence: 'high', portionNote: 'full dinner plate' }), null, null);
  assert.equal(grounded.confidence, 'high');
  assert.equal(grounded.portionNote, 'full dinner plate');
});

// ─── pickHistoryPer100g ──────────────────────────────────────────────────────

test('pickHistoryPer100g finds an exact-normalized-name match in a past estimatorItems breakdown and derives per-100g', () => {
  const rows = [
    {
      payload: {
        estimatorItems: [
          { food: 'White Rice, Cooked', grams: 380, kcal: 494, c: 106, p: 10, f: 1 },
          { food: 'grilled chicken breast', grams: 200, kcal: 330, c: 0, p: 47, f: 15 },
        ],
      },
    },
  ];

  const match = pickHistoryPer100g(rows, 'white rice, cooked');
  assert.ok(match);
  assert.equal(match!.source, 'history');
  // 494 kcal / 380 g * 100 = 130
  assert.equal(match!.per100g.kcal, 130);
});

test('pickHistoryPer100g returns the first (most recent, by row order) match and ignores unrelated foods', () => {
  const rows = [
    { payload: { estimatorItems: [{ food: 'banana', grams: 120, kcal: 107, c: 27, p: 1, f: 0 }] } },
    { payload: { estimatorItems: [{ food: 'white rice, cooked', grams: 300, kcal: 390, c: 84, p: 8, f: 1 }] } },
  ];
  const match = pickHistoryPer100g(rows, 'white rice, cooked');
  assert.ok(match);
  assert.equal(match!.per100g.kcal, 130);
});

test('pickHistoryPer100g returns null when nothing matches, and never throws on malformed payloads', () => {
  const rows = [
    { payload: null },
    { payload: { estimatorItems: 'not an array' } },
    { payload: { estimatorItems: [{ food: 'toast', grams: 0, kcal: 100, c: 0, p: 0, f: 0 }] } }, // grams 0 -> skipped
    { payload: { estimatorItems: [{ food: 'eggs', grams: 100, kcal: 140, c: 1, p: 12, f: 10 }] } },
  ];
  assert.equal(pickHistoryPer100g(rows, 'white rice, cooked'), null);
  assert.ok(pickHistoryPer100g(rows, 'eggs'));
});

// ─── estimateMeal orchestration (fully injected — no network/DB) ─────────────

function fakeDeps(overrides: Partial<EstimatorDeps> = {}): EstimatorDeps {
  return {
    parseMeal: async () => [],
    lookupHistory: async () => null,
    lookupProvider: async () => null,
    loadPortionMemory: async () => [],
    ...overrides,
  };
}

test('estimateMeal grounds every parsed item and sums the totals', async () => {
  const deps = fakeDeps({
    parseMeal: async () => [
      parsedItem({ food: 'grilled chicken breast', grams: 200, fallbackPer100g: { kcal: 165, c: 0, p: 31, f: 3.6 } }),
      parsedItem({ food: 'white rice, cooked', grams: 300, fallbackPer100g: { kcal: 130, c: 28, p: 2.7, f: 0.3 } }),
    ],
    lookupProvider: async (food: string) =>
      food === 'grilled chicken breast'
        ? { name: 'Chicken, broiler, meat only, cooked', per100g: { kcal: 165, c: 0, p: 31, f: 3.6 }, source: 'usda' as const }
        : { name: 'Rice, white, cooked', per100g: { kcal: 130, c: 28, p: 2.7, f: 0.3 }, source: 'usda' as const },
  });

  const result = await estimateMeal({ text: '200g chicken and rice', userId: 'user-1' }, deps);

  assert.equal(result.items.length, 2);
  // chicken: 165*2=330, rice: 130*3=390 -> 720
  assert.equal(result.kcal, 720);
  assert.equal(result.c, 84);
  assert.equal(result.items.every((i) => i.source === 'usda'), true);
});

test('estimateMeal passes portion memory through to parseMeal', async () => {
  const memory = [{ food: 'white rice, cooked', grams: 380, updatedAt: '2026-01-01T00:00:00.000Z' }];
  let seenMemory: unknown;
  const deps = fakeDeps({
    loadPortionMemory: async () => memory,
    parseMeal: async (input) => {
      seenMemory = input.portionMemory;
      return [];
    },
  });

  await estimateMeal({ text: 'a plate of rice', userId: 'user-1' }, deps);
  assert.deepEqual(seenMemory, memory);
});

test('estimateMeal returns an empty, zeroed result when the model parses no items', async () => {
  const result = await estimateMeal({ text: 'unobtainium soup', userId: 'user-1' }, fakeDeps());
  assert.deepEqual(result, { name: 'unobtainium soup', kcal: 0, c: 0, p: 0, f: 0, items: [] });
});

test('estimateMeal falls back per-item to the model estimate when both lookups miss for that item only', async () => {
  const deps = fakeDeps({
    parseMeal: async () => [
      parsedItem({ food: 'grilled chicken breast', grams: 200, fallbackPer100g: { kcal: 165, c: 0, p: 31, f: 3.6 } }),
      parsedItem({ food: 'homemade dal', grams: 250, fallbackPer100g: { kcal: 116, c: 20, p: 9, f: 0.4 } }),
    ],
    lookupProvider: async (food: string) =>
      food === 'grilled chicken breast'
        ? { name: 'Chicken, broiler, meat only, cooked', per100g: { kcal: 165, c: 0, p: 31, f: 3.6 }, source: 'usda' as const }
        : null, // no USDA/cache match for "homemade dal"
  });

  const result = await estimateMeal({ text: 'chicken and homemade dal', userId: 'user-1' }, deps);

  const chicken = result.items.find((i) => i.food === 'grilled chicken breast')!;
  const dal = result.items.find((i) => i.food === 'homemade dal')!;
  assert.equal(chicken.source, 'usda');
  assert.equal(dal.source, 'model');
  assert.equal(dal.kcal, 290); // 116 * 2.5
});
