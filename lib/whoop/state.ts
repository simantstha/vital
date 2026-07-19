/**
 * WHOOP OAuth `state` param — signed, short-lived JWT (see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md, Task 3).
 *
 * WHOOP's authorize redirect requires a `state` value (CSRF protection,
 * min 8 chars) that the callback route can verify came from us and that
 * identifies which Vital user initiated the connect flow — the callback is
 * unauthenticated (a browser redirect, no session Bearer token), so identity
 * has to travel in `state` itself. Reuses the exact same secret mechanism as
 * the session JWT (lib/auth.ts's `SESSION_JWT_SECRET` + jose HS256) rather
 * than a separate table, but with its own short 10-minute expiry and a
 * `nonce` claim (single-use in spirit, though — like the session JWT itself —
 * no server-side revocation list; the 10-minute window bounds the blast
 * radius of a leaked state value).
 */

import { jwtVerify, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { getSessionSecret } from '../auth';

const STATE_JWT_ALG = 'HS256';
const STATE_JWT_TTL = '10m';

export interface WhoopOAuthState {
  userId: string;
}

/** Signs a `state` JWT carrying `userId` (as `sub`) + a random nonce, 10-minute expiry. */
export async function signWhoopOAuthState(userId: string): Promise<string> {
  return new SignJWT({ nonce: randomUUID() })
    .setProtectedHeader({ alg: STATE_JWT_ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(STATE_JWT_TTL)
    .sign(getSessionSecret());
}

/**
 * Verifies a `state` JWT. Throws on an invalid signature, malformed token, or
 * expired token (jose's own `exp` check) — the callback route treats any
 * throw here as "reject and redirect to the error deep link".
 */
export async function verifyWhoopOAuthState(token: string): Promise<WhoopOAuthState> {
  const { payload } = await jwtVerify(token, getSessionSecret());
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('WHOOP OAuth state missing sub claim.');
  }
  return { userId: payload.sub };
}
