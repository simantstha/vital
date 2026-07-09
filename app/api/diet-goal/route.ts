/**
 * GET /api/diet-goal   — the user's current effective budget + the auto value
 *                        (so the editor can show "auto" alongside a custom pin).
 * PATCH /api/diet-goal  — update goal and/or the calorie/macro override.
 *
 * PATCH body (all fields optional):
 * {
 *   goal?: 'weight_loss' | 'muscle' | 'endurance' | 'general',
 *   mode?: 'auto' | 'custom',
 *   targetKcal?: number, protein?: number, carbs?: number, fat?: number,  // custom mode
 * }
 * mode:'auto' clears the override (recompute from goal). mode:'custom' pins the
 * supplied kcal + macros. Omitting mode leaves the override state unchanged and
 * only updates the goal.
 *
 * Auth: session JWT via middleware → x-user-id, read with getUserIdFromRequest.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import {
  resolveDietBudget,
  computeAutoBudget,
  normalizeGoal,
  DIET_GOALS,
  type DietGoal,
} from '@/lib/brain/dietBudget';

export const dynamic = 'force-dynamic';

const KCAL_MIN = 800;
const KCAL_MAX = 6000;
const GRAMS_MAX = 600;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

async function loadUser(userId: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user;
}

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const user = await loadUser(userId);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const current = await resolveDietBudget(user, userId);
  // Always surface the auto value too, so "Reset to auto" can preview it.
  const auto = current.mode === 'auto' ? current : await computeAutoBudget(userId, current.goal);

  return NextResponse.json({ current, auto, goals: DIET_GOALS });
}

export async function PATCH(request: Request): Promise<NextResponse> {
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

  const user = await loadUser(userId);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const update: Partial<typeof schema.users.$inferInsert> = {};

  // ── goal ────────────────────────────────────────────────────────────────
  if (body.goal !== undefined) {
    if (typeof body.goal !== 'string' || !(DIET_GOALS as readonly string[]).includes(body.goal)) {
      return NextResponse.json(
        { error: `goal must be one of: ${DIET_GOALS.join(', ')}.` },
        { status: 400 },
      );
    }
    update.goal = body.goal as DietGoal;
  }

  // ── override mode ─────────────────────────────────────────────────────────
  if (body.mode === 'auto') {
    update.target_kcal = null;
    update.protein_target_g = null;
    update.carbs_target_g = null;
    update.fat_target_g = null;
  } else if (body.mode === 'custom') {
    const kcal = num(body.targetKcal);
    const protein = num(body.protein);
    const carbs = num(body.carbs);
    const fat = num(body.fat);
    if (kcal == null || protein == null || carbs == null || fat == null) {
      return NextResponse.json(
        { error: 'custom mode requires targetKcal, protein, carbs and fat.' },
        { status: 400 },
      );
    }
    if (kcal < KCAL_MIN || kcal > KCAL_MAX) {
      return NextResponse.json(
        { error: `targetKcal must be between ${KCAL_MIN} and ${KCAL_MAX}.` },
        { status: 400 },
      );
    }
    for (const [label, g] of [['protein', protein], ['carbs', carbs], ['fat', fat]] as const) {
      if (g < 0 || g > GRAMS_MAX) {
        return NextResponse.json(
          { error: `${label} must be between 0 and ${GRAMS_MAX} g.` },
          { status: 400 },
        );
      }
    }
    update.target_kcal = Math.round(kcal);
    update.protein_target_g = Math.round(protein);
    update.carbs_target_g = Math.round(carbs);
    update.fat_target_g = Math.round(fat);
  } else if (body.mode !== undefined) {
    return NextResponse.json({ error: "mode must be 'auto' or 'custom'." }, { status: 400 });
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  const [updated] = await db
    .update(schema.users)
    .set(update)
    .where(eq(schema.users.id, userId))
    .returning();

  const current = await resolveDietBudget(updated, userId);
  const auto = current.mode === 'auto' ? current : await computeAutoBudget(userId, current.goal);
  return NextResponse.json({ current, auto, goals: DIET_GOALS });
}
