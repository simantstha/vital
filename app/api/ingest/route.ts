/**
 * POST /api/ingest
 *
 * Receives HealthKit delta readings from the iOS app and persists them as
 * append-only rows in the `events` table.
 *
 * Body: { deltas: [{ type: string, timestamp: string (ISO8601), payload: object }] }
 * Response: { inserted: number }
 *
 * Auth: session JWT via middleware.ts → x-user-id header, read with
 * lib/auth.ts getUserIdFromRequest().
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Delta {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

function isDelta(d: unknown): d is Delta {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.type === 'string' && o.type.length > 0 &&
    typeof o.timestamp === 'string' && o.timestamp.length > 0 &&
    o.payload !== null && typeof o.payload === 'object' && !Array.isArray(o.payload)
  );
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // Validate shape
  if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).deltas)) {
    return NextResponse.json(
      { error: 'Body must be { deltas: Delta[] }.' },
      { status: 400 }
    );
  }

  const raw = (body as { deltas: unknown[] }).deltas;

  if (raw.length === 0) {
    return NextResponse.json({ inserted: 0 });
  }

  const invalid = raw.filter((d) => !isDelta(d));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `${invalid.length} delta(s) are missing required fields (type, timestamp, payload).` },
      { status: 400 }
    );
  }

  const deltas = raw as Delta[];

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // Persist
  try {
    await db.insert(schema.events).values(
      deltas.map((d) => ({
        user_id:   userId,
        timestamp: new Date(d.timestamp),
        type:      d.type,
        payload:   d.payload,
        source:    'healthkit' as const,
      }))
    );

    return NextResponse.json({ inserted: deltas.length });
  } catch (err) {
    console.error('[ingest] DB error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
