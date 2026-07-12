/**
 * CI-safe Supabase schema migration runner.
 *
 * Replaces `npx drizzle-kit push --force` in the release workflow. `push
 * --force` ignores committed migration files/backfills entirely and
 * auto-accepts drizzle-kit's data-loss confirmation prompts — it truncated
 * prod's `messages` table on 2026-07-12. This script instead applies only
 * the migrations committed under db/migrations via drizzle-orm's migrator,
 * and fails loudly (non-zero exit, clear message) on any problem instead of
 * silently exiting 0 — which is what happened when DATABASE_URL was
 * malformed and caused an earlier outage.
 */

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const MIGRATIONS_FOLDER = './db/migrations';
const JOURNAL_PATH = './db/migrations/meta/_journal.json';

// Baseline row for databases provisioned via `drizzle-kit push` through
// migration 0006_easy_revanche, before this script existed. Inserting this
// row (once) into drizzle.__drizzle_migrations tells the migrator that
// 0000-0006 are already applied, so it doesn't try to re-run them against a
// database that already has that schema from `push`.
const BASELINE_HASH = '23028b6dc264103ff84a080a2098fa4fe5bbccca9c58bc0219695151a6e05e54';
const BASELINE_CREATED_AT = 1783885822601;

function requireValidDatabaseUrl() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error(
      'ci-migrate: DATABASE_URL is not set. Refusing to run — an unset or ' +
      'malformed DATABASE_URL previously caused the migration step to exit ' +
      '0 having done nothing, silently shipping schema drift to prod.',
    );
    process.exit(1);
  }
  try {
    new URL(rawUrl);
  } catch (error) {
    console.error(`ci-migrate: DATABASE_URL is not a valid URL: ${error.message}`);
    process.exit(1);
  }
  return rawUrl;
}

async function baselineIfNeeded(client) {
  const [{ has_migrations_table, has_messages_table }] = await client`
    SELECT
      to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS has_migrations_table,
      to_regclass('public.messages') IS NOT NULL AS has_messages_table
  `;
  if (has_migrations_table || !has_messages_table) return;

  console.info(
    'ci-migrate: baselining pre-existing prod schema (provisioned via ' +
    '`drizzle-kit push` through 0006_easy_revanche) so migrate() does not ' +
    'try to re-run 0000-0006.',
  );
  await client.begin(async (tx) => {
    await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await tx`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;
    await tx`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${BASELINE_HASH}, ${BASELINE_CREATED_AT})
    `;
  });
}

async function verifyAppliedHead(client) {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
  const lastEntry = journal.entries?.[journal.entries.length - 1];
  if (!lastEntry) {
    console.error(`ci-migrate: ${JOURNAL_PATH} has no entries — cannot verify applied head.`);
    process.exit(1);
  }

  const [{ max_created_at }] = await client`
    SELECT max(created_at) AS max_created_at FROM drizzle.__drizzle_migrations
  `;
  const appliedHead = max_created_at === null ? null : Number(max_created_at);

  if (appliedHead !== lastEntry.when) {
    console.error(
      `ci-migrate: post-migration verification failed. Expected latest ` +
      `migration "when" ${lastEntry.when} (${lastEntry.tag}) to match ` +
      `max(drizzle.__drizzle_migrations.created_at), got ${appliedHead}.`,
    );
    process.exit(1);
  }

  console.info(`ci-migrate: applied head is ${lastEntry.tag} (when=${lastEntry.when}).`);
}

async function main() {
  const url = requireValidDatabaseUrl();
  // prepare: false — prepared statements break on Supabase's transaction-mode
  // pooler (port 6543); disabling them is harmless on direct connections.
  const client = postgres(url, { max: 1, prepare: false });

  try {
    await baselineIfNeeded(client);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    await verifyAppliedHead(client);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('ci-migrate: unhandled error', error);
  process.exit(1);
});
