/**
 * POST /api/nutrition/search
 *
 * Body: { query: string }
 * Response: { name, kcal, c, p, f, items, candidates }
 *   — name/kcal/c/p/f mirror candidates[0] (the top-ranked match: the
 *     candidate's own name and totals, not the raw query); items is the
 *     CalorieNinjas free-text estimate breakdown when one was fetched
 *     (lib/nutrition/candidates' needsEstimate), else []; candidates is the
 *     full ranked list (user history, food_cache + USDA, estimate).
 *
 * Delegates to lib/nutrition/candidates searchCandidates, which merges the
 * user's own meal history (fastest re-log path), the shared food_cache +
 * USDA FoodData Central (branded/generic nutrition facts), and a
 * CalorieNinjas free-text estimate as a last resort into one ranked list.
 * searchCandidates never throws — a failed source just contributes no
 * candidates.
 *
 * Returns 400 on bad input, 401 if unauthenticated, 502 if no candidates
 * were found at all (mirrors the old CalorieNinjas-only 502).
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { searchCandidates } from '@/lib/nutrition/candidates';

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

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const query = b.query.trim();
  const { candidates, estimateFoods } = await searchCandidates(userId, query);

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: 'Nutrition lookup failed or no results found for that query.' },
      { status: 502 },
    );
  }

  const top = candidates[0];

  return NextResponse.json({
    name:  top.name,
    kcal:  top.kcal,
    c:     top.c,
    p:     top.p,
    f:     top.f,
    items: estimateFoods ?? [],
    candidates,
  });
}
