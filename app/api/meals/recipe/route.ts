/**
 * POST /api/meals/recipe
 *
 * Body: { name: string, servings?: number }
 * Response: { recipe: string }   — markdown (ingredients list + numbered steps)
 *
 * Powers the "How to make it" button in the Today meal-detail modal. The
 * markdown is rendered on-device by MarkdownText, so keep it to plain bullet
 * (`- `) and numbered (`1. `) lists plus short section labels — no tables,
 * headings, or links (MarkdownText strips links anyway).
 *
 * One claude-haiku-4-5 call. Returns 400 on bad shape, 502 on upstream failure.
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Input validation ──────────────────────────────────────────────────────────

interface RecipeBody {
  name:      string;
  servings?: number;
}

function isValidBody(b: unknown): b is RecipeBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.name === 'string' && o.name.trim().length > 0 &&
    (o.servings === undefined ||
      (typeof o.servings === 'number' && Number.isFinite(o.servings) && o.servings > 0))
  );
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json(
      { error: 'Body must include { name: string, servings?: number }.' },
      { status: 400 },
    );
  }

  const name = body.name.trim();
  const servings = body.servings && body.servings > 0 ? Math.round(body.servings) : 1;

  // Auth — fail closed.
  try {
    getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let recipe: string;
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 600,
      system:
        `You are a concise home-cooking assistant. Given a dish, return a short, ` +
        `practical recipe as MARKDOWN using ONLY:\n` +
        `- a "Ingredients" label followed by "- " bullet lines\n` +
        `- a "Steps" label followed by "1. " numbered lines\n` +
        `No headings (#), tables, links, or preamble. Keep it to real quantities ` +
        `and 4–7 steps. Do not add commentary before or after the recipe.`,
      messages: [{
        role: 'user',
        content: `Give me a recipe for "${name}" for ${servings} serving${servings === 1 ? '' : 's'}.`,
      }],
    });
    recipe = (msg.content[0] as { text: string }).text.trim();
  } catch (err) {
    console.error('[meals/recipe] Anthropic error:', err);
    return NextResponse.json({ error: 'Recipe generation failed upstream.' }, { status: 502 });
  }

  if (!recipe) {
    return NextResponse.json({ error: 'Empty recipe from model.' }, { status: 502 });
  }

  return NextResponse.json({ recipe });
}
