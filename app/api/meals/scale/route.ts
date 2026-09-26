/**
 * POST /api/meals/scale
 *
 * Body: { id: string, factor?: number } | { id: string, grams?: number }
 *   | { id: string, itemFood: string, grams: number }
 *   — exactly one of `factor` or `grams` for the whole-meal modes, OR
 *   `itemFood` + `grams` for the per-item mode:
 *     - factor: multiplies the logged meal's kcal/c/p/f (and, when present,
 *       each item's grams/macros — see estimatorItems below) by `factor`.
 *       This is what the iOS portion chips (½× · 1× · 1.5× · 2×) call.
 *     - grams (no itemFood): sets the meal's TOTAL grams to this value
 *       instead of a multiplier — only possible for a meal that already
 *       carries a gram baseline (`payload.totalGrams`, written by
 *       lib/nutrition/quickLog.ts's insertGroundedMeal / the coach's
 *       estimator-routed log_meal calls). A flat/legacy log with no gram
 *       baseline returns 422 for this mode; use `factor` instead.
 *     - itemFood + grams: sets ONE item's grams to this value, scaling that
 *       item's own macros proportionally and folding the delta into the
 *       meal's totals — the rest of the meal is untouched. Only valid on a
 *       meal that carries `payload.estimatorItems`; the item is matched by
 *       exact `food` string. This is the per-item receipt-row stepper on
 *       iOS's `LogReceiptCard`.
 * Response 200: { ok: true, id, name, kcal, c, p, f, item? }
 *   `item` (per-item mode only) is the one item's new
 *   { food, grams, kcal, c, p, f }.
 * Response 400: bad shape (missing id, neither/both of factor+grams, an
 *   out-of-range factor, a non-positive grams, or itemFood combined with
 *   factor).
 * Response 401: no/invalid auth.
 * Response 404: no matching `meal_logged` row for this user, or (per-item
 *   mode) no item matching `itemFood`.
 * Response 422: `grams` requested on a meal with no gram baseline, or
 *   `itemFood` requested on a meal with no item breakdown.
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
  itemFood?: string;
}

function isValidBody(b: unknown): b is ScaleBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return false;
  const hasFactor = o.factor !== undefined;
  const hasGrams = o.grams !== undefined;
  const hasItemFood = o.itemFood !== undefined;

  if (hasItemFood) {
    // Per-item mode: itemFood + grams only, never combined with factor.
    if (typeof o.itemFood !== 'string' || !o.itemFood.trim()) return false;
    if (hasFactor) return false;
    if (!hasGrams || !(typeof o.grams === 'number' && Number.isFinite(o.grams))) return false;
    return true;
  }

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

  // ── Per-item mode ─────────────────────────────────────────────────────────
  // Rescales ONE item to `body.grams`, folding the delta into the meal's
  // totals — the rest of the meal (and its items) is untouched. The
  // portion-memory write below applies ONLY to this item's food.
  if (body.itemFood !== undefined) {
    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: 'This meal has no per-item breakdown to scale.' },
        { status: 422 },
      );
    }
    const idx = items.findIndex((it) => it.food === body.itemFood);
    if (idx === -1) {
      return NextResponse.json({ error: `No item "${body.itemFood}" on this meal.` }, { status: 404 });
    }

    const oldItem = items[idx];
    if (!(oldItem.grams > 0)) {
      return NextResponse.json({ error: 'This item has no gram baseline to scale from.' }, { status: 422 });
    }
    const itemFactor = body.grams! / oldItem.grams;

    const newItem = {
      ...oldItem,
      grams: Math.round(oldItem.grams * itemFactor),
      kcal:  Math.round(oldItem.kcal * itemFactor),
      c:     Math.round(oldItem.c * itemFactor),
      p:     Math.round(oldItem.p * itemFactor),
      f:     Math.round(oldItem.f * itemFactor),
    };

    const newItems = items.slice();
    newItems[idx] = newItem;

    const newTotalKcal = Math.round(num(payload.kcal) - oldItem.kcal + newItem.kcal);
    const newTotalC    = Math.round(num(payload.c)    - oldItem.c    + newItem.c);
    const newTotalP    = Math.round(num(payload.p)    - oldItem.p    + newItem.p);
    const newTotalF    = Math.round(num(payload.f)    - oldItem.f    + newItem.f);
    const newTotalGrams = (oldTotalGrams ?? items.reduce((s, it) => s + it.grams, 0)) - oldItem.grams + newItem.grams;

    const itemPayload: Record<string, unknown> = {
      ...payload,
      kcal: newTotalKcal,
      c: newTotalC,
      p: newTotalP,
      f: newTotalF,
      estimatorItems: newItems,
      totalGrams: newTotalGrams,
      items: newItems.map((it) => `${it.grams}g ${it.food}`).join(', '),
    };

    // Best-effort, never fails the request — see this route's doc comment.
    // Only THIS food's portion is recorded, unlike the whole-meal factor
    // path below which records every item.
    await recordPortionCorrection(userId, newItem.food, newItem.grams).catch(() => {});

    const [updatedItemRow] = await db
      .update(schema.events)
      .set({ payload: itemPayload })
      .where(and(eq(schema.events.id, body.id), eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged')))
      .returning();

    if (!updatedItemRow) {
      return NextResponse.json({ error: 'Meal log not found.' }, { status: 404 });
    }

    const itemMealName = typeof payload.name === 'string' && payload.name
      ? payload.name
      : (typeof payload.description === 'string' ? payload.description : '');

    return NextResponse.json({
      ok: true,
      id: body.id,
      name: itemMealName,
      kcal: newTotalKcal,
      c: newTotalC,
      p: newTotalP,
      f: newTotalF,
      item: { food: newItem.food, grams: newItem.grams, kcal: newItem.kcal, c: newItem.c, p: newItem.p, f: newItem.f },
    });
  }

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
