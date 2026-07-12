/**
 * POST   /api/meals/log        — log a meal into the events ledger.
 * GET    /api/meals/log?tz=    — today's logged meals (for the Phase 3 diet sheet).
 * DELETE /api/meals/log?id=    — remove a mis-logged meal (user-initiated correction).
 *
 * POST
 * Body: { name: string, kcal: number, c: number, p: number, f: number, source: string,
 *         imageThumb?: string, slot?: 'breakfast'|'lunch'|'snacks'|'dinner' }
 *   — imageThumb: optional small base64 JPEG (no data-URL prefix)
 *   — slot: optional meal-slot tag (redesign-v3 diet sheet); omitted by older
 *     call sites (LogMealViewModel's photo/barcode/search flows), stored inside
 *     `payload` alongside the macros when present.
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
 *
 * GET
 * Decision (redesign-v3 Phase 3): reuse this route rather than extending
 * `/api/logs` (which returns generic formatted title/subtitle strings across
 * all event types over a rolling N-day window, not raw per-slot macros for
 * "today" specifically) or adding a new file — this endpoint already owns
 * `meal_logged` writes, so it owns today's read of them too. Local-day
 * resolution mirrors `app/api/plan/route.ts`'s `resolveDayKey` /
 * `app/api/today`'s `todayEvents` filter.
 * Response: { items: [{ id, name, kcal, protein, carbs, fat, slot, loggedAt }] }
 * (ascending by loggedAt)
 *
 * DELETE
 * ?id= is the eventId POST returned. Hard-deletes the row. This is a
 * deliberate narrow exception to the "events is an append-only ledger,
 * nothing is ever deleted" rule in db/schema.ts: it exists solely so a user
 * can correct a mis-logged meal, is scoped to that user's own `meal_logged`
 * rows only, and isn't a general-purpose delete capability.
 * 404 if no row matched, else 200 { ok: true }.
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { assembleContext } from '@/lib/brain/context';
import { localDayKey, pickTimeZone } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_SLOTS = ['breakfast', 'lunch', 'snacks', 'dinner'];

// ── Input validation ──────────────────────────────────────────────────────────

interface LogMealBody {
  name:   string;
  kcal:   number;
  c:      number;
  p:      number;
  f:      number;
  source: string;
  imageThumb?: string;
  slot?: string;
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
    (o.imageThumb === undefined || typeof o.imageThumb === 'string') &&
    (o.slot === undefined || typeof o.slot === 'string')
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ── POST ─────────────────────────────────────────────────────────────────────

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

  const { name, kcal, c, p, f, source, imageThumb, slot } = body;

  if (slot !== undefined && !VALID_SLOTS.includes(slot)) {
    return NextResponse.json(
      { error: `slot must be one of ${VALID_SLOTS.join(', ')}.` },
      { status: 400 },
    );
  }

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
        payload:   {
          name, kcal, c, p, f, source,
          ...(imageThumb ? { imageThumb } : {}),
          ...(slot ? { slot } : {}),
        },
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

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const paramTz = new URL(request.url).searchParams.get('tz');
  const [userRow] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const tz = pickTimeZone(paramTz, userRow?.timezone);
  const todayKey = localDayKey(new Date(), tz);

  let events: (typeof schema.events.$inferSelect)[];
  try {
    events = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged')));
  } catch (err) {
    return NextResponse.json({ error: `DB read error: ${String(err)}` }, { status: 500 });
  }

  const items = events
    .filter(e => localDayKey(e.timestamp, tz) === todayKey)
    .map(e => {
      const p = pl(e.payload);
      return {
        id:      e.id,
        name:    typeof p.name === 'string' ? p.name : '',
        kcal:    Math.round(num(p.kcal) ?? 0),
        protein: Math.round(num(p.p) ?? 0),
        carbs:   Math.round(num(p.c) ?? 0),
        fat:     Math.round(num(p.f) ?? 0),
        slot:    typeof p.slot === 'string' ? p.slot : null,
        loggedAt: e.timestamp.toISOString(),
      };
    })
    .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));

  return NextResponse.json({ items });
}

// ── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id query param is required.' }, { status: 400 });
  }

  // Narrow, deliberate exception to the append-only events ledger (see
  // db/schema.ts) — lets a user delete their own mis-logged meal. Scoped to
  // this user's own meal_logged rows only; not a general delete capability.
  const [deleted] = await db
    .delete(schema.events)
    .where(and(
      eq(schema.events.id, id),
      eq(schema.events.user_id, userId),
      eq(schema.events.type, 'meal_logged'),
    ))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Meal log not found.' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
