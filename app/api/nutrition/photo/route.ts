/**
 * POST /api/nutrition/photo
 *
 * Body: { imageBase64: string }   — raw base64 (or data-URL; prefix is stripped)
 * Response: { name, kcal, c, p, f, items[] }
 *
 * Two-step approach:
 *   1. claude-haiku-4-5 classifies the image and extracts a food query with
 *      realistic portion estimates.
 *   2. CalorieNinjas lookup via lookupNutrition — fast, deterministic numbers.
 *   3. Fallback: claude-haiku-4-5 direct macro estimate when the DB has no match.
 *
 * Returns 400 on bad input, 502 on upstream failure.
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { lookupNutrition } from '@/lib/nutritionix';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── Classification step ──────────────────────────────────────────────────────

async function classifyMealPhoto(b64: string): Promise<{
  query: string;
  items: string[];
} | null> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
        },
        {
          type: 'text',
          text: `Classify this image. Respond with JSON only, no markdown.

If it shows food or a meal: {"type":"meal_photo","query":"<natural language list, e.g. '6oz grilled chicken breast, 1 cup brown rice, 1 cup steamed broccoli'>","items":["<item 1>","<item 2>"]}
Otherwise: {"type":"other"}

For meal_photo: estimate realistic portion sizes. query must be comma-separated items with quantities and cooking method.`,
        },
      ],
    }],
  });

  try {
    const raw = (msg.content[0] as { text: string }).text;
    const parsed = JSON.parse(raw.replace(/```json\n?|```/g, '').trim()) as {
      type: string;
      query?: string;
      items?: string[];
    };
    if (parsed.type === 'meal_photo' && parsed.query) {
      return { query: parsed.query, items: parsed.items ?? [] };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Direct Claude vision macro estimate (fallback) ────────────────────────────

async function estimateDirectly(b64: string): Promise<{
  name: string; kcal: number; c: number; p: number; f: number;
  items: Array<{ name: string; qty: number; unit: string; kcal: number }>;
}> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
        },
        {
          type: 'text',
          text: `You are a nutrition expert. Estimate the macros for this meal photo.
Respond with JSON only, no markdown:
{"name":"<meal description>","kcal":N,"c":N,"p":N,"f":N,"items":[{"name":"<item>","qty":N,"unit":"g","kcal":N}]}
All numeric values must be integers. Base estimates on visible portion sizes.`,
        },
      ],
    }],
  });

  const raw = (msg.content[0] as { text: string }).text;
  try {
    return JSON.parse(raw.replace(/```json\n?|```/g, '').trim()) as {
      name: string; kcal: number; c: number; p: number; f: number;
      items: Array<{ name: string; qty: number; unit: string; kcal: number }>;
    };
  } catch {
    throw new UnrecognizedImageError();
  }
}

class UnrecognizedImageError extends Error {}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
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
    // Step 1: classify and extract food query
    const classification = await classifyMealPhoto(b64);

    if (classification) {
      // Step 2: try CalorieNinjas lookup for deterministic numbers
      const nutrition = await lookupNutrition(classification.query);
      if (nutrition) {
        return NextResponse.json({
          name:  classification.query,
          kcal:  nutrition.kcal,
          c:     nutrition.c,
          p:     nutrition.p,
          f:     nutrition.f,
          items: nutrition.foods,
        });
      }
    }

    // Step 3: fallback — direct Claude vision macro estimate
    const estimate = await estimateDirectly(b64);
    return NextResponse.json(estimate);
  } catch (err) {
    if (err instanceof UnrecognizedImageError) {
      return NextResponse.json(
        { error: 'Could not identify food in this photo. Try a clearer shot or log it manually.' },
        { status: 422 },
      );
    }
    console.error('[nutrition/photo] Error:', err);
    return NextResponse.json(
      { error: 'Failed to analyze image.' },
      { status: 502 },
    );
  }
}
