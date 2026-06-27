/**
 * POST /api/nutrition/barcode
 *
 * Body: { barcode: string, grams?: number }
 * Response: { name, brand, per100g, grams, kcal, c, p, f }
 *
 * Delegates to Open Food Facts via lib/openFoodFacts lookupBarcode.
 * Macros are scaled by grams/100; defaults to 100g when grams is omitted.
 * Returns 400 on bad input, 502 if the product is not found.
 */

import { NextResponse } from 'next/server';
import { lookupBarcode } from '@/lib/openFoodFacts';

export const dynamic = 'force-dynamic';

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

  const product = await lookupBarcode(b.barcode.trim());

  if (!product) {
    return NextResponse.json(
      { error: 'Product not found in Open Food Facts database.' },
      { status: 502 },
    );
  }

  const factor = grams / 100;

  return NextResponse.json({
    name:    product.productName,
    brand:   product.brand ?? null,
    per100g: product.per100g,
    grams,
    kcal:    Math.round(product.per100g.kcal * factor),
    c:       Math.round(product.per100g.c    * factor),
    p:       Math.round(product.per100g.p    * factor),
    f:       Math.round(product.per100g.f    * factor),
  });
}
