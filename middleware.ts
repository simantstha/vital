import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Shared-secret gate for the API surface.
 *
 * Every /api/* request must carry `Authorization: Bearer <API_SHARED_SECRET>`.
 * The iOS client injects this header on all requests (see APIClient.swift).
 *
 * Behaviour:
 *   - /api/health is always public (used by Fly health checks).
 *   - If API_SHARED_SECRET is unset:
 *       - in production → fail CLOSED (503), so a misconfiguration can never
 *         silently expose the API;
 *       - otherwise (local development) → allow through, so dev keeps working.
 *   - The token is compared in constant time to avoid leaking it via timing.
 */

/** Length-aware constant-time string comparison (no early-exit on mismatch). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/api/health') {
    return NextResponse.next();
  }

  const secret = process.env.API_SHARED_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Server auth misconfigured', { status: 503 });
    }
    return NextResponse.next();
  }

  const auth = req.headers.get('authorization') ?? '';
  if (safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.next();
  }

  return new NextResponse('Unauthorized', { status: 401 });
}

export const config = {
  matcher: ['/api/:path*'],
};
