/**
 * POST /api/onboarding
 *
 * One-shot form submission that seeds a brand-new user's memory files with
 * the facts collected during onboarding (see Phase 5 of the auth/onboarding/
 * backfill/baseline plan). Idempotent — re-POSTing overwrites the same
 * fields safely without duplicating data or clobbering fields the coach has
 * since learned on its own.
 *
 * Request body:
 *   {
 *     basics:    { name, dob, sex, heightCm, weightKg, units, goal, targetDate? },
 *     training?: { frequency?, types?, experience?, volumeNotes? },
 *     health?:   { injuries?, conditions?, medications? },
 *     lifestyle?:{ sleepSchedule?, stress?, diet? },
 *   }
 *
 * Behavior:
 *   - 401 if unauthenticated (no x-user-id from middleware).
 *   - 400 if `basics` is missing or missing a required field.
 *   - Seeds the user's memory dir (no-op if already seeded).
 *   - Template-fills core-profile.md (Identity / Active Goals / Fitness
 *     Activities / Typical Hard Days sections); leaves the coach-owned
 *     Baselines section alone.
 *   - Structured-merges training -> training-history.json, health ->
 *     health-conditions.json, lifestyle -> nutrition-habits.json +
 *     life-context.json. Merge is a shallow key overwrite: only keys present
 *     in the submitted body are touched, everything else already in the
 *     file (e.g. facts the coach learned via write_memory) is preserved.
 *   - Updates users.name (from basics.name), sets users.onboarded_at, and
 *     persists users.unit_system from basics.units (normalized, never 400s —
 *     see lib/units.ts resolveUnitSystem).
 *   - Maps basics.goal (iOS onboarding's own ids — lose_fat | build_muscle |
 *     improve_endurance | general_health) to the canonical DietGoal id and
 *     persists it to users.goal via lib/brain/dietBudget.ts's
 *     goalFromOnboarding, so the diet budget (GET /api/today, /api/diet-goal)
 *     picks up the right goal immediately instead of defaulting to 'general'
 *     until the user separately visits Profile > Goal. An unrecognised goal
 *     id leaves users.goal untouched rather than writing a wrong value. No
 *     separate budget recompute is needed: a freshly-onboarded user has no
 *     pinned override yet (users.target_kcal is null), so the auto budget is
 *     already derived live from users.goal on every read — there is no
 *     stored auto-mode kcal to go stale.
 *
 * Response: { ok: true, onboarded: true }
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { seedUserMemory, readMemoryFile, writeMemoryFile } from '@/lib/memory';
import { readCoreProfile, writeCoreProfile } from '@/lib/coreProfileStore';
import { resolveUnitSystem } from '@/lib/units';
import { ensureHealthConstraintNodes } from '@/lib/brain/healthConstraints';
import { goalFromOnboarding } from '@/lib/brain/dietBudget';

export const dynamic = 'force-dynamic';

// ── Body types ──────────────────────────────────────────────────────────────

interface Basics {
  name: string;
  dob: string;
  sex: string;
  heightCm: number;
  weightKg: number;
  units: string;
  goal: string;
  targetDate?: string;
}

interface Training {
  frequency?: string;
  types?: string[];
  experience?: string;
  volumeNotes?: string;
}

interface Health {
  injuries?: string[];
  conditions?: string[];
  medications?: string[];
}

interface Lifestyle {
  sleepSchedule?: string;
  stress?: string;
  diet?: string;
}

function isBasicsValid(b: unknown): b is Basics {
  if (!b || typeof b !== 'object') return false;
  const x = b as Record<string, unknown>;
  return (
    typeof x.name === 'string' && x.name.trim() !== '' &&
    typeof x.dob === 'string' && x.dob.trim() !== '' &&
    typeof x.sex === 'string' && x.sex.trim() !== '' &&
    typeof x.heightCm === 'number' && Number.isFinite(x.heightCm) &&
    typeof x.weightKg === 'number' && Number.isFinite(x.weightKg) &&
    typeof x.units === 'string' && x.units.trim() !== '' &&
    typeof x.goal === 'string' && x.goal.trim() !== ''
  );
}

function asObject<T>(v: unknown): T {
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

// ── core-profile.md template-fill ───────────────────────────────────────────

// Human labels for the core-profile.md free-text "Primary" goal line — keyed
// on both the raw onboarding ids (OnboardingFlowView.swift) and the
// canonical DietGoal ids (GoalDetailView.swift / lib/brain/dietBudget.ts) so
// this reads sensibly regardless of which shape basics.goal arrives in.
// Anything unrecognised falls back to the raw id (see fillCoreProfile) rather
// than dropping the text.
const GOAL_LABELS: Readonly<Record<string, string>> = {
  lose_fat:          'Lose fat',
  build_muscle:      'Build muscle',
  improve_endurance: 'Improve endurance',
  general_health:    'General health',
  weight_loss:       'Lose fat',
  muscle:            'Build muscle',
  endurance:         'Improve endurance',
  general:           'General health',
};

function computeAge(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - d.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 ? age : null;
}

/**
 * Section-aware line replacement: walks the template tracking the current
 * `## Heading`, and only rewrites known field lines within the sections
 * onboarding actually has data for. The Baselines section (auto-updated by
 * the coach/baseline system — see lib/brain/baselines.ts) is left alone.
 * A final catch-all swaps any leftover literal placeholder for a neutral
 * "Not yet established" so no stray `[to be filled]` survives regardless.
 */
// core-profile.md is storage for the coach's prompt context, not a
// user-facing surface — it stays canonically metric (cm/kg) regardless of
// basics.units; unit-system rendering is handled client-side off
// users.unit_system (see lib/units.ts), not here.
function fillCoreProfile(template: string, basics: Basics, training: Training): string {
  const age = computeAge(basics.dob);
  const today = new Date().toISOString().split('T')[0];

  let section = '';
  const lines = template.split('\n').map((line) => {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      return line;
    }

    if (section === 'Identity') {
      if (/^- Age:/.test(line)) return `- Age: ${age ?? 'Not yet established'}`;
      if (/^- Sex:/.test(line)) return `- Sex: ${basics.sex}`;
      if (/^- Height:/.test(line)) return `- Height: ${basics.heightCm} cm`;
      if (/^- Current weight:/.test(line)) {
        return `- Current weight: ${basics.weightKg} kg — last updated ${today}`;
      }
    }

    if (section === 'Active Goals') {
      if (/^- Primary:/.test(line)) return `- Primary: ${GOAL_LABELS[basics.goal] ?? basics.goal}`;
      if (/^- Secondary:/.test(line)) return '- Secondary: Not specified yet';
      if (/^- Weekly training target:/.test(line)) {
        return `- Weekly training target: ${training.frequency ?? 'Not specified yet'}`;
      }
    }

    if (section === 'Fitness Activities') {
      if (/^- Primary:/.test(line)) return `- Primary: ${training.types?.[0] ?? 'Not specified yet'}`;
      if (/^- Secondary:/.test(line)) return `- Secondary: ${training.types?.[1] ?? 'Not specified yet'}`;
    }

    if (section === 'Typical Hard Days') {
      if (/^- Gym days:/.test(line)) {
        return `- Gym days: ${training.frequency ?? 'Not specified yet'}`;
      }
      if (/^- \[to be filled\]$/.test(line)) {
        return `- ${training.volumeNotes ?? training.experience ?? 'Not specified yet'}`;
      }
    }

    return line;
  });

  // Safety net: anything still unfilled (e.g. Baselines' Resting HR/Recovery
  // baseline/Weight trend, which onboarding intentionally doesn't touch)
  // gets a neutral, non-fabricated label instead of leaking the raw
  // template placeholder text.
  return lines.join('\n').replace(/\[to be filled\]/g, 'Not yet established');
}

// ── JSON memory-file structured merge ───────────────────────────────────────

/** Shallow-merges only the defined (non-undefined) keys of `patch` on top of
 *  the existing file contents, so unrelated/previously-learned keys survive
 *  and re-POSTing the same body is a safe no-op. */
async function mergeJsonMemoryFile(userId: string, filename: string, patch: Record<string, unknown>): Promise<void> {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(defined).length === 0) return;

  const raw = (await readMemoryFile(userId, filename)) ?? '{}';
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(raw);
  } catch {
    existing = {};
  }

  const merged = { ...existing, ...defined };
  await writeMemoryFile(userId, filename, JSON.stringify(merged, null, 2));
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isBasicsValid(body.basics)) {
    return NextResponse.json(
      { error: '"basics" is required with name, dob, sex, heightCm, weightKg, units, and goal.' },
      { status: 400 },
    );
  }
  const basics = body.basics as Basics;
  const training = asObject<Training>(body.training);
  const health = asObject<Health>(body.health);
  const lifestyle = asObject<Lifestyle>(body.lifestyle);

  seedUserMemory(userId);

  // core-profile.md — template fill
  const template = (await readCoreProfile(userId)) ?? '';
  await writeCoreProfile(userId, fillCoreProfile(template, basics, training));

  // Structured JSON merges
  await mergeJsonMemoryFile(userId, 'training-history.json', {
    frequency: training.frequency,
    types: training.types,
    experience: training.experience,
    volumeNotes: training.volumeNotes,
  });

  await mergeJsonMemoryFile(userId, 'health-conditions.json', {
    injuries: health.injuries,
    conditions: health.conditions,
    medications: health.medications,
  });

  await mergeJsonMemoryFile(userId, 'nutrition-habits.json', {
    diet: lifestyle.diet,
  });

  await mergeJsonMemoryFile(userId, 'life-context.json', {
    sleepSchedule: lifestyle.sleepSchedule,
    stress: lifestyle.stress,
  });

  // Promote declared injuries/conditions/medications into ontology nodes so
  // the coach's hard-constraint safety layer (lib/brain/context.ts) actually
  // sees them — health-conditions.json alone is never read into any prompt.
  // Never throws (see lib/brain/healthConstraints.ts), so this can't fail
  // onboarding.
  await ensureHealthConstraintNodes(userId);

  // Completion flag + name (submitted at onboarding, Apple/dev-auth rows
  // otherwise carry a placeholder name) + unit-system preference. Normalized
  // via resolveUnitSystem rather than validated/400'd — basics.units is only
  // required to be a non-empty string (isBasicsValid), so an older client
  // sending something unexpected (or a future third option) lands on the
  // 'metric' default instead of failing onboarding outright.
  //
  // users.goal is set in this same update when basics.goal maps to a known
  // DietGoal (see goalFromOnboarding above and the route docstring). An
  // unrecognised id is simply omitted from the `set()` payload — drizzle
  // drops undefined keys, so the column is left exactly as it was rather
  // than being cleared or written with a bogus value.
  const mappedGoal = goalFromOnboarding(basics.goal);
  await db
    .update(schema.users)
    .set({
      name: basics.name,
      onboarded_at: new Date(),
      unit_system: resolveUnitSystem(basics.units),
      goal: mappedGoal ?? undefined,
    })
    .where(eq(schema.users.id, userId));

  return NextResponse.json({ ok: true, onboarded: true });
}
