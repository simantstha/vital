/**
 * POST /api/auth/apple
 *
 * Exchanges a Sign in with Apple identity token for a Vital session JWT.
 * Upserts the user by `apple_sub`: existing users are resolved by that
 * column, new sign-ins create a row (email falls back to a placeholder if
 * Apple withholds it, e.g. on subsequent sign-ins after the first).
 *
 * Request:  { identityToken: string, name?: string }
 * Response: { token: string, userId: string, onboarded: boolean }
 *
 * `name` is only sent by the client on Apple's first authorization (Apple
 * withholds fullName afterwards). It's used for the new user's name, and to
 * back-fill the "Vital User" placeholder on an existing row if we get it later.
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

  const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const identityToken = bodyObj.identityToken;

  if (typeof identityToken !== 'string' || !identityToken) {
    return NextResponse.json({ error: 'Missing identityToken' }, { status: 400 });
  }

  const providedName =
    typeof bodyObj.name === 'string' && bodyObj.name.trim() !== ''
      ? bodyObj.name.trim()
      : undefined;

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
      .select({ id: schema.users.id, onboarded_at: schema.users.onboarded_at, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.apple_sub, sub))
      .limit(1);

    if (existing.length > 0) {
      userId = existing[0].id;
      onboardedAt = existing[0].onboarded_at;
      // Back-fill the placeholder if Apple handed us a real name this time.
      if (providedName && (!existing[0].name || existing[0].name === 'Vital User')) {
        await db.update(schema.users).set({ name: providedName }).where(eq(schema.users.id, userId));
      }
    } else {
      const [created] = await db
        .insert(schema.users)
        .values({
          apple_sub: sub,
          email: email ?? `${sub}@privaterelay.appleid.com`,
          name: providedName ?? 'Vital User',
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
