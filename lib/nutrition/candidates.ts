/**
 * Vital — unified meal-search candidate merge
 *
 * Merges three sources into a single ranked candidate list for the meal
 * search UI: the user's own history (fastest re-log path), the shared
 * food_cache + USDA FoodData Central (branded/generic nutrition facts), and
 * a CalorieNinjas free-text estimate as a last resort for multi-food
 * phrases or when nothing else matched.
 *
 * All merge/normalization/dedup logic lives in pure, exported helpers
 * (normalizeName, dedupHistory, mergeProviderCandidates, needsEstimate,
 * aggregateRecents) so it is unit-testable without touching the database.
 * `searchCandidates` is a thin IO orchestrator: it runs the DB/network
 * fetches under Promise.allSettled (a failed source yields an empty list,
 * never a thrown error) and delegates all ranking to the pure helpers.
 */

import * as schema from '@/db/schema';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { searchFoods, type UsdaFood } from './usda';
import { lookupNutrition, type NutritionixResult } from '@/lib/nutritionix';

// `@/db` (the live Postgres pool) is imported lazily inside searchCandidates
// rather than at module scope. This keeps the pure helpers above importable
// (and unit-testable) without a DATABASE_URL — only actually calling
// searchCandidates touches the database. `@/db/schema` has no such
// side effect, so it's safe to import eagerly for types + query building.
type Database = Awaited<ReturnType<typeof loadDb>>;

async function loadDb() {
  const { db } = await import('@/db');
  return db;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Candidate {
  origin: 'history' | 'cache' | 'usda' | 'estimate';
  name: string;
  brand?: string | null;
  kcal: number;
  c: number;
  p: number;
  f: number;
  servingDesc?: string | null;
  servingGrams?: number | null;
  per100g?: { kcal: number; c: number; p: number; f: number } | null;
  lastLoggedAt?: string | null; // ISO — history only
  slot?: string | null; // history only
}

/** Raw row shape read from `events` (meal_logged), already filtered/ordered/
 * limited by SQL; name is COALESCE(payload->>'name', payload->>'description'). */
export interface HistoryRow {
  name: string | null;
  kcal: number;
  c: number;
  p: number;
  f: number;
  slot: string | null;
  timestamp: Date;
}

/** Raw row shape read from `food_cache`. */
export interface ProviderCacheRow {
  provider: string;
  provider_food_id: string;
  name: string;
  brand: string | null;
  serving_desc: string | null;
  serving_grams: number | null;
  kcal_100g: number | null;
  protein_100g: number | null;
  carbs_100g: number | null;
  fat_100g: number | null;
}

export interface RecentFood {
  name: string;
  kcal: number;
  c: number;
  p: number;
  f: number;
  slot: string | null;
  lastLoggedAt: string | null;
  imageThumb: string | null;
}

export interface RecentEventRow {
  name: string | null;
  description: string | null;
  kcal: number;
  c: number;
  p: number;
  f: number;
  slot: string | null;
  imageThumb: string | null;
  timestamp: Date;
}

const JUNK_NAMES = new Set(['', 'unknown']);

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Lowercase, trim, and collapse internal whitespace. Used as the dedup key
 * for history/recents; null/undefined normalize to ''. */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** History rows, deduped to one (most recent) entry per normalized name,
 * junk names dropped, exact normalized-name matches ranked before substring
 * matches, capped at 5. */
export function dedupHistory(rows: HistoryRow[], query: string): Candidate[] {
  const normalizedQuery = normalizeName(query);
  const latestByName = new Map<string, HistoryRow>();

  for (const row of rows) {
    const normalized = normalizeName(row.name);
    if (JUNK_NAMES.has(normalized)) continue;
    const existing = latestByName.get(normalized);
    if (!existing || row.timestamp > existing.timestamp) {
      latestByName.set(normalized, row);
    }
  }

  const ranked = Array.from(latestByName.entries()).sort(([aName, aRow], [bName, bRow]) => {
    const aExact = aName === normalizedQuery ? 0 : 1;
    const bExact = bName === normalizedQuery ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return bRow.timestamp.getTime() - aRow.timestamp.getTime();
  });

  return ranked.slice(0, 5).map(([, row]) => ({
    origin: 'history' as const,
    name: (row.name ?? '').trim(),
    kcal: row.kcal,
    c: row.c,
    p: row.p,
    f: row.f,
    lastLoggedAt: row.timestamp.toISOString(),
    slot: row.slot,
  }));
}

interface Per100g {
  kcal: number | null;
  c: number | null;
  p: number | null;
  f: number | null;
}

/** Default-portion totals: per-serving (per100g × servingGrams/100, rounded)
 * when servingGrams is known, else per-100g values with servingDesc
 * falling back to "100 g". Returns null when per100g.kcal is unknown —
 * callers should skip the row. */
function toDefaultPortion(per100g: Per100g, servingGrams: number | null, servingDesc: string | null) {
  if (per100g.kcal == null) return null;

  if (servingGrams != null) {
    const scale = servingGrams / 100;
    return {
      kcal: Math.round(per100g.kcal * scale),
      c: Math.round((per100g.c ?? 0) * scale),
      p: Math.round((per100g.p ?? 0) * scale),
      f: Math.round((per100g.f ?? 0) * scale),
      servingDesc: servingDesc ?? null,
      servingGrams,
    };
  }

  return {
    kcal: Math.round(per100g.kcal),
    c: Math.round(per100g.c ?? 0),
    p: Math.round(per100g.p ?? 0),
    f: Math.round(per100g.f ?? 0),
    servingDesc: servingDesc ?? '100 g',
    servingGrams: null,
  };
}

/** Merges food_cache rows and USDA search results into provider candidates.
 * USDA rows already present in the cache (by provider + provider_food_id)
 * are dropped in favor of the cache row (origin stays 'cache'). Provider
 * rows with unknown (null) kcal are skipped entirely. Capped at 10 combined,
 * cache rows first. */
export function mergeProviderCandidates(cacheRows: ProviderCacheRow[], usdaRows: UsdaFood[]): Candidate[] {
  const cacheKeys = new Set(cacheRows.map((row) => `${row.provider}:${row.provider_food_id}`));

  const cacheCandidates: Candidate[] = [];
  for (const row of cacheRows) {
    const portion = toDefaultPortion(
      { kcal: row.kcal_100g, c: row.carbs_100g, p: row.protein_100g, f: row.fat_100g },
      row.serving_grams,
      row.serving_desc
    );
    if (!portion) continue;
    cacheCandidates.push({
      origin: 'cache',
      name: row.name,
      brand: row.brand,
      kcal: portion.kcal,
      c: portion.c,
      p: portion.p,
      f: portion.f,
      servingDesc: portion.servingDesc,
      servingGrams: portion.servingGrams,
      per100g: {
        kcal: row.kcal_100g as number,
        c: row.carbs_100g ?? 0,
        p: row.protein_100g ?? 0,
        f: row.fat_100g ?? 0,
      },
    });
  }

  const usdaCandidates: Candidate[] = [];
  for (const food of usdaRows) {
    if (food.per100g.kcal == null) continue; // skip provider rows whose kcal is null
    if (cacheKeys.has(`usda:${food.fdcId}`)) continue; // cache row wins position
    const portion = toDefaultPortion(food.per100g, food.servingGrams, food.servingDesc);
    if (!portion) continue;
    usdaCandidates.push({
      origin: 'usda',
      name: food.name,
      brand: food.brand,
      kcal: portion.kcal,
      c: portion.c,
      p: portion.p,
      f: portion.f,
      servingDesc: portion.servingDesc,
      servingGrams: portion.servingGrams,
      per100g: {
        kcal: food.per100g.kcal,
        c: food.per100g.c ?? 0,
        p: food.per100g.p ?? 0,
        f: food.per100g.f ?? 0,
      },
    });
  }

  return [...cacheCandidates, ...usdaCandidates].slice(0, 10);
}

/** True when a free-text estimate should be fetched: USDA returned nothing,
 * or the query looks like a multi-food phrase (contains digits, the word
 * "and", or a comma). */
export function needsEstimate(query: string, usdaCount: number): boolean {
  if (usdaCount === 0) return true;
  return /\d/.test(query) || /\band\b/i.test(query) || query.includes(',');
}

/** Aggregates meal-history rows into ranked "recent foods": normalizes +
 * dedups by name (route logs use `name`, coach logs use `description`),
 * keeps the latest macros/slot/thumb per name, counts occurrences, sorts by
 * (count desc, latest timestamp desc), returns the top 12. */
export function aggregateRecents(rows: RecentEventRow[]): RecentFood[] {
  interface Agg {
    name: string;
    kcal: number;
    c: number;
    p: number;
    f: number;
    slot: string | null;
    imageThumb: string | null;
    timestamp: Date;
    count: number;
  }

  const byName = new Map<string, Agg>();

  for (const row of rows) {
    const rawName = row.name ?? row.description;
    const normalized = normalizeName(rawName);
    if (JUNK_NAMES.has(normalized)) continue;

    const existing = byName.get(normalized);
    if (!existing) {
      byName.set(normalized, {
        name: (rawName ?? '').trim(),
        kcal: row.kcal,
        c: row.c,
        p: row.p,
        f: row.f,
        slot: row.slot,
        imageThumb: row.imageThumb,
        timestamp: row.timestamp,
        count: 1,
      });
      continue;
    }

    existing.count += 1;
    if (row.timestamp > existing.timestamp) {
      existing.name = (rawName ?? '').trim();
      existing.kcal = row.kcal;
      existing.c = row.c;
      existing.p = row.p;
      existing.f = row.f;
      existing.slot = row.slot;
      existing.imageThumb = row.imageThumb;
      existing.timestamp = row.timestamp;
    }
  }

  const ranked = Array.from(byName.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.timestamp.getTime() - a.timestamp.getTime();
  });

  return ranked.slice(0, 12).map((agg) => ({
    name: agg.name,
    kcal: agg.kcal,
    c: agg.c,
    p: agg.p,
    f: agg.f,
    slot: agg.slot,
    lastLoggedAt: agg.timestamp.toISOString(),
    imageThumb: agg.imageThumb,
  }));
}

// ─── IO orchestration ────────────────────────────────────────────────────────

/** Escapes ILIKE wildcard characters so user input is matched literally. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[%_\\]/g, '\\$&');
}

async function fetchHistoryRows(db: Database, userId: string, likePattern: string): Promise<HistoryRow[]> {
  return db
    .select({
      name: sql<string | null>`coalesce(${schema.events.payload}->>'name', ${schema.events.payload}->>'description')`,
      kcal: sql<number>`coalesce((${schema.events.payload}->>'kcal')::float8, 0)`,
      c: sql<number>`coalesce((${schema.events.payload}->>'c')::float8, 0)`,
      p: sql<number>`coalesce((${schema.events.payload}->>'p')::float8, 0)`,
      f: sql<number>`coalesce((${schema.events.payload}->>'f')::float8, 0)`,
      slot: sql<string | null>`${schema.events.payload}->>'slot'`,
      timestamp: schema.events.timestamp,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'meal_logged'),
        sql`coalesce(${schema.events.payload}->>'name', ${schema.events.payload}->>'description') ILIKE ${likePattern}`
      )
    )
    .orderBy(desc(schema.events.timestamp))
    .limit(50);
}

async function fetchCacheRows(db: Database, likePattern: string): Promise<ProviderCacheRow[]> {
  return db
    .select({
      provider: schema.food_cache.provider,
      provider_food_id: schema.food_cache.provider_food_id,
      name: schema.food_cache.name,
      brand: schema.food_cache.brand,
      serving_desc: schema.food_cache.serving_desc,
      serving_grams: schema.food_cache.serving_grams,
      kcal_100g: schema.food_cache.kcal_100g,
      protein_100g: schema.food_cache.protein_100g,
      carbs_100g: schema.food_cache.carbs_100g,
      fat_100g: schema.food_cache.fat_100g,
    })
    .from(schema.food_cache)
    .where(ilike(schema.food_cache.name, likePattern))
    .limit(10);
}

/** Best-effort upsert of freshly-fetched USDA rows into the shared cache.
 * Never throws — a failed upsert just means the next search re-fetches. */
async function upsertUsdaRows(db: Database, usdaRows: UsdaFood[]): Promise<void> {
  const values = usdaRows
    .filter((food) => food.per100g.kcal != null)
    .map((food) => ({
      provider: 'usda',
      provider_food_id: String(food.fdcId),
      barcode: food.barcode,
      name: food.name,
      brand: food.brand,
      serving_desc: food.servingDesc,
      serving_grams: food.servingGrams,
      kcal_100g: food.per100g.kcal,
      protein_100g: food.per100g.p,
      carbs_100g: food.per100g.c,
      fat_100g: food.per100g.f,
      fetched_at: new Date(),
    }));
  if (values.length === 0) return;

  try {
    await db
      .insert(schema.food_cache)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.food_cache.provider, schema.food_cache.provider_food_id],
        set: {
          barcode: sql`excluded.barcode`,
          name: sql`excluded.name`,
          brand: sql`excluded.brand`,
          serving_desc: sql`excluded.serving_desc`,
          serving_grams: sql`excluded.serving_grams`,
          kcal_100g: sql`excluded.kcal_100g`,
          protein_100g: sql`excluded.protein_100g`,
          carbs_100g: sql`excluded.carbs_100g`,
          fat_100g: sql`excluded.fat_100g`,
          fetched_at: sql`excluded.fetched_at`,
        },
      });
  } catch (err) {
    console.warn('food_cache upsert failed', err);
  }
}

export interface SearchCandidatesResult {
  candidates: Candidate[];
  estimateFoods: NutritionixResult['foods'] | null;
}

/** Merges history, cache/USDA provider candidates, and a free-text estimate
 * (when needed) into a single ranked list. History and provider fetches
 * both run under Promise.allSettled — a failed source contributes no
 * candidates rather than throwing. */
export async function searchCandidates(userId: string, query: string): Promise<SearchCandidatesResult> {
  const trimmed = query.trim();
  if (!trimmed) return { candidates: [], estimateFoods: null };

  const likePattern = `%${escapeLikePattern(trimmed)}%`;
  const db = await loadDb();

  const [historyResult, cacheResult, usdaResult] = await Promise.allSettled([
    fetchHistoryRows(db, userId, likePattern),
    fetchCacheRows(db, likePattern),
    searchFoods(trimmed),
  ]);

  const historyRows = historyResult.status === 'fulfilled' ? historyResult.value : [];
  const cacheRows = cacheResult.status === 'fulfilled' ? cacheResult.value : [];
  const usdaRows = usdaResult.status === 'fulfilled' ? usdaResult.value : [];

  if (usdaRows.length > 0) {
    await upsertUsdaRows(db, usdaRows);
  }

  const candidates = [...dedupHistory(historyRows, trimmed), ...mergeProviderCandidates(cacheRows, usdaRows)];

  let estimateFoods: NutritionixResult['foods'] | null = null;
  if (needsEstimate(trimmed, usdaRows.length)) {
    const estimate = await lookupNutrition(trimmed);
    if (estimate) {
      candidates.push({
        origin: 'estimate',
        name: trimmed,
        kcal: estimate.kcal,
        c: estimate.c,
        p: estimate.p,
        f: estimate.f,
      });
      estimateFoods = estimate.foods;
    }
  }

  return { candidates, estimateFoods };
}
