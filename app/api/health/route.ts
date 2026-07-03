/**
 * GET /api/health — unauthenticated liveness probe for Fly health checks.
 * Exempted from the auth middleware. Does not touch the database.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true });
}
