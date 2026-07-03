/**
 * Vital — session + Sign in with Apple auth helpers
 *
 * Uses `jose` (not `jsonwebtoken`) for both signing and verifying, because
 * middleware.ts runs on the Edge runtime, where Node-only crypto (and thus
 * `jsonwebtoken`) is unavailable.
 *
 * Flow:
 *   1. iOS posts the Apple identity token (or the dev-auth secret) to
 *      /api/auth/apple (or /api/auth/dev).
 *   2. Server verifies it, upserts/resolves the user row, and issues a
 *      long-lived HS256 session JWT via issueSessionJwt().
 *   3. Every subsequent request carries that session JWT as a Bearer token.
 *      middleware.ts verifies it and forwards `x-user-id` to route handlers.
 *   4. Route handlers call getUserIdFromRequest(req) to read that header.
 */

import { jwtVerify, SignJWT, createRemoteJWKSet } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const SESSION_JWT_ALG = 'HS256';
const SESSION_JWT_TTL = '30d';

// Cached across invocations (module scope) so we don't refetch Apple's JWKS
// on every request.
let appleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getAppleJwks() {
  if (!appleJwks) {
    appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  }
  return appleJwks;
}

function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) {
    throw new Error('SESSION_JWT_SECRET environment variable is not set.');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Verifies a Sign in with Apple identity token against Apple's published
 * JWKS. Returns the Apple user id (`sub`) and email, if present in the token.
 *
 * Throws if the token is invalid, expired, or fails issuer/audience checks.
 */
export async function verifyAppleIdentityToken(
  identityToken: string
): Promise<{ sub: string; email?: string }> {
  const audience = process.env.APPLE_BUNDLE_ID;
  if (!audience) {
    throw new Error('APPLE_BUNDLE_ID environment variable is not set.');
  }

  const { payload } = await jwtVerify(identityToken, getAppleJwks(), {
    issuer: APPLE_ISSUER,
    audience,
  });

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Apple identity token missing sub claim.');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

/**
 * Issues a first-party session JWT (HS256, 30-day expiry) with `sub` set to
 * the internal user id. This is what the client sends as `Authorization:
 * Bearer <token>` on every subsequent request.
 */
export async function issueSessionJwt(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: SESSION_JWT_ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_JWT_TTL)
    .sign(getSessionSecret());
}

/**
 * Reads the internal user id from the `x-user-id` header set by
 * middleware.ts after verifying the session JWT. Route handlers should call
 * this instead of reaching into headers directly.
 *
 * Throws if the header is absent — middleware guarantees it's present for
 * every authenticated request, so a missing header means either the request
 * bypassed middleware (misconfiguration) or is genuinely unauthenticated.
 */
export function getUserIdFromRequest(req: Request): string {
  const userId = req.headers.get('x-user-id');
  if (!userId) {
    throw new Error('Missing x-user-id header — request did not pass through auth middleware.');
  }
  return userId;
}
