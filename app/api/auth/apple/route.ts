/**
 * POST /api/auth/apple
 *
 * Exchanges a Sign in with Apple identity token for a Vital session JWT.
 * Upserts the user by `apple_sub`: existing users are resolved by that
 * column, new sign-ins create a row (email falls back to a placeholder if
 * Apple withholds it, e.g. on subsequent sign-ins after the first).
 *
 * Request:  { identityToken: string }
 * Response: { token: string, userId: string, onboarded: boolean }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { verifyAppleIdentityToken, issueSessionJwt } from '@/lib/auth';

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const identityToken =
    body && typeof body === 'object' && 'identityToken' in body
      ? (body as Record<string, unknown>).identityToken
      : undefined;

  if (typeof identityToken !== 'string' || !identityToken) {
    return NextResponse.json({ error: 'Missing identityToken' }, { status: 400 });
  }

  let sub: string;
  let email: string | undefined;
  try {
    ({ sub, email } = await verifyAppleIdentityToken(identityToken));
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid Apple identity token: ${String(err)}` },
      { status: 401 }
    );
  }

  let userId: string;
  let onboardedAt: Date | null;
  try {
    const existing = await db
      .select({ id: schema.users.id, onboarded_at: schema.users.onboarded_at })
      .from(schema.users)
      .where(eq(schema.users.apple_sub, sub))
      .limit(1);

    if (existing.length > 0) {
      userId = existing[0].id;
      onboardedAt = existing[0].onboarded_at;
    } else {
      const [created] = await db
        .insert(schema.users)
        .values({
          apple_sub: sub,
          email: email ?? `${sub}@privaterelay.appleid.com`,
          name: 'Vital User',
        })
        .returning({ id: schema.users.id, onboarded_at: schema.users.onboarded_at });
      userId = created.id;
      onboardedAt = created.onboarded_at;
    }
  } catch (err) {
    return NextResponse.json({ error: `DB error resolving user: ${String(err)}` }, { status: 500 });
  }

  const token = await issueSessionJwt(userId);
  return NextResponse.json({ token, userId, onboarded: !!onboardedAt });
}
