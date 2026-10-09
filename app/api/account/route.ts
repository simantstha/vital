/**
 * DELETE /api/account
 *
 * Session-authed. Permanently deletes the caller's account and ALL of their
 * data (App Store guideline 5.1.1(v)): every user-scoped table (including
 * WHOOP connection tokens and push device tokens) plus the users row, in a
 * single transaction, then the legacy on-disk memory dir.
 *
 * Request body (optional JSON): { appleAuthorizationCode?: string }
 *   A fresh Sign in with Apple authorization code the iOS app obtains right
 *   before calling this route. After the data is gone we exchange it for
 *   Apple tokens and revoke them (lib/appleRevocation.ts), as guideline
 *   5.1.1(v) requires of apps that offer Sign in with Apple. The body may be
 *   absent/empty/malformed (older app builds, dev sign-in, Apple sheet
 *   failure) — deletion proceeds regardless.
 *
 * Response: 200 { ok: true, appleRevocation: 'revoked' | 'skipped' | 'failed' }
 *   - 'revoked'  Apple confirmed the token revocation
 *   - 'skipped'  no authorization code was sent, the account has no
 *                `users.apple_sub` (dev account), or the APPLE_* secrets below
 *                are not configured (a warning is logged in the latter case)
 *   - 'failed'   Apple rejected the exchange/revoke, it timed out (~5 s), or
 *                the id_token Apple returned is missing/unverifiable/belongs
 *                to a different Apple ID than the deleted account's
 *                `apple_sub` (then /auth/revoke is never called)
 *
 * The deleted user's `apple_sub` is read BEFORE the delete transaction (the
 * row is gone afterwards) and is what the Apple id_token's `sub` must match.
 *
 * Deletion is NEVER blocked or rolled back by revocation: it runs strictly
 * after the DB transaction, is time-boxed, and cannot throw.
 *
 * Required Fly secrets for revocation (no real values live in the repo):
 *   fly secrets set APPLE_TEAM_ID=… APPLE_KEY_ID=… APPLE_CLIENT_ID=… \
 *     APPLE_PRIVATE_KEY="$(cat AuthKey_XXXX.p8)"
 * APPLE_CLIENT_ID is the app bundle id; it falls back to APPLE_BUNDLE_ID (the
 * audience /api/auth/apple already verifies). See docs/CI-TESTFLIGHT.md.
 *
 * Not done server-side: a WHOOP-side revoke (no documented endpoint; see
 * app/api/whoop/disconnect). The WHOOP tokens are deleted from our DB.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { deleteUserData, removeLegacyMemoryDir } from '@/lib/accountDeletion';
import {
  DEFAULT_REVOCATION_TIMEOUT_MS,
  loadAppleRevocationConfig,
  revokeAppleTokens,
} from '@/lib/appleRevocation';

export const dynamic = 'force-dynamic';

/** Leniently reads `appleAuthorizationCode`; any problem just means "none". */
async function readAppleAuthorizationCode(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object') {
      const code = (body as Record<string, unknown>).appleAuthorizationCode;
      if (typeof code === 'string' && code.trim()) return code.trim();
    }
  } catch {
    // no body / not JSON
  }
  return undefined;
}

export async function DELETE(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 401 });
  }

  // Read the body up front; nothing below can fail because of it.
  const appleAuthorizationCode = await readAppleAuthorizationCode(request);

  // The users row (and its apple_sub) is gone after the delete below, so read
  // it now. Only needed when there is a code to revoke; a lookup failure must
  // not block deletion, it just means we cannot prove whose tokens Apple would
  // hand back, so revocation is reported as failed.
  let appleSub: string | null = null;
  let appleSubLookupFailed = false;
  if (appleAuthorizationCode) {
    try {
      const rows = await db
        .select({ apple_sub: schema.users.apple_sub })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      appleSub = rows[0]?.apple_sub ?? null;
    } catch (err) {
      console.error('[account/delete] apple_sub lookup failed:', err);
      appleSubLookupFailed = true;
    }
  }

  try {
    await deleteUserData(db as unknown as Parameters<typeof deleteUserData>[0], userId);
  } catch (err) {
    console.error('[account/delete] DB error:', err);
    return Response.json({ error: 'Database error.' }, { status: 500 });
  }

  try {
    removeLegacyMemoryDir(userId);
  } catch (err) {
    // DB data is already gone; a leftover dir is non-fatal.
    console.error('[account/delete] memory dir cleanup failed:', err);
  }

  // Best-effort and strictly after deletion. revokeAppleTokens never throws;
  // the catch is belt-and-braces so nothing here can turn a completed
  // deletion into an error response.
  let appleRevocation: 'revoked' | 'skipped' | 'failed';
  try {
    if (appleSubLookupFailed) {
      appleRevocation = 'failed';
    } else {
      const revocation = await revokeAppleTokens({
        authorizationCode: appleAuthorizationCode,
        expectedAppleSub: appleSub,
        config: loadAppleRevocationConfig(),
        timeoutMs: DEFAULT_REVOCATION_TIMEOUT_MS,
      });
      appleRevocation = revocation.status;
    }
  } catch (err) {
    console.error('[account/delete] SIWA revocation threw unexpectedly:', err);
    appleRevocation = 'failed';
  }

  return Response.json({ ok: true, appleRevocation });
}
