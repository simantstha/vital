/**
 * Drizzle Kit configuration
 *
 * Used by:
 *   npx drizzle-kit generate   — produce SQL migrations from schema diff (no live DB needed)
 *   npx drizzle-kit push       — apply schema directly to a live DB (dev convenience)
 *   npx drizzle-kit studio     — open Drizzle Studio against the live DB
 *
 * DATABASE_URL is loaded from .env.local for local development.
 * In CI / production, set it as an environment variable directly.
 */

import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

// Load .env.local so drizzle-kit push / studio pick up DATABASE_URL locally.
// drizzle-kit generate does not need a live connection and works regardless.
config({ path: '.env.local' });

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/vital',
  },
});
