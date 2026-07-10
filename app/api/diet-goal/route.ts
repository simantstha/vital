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
  applyDietBudgetUpdate,
  DIET_GOALS,
} from '@/lib/brain/dietBudget';

export const dynamic = 'force-dynamic';

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

  try {
    const { current, auto } = await applyDietBudgetUpdate(userId, body);
    return NextResponse.json({ current, auto, goals: DIET_GOALS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'User not found.' ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
