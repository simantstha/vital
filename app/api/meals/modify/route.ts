/**
 * POST /api/meals/modify
 *
 * Body: { name: string, kcal: number, instruction?: string }
 * Response: { name: string, kcal: number, c: number, p: number, f: number, why: string }
 *
 * Powers the Today meal-detail modal. Two modes, one code path:
 *   • No / empty `instruction` → estimate macros for the meal AS-IS. The given
 *     `kcal` is preserved and split into protein/carbs/fat. This is the
 *     auto-estimate-on-open path (planned meals carry kcal but no macros).
 *   • Non-empty `instruction` → apply the natural-language edit ("replace egg
 *     with tofu", "make it lighter") and return the new name + re-estimated
 *     kcal + macros.
 *
 * One claude-haiku-4-5 call. All numbers are clamped/validated before return.
 * Returns 400 on bad shape, 502 on upstream/parse failure.
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Input validation ──────────────────────────────────────────────────────────

interface ModifyBody {
  name:        string;
  kcal:        number;
  instruction?: string;
}

function isValidBody(b: unknown): b is ModifyBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.name === 'string' && o.name.trim().length > 0 &&
    typeof o.kcal === 'number' && Number.isFinite(o.kcal) && o.kcal >= 0 &&
    (o.instruction === undefined || typeof o.instruction === 'string')
  );
}

// ── Output parsing / clamping ──────────────────────────────────────────────────

/** A non-negative, finite, rounded number — or `fallback` if the input is junk. */
function clampNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback;
}

/** Extracts the first JSON object from a model reply that may be fenced or prose-wrapped. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
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
      { error: 'Body must include { name: string, kcal: number, instruction?: string }.' },
      { status: 400 },
    );
  }

  const { name, kcal } = body;
  const instruction = body.instruction?.trim() ?? '';

  // Auth — fail closed.
  try {
    getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // ── Build the task prompt (as-is estimate vs. applied edit) ──────────────────
  const task = instruction
    ? `The user wants to modify this planned meal.\n` +
      `Current meal: "${name}" (~${kcal} kcal).\n` +
      `Requested change: "${instruction}".\n` +
      `Apply the change and return the updated meal: a new name, re-estimated total ` +
      `kcal, and macro grams (carbs, protein, fat).`
    : `Estimate the macronutrient breakdown for this meal.\n` +
      `Meal: "${name}" (~${kcal} kcal).\n` +
      `Keep the total kcal at ${kcal}; split it into realistic macro grams ` +
      `(carbs, protein, fat) whose calories (4/4/9 per gram) sum to roughly ${kcal}.`;

  let raw: string;
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 300,
      system:
        `You are a nutrition estimator. Given a meal, return your best estimate as ` +
        `STRICT JSON only — no prose, no markdown fences. Shape:\n` +
        `{ "name": string, "kcal": number, "c": number, "p": number, "f": number, "why": string }\n` +
        `where c/p/f are grams of carbs/protein/fat, and "why" is a single short ` +
        `sentence (≤ 15 words) on the macro profile. Never include units in the numbers.`,
      messages: [{ role: 'user', content: task }],
    });
    raw = (msg.content[0] as { text: string }).text;
  } catch (err) {
    console.error('[meals/modify] Anthropic error:', err);
    return NextResponse.json({ error: 'Meal estimate failed upstream.' }, { status: 502 });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    console.error('[meals/modify] Could not parse model JSON:', raw);
    return NextResponse.json({ error: 'Could not parse meal estimate.' }, { status: 502 });
  }

  // For the as-is path, keep the caller's kcal authoritative; for an edit, trust
  // the model's re-estimate (falling back to the original kcal if it's junk).
  const outKcal = instruction ? clampNum(parsed.kcal, Math.round(kcal)) : Math.round(kcal);
  const outName = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim()
    : name;
  const why = typeof parsed.why === 'string' ? parsed.why.trim() : '';

  return NextResponse.json({
    name: outName,
    kcal: outKcal,
    c:    clampNum(parsed.c),
    p:    clampNum(parsed.p),
    f:    clampNum(parsed.f),
    why,
  });
}
