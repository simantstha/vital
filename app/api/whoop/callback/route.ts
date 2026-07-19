/**
 * GET /api/whoop/callback
 *
 * UNAUTHENTICATED (excluded from session-JWT middleware — see middleware.ts).
 * This is WHOOP's own redirect back to us after the user approves/denies the
 * connection on WHOOP's login page, so it carries no Authorization header;
 * identity comes entirely from the signed `state` param (lib/whoop/state.ts),
 * which was minted for this user by /api/whoop/connect.
 *
 * Flow:
 *   1. WHOOP denied / user cancelled → `?error=...` present, no code/state
 *      needed → redirect to the error deep link.
 *   2. Verify `state` (expired/invalid/tampered → error deep link).
 *   3. Exchange the code for tokens (exchangeCode).
 *   4. Fetch profile/basic for `whoop_user_id` (needed to route webhooks).
 *   5. Upsert `whoop_connections` (one row per user — re-connecting updates
 *      the existing row rather than erroring).
 *   6. Kick off a 30-day backfill (fire-and-forget — NOT awaited before the
 *      redirect; WHOOP wants the browser closed quickly, and a slow backfill
 *      must never block that). Errors are caught + logged, never thrown.
 *   7. 302 to the app deep link `vital://whoop?status=connected` (or
 *      `?status=error` for any failure above).
 *
 * Never logs tokens or the client secret at any step.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { exchangeCode, getProfile, createWhoopTokenStore } from '@/lib/whoop/client';
import { createWhoopSyncRepository, runWhoopSync } from '@/lib/whoop/sync';
import { verifyWhoopOAuthState } from '@/lib/whoop/state';

const CONNECTED_REDIRECT = 'vital://whoop?status=connected';
const ERROR_REDIRECT = 'vital://whoop?status=error';
const BACKFILL_WINDOW_MS = 30 * 24 * 3_600_000; // 30 days

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const whoopError = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (whoopError) {
    console.error(`[whoop/callback] WHOOP returned an error param: ${whoopError}`);
    return NextResponse.redirect(ERROR_REDIRECT, 302);
  }

  if (!code || !state) {
    console.error('[whoop/callback] missing code or state on callback');
    return NextResponse.redirect(ERROR_REDIRECT, 302);
  }

  let userId: string;
  try {
    ({ userId } = await verifyWhoopOAuthState(state));
  } catch (err) {
    console.error('[whoop/callback] state verification failed:', String(err));
    return NextResponse.redirect(ERROR_REDIRECT, 302);
  }

  let accessToken: string;
  let refreshToken: string;
  let expiresIn: number;
  let scope: string;
  try {
    const tokens = await exchangeCode(code);
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    expiresIn = tokens.expires_in;
    scope = tokens.scope;
  } catch (err) {
    console.error('[whoop/callback] token exchange failed:', String(err));
    return NextResponse.redirect(ERROR_REDIRECT, 302);
  }

  let whoopUserId: number;
  try {
    const profile = await getProfile(accessToken);
    whoopUserId = profile.user_id;
  } catch (err) {
    console.error('[whoop/callback] profile fetch failed:', String(err));
    return NextResponse.redirect(ERROR_REDIRECT, 302);
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  let connectionId: string;
  let timezone: string | null;
  try {
    const [usersRow] = await db
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    timezone = usersRow?.timezone ?? null;

    const [connectionRow] = await db
      .insert(schema.whoop_connections)
      .values({
        user_id: userId,
        whoop_user_id: whoopUserId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        scopes: scope,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: schema.whoop_connections.user_id,
        set: {
          whoop_user_id: whoopUserId,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          scopes: scope,
          status: 'active',
          updated_at: new Date(),
        },
      })
      .returning({ id: schema.whoop_connections.id });
    connectionId = connectionRow.id;
  } catch (err) {
    console.error('[whoop/callback] DB upsert failed:', String(err));
    return NextResponse.redirect(ERROR_REDIRECT, 302);
  }

  // Fire-and-forget 30-day backfill — never awaited before the redirect.
  const tokenStore = createWhoopTokenStore(db, schema);
  const repository = createWhoopSyncRepository(db, schema);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - BACKFILL_WINDOW_MS);
  runWhoopSync({ connectionId, userId, timezone }, tokenStore, repository, windowStart, windowEnd).catch((err) => {
    console.error(`[whoop/callback] initial backfill failed for connection ${connectionId}:`, String(err));
  });

  return NextResponse.redirect(CONNECTED_REDIRECT, 302);
}
