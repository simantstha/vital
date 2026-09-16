/**
 * Vital — memory files store (Postgres-backed, file-cache fallback)
 *
 * Generalizes lib/coreProfileStore.ts to the rest of .vital-memory/<userId>/
 * — health-conditions.json, training-history.json, nutrition-habits.json,
 * life-context.json, lab-results.json, coach-observations.md,
 * user-profile.md. Same bug, same fix: that directory is a Fly volume
 * mounted to the `app` process only (fly.toml sets VITAL_DATA_DIR globally,
 * but volumes are single-attach), so the worker machine's writes/reads never
 * see the app machine's files and vice versa. `users.core_profile_md` was
 * carved out first because it's the one file read on every brief/chat
 * prompt; `users.memory_files` (db/schema.ts) now covers the rest with a
 * single `{ "<filename>": "<raw file text>" }` jsonb map.
 *
 * This store is LOSSLESS CAPTURE ONLY. It stores and returns the exact raw
 * file text — never parses, reshapes, or interprets it. The coach can
 * overwrite any of these files with arbitrary content via the write_memory
 * tool (see lib/memory.ts's MEMORY_TOOLS), so the file shapes are not
 * statically knowable here; a later PR is responsible for converting this
 * raw capture into ontology nodes.
 *
 * The on-disk file (lib/memory.ts) is kept only as a legacy cache /
 * back-compat write target — still read directly by the coach's
 * read_memory/write_memory tools — so every write here also updates it.
 */

import fs from 'fs';
import path from 'path';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { readMemoryFileFromDisk, writeMemoryFileToDisk, resolveTemplateDir } from '@/lib/memory';

type MemoryFileMap = Record<string, string>;

/**
 * Sets ONE filename's entry in the `users.memory_files` map, leaving every
 * other key untouched.
 *
 * The merge happens in SQL — `jsonb || jsonb` is a right-biased key merge —
 * and never in JS. That is load-bearing, not stylistic. A
 * read-the-whole-map / spread-in-JS / write-the-whole-map-back update loses
 * concurrent writes to *different* filenames: whichever UPDATE lands second
 * is holding a snapshot taken before the first one committed, so it silently
 * reverts the other filename's entry. The race is reachable in production,
 * not theoretical — the `worker` process writes user-profile.md via
 * lib/claude.ts's appendCoachNote on the daily-brief path while the `app`
 * process can write health-conditions.json from onboarding or a write_memory
 * tool call. Losing a key there is precisely the data loss this module
 * exists to prevent. Concatenating inside the UPDATE makes read-and-merge
 * atomic under the row lock instead, so neither writer needs a pre-read.
 */
function setMemoryFileEntry(userId: string, filename: string, content: string) {
  return db
    .update(schema.users)
    .set({
      memory_files: sql`coalesce(${schema.users.memory_files}, '{}'::jsonb) || ${JSON.stringify({ [filename]: content })}::jsonb`,
    })
    .where(eq(schema.users.id, userId));
}

/**
 * A never-onboarded / never-written memory file still carries the exact
 * content baked into vital-memory-template/<filename> at container build
 * time (see lib/memory.ts's seedUserMemory / resolveTemplateDir). Comparing
 * against that template's actual contents — rather than a placeholder-
 * substring heuristic like coreProfileStore's isBlankTemplate — is what lets
 * this generalize to both `.json` files (whose seed content has no
 * `[to be filled]` marker at all) and `.md` files alike. Trailing whitespace
 * is normalized per line so a stray trailing newline doesn't defeat the
 * comparison.
 */
export function isSeedTemplate(filename: string, content: string): boolean {
  const templatePath = path.join(resolveTemplateDir(), filename);
  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    // No template for this filename — can't be "the" seed template.
    return false;
  }
  const normalize = (s: string) => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  return normalize(content) === normalize(template);
}

async function readMemoryFilesColumn(userId: string): Promise<MemoryFileMap> {
  const [row] = await db
    .select({ memory_files: schema.users.memory_files })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return (row?.memory_files as MemoryFileMap | null | undefined) ?? {};
}

/**
 * Reads a user's memory file content. Prefers `users.memory_files[filename]`
 * (the canonical store). Falls back to the on-disk file for users onboarded
 * before this column existed, and — unless the file is still the untouched
 * seed template — lazily backfills the file's content into the column so
 * every later read (worker included) hits Postgres instead of a per-machine
 * file.
 *
 * The seed-template guard matters specifically for the worker machine: its
 * /data is ephemeral and gets re-seeded with the bare templates on every
 * boot, so if it treated that as real content and backfilled it, it would
 * permanently poison the column with seed content for a user whose real
 * content genuinely lives only on the app machine's volume — recreating the
 * exact bug this store exists to fix. Same reasoning as
 * lib/coreProfileStore.ts's readCoreProfile.
 */
export async function readStoredMemoryFile(userId: string, filename: string): Promise<string | null> {
  const columnMap = await readMemoryFilesColumn(userId);
  const stored = columnMap[filename];
  if (stored != null) return stored;

  const fileContent = readMemoryFileFromDisk(userId, filename);
  if (fileContent != null && !isSeedTemplate(filename, fileContent)) {
    // Atomic single-key merge — never a JS spread of the snapshot read
    // above, which would clobber a sibling filename written concurrently
    // between that read and this update. See setMemoryFileEntry.
    await setMemoryFileEntry(userId, filename, fileContent);
  }
  return fileContent;
}

/**
 * Writes a user's memory file content. The column is the source of truth;
 * writeMemoryFileToDisk keeps the on-disk cache in sync for back-compat with
 * code not yet repointed at this store and with the coach's
 * read_memory/write_memory tools. The disk write is best-effort and always
 * happens — including in the refused case below — mirroring
 * lib/coreProfileStore.ts's writeCoreProfile exactly.
 *
 * The seed-template guard is deliberately SYMMETRIC with
 * readStoredMemoryFile's. Guarding only the read path leaves a hole that is
 * strictly worse than the bug being fixed: on the worker machine, a user
 * whose column entry is still unset reads back the freshly re-seeded
 * template (the read guard correctly declines to backfill it), but an
 * unguarded write from that same worker (e.g. a tool call, or any future
 * code path that re-derives and writes back seed-shaped content) would make
 * the column entry non-null AND seed-shaped, so readStoredMemoryFile
 * short-circuits on it forever and the user's real content — which exists
 * only on the app machine's volume — could never be backfilled. Permanent,
 * and worse than the original bug. See lib/coreProfileStore.ts:76-105 for
 * the fuller writeup (concrete regression case: writeHrvBaselineToProfile
 * patching the still-blank core-profile.md template on the worker).
 */
export async function writeStoredMemoryFile(userId: string, filename: string, content: string): Promise<void> {
  if (!isSeedTemplate(filename, content)) {
    // No pre-read: the merge is atomic in SQL, so there is no snapshot to go
    // stale between read and write. See setMemoryFileEntry.
    await setMemoryFileEntry(userId, filename, content);
  }
  writeMemoryFileToDisk(userId, filename, content);
}
