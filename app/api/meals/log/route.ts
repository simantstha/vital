/**
 * POST /api/meals/log
 *
 * Body: { name: string, kcal: number, c: number, p: number, f: number, source: string,
 *         imageThumb?: string }   — imageThumb: optional small base64 JPEG (no data-URL prefix)
 * Response: { ok: true, eventId: string, coachReaction: string }
 *
 * 1. Resolves the authenticated user (getUserIdFromRequest).
 * 2. Inserts a `meal_logged` event into the append-only events ledger.
 * 3. Assembles today's context via lib/brain/context.assembleContext.
 * 4. Makes ONE claude-haiku-4-5 call to produce a 1-2 sentence coach reaction
 *    in observation-not-prescription voice.
 *
 * Returns 400 on bad shape, 502 on upstream failure.
 * Coach reaction errors are non-fatal — eventId is still returned with an
 * empty coachReaction string so the mobile client can always proceed.
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { assembleContext } from '@/lib/brain/context';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Input validation ──────────────────────────────────────────────────────────

interface LogMealBody {
  name:   string;
  kcal:   number;
  c:      number;
  p:      number;
  f:      number;
  source: string;
  imageThumb?: string;
}

function isValidBody(b: unknown): b is LogMealBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.name   === 'string'  && o.name.trim().length > 0 &&
    typeof o.kcal   === 'number'  && Number.isFinite(o.kcal) &&
    typeof o.c      === 'number'  && Number.isFinite(o.c) &&
    typeof o.p      === 'number'  && Number.isFinite(o.p) &&
    typeof o.f      === 'number'  && Number.isFinite(o.f) &&
    typeof o.source === 'string'  && o.source.trim().length > 0 &&
    (o.imageThumb === undefined || typeof o.imageThumb === 'string')
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
      {
        error:
          'Body must include { name: string, kcal: number, c: number, ' +
          'p: number, f: number, source: string }.',
      },
      { status: 400 },
    );
  }

  const { name, kcal, c, p, f, source, imageThumb } = body;

  // ── 1. Resolve user ────────────────────────────────────────────────────────

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // ── 2. Insert meal_logged event ────────────────────────────────────────────

  let eventId: string;
  try {
    const [row] = await db
      .insert(schema.events)
      .values({
        user_id:   userId,
        timestamp: new Date(),
        type:      'meal_logged',
        payload:   { name, kcal, c, p, f, source, ...(imageThumb ? { imageThumb } : {}) },
        source,
      })
      .returning({ id: schema.events.id });
    eventId = row.id;
  } catch (err) {
    console.error('[meals/log] DB insert error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }

  // ── 3. Assemble context + produce coach reaction ───────────────────────────
  // Non-fatal: a Claude or context error still returns ok + eventId.

  let coachReaction = '';
  try {
    const ctx = await assembleContext(userId);

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 120,
      system: `You are Vital Coach — a calm, data-aware personal health companion.
Speak in first-person observation voice ("That puts you at…", "Nice — you're tracking…").
Never prescribe or advise. Respond in 1–2 short sentences only. No emojis. No markdown.`,
      messages: [{
        role: 'user',
        content:
          `${ctx.promptText}\n\n---\n\n` +
          `User just logged: ${name} — ${kcal} kcal, ${c}g carbs, ${p}g protein, ${f}g fat.\n` +
          `Give a brief observation about this meal in the context of their day.`,
      }],
    });

    coachReaction = (msg.content[0] as { text: string }).text.trim();
  } catch (err) {
    console.error('[meals/log] Coach reaction error (non-fatal):', err);
  }

  return NextResponse.json({ ok: true, eventId, coachReaction });
}
