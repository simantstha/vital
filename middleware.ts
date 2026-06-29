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
 *   - If API_SHARED_SECRET is unset (e.g. local development), the gate is
 *     disabled and all requests pass through — local dev keeps working unchanged.
 *   - In production the secret is provided via a Fly secret.
 */
export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/api/health') {
    return NextResponse.next();
  }

  const secret = process.env.API_SHARED_SECRET;
  if (!secret) {
    return NextResponse.next();
  }

  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) {
    return NextResponse.next();
  }

  return new NextResponse('Unauthorized', { status: 401 });
}

export const config = {
  matcher: ['/api/:path*'],
};
