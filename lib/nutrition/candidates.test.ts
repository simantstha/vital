import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeName,
  dedupHistory,
  mergeProviderCandidates,
  needsEstimate,
  aggregateRecents,
  type HistoryRow,
  type ProviderCacheRow,
} from './candidates';
import type { UsdaFood } from './usda';

// ─── normalizeName ──────────────────────────────────────────────────────────

test('normalizeName: lowercases, trims, and collapses whitespace', () => {
  assert.equal(normalizeName('  Grilled   Chicken  Breast '), 'grilled chicken breast');
  assert.equal(normalizeName('Chicken'), 'chicken');
});

test('normalizeName: null/undefined/empty all normalize to empty string', () => {
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('   '), '');
});

// ─── dedupHistory ────────────────────────────────────────────────────────────

function historyRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    name: 'Chicken Salad',
    kcal: 400,
    c: 20,
    p: 30,
    f: 15,
    slot: 'lunch',
    timestamp: new Date('2026-07-01T12:00:00Z'),
    ...overrides,
  };
}

test('dedupHistory: keeps the most recent row per normalized name (latest macros win)', () => {
  const rows = [
    historyRow({ name: 'chicken salad', kcal: 400, timestamp: new Date('2026-07-01T00:00:00Z') }),
    historyRow({ name: 'Chicken Salad', kcal: 550, timestamp: new Date('2026-07-05T00:00:00Z') }),
  ];
  const result = dedupHistory(rows, 'chicken');
  assert.equal(result.length, 1);
  assert.equal(result[0].kcal, 550);
  assert.equal(result[0].lastLoggedAt, new Date('2026-07-05T00:00:00Z').toISOString());
});

test('dedupHistory: drops junk names (empty, whitespace-only, "unknown")', () => {
  const rows = [
    historyRow({ name: '' }),
    historyRow({ name: null }),
    historyRow({ name: '   ' }),
    historyRow({ name: 'Unknown' }),
    historyRow({ name: 'unknown' }),
    historyRow({ name: 'Real Food' }),
  ];
  const result = dedupHistory(rows, 'food');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Real Food');
});

test('dedupHistory: ranks exact normalized-name match before substring matches', () => {
  const rows = [
    historyRow({ name: 'Chicken Salad Bowl', timestamp: new Date('2026-07-10T00:00:00Z') }),
    historyRow({ name: 'Chicken', timestamp: new Date('2026-07-01T00:00:00Z') }),
  ];
  const result = dedupHistory(rows, 'chicken');
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Chicken'); // exact match wins despite being older
  assert.equal(result[1].name, 'Chicken Salad Bowl');
});

test('dedupHistory: caps results at 5', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    historyRow({ name: `Food ${i}`, timestamp: new Date(2026, 6, i + 1) })
  );
  const result = dedupHistory(rows, 'food');
  assert.equal(result.length, 5);
});

test('dedupHistory: emits origin history with slot and totals from payload', () => {
  const rows = [historyRow({ name: 'Oatmeal', kcal: 300, c: 50, p: 10, f: 5, slot: 'breakfast' })];
  const result = dedupHistory(rows, 'oatmeal');
  assert.deepEqual(result[0], {
    origin: 'history',
    name: 'Oatmeal',
    kcal: 300,
    c: 50,
    p: 10,
    f: 5,
    lastLoggedAt: rows[0].timestamp.toISOString(),
    slot: 'breakfast',
  });
});

// ─── mergeProviderCandidates ────────────────────────────────────────────────

function cacheRow(overrides: Partial<ProviderCacheRow> = {}): ProviderCacheRow {
  return {
    provider: 'usda',
    provider_food_id: '111',
    name: 'Chicken Breast',
    brand: null,
    serving_desc: '1 breast',
    serving_grams: 150,
    kcal_100g: 165,
    protein_100g: 31,
    carbs_100g: 0,
    fat_100g: 3.6,
    ...overrides,
  };
}

function usdaFood(overrides: Partial<UsdaFood> = {}): UsdaFood {
  return {
    fdcId: 222,
    name: 'Rice',
    brand: null,
    dataType: 'SR Legacy',
    barcode: null,
    servingGrams: null,
    servingDesc: null,
    per100g: { kcal: 130, p: 2.7, c: 28, f: 0.3 },
    ...overrides,
  };
}

test('mergeProviderCandidates: dedups USDA rows already present in cache by provider+id, cache wins position/origin', () => {
  const cache = [cacheRow({ provider: 'usda', provider_food_id: '222', name: 'Rice (cached)' })];
  const usda = [usdaFood({ fdcId: 222 })];
  const result = mergeProviderCandidates(cache, usda);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin, 'cache');
  assert.equal(result[0].name, 'Rice (cached)');
});

test('mergeProviderCandidates: skips USDA rows whose kcal is null', () => {
  const usda = [usdaFood({ fdcId: 333, per100g: { kcal: null, p: 1, c: 1, f: 1 } })];
  const result = mergeProviderCandidates([], usda);
  assert.equal(result.length, 0);
});

test('mergeProviderCandidates: scales per-100g to per-serving when servingGrams known, rounded', () => {
  const cache = [cacheRow({ serving_grams: 150, kcal_100g: 165, protein_100g: 31, carbs_100g: 0, fat_100g: 3.6 })];
  const result = mergeProviderCandidates(cache, []);
  assert.equal(result.length, 1);
  // 165 * 1.5 = 247.5 -> 248; 31 * 1.5 = 46.5 -> 46 or 47 depending on rounding rule (banker's/half-up)
  assert.equal(result[0].kcal, Math.round(165 * 1.5));
  assert.equal(result[0].p, Math.round(31 * 1.5));
  assert.equal(result[0].c, Math.round(0 * 1.5));
  assert.equal(result[0].f, Math.round(3.6 * 1.5));
  assert.equal(result[0].servingGrams, 150);
  assert.equal(result[0].servingDesc, '1 breast');
});

test('mergeProviderCandidates: falls back to per-100g totals with "100 g" default desc when servingGrams unknown', () => {
  const usda = [usdaFood({ fdcId: 444, servingGrams: null, servingDesc: null, per100g: { kcal: 130, p: 2.7, c: 28, f: 0.3 } })];
  const result = mergeProviderCandidates([], usda);
  assert.equal(result.length, 1);
  assert.equal(result[0].kcal, 130);
  assert.equal(result[0].p, 3); // Math.round(2.7)
  assert.equal(result[0].c, 28);
  assert.equal(result[0].f, 0); // Math.round(0.3)
  assert.equal(result[0].servingDesc, '100 g');
  assert.equal(result[0].servingGrams, null);
});

test('mergeProviderCandidates: caps combined result at 10, cache entries first', () => {
  const cache = Array.from({ length: 6 }, (_, i) =>
    cacheRow({ provider_food_id: `c${i}`, name: `Cache ${i}` })
  );
  const usda = Array.from({ length: 8 }, (_, i) =>
    usdaFood({ fdcId: 900 + i, name: `Usda ${i}` })
  );
  const result = mergeProviderCandidates(cache, usda);
  assert.equal(result.length, 10);
  assert.equal(result.slice(0, 6).every((c) => c.origin === 'cache'), true);
  assert.equal(result.slice(6).every((c) => c.origin === 'usda'), true);
});

// ─── needsEstimate ───────────────────────────────────────────────────────────

test('needsEstimate: true when USDA returned nothing', () => {
  assert.equal(needsEstimate('plain query', 0), true);
});

test('needsEstimate: true when query contains digits', () => {
  assert.equal(needsEstimate('200g chicken', 5), true);
});

test('needsEstimate: true when query contains the word "and"', () => {
  assert.equal(needsEstimate('chicken and rice', 5), true);
});

test('needsEstimate: true when query contains a comma', () => {
  assert.equal(needsEstimate('chicken, rice, broccoli', 5), true);
});

test('needsEstimate: false for a plain single-food query with USDA results', () => {
  assert.equal(needsEstimate('chicken breast', 5), false);
});

test('needsEstimate: does not false-positive on words containing "and" as a substring', () => {
  assert.equal(needsEstimate('sandwich', 5), false);
});

// ─── aggregateRecents ────────────────────────────────────────────────────────

function recentRow(overrides: Partial<Parameters<typeof aggregateRecents>[0][number]> = {}) {
  return {
    name: 'Chicken Salad',
    description: null,
    kcal: 400,
    c: 20,
    p: 30,
    f: 15,
    slot: 'lunch',
    imageThumb: null,
    timestamp: new Date('2026-07-01T12:00:00Z'),
    ...overrides,
  };
}

test('aggregateRecents: falls back to description when name is absent (coach logs)', () => {
  const rows = [recentRow({ name: null, description: 'Coach Logged Meal' })];
  const result = aggregateRecents(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Coach Logged Meal');
});

test('aggregateRecents: counts occurrences and ranks by count desc, then latest timestamp desc', () => {
  const rows = [
    recentRow({ name: 'Oatmeal', timestamp: new Date('2026-07-01T00:00:00Z') }),
    recentRow({ name: 'Oatmeal', timestamp: new Date('2026-07-03T00:00:00Z') }),
    recentRow({ name: 'Oatmeal', timestamp: new Date('2026-07-05T00:00:00Z') }),
    recentRow({ name: 'Toast', timestamp: new Date('2026-07-10T00:00:00Z') }),
  ];
  const result = aggregateRecents(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Oatmeal'); // count 3 beats count 1 even though Toast is more recent
  assert.equal(result[1].name, 'Toast');
});

test('aggregateRecents: keeps latest macros/slot/thumb per name', () => {
  const rows = [
    recentRow({ name: 'Eggs', kcal: 200, slot: 'breakfast', imageThumb: 'old.jpg', timestamp: new Date('2026-07-01T00:00:00Z') }),
    recentRow({ name: 'Eggs', kcal: 260, slot: 'lunch', imageThumb: 'new.jpg', timestamp: new Date('2026-07-05T00:00:00Z') }),
  ];
  const result = aggregateRecents(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].kcal, 260);
  assert.equal(result[0].slot, 'lunch');
  assert.equal(result[0].imageThumb, 'new.jpg');
  assert.equal(result[0].lastLoggedAt, new Date('2026-07-05T00:00:00Z').toISOString());
});

test('aggregateRecents: drops junk names (empty/null/unknown)', () => {
  const rows = [
    recentRow({ name: '', description: null }),
    recentRow({ name: null, description: null }),
    recentRow({ name: 'Unknown' }),
    recentRow({ name: 'Valid Meal' }),
  ];
  const result = aggregateRecents(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Valid Meal');
});

test('aggregateRecents: caps at top 12', () => {
  const rows = Array.from({ length: 15 }, (_, i) =>
    recentRow({ name: `Food ${i}`, timestamp: new Date(2026, 6, i + 1) })
  );
  const result = aggregateRecents(rows);
  assert.equal(result.length, 12);
});
