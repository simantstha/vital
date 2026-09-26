/**
 * POST   /api/meals/log        — log a meal into the events ledger.
 * GET    /api/meals/log?tz=    — today's logged meals (for the Phase 3 diet sheet).
 * DELETE /api/meals/log?id=    — remove a mis-logged meal (user-initiated correction).
 *
 * POST
 * Body: { name: string, kcal: number, c: number, p: number, f: number, source: string,
 *         imageThumb?: string, slot?: 'breakfast'|'lunch'|'snacks'|'dinner', reaction?: boolean,
 *         estimatorItems?: GroundedItem[] }
 *   — imageThumb: optional small base64 JPEG (no data-URL prefix)
 *   — slot: optional meal-slot tag (redesign-v3 diet sheet); omitted by older
 *     call sites (LogMealViewModel's photo/barcode/search flows), stored inside
 *     `payload` alongside the macros when present.
 *   — reaction: optional; `false` (or `?reaction=0` / `?reaction=false` query
 *     param) skips step 3 below entirely so the response comes back
 *     immediately. Callers that never display `coachReaction` (the Diet
 *     sheet's "log again"/custom-log flows) should pass this. Omitted →
 *     unchanged behavior, so older app builds keep getting a reaction.
 *   — estimatorItems: optional per-item grounded breakdown, round-tripped
 *     unchanged from POST /api/nutrition/photo's additive `estimatorItems`
 *     field (the iOS photo-log flow decodes it and passes it straight
 *     through here on save). Validated for shape/bounds via
 *     lib/nutrition/estimator.ts's `validateEstimatorItems` — a malformed
 *     array is a 400, same as a bad flat macro field. A well-shaped array is
 *     stored (as `payload.estimatorItems` + `payload.totalGrams`, exactly
 *     the shape lib/nutrition/quickLog.ts's `insertGroundedMeal` writes for
 *     the text-log path) ONLY when its own summed macros are still within 5%
 *     of this request's flat `kcal/c/p/f` (`estimatorItemsMatchTotals`) — if
 *     the user edited the macros in the review step enough to disagree with
 *     the item breakdown, the breakdown is stale and is silently dropped
 *     (the flat log still succeeds) rather than stored contradicting the
 *     totals it would sit next to. This is what lets a photo-logged meal
 *     feed POST /api/meals/scale's per-item mode and
 *     lib/nutrition/estimator.ts's history grounding, same as a
 *     text/coach-logged estimate.
 * Response: { ok: true, eventId: string, coachReaction: string }
 *   — coachReaction is '' when `reaction: false` was passed, or on a
 *     non-fatal context/Claude error.
 *
 * 1. Resolves the authenticated user (getUserIdFromRequest).
 * 2. Inserts a `meal_logged` event into the append-only events ledger.
 * 3. Unless opted out via `reaction: false`, assembles today's context via
 *    lib/brain/context.assembleContext and makes ONE claude-haiku-4-5 call to
 *    produce a 1-2 sentence coach reaction in observation-not-prescription
 *    voice.
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
 * ?date=YYYY-MM-DD (redesign-v3 Phase 6): optional. When present, resolves
 *   that local day (in `tz`) instead of today's — lets the Logs day-pager
 *   fetch a past day's meal entries for its diet-budget card. Malformed
 *   values (not matching /^\d{4}-\d{2}-\d{2}$/) return 400. Omitted → behavior
 *   is byte-identical to before (today's local day).
 * Response: { items: [{ id, name, kcal, protein, carbs, fat, slot, loggedAt }] }
 * (ascending by loggedAt). `name` falls back to `payload.description` when
 * `payload.name` is missing/empty — coach-logged rows (lib/brain/tools.ts
 * `log_meal`) historically wrote only `description`.
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
import { validateEstimatorItems, estimatorItemsMatchTotals } from '@/lib/nutrition/estimator';

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
  reaction?: boolean;
  estimatorItems?: unknown;
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
    (o.slot === undefined || typeof o.slot === 'string') &&
    (o.reaction === undefined || typeof o.reaction === 'boolean')
    // o.estimatorItems shape/bounds are validated separately (below, via
    // validateEstimatorItems) so a bad array gets its own clear 400 message
    // rather than the generic one this function's callers return.
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

  const { name, kcal, c, p, f, source, imageThumb, slot, reaction, estimatorItems: rawEstimatorItems } = body;

  // ── Validate estimatorItems shape/bounds (optional) ──────────────────────
  // A malformed array (wrong shape, out-of-bounds values) is rejected
  // outright — see this route's doc comment. A well-shaped array whose
  // totals disagree with the flat macros above is NOT rejected here; it's
  // silently dropped further down (after totals are known to be final) so a
  // user-edited macro correction never fails the whole log.
  let validatedEstimatorItems: ReturnType<typeof validateEstimatorItems> = null;
  if (rawEstimatorItems !== undefined) {
    validatedEstimatorItems = validateEstimatorItems(rawEstimatorItems);
    if (validatedEstimatorItems === null) {
      return NextResponse.json(
        { error: 'estimatorItems must be a non-empty array of valid grounded items.' },
        { status: 400 },
      );
    }
  }

  // Opt-out for callers that never display the coach reaction (e.g. the
  // Diet sheet's "log again"/custom-log flows) — skips assembleContext + the
  // Haiku call below so those saves return immediately instead of waiting on
  // it. Body `reaction: false` or `?reaction=0` opts out; default (both
  // omitted) is unchanged so older app builds keep getting a reaction.
  const url = new URL(request.url);
  const reactionParam = url.searchParams.get('reaction');
  const wantsReaction = reaction !== false && reactionParam !== '0' && reactionParam !== 'false';

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

  // Only keep a validated estimatorItems array when its own summed macros
  // still agree (within 5%) with the flat kcal/c/p/f above — see this
  // route's doc comment. A mismatch means the user edited the macros in the
  // review step; the item breakdown is dropped rather than stored
  // contradicting the totals it would sit next to.
  const estimatorItemsForPayload =
    validatedEstimatorItems && estimatorItemsMatchTotals(validatedEstimatorItems, { kcal, c, p, f })
      ? validatedEstimatorItems
      : null;
  const totalGrams = estimatorItemsForPayload
    ? estimatorItemsForPayload.reduce((sum, it) => sum + it.grams, 0)
    : null;

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
          // Additive — same shape lib/nutrition/quickLog.ts's
          // insertGroundedMeal writes for the text-log path (see route doc
          // comment): payload.items stays a preformatted "<grams>g <food>, …"
          // string for anything already reading it as such (e.g.
          // POST /api/meals/scale's per-item mode formatting).
          ...(estimatorItemsForPayload ? {
            estimatorItems: estimatorItemsForPayload,
            totalGrams,
            items: estimatorItemsForPayload.map((it) => `${it.grams}g ${it.food}`).join(', '),
          } : {}),
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
  if (wantsReaction) {
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

  const url = new URL(request.url);
  const paramTz = url.searchParams.get('tz');
  const paramDate = url.searchParams.get('date');

  if (paramDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(paramDate)) {
    return NextResponse.json({ error: 'date must be in YYYY-MM-DD format.' }, { status: 400 });
  }

  const [userRow] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const tz = pickTimeZone(paramTz, userRow?.timezone);
  const todayKey = paramDate ?? localDayKey(new Date(), tz);

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
        name:    typeof p.name === 'string' && p.name
          ? p.name
          : (typeof p.description === 'string' ? p.description : ''),
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
