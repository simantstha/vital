/**
 * POST /api/whoop/disconnect
 *
 * Session-authed. Deletes this user's `whoop_connections` row (revoking the
 * link on our side; we don't call a WHOOP-side revoke endpoint — none is
 * documented — so a future re-connect just runs the OAuth flow again).
 * Historical daily_metrics/events rows already synced are left alone; only
 * the connection itself is removed. Always 200 { ok: true }, even if there
 * was no connection to delete — disconnecting an already-disconnected
 * account is a no-op success, not an error.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  try {
    await db.delete(schema.whoop_connections).where(eq(schema.whoop_connections.user_id, userId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[whoop/disconnect] DB error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
