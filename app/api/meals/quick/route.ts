/**
 * POST /api/meals/quick
 *
 * "Quick log" — the Siri/App Intents, Shortcuts, Spotlight, Action Button and
 * meal-reminder-notification entry point for logging a meal from OUTSIDE the
 * app in as few taps as possible. Delegates the actual candidate search +
 * insert to lib/nutrition/quickLog.ts (shared with lib/brain/tools.ts's
 * log_meal), but with two deliberate differences from the coach's log_meal:
 *
 *   - source: 'quick', NOT 'coach' — so delete_meal (which only ever acts on
 *     'coach'-sourced rows within its time window) can never reach a quick
 *     log. Undo for a quick log goes through the ordinary
 *     `DELETE /api/meals/log?id=` route instead (the same one the Diet
 *     sheet's manual-correction Undo uses).
 *   - NO coach reaction — quick logs are instant and silent product-wise; the
 *     "logged / undo" affordance lives entirely on the calling surface (the
 *     Siri dialog, the notification's confirmation, the Shortcut's output),
 *     never in a coach message. This route never calls Claude.
 *
 * Body: { text: string, tz?: string, slot?: 'breakfast'|'lunch'|'snacks'|'dinner' }
 *   - text: free-text meal description, e.g. "two eggs and toast". Required,
 *     non-empty, max ~300 chars.
 *   - tz: IANA timezone, used only to infer `slot` when it's omitted (mirrors
 *     the app's own local-day/local-hour resolution — see lib/localDay.ts).
 *   - slot: optional explicit slot; when omitted it's inferred from the
 *     current local hour (see `inferSlot` below), matching iOS's
 *     ReminderScheduler.fallbackSlot boundaries so a Siri log at 7pm lands in
 *     "dinner" the same way the app would bucket it.
 *
 * Response 200: { id, name, kcal, p, c, f, slot, kcalLeft }
 *   - kcalLeft: today's remaining calorie budget AFTER this log, computed the
 *     same way /api/today's dietBudget.remaining is (resolveDietBudget +
 *     resolveDailyIntake) — or null if that computation fails, since it's a
 *     nice-to-have for the Siri/notification confirmation, not required to
 *     confirm the log itself.
 * Response 404: { error: 'not_found' } — no nutrition candidate matched
 *   `text` (mirrors log_meal's "Could not find nutrition data for…" case).
 * Response 400: { error: string } — missing/empty/too-long text, or a bad
 *   `slot`.
 * Response 401: { error: string } — no/invalid auth.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { quickLogMeal } from '@/lib/nutrition/quickLog';
import { resolveDietBudget } from '@/lib/brain/dietBudget';
import { resolveDailyIntake } from '@/lib/brain/nutritionIntake';
import { localDayKey, localHour, pickTimeZone } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

const VALID_SLOTS = ['breakfast', 'lunch', 'snacks', 'dinner'] as const;
type Slot = (typeof VALID_SLOTS)[number];

const MAX_TEXT_LENGTH = 300;

interface QuickLogBody {
  text: string;
  tz?: string;
  slot?: string;
}

function isValidBody(b: unknown): b is QuickLogBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.text === 'string' &&
    (o.tz === undefined || typeof o.tz === 'string') &&
    (o.slot === undefined || typeof o.slot === 'string')
  );
}

/**
 * Time-of-day → slot fallback, mirroring iOS's
 * ReminderScheduler.fallbackSlot: <11a breakfast, 11a–3p lunch, 3p–6p snack,
 * else dinner.
 */
export function inferSlot(hour: number): Slot {
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 18) return 'snacks';
  return 'dinner';
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
    return NextResponse.json({ error: 'Body must include { text: string }.' }, { status: 400 });
  }

  const text = body.text.trim();
  if (!text) {
    return NextResponse.json({ error: 'text must not be empty.' }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `text must be ${MAX_TEXT_LENGTH} characters or fewer.` }, { status: 400 });
  }

  if (body.slot !== undefined && !VALID_SLOTS.includes(body.slot as Slot)) {
    return NextResponse.json({ error: `slot must be one of ${VALID_SLOTS.join(', ')}.` }, { status: 400 });
  }

  // ── Resolve slot ───────────────────────────────────────────────────────
  let slot: Slot;
  if (body.slot !== undefined) {
    slot = body.slot as Slot;
  } else {
    const [userRow] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const tz = pickTimeZone(body.tz, userRow?.timezone);
    slot = inferSlot(localHour(new Date(), tz));
  }

  // ── Log it ─────────────────────────────────────────────────────────────
  const result = await quickLogMeal(userId, text, { source: 'quick', slot });
  if (!result.ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // ── kcalLeft — best-effort, mirrors /api/today's dietBudget.remaining ───
  let kcalLeft: number | null = null;
  try {
    const [userRow] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const tz = pickTimeZone(body.tz, userRow?.timezone) ?? 'UTC';
    const dayKey = localDayKey(new Date(), tz);
    const budget = userRow
      ? await resolveDietBudget(userRow, userId)
      : await resolveDietBudget(
          { goal: null, target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null },
          userId,
        );
    const intakeByDay = await resolveDailyIntake(userId, [dayKey], tz);
    const consumedKcal = intakeByDay.get(dayKey)?.kcal ?? 0;
    kcalLeft = Math.max(0, budget.targetKcal - consumedKcal);
  } catch (err) {
    console.error('[meals/quick] kcalLeft computation failed (non-fatal):', err);
  }

  // Rounded to whole numbers — mirrors GET /api/meals/log's `items` mapping
  // (Math.round(kcal/protein/carbs/fat)); every other surface that displays
  // these (Diet sheet, coach receipts) shows integers.
  return NextResponse.json({
    id: result.id,
    name: result.name,
    kcal: Math.round(result.kcal),
    p: Math.round(result.p),
    c: Math.round(result.c),
    f: Math.round(result.f),
    slot,
    kcalLeft,
  });
}
