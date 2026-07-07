import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Session-JWT gate for the API surface.
 *
 * Every /api/* request (other than the exceptions below) must carry
 * `Authorization: Bearer <session JWT>`, issued by /api/auth/apple or
 * /api/auth/dev (see lib/auth.ts issueSessionJwt). On success, the verified
 * user id (`sub` claim) is forwarded to route handlers via the `x-user-id`
 * request header — read it with lib/auth.ts getUserIdFromRequest().
 *
 * Behaviour:
 *   - /api/health is always public (used by Fly health checks).
 *   - /api/auth/* is always public (that's how a client obtains a session
 *     JWT in the first place).
 *   - If SESSION_JWT_SECRET is unset:
 *       - in production → fail CLOSED (503), so a misconfiguration can
 *         never silently expose the API;
 *       - otherwise (local development) → allow through with no
 *         `x-user-id` set, so dev keeps working against getOrCreateDevUser
 *         fallbacks until every route is threaded through.
 *   - Invalid/expired/missing tokens → 401.
 */

const encodedSecretCache = new Map<string, Uint8Array>();

function getSecretKey(secret: string): Uint8Array {
  let key = encodedSecretCache.get(secret);
  if (!key) {
    key = new TextEncoder().encode(secret);
    encodedSecretCache.set(secret, key);
  }
  return key;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === '/api/health' || pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Server auth misconfigured', { status: 503 });
    }
    // Dev pass-through: strip any client-supplied x-user-id so identity can
    // never be spoofed by sending the header directly.
    const passthroughHeaders = new Headers(req.headers);
    passthroughHeaders.delete('x-user-id');
    return NextResponse.next({ request: { headers: passthroughHeaders } });
  }

  const auth = req.headers.get('authorization') ?? '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret));
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    userId = payload.sub;
  } catch {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-user-id', userId);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/api/:path*'],
};
