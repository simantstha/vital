/**
 * Vital Brain — dev user helper
 *
 * Shared by lib/brain/* and app/api/ingest so both resolve the same row
 * without duplicating the upsert logic.
 *
 * In production this will be replaced by Sign-in-with-Apple JWT validation;
 * dev@vital.local is the singleton for local development.
 */

import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

export const DEV_EMAIL = 'dev@vital.local';
export const DEV_NAME  = 'Dev User';

/**
 * Upsert-style helper: returns the UUID of dev@vital.local, creating the
 * user row on first call. Subsequent calls hit the fast SELECT path.
 */
export async function getOrCreateDevUser(): Promise<string> {
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
