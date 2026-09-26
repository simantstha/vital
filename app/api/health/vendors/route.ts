/**
 * GET /api/health/vendors
 *
 * Server-to-server vendor health check: probes every third-party API this
 * app depends on in production (same model ids / endpoints, see
 * lib/health/vendors.ts) so a silent vendor-side break — like ElevenLabs
 * removing the `scribe_v1` STT model on 2026-07-09, which degraded every
 * voice turn for ~2.5 months before anyone noticed — trips an alarm instead.
 *
 * Auth: `Authorization: Bearer <HEALTHCHECK_TOKEN>`, the same static-secret
 * bearer pattern as POST /api/auth/dev (see lib/auth.ts's safeEqual). This
 * route is excluded from the session-JWT gate in middleware.ts (like
 * /api/health) and does its own check instead, since the caller here is the
 * scheduled GitHub Actions workflow (.github/workflows/vendor-health.yml),
 * not an app user.
 *
 * Response:
 *   200 { ok: true,  checks: VendorCheckResult[] }   — every vendor probe passed
 *   503 { ok: false, checks: VendorCheckResult[] }   — at least one probe failed
 *   401                                              — missing/invalid HEALTHCHECK_TOKEN
 *   503 'Not configured'                             — HEALTHCHECK_TOKEN env var unset
 *
 * Env vars:
 *   HEALTHCHECK_TOKEN   — required; unset means the route always 503s (fail
 *                         closed, same posture as middleware.ts's SESSION_JWT_SECRET
 *                         check) rather than accepting any/no token.
 */

import { NextResponse } from 'next/server';
import { safeEqual } from '@/lib/auth';
import { runVendorHealthChecks } from '@/lib/health/vendors';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const token = process.env.HEALTHCHECK_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const auth = request.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${token}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const report = await runVendorHealthChecks();
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}
