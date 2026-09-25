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
 * Only TWO things short-circuit straight to a plain candidate instead of the
 * estimator:
 *   - barcode input — handled entirely in tools.ts's log_meal before it ever
 *     calls this function; never reaches quickLogMeal.
 *   - an EXACT user-history hit — the normalized query matches a food this
 *     user has logged before by name (pickLoggableCandidate rule (a)) — fast,
 *     and re-logs exactly what the user logged before.
 *
 * EVERY other free-text query — including a single plain food with no
 * quantity language at all, like "grilled chicken breast" or "a plate of
 * rice" — goes through lib/nutrition/estimator.ts's grounded estimator
 * instead of one default-portion candidate. An earlier version of this file
 * only routed a query through the estimator when
 * lib/nutrition/candidates.ts's `needsEstimate` said so (digits, "and", a
 * comma, or no USDA hit) — but that left "a plate of rice" (no quantity
 * word, and USDA has a plain "rice" hit) and "a bowl of oatmeal with banana"
 * ("with", not "and") still auto-logging one generic default USDA serving,
 * which is the owner's exact original complaint. The estimator still grounds
 * a genuinely single, plain food via the same USDA/cache per-100g lookup
 * this file used to use directly (lib/nutrition/candidates.ts's
 * `lookupProviderPer100g`) — it just also reasons about a realistic serving
 * size first, instead of trusting a fixed "default serving" number.
 *
 * `needsEstimate` and `searchCandidates`'s default behavior are UNCHANGED —
 * both still back the manual search picker (app/api/nutrition/search) as
 * before. This file only stops relying on `needsEstimate` for its own
 * routing decision, and passes `skipEstimate: true` to `searchCandidates` so
 * the now-always-superseded CalorieNinjas free-text estimate isn't fetched
 * on this auto-log path for nothing (see `SearchCandidatesOptions`).
 */

import { db, schema } from '@/db';
import { searchCandidates, pickLoggableCandidate, normalizeName, type Candidate } from '@/lib/nutrition/candidates';
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
 * Resolves free-text `text` to one logged `meal_logged` event for `userId`:
 * an exact-history re-log (fast, personal), or — for every other query — a
 * grounded multi-item estimate from lib/nutrition/estimator.ts. Returns
 * `{ ok: false }` when nothing matches at all (nothing is inserted).
 */
export async function quickLogMeal(
  userId: string,
  text: string,
  options: QuickLogOptions,
): Promise<QuickLogResult> {
  // skipEstimate: true — see this file's header comment. The legacy
  // CalorieNinjas 'estimate' candidate is never used by this auto-log path
  // any more, so fetching it here would be a wasted network call.
  const { candidates, usdaCount } = await searchCandidates(userId, text, { skipEstimate: true });
  const top = pickLoggableCandidate(text, candidates, usdaCount);

  // The ONLY short-circuit left: an exact user-history hit (see this file's
  // header comment for why every other query — including a single plain
  // food — now goes through the estimator instead).
  const isExactHistory = top?.origin === 'history' && normalizeName(top.name) === normalizeName(text);

  if (!isExactHistory) {
    // estimateMeal makes a real Anthropic API call (lib/brain/anthropicClient)
    // and can throw on an outage/timeout/429 — before this file routed
    // everything through the estimator, a model failure never touched this
    // path at all (it only affected the photo route, which already 502s on
    // failure — see app/api/nutrition/photo/route.ts). Uncaught here, a
    // model outage would now break ALL quick/coach TEXT logging, not just
    // photo logging. Catch it and fall through to the same plain
    // history/cache/USDA candidate safety net used when the estimator finds
    // nothing, so a log still succeeds (with a less accurate default
    // portion) instead of failing outright.
    try {
      const grounded = await estimateMeal({ text, userId });
      if (grounded.items.length > 0) {
        return insertGroundedMeal(userId, text, grounded, options);
      }
      // The estimator found nothing loggable (e.g. truly unrecognized
      // text) — fall through to the best plain history/cache/USDA
      // candidate as a safety net, which for this same case is typically
      // also empty and correctly yields { ok: false }.
    } catch (err) {
      console.error(
        '[quickLog] estimator failed, falling back to candidate:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!top) return { ok: false };

  const payload: Record<string, unknown> = {
    kcal:        top.kcal,
    c:           top.c,
    p:           top.p,
    f:           top.f,
    name:        top.name,
    description: text,
    source:      SOURCE_BY_ORIGIN[top.origin],
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
    name: top.name,
    kcal: top.kcal,
    p: top.p,
    c: top.c,
    f: top.f,
    // top.origin can only be 'history' (the exact-history short-circuit
    // above) or 'cache'/'usda' (the estimator-found-nothing safety net) at
    // this point — never 'estimate': searchCandidates was called with
    // skipEstimate: true, so no origin: 'estimate' candidate exists to pick.
    isEstimate: false,
    origin: top.origin,
  };
}
