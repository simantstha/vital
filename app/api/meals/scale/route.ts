/**
 * POST /api/meals/scale
 *
 * Body: { id: string, factor?: number } | { id: string, grams?: number }
 *   — exactly one of `factor` or `grams`:
 *     - factor: multiplies the logged meal's kcal/c/p/f (and, when present,
 *       each item's grams/macros — see estimatorItems below) by `factor`.
 *       This is what the iOS portion chips (½× · 1× · 1.5× · 2×) call.
 *     - grams: sets the meal's TOTAL grams to this value instead of a
 *       multiplier — only possible for a meal that already carries a gram
 *       baseline (`payload.totalGrams`, written by
 *       lib/nutrition/quickLog.ts's insertGroundedMeal / the coach's
 *       estimator-routed log_meal calls). A flat/legacy log with no gram
 *       baseline returns 422 for this mode; use `factor` instead.
 * Response 200: { ok: true, id, name, kcal, c, p, f }
 * Response 400: bad shape (missing id, neither/both of factor+grams, an
 *   out-of-range factor, or a non-positive grams).
 * Response 401: no/invalid auth.
 * Response 404: no matching `meal_logged` row for this user.
 * Response 422: `grams` requested on a meal with no gram baseline.
 *
 * This is the "portion memory" write side (see
 * lib/nutrition/portionMemory.ts): whenever the scaled meal carries a
 * per-item breakdown (`payload.estimatorItems`), each item's NEW grams is
 * recorded as this user's typical portion for that food — best-effort, never
 * fails the request — so a repeated correction (e.g. always tapping 1.5× on
 * "white rice, cooked") teaches lib/nutrition/estimator.ts's step-1 parse
 * over time instead of repeating the same under-estimate forever. A flat log
 * with no item breakdown scales its totals but has no per-food portion to
 * remember.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { and, eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { recordPortionCorrection } from '@/lib/nutrition/portionMemory';

export const dynamic = 'force-dynamic';

const MIN_FACTOR = 0.1;
const MAX_FACTOR = 5;

interface ScaleBody {
  id: string;
  factor?: number;
  grams?: number;
}

function isValidBody(b: unknown): b is ScaleBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return false;
  const hasFactor = o.factor !== undefined;
  const hasGrams = o.grams !== undefined;
  if (hasFactor === hasGrams) return false; // exactly one of the two
  if (hasFactor && !(typeof o.factor === 'number' && Number.isFinite(o.factor))) return false;
  if (hasGrams && !(typeof o.grams === 'number' && Number.isFinite(o.grams))) return false;
  return true;
}

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

interface EstimatorItemRow {
  food: string;
  grams: number;
  kcal: number;
  c: number;
  p: number;
  f: number;
  source: string;
  confidence: string;
  portionNote: string;
}

function readEstimatorItems(payload: Record<string, unknown>): EstimatorItemRow[] | null {
  const raw = payload.estimatorItems;
  if (!Array.isArray(raw)) return null;
  const out: EstimatorItemRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.food !== 'string' || !Number.isFinite(Number(e.grams))) continue;
    out.push({
      food: e.food,
      grams: num(e.grams),
      kcal: num(e.kcal),
      c: num(e.c),
      p: num(e.p),
      f: num(e.f),
      source: typeof e.source === 'string' ? e.source : 'model',
      confidence: typeof e.confidence === 'string' ? e.confidence : 'low',
      portionNote: typeof e.portionNote === 'string' ? e.portionNote : '',
    });
  }
  return out;
}

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json(
      { error: 'Body must include { id: string } and exactly one of { factor: number } or { grams: number }.' },
      { status: 400 },
    );
  }

  if (body.factor !== undefined && (body.factor < MIN_FACTOR || body.factor > MAX_FACTOR)) {
    return NextResponse.json({ error: `factor must be between ${MIN_FACTOR} and ${MAX_FACTOR}.` }, { status: 400 });
  }
  if (body.grams !== undefined && body.grams <= 0) {
    return NextResponse.json({ error: 'grams must be a positive number.' }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.id, body.id), eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged')))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: 'Meal log not found.' }, { status: 404 });
  }

  const payload = pl(row.payload);
  const items = readEstimatorItems(payload);
  const oldTotalGrams = typeof payload.totalGrams === 'number' ? payload.totalGrams : null;

  let factor: number;
  if (body.factor !== undefined) {
    factor = body.factor;
  } else {
    if (!oldTotalGrams || oldTotalGrams <= 0) {
      return NextResponse.json(
        { error: 'This meal has no gram baseline to scale from — use { factor } instead.' },
        { status: 422 },
      );
    }
    factor = body.grams! / oldTotalGrams;
  }

  const newKcal = Math.round(num(payload.kcal) * factor);
  const newC    = Math.round(num(payload.c) * factor);
  const newP    = Math.round(num(payload.p) * factor);
  const newF    = Math.round(num(payload.f) * factor);

  const newPayload: Record<string, unknown> = { ...payload, kcal: newKcal, c: newC, p: newP, f: newF };

  if (items && items.length > 0) {
    const scaledItems = items.map((it) => ({
      ...it,
      grams: Math.round(it.grams * factor),
      kcal:  Math.round(it.kcal * factor),
      c:     Math.round(it.c * factor),
      p:     Math.round(it.p * factor),
      f:     Math.round(it.f * factor),
    }));
    newPayload.estimatorItems = scaledItems;
    newPayload.totalGrams = scaledItems.reduce((sum, it) => sum + it.grams, 0);
    newPayload.items = scaledItems.map((it) => `${it.grams}g ${it.food}`).join(', ');

    // Portion memory — best-effort, never fails the request. Each item's
    // NEW grams becomes this user's remembered typical portion for that
    // food (see lib/nutrition/portionMemory.ts's header comment).
    await Promise.allSettled(
      scaledItems.map((it) => recordPortionCorrection(userId, it.food, it.grams)),
    );
  } else if (oldTotalGrams) {
    newPayload.totalGrams = Math.round(oldTotalGrams * factor);
  }

  const [updated] = await db
    .update(schema.events)
    .set({ payload: newPayload })
    .where(and(eq(schema.events.id, body.id), eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged')))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: 'Meal log not found.' }, { status: 404 });
  }

  const name = typeof payload.name === 'string' && payload.name
    ? payload.name
    : (typeof payload.description === 'string' ? payload.description : '');

  return NextResponse.json({ ok: true, id: body.id, name, kcal: newKcal, c: newC, p: newP, f: newF });
}
