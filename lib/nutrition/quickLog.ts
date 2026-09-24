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
 * History-first candidate search (lib/nutrition/candidates.ts) picks the best
 * single loggable candidate for free text (grilled chicken breast, an
 * estimate like "eggs and toast", etc.) and writes one `meal_logged` event.
 * Barcode lookups are NOT handled here — that path stays in tools.ts's
 * log_meal, which never delegates to this helper for barcode input.
 */

import { db, schema } from '@/db';
import { searchCandidates, pickLoggableCandidate, type Candidate } from '@/lib/nutrition/candidates';

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

/**
 * Resolves free-text `text` to the best loggable nutrition candidate and
 * inserts one `meal_logged` event for `userId`. Returns `{ ok: false }` when
 * no candidate matches (nothing is inserted).
 */
export async function quickLogMeal(
  userId: string,
  text: string,
  options: QuickLogOptions,
): Promise<QuickLogResult> {
  const { candidates, estimateFoods, usdaCount } = await searchCandidates(userId, text);
  const top = pickLoggableCandidate(text, candidates, usdaCount);
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
