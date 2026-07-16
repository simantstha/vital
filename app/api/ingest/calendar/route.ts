/**
 * POST /api/ingest/calendar
 *
 * Receives EventKit busy blocks from the iOS app (title only — never
 * location/attendees/notes; synced with explicit user consent) and does a
 * full-replace sync into `calendar_blocks` for the posted window: existing
 * rows overlapping [windowStart, windowEnd) are deleted, then the posted
 * blocks are inserted. Re-posting the same window is therefore idempotent —
 * no dedup key needed, unlike /api/ingest/daily's UNIQUE-constraint upsert.
 *
 * Body:
 * {
 *   windowStart: ISO 8601 string,
 *   windowEnd:   ISO 8601 string (must be > windowStart, window <= 31 days),
 *   blocks: [{ start: ISO 8601, end: ISO 8601, allDay?: boolean, title?: string }]
 *     (<= 500 blocks; title trimmed + capped at 200 chars, not rejected)
 * }
 * Response: { replaced: number }  — count of blocks inserted for the window
 *
 * Auth: session JWT via middleware.ts → x-user-id header, read with
 * lib/auth.ts getUserIdFromRequest().
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { validateCalendarIngestBody, ingestCalendarBlocks } from '@/lib/calendarIngest';
import { createCalendarIngestStore } from '@/lib/calendarIngestStore';

const drizzleCalendarIngestStore = createCalendarIngestStore(db, schema);

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

  const validated = validateCalendarIngestBody(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    const result = await ingestCalendarBlocks(drizzleCalendarIngestStore, userId, validated.value);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[ingest/calendar] DB error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
