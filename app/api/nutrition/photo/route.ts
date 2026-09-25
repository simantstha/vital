/**
 * POST /api/nutrition/photo
 *
 * Body: { imageBase64: string }   — raw base64 (or data-URL; prefix is stripped)
 * Response: { name, kcal, c, p, f, items[] }
 *   items[]: { name, qty, unit, kcal } — same shape the pre-v2 CalorieNinjas
 *   path returned (qty is now grams, unit is always "g"), so the iOS decoder
 *   (NutritionResult) needs no changes; see it in
 *   ios/Vital/Sources/Core/APIClient.swift.
 *
 * v2 (lib/nutrition/estimator.ts): ONE claude-sonnet-5 vision call reasons
 * directly about realistic per-item portions (plate/bowl/utensil size,
 * cooked-vs-raw, visible oil) instead of writing a free-text query that got
 * thrown away and re-guessed by a second, cruder text parser — see
 * estimator.ts's header comment for the full rationale (this is the fix for
 * "meal logging is way off"). Each item is then grounded against real
 * per-100g nutrition data (this user's own history, then food_cache/USDA)
 * before the model's own macro guess is used.
 *
 * This route only ESTIMATES — like before, it does not write a `meal_logged`
 * event itself. LogMealViewModel shows the result for the user to review/
 * edit, then saves it via POST /api/meals/log (flat macros only, no item
 * breakdown), same as the barcode/search paths. Only the text-log path
 * (lib/nutrition/quickLog.ts's insertGroundedMeal) currently persists the
 * per-item `estimatorItems` breakdown that seeds future history grounding —
 * see the Risks section of this feature's PR description for that gap.
 *
 * Returns 400 on bad input, 401 on missing/invalid auth, 422 when the model
 * finds no food in the photo, 502 on upstream failure.
 */

import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { getUserIdFromRequest } from '@/lib/auth';
import { estimateMeal } from '@/lib/nutrition/estimator';

export const dynamic = 'force-dynamic';

// ── normalize to a vision-API-safe JPEG ────────────────────────────────────────
// Modern phone cameras (e.g. 48MP sensors) can exceed Claude's 8000px-per-side
// limit. Resize to fit Anthropic's ~1568px recommended long edge — well under
// the hard cap and avoids paying for tokens on detail the model downsamples anyway.

async function normalizeImage(b64: string): Promise<string> {
  const buf = Buffer.from(b64, 'base64');
  const resized = await sharp(buf)
    .rotate() // apply EXIF orientation before stripping it
    .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return resized.toString('base64');
}

// ── Route handler ─────────────────────────────────────────────────────────────

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

  const b = body as Record<string, unknown>;
  if (typeof b?.imageBase64 !== 'string' || !b.imageBase64.trim()) {
    return NextResponse.json(
      { error: '"imageBase64" is required and must be a non-empty string.' },
      { status: 400 },
    );
  }

  // Strip data-URL prefix if present (e.g. "data:image/jpeg;base64,")
  const raw = b.imageBase64.trim();
  const rawB64 = raw.includes(',') ? raw.split(',')[1] : raw;

  let b64: string;
  try {
    b64 = await normalizeImage(rawB64);
  } catch (err) {
    console.error('[nutrition/photo] Invalid image:', err);
    return NextResponse.json(
      { error: 'Could not read image data — unsupported or corrupted format.' },
      { status: 400 },
    );
  }

  try {
    const estimate = await estimateMeal({ imageB64: b64, userId });

    if (estimate.items.length === 0) {
      return NextResponse.json(
        { error: 'Could not identify food in this photo. Try a clearer shot or log it manually.' },
        { status: 422 },
      );
    }

    return NextResponse.json({
      name:  estimate.name,
      kcal:  estimate.kcal,
      c:     estimate.c,
      p:     estimate.p,
      f:     estimate.f,
      items: estimate.items.map((it) => ({ name: it.food, qty: it.grams, unit: 'g', kcal: it.kcal })),
      // Additive — not decoded by the current iOS NutritionResult, but kept
      // for a future client and for anything that wants the full grounded
      // breakdown without a second round trip.
      estimatorItems: estimate.items,
    });
  } catch (err) {
    console.error('[nutrition/photo] Error:', err);
    return NextResponse.json(
      { error: 'Failed to analyze image.' },
      { status: 502 },
    );
  }
}
