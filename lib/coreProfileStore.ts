/**
 * Vital — core profile store (Postgres-backed, file-cache fallback)
 *
 * `core-profile.md` (age/sex/height/weight, HRV baseline, training notes —
 * the coach's "who is this person" context fed into every daily brief and
 * chat prompt) used to live ONLY on disk under VITAL_DATA_DIR/.vital-memory/
 * <userId>/ (lib/memory.ts). That directory is a Fly volume mounted to the
 * `app` process only (fly.toml sets VITAL_DATA_DIR globally, but volumes are
 * single-attach) — the worker machine has no volume, so every worker-
 * generated daily brief read back a freshly re-seeded blank template
 * (scripts/docker-entrypoint.sh) instead of the user's real profile.
 *
 * `users.core_profile_md` (db/schema.ts) is now the canonical store. The
 * on-disk file is kept only as a legacy cache / back-compat write target —
 * still read directly by lib/memory.ts's read_memory/write_memory coach
 * tools — so every write here also updates it.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { readMemoryFile, writeMemoryFile } from '@/lib/memory';

/**
 * A never-onboarded core-profile.md still carries the literal
 * "[to be filled]" placeholder text from vital-memory-template/core-profile.md.
 * app/api/onboarding/route.ts's fillCoreProfile guarantees every real
 * (post-onboarding) profile has swapped every placeholder for a neutral
 * "Not yet established" / "Not specified yet" string ("A final catch-all
 * swaps any leftover literal placeholder ... so no stray `[to be filled]`
 * survives regardless.") — so this substring check reliably tells a
 * genuinely-blank template apart from any onboarded profile, on any machine,
 * with no extra config.
 */
function isBlankTemplate(content: string): boolean {
  return content.includes('[to be filled]');
}

/**
 * Reads a user's core-profile.md content. Prefers `users.core_profile_md`
 * (the canonical store). Falls back to the on-disk file for users onboarded
 * before this column existed, and — unless the file is still the untouched
 * template — lazily backfills the file's content into the column so every
 * later read (worker included) hits Postgres instead of a per-machine file.
 *
 * The blank-template guard matters specifically for the worker machine: its
 * /data is ephemeral and gets re-seeded with the bare template on every
 * boot, so if it treated that as real content and backfilled it, it would
 * permanently poison the column with a blank profile for a user whose real
 * content genuinely lives only on the app machine's volume — recreating the
 * exact bug this store exists to fix.
 */
export async function readCoreProfile(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ core_profile_md: schema.users.core_profile_md })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (row?.core_profile_md != null) return row.core_profile_md;

  const fileContent = await readMemoryFile(userId, 'core-profile.md');
  if (fileContent != null && !isBlankTemplate(fileContent)) {
    await db.update(schema.users).set({ core_profile_md: fileContent }).where(eq(schema.users.id, userId));
  }
  return fileContent;
}

/**
 * Writes a user's core-profile.md content. The column is the source of
 * truth; writeMemoryFile keeps the on-disk cache in sync for back-compat
 * with code not yet repointed at this store and with the coach's
 * read_memory/write_memory tools. writeMemoryFile is best-effort (silently
 * no-ops on a read-only/volume-less filesystem), so the column write is
 * never blocked on it.
 *
 * The blank-template guard is deliberately SYMMETRIC with readCoreProfile's.
 * Guarding only the read path leaves a hole that is strictly worse than the
 * bug being fixed: on the worker machine, a user whose column is still null
 * reads back the freshly re-seeded template (the read guard correctly
 * declines to backfill it), but lib/brain/baselines.ts's
 * writeHrvBaselineToProfile — reached from lib/claude.ts's generateDailyBrief,
 * squarely on the worker path — then regex-matches the template's OWN
 * `HRV baseline: 0ms (updated never)` line, computes stored = 0, clears the
 * `Math.abs(currentAvg - stored) <= 3` early return for any real HRV, and
 * writes the patched-but-still-blank template back here. That would make the
 * column non-null AND blank, so readCoreProfile short-circuits on it forever
 * and the user's real profile — which exists only on the app machine's
 * volume — could never be backfilled. Permanent, and worse than the original
 * bug.
 *
 * Refusing is safe because app/api/onboarding/route.ts's fillCoreProfile
 * scrubs every `[to be filled]` placeholder, so no legitimate
 * post-onboarding write is ever classified as a blank template.
 *
 * The legacy writeMemoryFile call still happens in the refused case, on
 * purpose. The file is per-machine and was the sole store before this module
 * existed, so continuing to write it preserves the exact prior behavior for
 * the one edge case that can legitimately produce template-shaped content on
 * the app machine: patching a not-yet-onboarded user's Identity lines
 * (seedUserMemory means the file always exists, so updateIdentityLines can
 * patch a still-placeholder template). On the worker that write lands on an
 * ephemeral disk and is harmlessly discarded, and it can never clobber the
 * app machine's real file — the volume is single-attach, which is the very
 * premise of this bug. Only the column, which is global and
 * read-short-circuiting, needs protecting.
 */
export async function writeCoreProfile(userId: string, content: string): Promise<void> {
  if (!isBlankTemplate(content)) {
    await db.update(schema.users).set({ core_profile_md: content }).where(eq(schema.users.id, userId));
  }
  await writeMemoryFile(userId, 'core-profile.md', content);
}
