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

const DEV_EMAIL = 'dev@vital.local';
const DEV_NAME  = 'Dev User';

/** Length-aware constant-time string comparison (no early-exit on mismatch). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Upsert-style helper: returns the UUID of dev@vital.local, creating the
 * user row on first call. Subsequent calls hit the fast SELECT path.
 *
 * Inlined from the former lib/brain/user.ts (deleted — this was its only
 * caller once every other route moved to getUserIdFromRequest()).
 */
async function getOrCreateDevUser(): Promise<string> {
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, DEV_EMAIL))
    .limit(1);

  if (existing.length > 0) return existing[0].id;

  const [created] = await db
    .insert(schema.users)
    .values({ email: DEV_EMAIL, name: DEV_NAME })
    .returning({ id: schema.users.id });

  return created.id;
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
    console.error('auth/dev: failed to resolve dev user:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
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
    console.error('auth/dev: failed to read user:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const token = await issueSessionJwt(userId);
  return NextResponse.json({ token, userId, onboarded: !!onboardedAt });
}
