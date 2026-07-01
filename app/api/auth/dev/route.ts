/**
 * POST /api/auth/dev
 *
 * Dev-only auth bypass, gated on the DEV_AUTH_SECRET env var being set.
 * Exists because Sign in with Apple requires the paid Apple Developer
 * Program (see plan doc, Phase 1 note 7); this lets every other phase work
 * identically against a real session JWT in the meantime.
 *
 * Request:  (none — Authorization: Bearer <DEV_AUTH_SECRET>)
 * Response: { token: string, userId: string, onboarded: boolean }
 *
 * - If DEV_AUTH_SECRET is unset, the route is disabled (404).
 * - If the bearer token doesn't match, 401.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { issueSessionJwt } from '@/lib/auth';
import { getOrCreateDevUser } from '@/lib/brain/user';

/** Length-aware constant-time string comparison (no early-exit on mismatch). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function POST(req: Request): Promise<NextResponse> {
  const devSecret = process.env.DEV_AUTH_SECRET;
  if (!devSecret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${devSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let userId: string;
  try {
    userId = await getOrCreateDevUser();
  } catch (err) {
    return NextResponse.json({ error: `DB error resolving dev user: ${String(err)}` }, { status: 500 });
  }

  let onboardedAt: Date | null = null;
  try {
    const [row] = await db
      .select({ onboarded_at: schema.users.onboarded_at })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    onboardedAt = row?.onboarded_at ?? null;
  } catch (err) {
    return NextResponse.json({ error: `DB error reading user: ${String(err)}` }, { status: 500 });
  }

  const token = await issueSessionJwt(userId);
  return NextResponse.json({ token, userId, onboarded: !!onboardedAt });
}
