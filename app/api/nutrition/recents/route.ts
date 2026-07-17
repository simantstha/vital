/**
 * GET /api/nutrition/recents?tz=
 *
 * Response: { items: RecentFood[] }
 *
 * DB-only — no external nutrition-provider calls. Reads the user's own
 * `meal_logged` events from the last 30 days (newest 500 rows), maps each
 * row's payload into lib/nutrition/candidates' RecentEventRow shape (route
 * logs use `name`, coach logs use `description`), and runs aggregateRecents
 * to dedup by name, keep the latest macros/slot/thumb per name, and rank by
 * (frequency desc, recency desc) capped at 12.
 *
 * `tz` is accepted but currently unused (reserved for a future "recent in
 * the user's local day" cut) — it is never validated or used to reject the
 * request.
 *
 * Returns 401 if unauthenticated, 500 on a DB read error.
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { aggregateRecents, type RecentEventRow } from '@/lib/nutrition/candidates';

export const dynamic = 'force-dynamic';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ROW_CAP = 500;

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // tz reserved for future use — accepted, never validated.
  void new URL(request.url).searchParams.get('tz');

  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);

  let events: (typeof schema.events.$inferSelect)[];
  try {
    events = await db
      .select()
      .from(schema.events)
      .where(and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'meal_logged'),
        gte(schema.events.timestamp, cutoff),
      ))
      .orderBy(desc(schema.events.timestamp))
      .limit(ROW_CAP);
  } catch (err) {
    return NextResponse.json({ error: `DB read error: ${String(err)}` }, { status: 500 });
  }

  const rows: RecentEventRow[] = events.map((e) => {
    const p = pl(e.payload);
    return {
      name:        str(p.name),
      description: str(p.description),
      kcal:        num(p.kcal),
      c:           num(p.c),
      p:           num(p.p),
      f:           num(p.f),
      slot:        str(p.slot),
      imageThumb:  str(p.imageThumb),
      timestamp:   e.timestamp,
    };
  });

  return NextResponse.json({ items: aggregateRecents(rows) });
}
