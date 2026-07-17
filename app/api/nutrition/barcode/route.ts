/**
 * POST /api/nutrition/barcode
 *
 * Body: { barcode: string, grams?: number }
 * Response (success): { name, brand, per100g, grams, kcal, c, p, f,
 *   servingGrams, servingDesc, source }
 *   — name/brand/per100g/grams/kcal/c/p/f are the legacy fields, unchanged
 *     in name/type/semantics (kcal/c/p/f = per100g × grams/100, rounded;
 *     grams defaults to 100 when omitted). servingGrams/servingDesc/source
 *     are additive. Null protein/carbs/fat from a source map to 0 in both
 *     per100g and the scaled fields (the legacy shape requires numbers);
 *     servingGrams/servingDesc stay null when the source doesn't know them.
 *
 * Lookup order, stopping at the first hit whose kcal is known (a hit with
 * unknown/null kcal is skipped in favor of the next source):
 *   1. food_cache by barcode, newest fetched_at first.
 *   2. Open Food Facts (lib/openFoodFacts lookupBarcode) — upserted into
 *      food_cache as provider 'off' (provider_food_id = barcode) on a hit.
 *   3. USDA FoodData Central (lib/nutrition/usda searchByGtin) — upserted
 *      into food_cache as provider 'usda' (provider_food_id = String(fdcId))
 *      on a hit.
 * food_cache is a shared, provider-only cache (no user scoping) — see
 * db/schema.ts.
 *
 * Returns 400 on bad input, 401 if unauthenticated, 404 with
 * { error, offerTextSearch: true } when no source has the product —
 * offerTextSearch signals the client to fall back to the search flow
 * instead of retrying the scan.
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { lookupBarcode } from '@/lib/openFoodFacts';
import { searchByGtin } from '@/lib/nutrition/usda';

export const dynamic = 'force-dynamic';

type Source = 'cache' | 'off' | 'usda';

interface ResolvedProduct {
  name: string;
  brand: string | null;
  per100g: { kcal: number; c: number; p: number; f: number };
  servingGrams: number | null;
  servingDesc: string | null;
  source: Source;
}

async function fromCache(barcode: string): Promise<ResolvedProduct | null> {
  const [row] = await db
    .select()
    .from(schema.food_cache)
    .where(and(eq(schema.food_cache.barcode, barcode), isNotNull(schema.food_cache.kcal_100g)))
    .orderBy(desc(schema.food_cache.fetched_at))
    .limit(1);

  if (!row || row.kcal_100g == null) return null;

  return {
    name: row.name,
    brand: row.brand,
    per100g: {
      kcal: row.kcal_100g,
      c: row.carbs_100g ?? 0,
      p: row.protein_100g ?? 0,
      f: row.fat_100g ?? 0,
    },
    servingGrams: row.serving_grams,
    servingDesc: row.serving_desc,
    source: 'cache',
  };
}

/** Best-effort upsert — never throws. A failed write just means the next
 * lookup re-fetches from the provider instead of hitting the cache. */
async function upsertCache(values: typeof schema.food_cache.$inferInsert): Promise<void> {
  try {
    await db
      .insert(schema.food_cache)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.food_cache.provider, schema.food_cache.provider_food_id],
        set: {
          barcode:       values.barcode,
          name:          values.name,
          brand:         values.brand,
          serving_desc:  values.serving_desc,
          serving_grams: values.serving_grams,
          kcal_100g:     values.kcal_100g,
          protein_100g:  values.protein_100g,
          carbs_100g:    values.carbs_100g,
          fat_100g:      values.fat_100g,
          fetched_at:    values.fetched_at,
        },
      });
  } catch (err) {
    console.warn('[nutrition/barcode] food_cache upsert failed', err);
  }
}

async function fromOff(barcode: string): Promise<ResolvedProduct | null> {
  const product = await lookupBarcode(barcode);
  if (!product) return null;

  await upsertCache({
    provider:         'off',
    provider_food_id: barcode,
    barcode,
    name:             product.productName,
    brand:            product.brand ?? null,
    serving_desc:     null,
    serving_grams:    null,
    kcal_100g:        product.per100g.kcal,
    protein_100g:     product.per100g.p,
    carbs_100g:       product.per100g.c,
    fat_100g:         product.per100g.f,
    fetched_at:       new Date(),
  });

  return {
    name: product.productName,
    brand: product.brand ?? null,
    per100g: product.per100g,
    servingGrams: null,
    servingDesc: null,
    source: 'off',
  };
}

async function fromUsda(barcode: string): Promise<ResolvedProduct | null> {
  const food = await searchByGtin(barcode);
  if (!food || food.per100g.kcal == null) return null;

  await upsertCache({
    provider:         'usda',
    provider_food_id: String(food.fdcId),
    barcode,
    name:             food.name,
    brand:            food.brand,
    serving_desc:     food.servingDesc,
    serving_grams:    food.servingGrams,
    kcal_100g:        food.per100g.kcal,
    protein_100g:     food.per100g.p,
    carbs_100g:       food.per100g.c,
    fat_100g:         food.per100g.f,
    fetched_at:       new Date(),
  });

  return {
    name: food.name,
    brand: food.brand,
    per100g: {
      kcal: food.per100g.kcal,
      c: food.per100g.c ?? 0,
      p: food.per100g.p ?? 0,
      f: food.per100g.f ?? 0,
    },
    servingGrams: food.servingGrams,
    servingDesc: food.servingDesc,
    source: 'usda',
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  if (typeof b?.barcode !== 'string' || !b.barcode.trim()) {
    return NextResponse.json(
      { error: '"barcode" is required and must be a non-empty string.' },
      { status: 400 },
    );
  }

  const grams =
    typeof b.grams === 'number' && Number.isFinite(b.grams) && b.grams > 0
      ? b.grams
      : 100;

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }
  void userId; // food_cache is a shared, provider-only cache — not user-scoped.

  const barcode = b.barcode.trim();

  let resolved: ResolvedProduct | null = null;
  try {
    resolved = await fromCache(barcode);
    if (!resolved) resolved = await fromOff(barcode);
    if (!resolved) resolved = await fromUsda(barcode);
  } catch (err) {
    console.error('[nutrition/barcode] lookup error:', err);
  }

  if (!resolved) {
    return NextResponse.json(
      { error: 'Product not found.', offerTextSearch: true },
      { status: 404 },
    );
  }

  const factor = grams / 100;

  return NextResponse.json({
    name:    resolved.name,
    brand:   resolved.brand,
    per100g: resolved.per100g,
    grams,
    kcal:    Math.round(resolved.per100g.kcal * factor),
    c:       Math.round(resolved.per100g.c    * factor),
    p:       Math.round(resolved.per100g.p    * factor),
    f:       Math.round(resolved.per100g.f    * factor),
    servingGrams: resolved.servingGrams,
    servingDesc:  resolved.servingDesc,
    source: resolved.source,
  });
}
