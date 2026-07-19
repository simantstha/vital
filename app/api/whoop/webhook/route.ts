/**
 * POST /api/whoop/webhook
 *
 * UNAUTHENTICATED (excluded from session-JWT middleware — see middleware.ts).
 * WHOOP posts recovery.updated / sleep.updated / workout.updated (and their
 * .deleted counterparts) here; there is no session JWT, only WHOOP's own
 * `X-WHOOP-Signature` HMAC over the raw request body.
 *
 * Verification (must read the RAW body — `await request.text()` — before any
 * JSON.parse, since the HMAC is computed over the exact bytes):
 *   base64(HMAC-SHA256(X-WHOOP-Signature-Timestamp + rawBody, WHOOP_CLIENT_SECRET))
 * compared timing-safe against `X-WHOOP-Signature`. Missing headers, a
 * mismatch, or a timestamp more than 5 minutes from now (WHOOP sends
 * milliseconds since epoch) → 401.
 *
 * Payload: { user_id (WHOOP's int64 user id), id (UUID), type, trace_id }.
 * `user_id` is looked up against `whoop_connections.whoop_user_id`; an
 * unknown user → 202 (drop silently — could be a webhook for an account that
 * later disconnected). A known user gets a 200 immediately (WHOOP wants a
 * 2XX within ~1s), then processing happens asynchronously, fire-and-forget,
 * catching + logging any error so a bad sync can never surface as a failed
 * webhook delivery (which would just trigger WHOOP's 5x retry over ~1h).
 *
 * Deviation from the plan: rather than fetching the single changed record by
 * its UUID (recovery/sleep/workout each have a GET-by-id v2 endpoint), this
 * re-runs the same trailing-48h sync that lib/whoop/sync.ts's runWhoopSync
 * already does for the worker's reconciliation pass (Task 5). That's simpler
 * (no new per-resource-type fetch-by-id code path), more robust (also
 * catches whatever changed around the notified record), and safe (the
 * mapping upserts are idempotent on (user_id, date, metric) / workout id) —
 * a duplicate or redundant sync is a no-op, not a correctness risk. `.deleted`
 * events are handled the same way: WHOOP's payload doesn't carry enough to
 * derive which exact daily_metrics row to remove (no date, no old value), so
 * this logs the deletion and re-syncs rather than attempting a destructive
 * delete from partial information. TODO: revisit once/if WHOOP's webhook
 * payload (or a follow-up API call) gives us enough to target a delete.
 */

import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { createWhoopTokenStore } from '@/lib/whoop/client';
import { createWhoopSyncRepository, runWhoopSync } from '@/lib/whoop/sync';

const SIGNATURE_HEADER = 'x-whoop-signature';
const TIMESTAMP_HEADER = 'x-whoop-signature-timestamp';
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SYNC_WINDOW_MS = 48 * 3_600_000;

const SYNC_EVENT_TYPES = new Set(['recovery.updated', 'sleep.updated', 'workout.updated']);
const DELETE_EVENT_TYPES = new Set(['recovery.deleted', 'sleep.deleted', 'workout.deleted']);

interface WhoopWebhookPayload {
  user_id?: unknown;
  id?: unknown;
  type?: unknown;
  trace_id?: unknown;
}

function verifySignature(rawBody: string, timestampHeader: string, signatureHeader: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(timestampHeader + rawBody).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function POST(request: Request): Promise<NextResponse> {
  // Must read the raw body BEFORE any JSON parsing — the HMAC is over the
  // exact bytes WHOOP sent, not a re-serialized/normalized version.
  const rawBody = await request.text();

  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestampHeader = request.headers.get(TIMESTAMP_HEADER);
  const secret = process.env.WHOOP_CLIENT_SECRET;

  if (!signature || !timestampHeader || !secret) {
    return NextResponse.json({ error: 'Missing signature headers.' }, { status: 401 });
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return NextResponse.json({ error: 'Stale or invalid timestamp.' }, { status: 401 });
  }

  if (!verifySignature(rawBody, timestampHeader, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }

  let payload: WhoopWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhoopWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const whoopUserId = payload.user_id;
  const type = payload.type;
  const traceId = typeof payload.trace_id === 'string' ? payload.trace_id : 'unknown';

  if (typeof whoopUserId !== 'number' || typeof type !== 'string') {
    return NextResponse.json({ error: 'Malformed payload.' }, { status: 400 });
  }

  let connection: { id: string; user_id: string } | undefined;
  try {
    const rows = await db
      .select({ id: schema.whoop_connections.id, user_id: schema.whoop_connections.user_id })
      .from(schema.whoop_connections)
      .where(eq(schema.whoop_connections.whoop_user_id, whoopUserId))
      .limit(1);
    connection = rows[0];
  } catch (err) {
    console.error(`[whoop/webhook] connection lookup failed (trace_id=${traceId}):`, String(err));
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }

  if (!connection) {
    // Unknown WHOOP user (e.g. already disconnected on our side) — drop
    // silently rather than error; WHOOP treats 202 as accepted.
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  if (!SYNC_EVENT_TYPES.has(type) && !DELETE_EVENT_TYPES.has(type)) {
    console.log(`[whoop/webhook] ignoring unrecognized event type (trace_id=${traceId}, type=${type})`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  if (DELETE_EVENT_TYPES.has(type)) {
    console.log(`[whoop/webhook] deletion event received (trace_id=${traceId}, type=${type}) — re-syncing trailing 48h instead of a targeted delete (see route doc comment)`);
  }

  // Respond 200 immediately; everything below (including the timezone
  // lookup) runs asynchronously, fire-and-forget — never awaited before the
  // response, since WHOOP wants a fast 2XX and retries on timeout.
  const connectionId = connection.id;
  const userId = connection.user_id;
  void (async () => {
    let timezone: string | null = null;
    try {
      const [usersRow] = await db
        .select({ timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      timezone = usersRow?.timezone ?? null;
    } catch (err) {
      console.error(`[whoop/webhook] user timezone lookup failed (trace_id=${traceId}), proceeding with UTC:`, String(err));
    }

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - SYNC_WINDOW_MS);
    const tokenStore = createWhoopTokenStore(db, schema);
    const repository = createWhoopSyncRepository(db, schema);

    await runWhoopSync(
      { connectionId, userId, timezone },
      tokenStore,
      repository,
      windowStart,
      windowEnd,
    );
  })().catch((err) => {
    console.error(`[whoop/webhook] async sync failed (trace_id=${traceId}, type=${type}):`, String(err));
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
