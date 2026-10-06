/**
 * DELETE /api/account
 *
 * Session-authed. Permanently deletes the caller's account and ALL of their
 * data (App Store guideline 5.1.1(v)): every user-scoped table (including
 * WHOOP connection tokens and push device tokens) plus the users row, in a
 * single transaction, then the legacy on-disk memory dir. Returns 204.
 *
 * Not done server-side: Sign in with Apple token revocation (we don't store
 * Apple refresh tokens) and a WHOOP-side revoke (no documented endpoint; see
 * app/api/whoop/disconnect). The WHOOP tokens are deleted from our DB.
 */
import { db } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { deleteUserData, removeLegacyMemoryDir } from '@/lib/accountDeletion';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 401 });
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
  return new Response(null, { status: 204 });
}
