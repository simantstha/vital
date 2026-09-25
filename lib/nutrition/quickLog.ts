/**
 * Vital — quick meal logging
 *
 * The shared text→meal_logged-event path used by both:
 *   - lib/brain/tools.ts `log_meal` (source: 'coach' — the in-conversation
 *     coach flow; `delete_meal` and the coach's `meal_logged` SSE event both
 *     depend on that row's `source` column being exactly 'coach', and on
 *     log_meal's own JSON output shape, so this extraction must not change
 *     either).
 *   - app/api/meals/quick (source: 'quick' — Siri/Shortcuts/notification/Action
 *     Button "quick log", which must NOT be reachable by delete_meal and must
 *     NOT trigger a coach reaction).
 *
 * Two ways a query resolves to one logged `meal_logged` event:
 *   - An EXACT user-history hit (the normalized query matches a food this
 *     user has logged before by name) or a single plain food with no
 *     quantity language short-circuits straight to the top history-first
 *     candidate (lib/nutrition/candidates.ts) — fast, and re-logs exactly
 *     what the user logged before.
 *   - A phrase with quantity language ("200g", "and", a comma — see
 *     candidates.ts's `needsEstimate`) or that matched nothing in
 *     history/cache/USDA goes through lib/nutrition/estimator.ts's grounded
 *     multi-item estimator instead of a single default-portion candidate —
 *     this is what fixes "a plate of rice" logging as one generic ~150 kcal
 *     serving (see estimator.ts's header comment for why).
 */

import { db, schema } from '@/db';
import { searchCandidates, pickLoggableCandidate, normalizeName, needsEstimate, type Candidate } from '@/lib/nutrition/candidates';
import { estimateMeal, type GroundedItem } from '@/lib/nutrition/estimator';

const SOURCE_BY_ORIGIN: Record<Candidate['origin'], string> = {
  history:  'history',
  cache:    'cache',
  usda:     'usda',
  estimate: 'calorieninjas',
};

export interface QuickLogFood {
  name: string;
  qty: number;
  unit: string;
  kcal: number;
}

export interface QuickLogSuccess {
  ok: true;
  id: string;
  /** The matched candidate's name (log_meal's `matched` field). */
  name: string;
  kcal: number;
  p: number;
  c: number;
  f: number;
  /** True when the candidate came from the free-text estimate provider. */
  isEstimate: boolean;
  /** Which source won — feeds log_meal's `origin` field. */
  origin: Candidate['origin'];
  /** Present only when isEstimate — feeds log_meal's `foods` field. */
  foods?: QuickLogFood[];
}

export interface QuickLogNotFound {
  ok: false;
}

export type QuickLogResult = QuickLogSuccess | QuickLogNotFound;

export interface QuickLogOptions {
  /** Written to the events row's `source` column — 'coach' or 'quick'. */
  source: string;
  /** Optional meal-slot tag, stored in the payload alongside the macros. */
  slot?: string;
}

function itemsToFoods(items: GroundedItem[]): QuickLogFood[] {
  return items.map((it) => ({ name: it.food, qty: it.grams, unit: 'g', kcal: it.kcal }));
}

/** Inserts one `meal_logged` event from a grounded, possibly multi-item estimate. */
async function insertGroundedMeal(
  userId: string,
  text: string,
  grounded: { name: string; kcal: number; c: number; p: number; f: number; items: GroundedItem[] },
  options: QuickLogOptions,
): Promise<QuickLogSuccess> {
  const foods = itemsToFoods(grounded.items);
  const totalGrams = grounded.items.reduce((sum, it) => sum + it.grams, 0);

  const payload: Record<string, unknown> = {
    kcal:        grounded.kcal,
    c:           grounded.c,
    p:           grounded.p,
    f:           grounded.f,
    name:        grounded.name,
    description: text,
    source:      'estimator',
    // Preformatted "<qty><unit> <name>, …" string — same shape/consumer as
    // the legacy CalorieNinjas estimate path below, so nothing reading
    // payload.items as a string needs to change.
    items: foods.map((fd) => `${fd.qty}${fd.unit} ${fd.name}`).join(', '),
    // Additive: the full grounded per-item breakdown (grams, per-item
    // macros, which grounding source won, confidence, portionNote) — read
    // back by lib/nutrition/estimator.ts's history grounding source
    // (source 1) for THIS user's own future logs of the same food, and by
    // app/api/meals/scale/route.ts to scale each item on a correction.
    estimatorItems: grounded.items,
    totalGrams,
  };
  if (options.slot) {
    payload.slot = options.slot;
  }

  const [row] = await db.insert(schema.events).values({
    user_id:   userId,
    timestamp: new Date(),
    type:      'meal_logged',
    payload,
    source: options.source,
  }).returning({ id: schema.events.id });

  return {
    ok: true,
    id: row.id,
    name: grounded.name,
    kcal: grounded.kcal,
    p: grounded.p,
    c: grounded.c,
    f: grounded.f,
    isEstimate: true,
    origin: 'estimate',
    foods,
  };
}

/**
 * Resolves free-text `text` to a loggable nutrition candidate — a single
 * exact-history/plain-food match, or (for quantity/multi-food phrases) a
 * grounded multi-item estimate — and inserts one `meal_logged` event for
 * `userId`. Returns `{ ok: false }` when nothing matches and the estimator
 * also comes up empty (nothing is inserted).
 */
export async function quickLogMeal(
  userId: string,
  text: string,
  options: QuickLogOptions,
): Promise<QuickLogResult> {
  const { candidates, estimateFoods, usdaCount } = await searchCandidates(userId, text);
  const top = pickLoggableCandidate(text, candidates, usdaCount);

  // Exact history hits short-circuit — fast, and re-logs exactly what this
  // user logged before (see candidates.ts's pickLoggableCandidate rule (a)).
  const isExactHistory = top?.origin === 'history' && normalizeName(top.name) === normalizeName(text);

  if (!isExactHistory && needsEstimate(text, usdaCount)) {
    const grounded = await estimateMeal({ text, userId });
    if (grounded.items.length > 0) {
      return insertGroundedMeal(userId, text, grounded, options);
    }
    // The estimator found nothing loggable (e.g. an unrecognized food) —
    // fall through to the plain candidate list below, which for this same
    // case is typically also empty and correctly yields { ok: false }.
  }

  if (!top) return { ok: false };

  const isEstimate = top.origin === 'estimate' && estimateFoods != null;

  const payload: Record<string, unknown> = {
    kcal:        top.kcal,
    c:           top.c,
    p:           top.p,
    f:           top.f,
    name:        top.name,
    description: text,
    source:      SOURCE_BY_ORIGIN[top.origin],
  };
  if (isEstimate) {
    payload.items = estimateFoods!.map(fd => `${fd.qty}${fd.unit} ${fd.name}`).join(', ');
  }
  if (options.slot) {
    payload.slot = options.slot;
  }

  const [row] = await db.insert(schema.events).values({
    user_id:   userId,
    timestamp: new Date(),
    type:      'meal_logged',
    payload,
    source: options.source,
  }).returning({ id: schema.events.id });

  return {
    ok: true,
    id: row.id,
    name: top.name,
    kcal: top.kcal,
    p: top.p,
    c: top.c,
    f: top.f,
    isEstimate,
    origin: top.origin,
    ...(isEstimate ? { foods: estimateFoods! } : {}),
  };
}
