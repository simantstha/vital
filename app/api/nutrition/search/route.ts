/**
 * POST /api/nutrition/search
 *
 * Body: { query: string }
 * Response: { name, kcal, c, p, f, items[] }
 *
 * Delegates to CalorieNinjas via lib/nutritionix lookupNutrition.
 * Returns 400 on bad input, 502 if the upstream lookup produces no results.
 */

import { NextResponse } from 'next/server';
import { lookupNutrition } from '@/lib/nutritionix';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  if (typeof b?.query !== 'string' || !b.query.trim()) {
    return NextResponse.json(
      { error: '"query" is required and must be a non-empty string.' },
      { status: 400 },
    );
  }

  const query = b.query.trim();
  const result = await lookupNutrition(query);

  if (!result) {
    return NextResponse.json(
      { error: 'Nutrition lookup failed or no results found for that query.' },
      { status: 502 },
    );
  }

  return NextResponse.json({
    name:  query,
    kcal:  result.kcal,
    c:     result.c,
    p:     result.p,
    f:     result.f,
    items: result.foods,
  });
}
