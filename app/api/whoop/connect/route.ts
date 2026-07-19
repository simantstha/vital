/**
 * GET /api/whoop/connect
 *
 * Session-authed. Builds the WHOOP authorize URL (client_id, redirect_uri,
 * response_type=code, scopes, a signed `state`) and 302s the client there.
 * iOS opens this URL in `ASWebAuthenticationSession` (attaching the session
 * JWT as a Bearer header, same as any other authenticated request) so the
 * user can approve the connection on WHOOP's own login page; WHOOP then
 * redirects to /api/whoop/callback with `?code=&state=`.
 *
 * `state` carries this user's id (see lib/whoop/state.ts) since the callback
 * itself is unauthenticated — WHOOP's redirect carries no Bearer token, so
 * identity has to travel in `state`.
 *
 * Scopes requested: read:recovery read:cycles read:sleep read:workout
 * read:profile offline — `read:profile` is required for the one-time
 * `user/profile/basic` call the callback makes to learn `whoop_user_id`;
 * `offline` is required to receive a refresh token at all.
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { signWhoopOAuthState } from '@/lib/whoop/state';

const WHOOP_AUTHORIZE_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_SCOPES = 'read:recovery read:cycles read:sleep read:workout read:profile offline';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const clientId = process.env.WHOOP_CLIENT_ID;
  const redirectUri = process.env.WHOOP_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    console.error('[whoop/connect] WHOOP_CLIENT_ID/WHOOP_REDIRECT_URI not configured');
    return NextResponse.json({ error: 'WHOOP integration is not configured.' }, { status: 500 });
  }

  const state = await signWhoopOAuthState(userId);

  const authorizeUrl = new URL(WHOOP_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', WHOOP_SCOPES);
  authorizeUrl.searchParams.set('state', state);

  return NextResponse.redirect(authorizeUrl.toString(), 302);
}
