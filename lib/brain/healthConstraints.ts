/**
 * Vital Brain — health-constraint node backfill
 *
 * Onboarding (app/api/onboarding/route.ts) collects health.injuries,
 * health.conditions, health.medications and writes them ONLY into
 * health-conditions.json (a memory file whose only reader,
 * lib/memory.ts's loadAlwaysOnContext, has zero callers). Hard constraints
 * the coach actually obeys come exclusively from the `nodes` table (see
 * lib/brain/context.ts's HARD_CONSTRAINT_TYPES and lib/brain/persona.ts's
 * trainerLens) — onboarding never inserted a node, so a declared injury,
 * condition, or medication was invisible to every prompt.
 *
 * ensureHealthConstraintNodes(userId) closes that gap: it reads the stored
 * health-conditions.json (Postgres-canonical, via lib/memoryFilesStore.ts),
 * tolerantly parses it, and inserts an Injury/Condition/Medication node for
 * each declared fact not already represented by an active node of the same
 * type. Called from two places — onboarding (new users) and
 * app/api/profile/route.ts's GET (lazy backfill for users who onboarded
 * before this existed, mirroring lib/coreProfileStore.ts's read-time
 * backfill pattern).
 *
 * These are user-confirmed facts (typed into a form), so they're inserted
 * exactly like the confirm_fact path in app/api/pending-facts/resolve/route.ts:
 * source 'confirmed', weight 0.9.
 */

import { db, schema } from '@/db';
import { and, eq, isNull } from 'drizzle-orm';
import { readStoredMemoryFile } from '@/lib/memoryFilesStore';

/** health-conditions.json field name → nodes.type. Allergies aren't collected
 *  by onboarding yet (see health-conditions.json's schema / iOS form), and
 *  any other key in the file is ignored here on purpose. */
const FIELD_TO_TYPE: Record<string, string> = {
  injuries: 'Injury',
  conditions: 'Condition',
  medications: 'Medication',
};

/**
 * Tolerantly parses health-conditions.json into a Map<nodeType, declared
 * strings>. Never throws: malformed JSON, a non-object/array root, a missing
 * or non-array field, and non-string (or blank) array entries are each
 * skipped silently rather than aborting the whole parse — a user's other
 * valid fields (or the rest of onboarding/a profile fetch) must never be
 * held hostage by one malformed entry.
 */
function parseDeclaredConstraints(raw: string | null): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  if (!raw) return declared;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return declared;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return declared;
  const obj = parsed as Record<string, unknown>;

  for (const [field, type] of Object.entries(FIELD_TO_TYPE)) {
    const values = obj[field];
    if (!Array.isArray(values)) continue;

    const strings = values.filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    if (strings.length > 0) declared.set(type, strings);
  }

  return declared;
}

/** Case-insensitive, whitespace-trimmed label comparison for idempotency. */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Backfills Injury/Condition/Medication nodes from a user's declared
 * health-conditions.json. Idempotent — safe to call on every onboarding
 * submit and every profile fetch:
 *   - Skips any declared label that already exists for this user as an
 *     ACTIVE, non-superseded node of the same type (case-insensitive,
 *     trimmed compare). A resolved/superseded node of the same label does
 *     NOT block re-creation — nodes has no uniqueness constraint, and a
 *     resolved fact means "no longer true", so re-declaring it should
 *     produce a fresh active fact, not silently no-op.
 *   - An existing node of a *different* type with the same label never
 *     blocks creation (the dedup key is type+label, not label alone).
 *
 * Never throws — a parse failure, a missing file, or a DB error each result
 * in { created: 0 } (logged), never an exception. Both call sites depend on
 * this: onboarding must not fail signup over a memory-file quirk, and
 * app/api/profile/route.ts's GET must not 500 a profile fetch over a
 * backfill failure.
 */
export async function ensureHealthConstraintNodes(userId: string): Promise<{ created: number }> {
  try {
    const raw = await readStoredMemoryFile(userId, 'health-conditions.json');
    const declared = parseDeclaredConstraints(raw);
    if (declared.size === 0) return { created: 0 };

    // One query covers every declared type — nodes has no uniqueness
    // constraint, so idempotency is enforced here in code by comparing
    // against every active, non-superseded node this user has (of any
    // type; the type+label key below does the real narrowing).
    const existingRows = await db
      .select({ type: schema.nodes.type, label: schema.nodes.label })
      .from(schema.nodes)
      .where(and(
        eq(schema.nodes.user_id, userId),
        eq(schema.nodes.status, 'active'),
        isNull(schema.nodes.superseded_by),
      ));

    const seen = new Set(existingRows.map((n) => `${n.type}::${normalizeLabel(n.label)}`));

    let created = 0;
    for (const [type, labels] of declared) {
      for (const label of labels) {
        const key = `${type}::${normalizeLabel(label)}`;
        if (seen.has(key)) continue;
        seen.add(key); // guards against duplicate entries within this same declared list

        await db.insert(schema.nodes).values({
          user_id: userId,
          type,
          label: label.trim(),
          properties: { evidence: label },
          source: 'confirmed',
          weight: 0.9,
        });
        created += 1;
      }
    }

    return { created };
  } catch (err) {
    console.error(`[healthConstraints] ensureHealthConstraintNodes failed for user ${userId}:`, err);
    return { created: 0 };
  }
}
