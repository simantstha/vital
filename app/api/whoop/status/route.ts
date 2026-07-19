/**
 * GET /api/whoop/status
 *
 * Session-authed. Tells the iOS "Connected apps" screen whether this user
 * has a WHOOP connection and, if so, its status and last successful sync
 * time. `connected: false` (with null status/last_synced_at) when there is
 * no row at all — including the never-connected and disconnected cases,
 * which are indistinguishable to the client and don't need to be.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  try {
    const [row] = await db
      .select({
        status: schema.whoop_connections.status,
        last_synced_at: schema.whoop_connections.last_synced_at,
      })
      .from(schema.whoop_connections)
      .where(eq(schema.whoop_connections.user_id, userId))
      .limit(1);

    if (!row) {
      return NextResponse.json({ connected: false, status: null, last_synced_at: null });
    }
    return NextResponse.json({ connected: true, status: row.status, last_synced_at: row.last_synced_at });
  } catch (err) {
    console.error('[whoop/status] DB error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
