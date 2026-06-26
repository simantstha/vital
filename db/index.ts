/**
 * Vital — Drizzle database client
 *
 * Provides a singleton postgres.js connection pool + drizzle instance.
 * The singleton pattern prevents connection-pool exhaustion during Next.js
 * hot-module reloading in development (each HMR cycle would otherwise create
 * a fresh pool and the old one leaks).
 *
 * Usage:
 *   import { db } from '@/db';
 *   const rows = await db.select().from(schema.events).where(eq(schema.events.user_id, id));
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is not set. ' +
    'Add it to .env.local (development) or the Vercel project settings (production).'
  );
}

// Attach the client to globalThis so Next.js HMR re-uses the same pool.
const g = globalThis as typeof globalThis & {
  _vitalPgClient?: ReturnType<typeof postgres>;
};

const client: ReturnType<typeof postgres> =
  g._vitalPgClient ??
  postgres(process.env.DATABASE_URL, {
    max: 10,              // connection-pool ceiling; tune for Neon/Supabase free tiers
    idle_timeout: 20,     // seconds before idle connections are released
    connect_timeout: 10,  // seconds before a connection attempt is abandoned
  });

if (process.env.NODE_ENV !== 'production') {
  g._vitalPgClient = client;
}

export const db = drizzle(client, { schema });

// Re-export the schema namespace so callers can write:
//   import { db, schema } from '@/db';
export { schema };
