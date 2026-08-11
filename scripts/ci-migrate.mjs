import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationSchema = 'drizzle';
const migrationTable = '__drizzle_migrations';
const migrationFolder = path.resolve(process.cwd(), 'db/migrations');

export function validateDatabaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('DATABASE_URL must be set to a PostgreSQL connection URL.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('DATABASE_URL must be a complete PostgreSQL connection URL.');
  }

  return url;
}

export function validateMigrationJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new Error('PostgreSQL migration journal must be an object.');
  }
  if (journal.dialect !== 'postgresql') {
    throw new Error('PostgreSQL migration journal must declare the postgresql dialect.');
  }
  if (typeof journal.version !== 'string' || !/^\d+$/.test(journal.version)) {
    throw new Error('PostgreSQL migration journal must declare a numeric format version.');
  }
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('PostgreSQL migration journal must contain at least one entry.');
  }

  let previousWhen = -1;
  for (const [position, entry] of journal.entries.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.idx !== position ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen ||
      typeof entry.tag !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.tag) ||
      typeof entry.breakpoints !== 'boolean'
    ) {
      throw new Error('PostgreSQL migration journal must contain ordered entries with safe tags.');
    }
    previousWhen = entry.when;
  }

  const head = journal.entries.at(-1);
  return { tag: head.tag, createdAt: head.when };
}

export function assertAppliedMigrationHead(appliedHead, expectedHead) {
  if (
    !appliedHead ||
    Number(appliedHead.createdAt) !== expectedHead.createdAt ||
    appliedHead.hash !== expectedHead.hash
  ) {
    throw new Error('Applied migration table does not match the committed journal head.');
  }
}

async function readCommittedMigrationHead(folder) {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read committed migration journal: ${error.message}`);
  }

  const head = validateMigrationJournal(journal);
  const sqlPath = path.join(folder, `${head.tag}.sql`);
  let sql;
  try {
    sql = await readFile(sqlPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read committed migration ${head.tag}: ${error.message}`);
  }

  return {
    ...head,
    hash: createHash('sha256').update(sql).digest('hex'),
  };
}

async function closeClient(client, operationFailed) {
  try {
    await client.end({ timeout: 5 });
  } catch (error) {
    if (!operationFailed) {
      throw error;
    }
    console.error(`Migration database connection did not close cleanly: ${error.message}`);
  }
}

export async function runMigrations({ databaseUrl = process.env.DATABASE_URL, migrationsFolder = migrationFolder } = {}) {
  const url = validateDatabaseUrl(databaseUrl);
  const expectedHead = await readCommittedMigrationHead(migrationsFolder);
  let client;
  let operationFailed = true;

  try {
    // `npm ci` installs the package-lock-pinned drizzle-orm version. Its
    // migrator reads only this folder's journal and SQL files; no schema diff
    // command or drizzle-kit push path is used in production.
    const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
      import('postgres'),
      import('drizzle-orm/postgres-js'),
      import('drizzle-orm/postgres-js/migrator'),
    ]);

    client = postgres(url.toString(), {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
    });
    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder,
      migrationsSchema: migrationSchema,
      migrationsTable: migrationTable,
    });

    const [appliedHead] = await client.unsafe(
      'select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at desc, id desc limit 1',
    );
    assertAppliedMigrationHead(
      appliedHead && { hash: appliedHead.hash, createdAt: appliedHead.created_at },
      expectedHead,
    );
    operationFailed = false;
    console.log(`Migration head verified: ${expectedHead.tag}`);
  } finally {
    if (client) {
      await closeClient(client, operationFailed);
    }
  }
}

async function main() {
  await runMigrations();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Production migration gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
