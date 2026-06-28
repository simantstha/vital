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
import { lookupNutrition } from '@/lib/nutritionix';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── mime-type detection from base64 header bytes ──────────────────────────────

function detectMimeType(b64: string): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('UklGR'))        return 'image/webp';
  if (b64.startsWith('R0lGOD'))       return 'image/gif';
  return 'image/jpeg'; // default — covers most mobile photos
}

// ── Classification step ──────────────────────────────────────────────────────

async function classifyMealPhoto(b64: string, mimeType: ReturnType<typeof detectMimeType>): Promise<{
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
          source: { type: 'base64', media_type: mimeType, data: b64 },
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

async function estimateDirectly(b64: string, mimeType: ReturnType<typeof detectMimeType>): Promise<{
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
          source: { type: 'base64', media_type: mimeType, data: b64 },
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
  return JSON.parse(raw.replace(/```json\n?|```/g, '').trim()) as {
    name: string; kcal: number; c: number; p: number; f: number;
    items: Array<{ name: string; qty: number; unit: string; kcal: number }>;
  };
}

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
  const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
  const mimeType = detectMimeType(b64);

  try {
    // Step 1: classify and extract food query
    const classification = await classifyMealPhoto(b64, mimeType);

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
    const estimate = await estimateDirectly(b64, mimeType);
    return NextResponse.json(estimate);
  } catch (err) {
    console.error('[nutrition/photo] Error:', err);
    return NextResponse.json(
      { error: 'Failed to analyze image.' },
      { status: 502 },
    );
  }
}
