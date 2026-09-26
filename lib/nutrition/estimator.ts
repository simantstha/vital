/**
 * Vital — grounded meal estimator (v2)
 *
 * Replaces the two-hop "vision model writes a free-text query → CalorieNinjas
 * re-parses it" design (the old app/api/nutrition/photo/route.ts and
 * lib/nutrition/candidates.ts `needsEstimate` path) with ONE model call that
 * reasons about realistic per-item portions directly, followed by grounding
 * each item's macros against real nutrition data instead of trusting the
 * model's calorie guess.
 *
 * Two steps:
 *   1. `parseMeal` — claude-sonnet-5, tool-use forced to REPORT_TOOL, turns
 *      free text and/or a meal photo into `items[]`: a canonical food name,
 *      edible (as-served, cooked) grams, prep method, a confidence, a human
 *      portionNote, and the model's own per-100g macro guess as a fallback.
 *   2. `groundItem` — for each item, looks up real per-100g macros in order
 *      (user history → food_cache/USDA → the model's own fallback), clamps
 *      absurd values, and rejects a lookup whose matched name doesn't share
 *      any word with the parsed food (falls back to the model's estimate
 *      instead of silently logging the wrong food's macros).
 *
 * Every side-effecting piece (the model call, the two lookups, portion
 * memory) is injected via `EstimatorDeps` — `estimateMeal(input)` uses the
 * real Anthropic/DB-backed implementations by default, but every unit test
 * in estimator.test.ts passes fakes, so the grounding math, source fallback
 * order, and clamping are all exercised with zero network/DB access.
 */

import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { client } from '@/lib/brain/anthropicClient';
import { normalizeName, lookupProviderPer100g } from './candidates';
import type { PortionMemoryEntry } from './portionMemory';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1500;
const HISTORY_SCAN_LIMIT = 150;

// Absurd-value guard for step 3 ("sanity checks"). Very few whole foods
// exceed ~900 kcal/100g (pure oil is ~884, butter ~717); above that a
// grounding match is almost certainly the wrong food or a bad DB row.
export const MAX_KCAL_PER_100G = 900;
export const MIN_KCAL_PER_100G = 0;
// A macro gram value can never exceed 100 g per 100 g of food.
const MAX_MACRO_PER_100G = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Per100g {
  kcal: number;
  c: number;
  p: number;
  f: number;
}

export type Confidence = 'low' | 'med' | 'high';

/** One food, as the model parsed it in step 1 — before grounding. */
export interface ParsedItem {
  /** Canonical food name, e.g. "white rice, cooked". */
  food: string;
  /** Edible weight AS SERVED (cooked, not raw), in grams. */
  grams: number;
  /** Cooking method, e.g. "steamed", "pan-fried", "raw". */
  prep: string;
  confidence: Confidence;
  /** Household-measure reasoning, e.g. "standard dinner plate, ~1.5 cups". */
  portionNote: string;
  /** The model's own per-100g macro guess — used only when no real lookup matches (step 2, source 3). */
  fallbackPer100g: Per100g;
}

/** One food after step 2 grounding — what the estimator actually logs. */
export interface GroundedItem {
  food: string;
  grams: number;
  kcal: number;
  c: number;
  p: number;
  f: number;
  source: 'history' | 'usda' | 'cache' | 'model';
  confidence: Confidence;
  portionNote: string;
}

export interface EstimateResult {
  name: string;
  kcal: number;
  c: number;
  p: number;
  f: number;
  items: GroundedItem[];
}

// ─── Client-submitted estimatorItems validation (photo-log save path) ─────────
//
// POST /api/nutrition/photo returns `estimatorItems` (this file's
// `GroundedItem[]`) additively alongside the flat macros; the iOS client
// round-trips that same array back on POST /api/meals/log so the save can
// store the per-item breakdown (see that route). Nothing about grounding
// runs again here — this only re-validates shape/bounds on data the server
// itself produced moments earlier (or a client could have tampered with), so
// a malformed/hostile body can't corrupt the events ledger.

const MAX_ESTIMATOR_ITEMS = 20;
const MAX_ITEM_GRAMS = 5000;
const MAX_FOOD_NAME_LENGTH = 200;
const CONFIDENCES: readonly string[] = ['low', 'med', 'high'];
const SOURCES: readonly string[] = ['history', 'usda', 'cache', 'model'];
// Rounding/clamping slack on top of groundItem's own MAX_KCAL_PER_100G scale
// check — a legitimate item can be a few kcal over the strict per-100g*grams
// figure due to Math.round on both sides of the original computation.
const KCAL_BOUND_SLACK = 10;

/**
 * Validates a client-submitted `estimatorItems` array (already-grounded
 * `GroundedItem[]`, as returned by POST /api/nutrition/photo) against shape
 * and plausibility bounds. Returns `null` — never throws — on anything
 * malformed: a non-array, an empty array, too many items, a bad/missing
 * field, a non-finite or out-of-range number, or a kcal value that's wildly
 * inconsistent with its own grams (a manipulated or corrupted payload).
 * Callers treat `null` as "reject the whole array" (400), distinct from a
 * validly-shaped array whose *totals* don't match the meal's edited macros
 * (which callers instead silently drop — see `estimatorItemsMatchTotals`).
 */
export function validateEstimatorItems(raw: unknown): GroundedItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ESTIMATOR_ITEMS) return null;

  const out: GroundedItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;

    const food = typeof e.food === 'string' ? e.food.trim() : '';
    if (!food || food.length > MAX_FOOD_NAME_LENGTH) return null;

    const grams = Number(e.grams);
    if (!Number.isFinite(grams) || grams <= 0 || grams > MAX_ITEM_GRAMS) return null;

    const kcal = Number(e.kcal);
    const c = Number(e.c);
    const p = Number(e.p);
    const f = Number(e.f);
    if (![kcal, c, p, f].every((v) => Number.isFinite(v) && v >= 0)) return null;

    // Sanity bound: this item's kcal can't imply a per-100g density above
    // MAX_KCAL_PER_100G (plus rounding slack) — catches a tampered/garbage
    // kcal value that grams alone wouldn't rule out.
    const maxPlausibleKcal = (MAX_KCAL_PER_100G * grams) / 100 + KCAL_BOUND_SLACK;
    if (kcal > maxPlausibleKcal) return null;

    const confidence = e.confidence;
    if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence)) return null;

    const source = e.source;
    if (typeof source !== 'string' || !SOURCES.includes(source)) return null;

    const portionNote = typeof e.portionNote === 'string' ? e.portionNote.slice(0, 500) : '';

    out.push({
      food,
      grams,
      kcal,
      c,
      p,
      f,
      source: source as GroundedItem['source'],
      confidence: confidence as Confidence,
      portionNote,
    });
  }
  return out;
}

/**
 * True when `items`' own summed macros are within `tolerance` (relative,
 * default 5%) of `totals` on every one of kcal/c/p/f. Used by POST
 * /api/meals/log to decide whether a client-submitted `estimatorItems`
 * breakdown still agrees with the (possibly user-edited-in-the-review-step)
 * flat macros it's being saved alongside — if the user changed the numbers
 * enough to disagree with the item breakdown, the breakdown is stale and
 * must be dropped rather than stored contradicting the totals it sits next
 * to (see that route's POST handler).
 */
export function estimatorItemsMatchTotals(
  items: GroundedItem[],
  totals: { kcal: number; c: number; p: number; f: number },
  tolerance = 0.05,
): boolean {
  const sum = items.reduce(
    (acc, it) => ({ kcal: acc.kcal + it.kcal, c: acc.c + it.c, p: acc.p + it.p, f: acc.f + it.f }),
    { kcal: 0, c: 0, p: 0, f: 0 },
  );

  const within = (a: number, b: number): boolean => {
    if (Math.abs(a - b) < 1e-9) return true; // exact/near-exact match, incl. both 0
    const denom = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) / denom <= tolerance;
  };

  return (
    within(sum.kcal, totals.kcal) &&
    within(sum.c, totals.c) &&
    within(sum.p, totals.p) &&
    within(sum.f, totals.f)
  );
}

export interface EstimatorInput {
  text?: string;
  imageB64?: string;
  userId: string;
}

/** A per-100g match found by a grounding lookup, with the matched food's own name (for the mismatch sanity check). */
export interface GroundingMatch {
  name: string;
  per100g: Per100g;
  source: 'history' | 'usda' | 'cache';
}

export interface ParseMealInput {
  text?: string;
  imageB64?: string;
  portionMemory: PortionMemoryEntry[];
}

export interface EstimatorDeps {
  parseMeal(input: ParseMealInput): Promise<ParsedItem[]>;
  lookupHistory(userId: string, food: string): Promise<GroundingMatch | null>;
  lookupProvider(food: string): Promise<GroundingMatch | null>;
  loadPortionMemory(userId: string): Promise<PortionMemoryEntry[]>;
}

// ─── Step 1: parse (claude-sonnet-5, forced tool-use) ─────────────────────────

const REPORT_TOOL: Tool = {
  name: 'report_meal_items',
  description:
    'Report every distinct food in this meal with a realistic as-served portion in grams.',
  input_schema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        description: 'One entry per distinct food. Never combine different foods into one item.',
        items: {
          type: 'object',
          properties: {
            food: {
              type: 'string',
              description: 'Canonical food name, e.g. "white rice, cooked" — not the user\'s raw words.',
            },
            grams: {
              type: 'number',
              description: 'Edible weight AS SERVED (cooked/prepared, not raw), in grams.',
            },
            prep: {
              type: 'string',
              description: 'Cooking method, e.g. "steamed", "pan-fried", "grilled", "raw".',
            },
            confidence: {
              type: 'string',
              enum: ['low', 'med', 'high'],
              description: 'How sure you are of this portion estimate.',
            },
            portionNote: {
              type: 'string',
              description:
                'The household-measure reasoning behind the gram estimate, e.g. "standard dinner ' +
                'plate, ~1.5 cups" or "2 medium rotis, ~40g each".',
            },
            fallbackKcal100g: { type: 'number', description: 'Your own best kcal-per-100g estimate for this food, as a fallback.' },
            fallbackC100g: { type: 'number', description: 'Your own best carbs-grams-per-100g estimate.' },
            fallbackP100g: { type: 'number', description: 'Your own best protein-grams-per-100g estimate.' },
            fallbackF100g: { type: 'number', description: 'Your own best fat-grams-per-100g estimate.' },
          },
          required: [
            'food', 'grams', 'prep', 'confidence', 'portionNote',
            'fallbackKcal100g', 'fallbackC100g', 'fallbackP100g', 'fallbackF100g',
          ],
        },
      },
    },
    required: ['items'],
  },
};

// Kept as a single exported constant (not inlined) so estimator.eval.ts and
// the prompt text quoted in the PR description are guaranteed to match what
// actually runs.
export const SYSTEM_PROMPT = `You are a meal-portion estimator for a nutrition-logging app. Your ONE job is \
realistic PORTION SIZES — grams as actually served/eaten — not just "what food is this". Owners of this \
app consistently complain that logged meals are "way off", almost always because portions were guessed too \
small (e.g. a plate of rice logged as one generic ~150g serving when a real plate is 300-400g cooked).

Reason step by step about each food's portion before answering:
- Household measures → grams: a standard dinner plate holds 300-450g of food total; a cereal/rice bowl \
holds 200-300g of a starch; 1 cup of cooked rice is ~175-200g; 1 roti/chapati is ~35-45g; 1 slice of bread \
is ~30-35g; a "handful" is ~30g; a medium banana is ~120g.
- Cooked vs raw: always report the weight AS EATEN. Rice, pasta, and dried legumes roughly double-to-triple \
in weight when cooked — never report a cooked dish's raw/dry weight.
- Visible oil, ghee, butter, or sauce is a separate small item (5-15g of added fat is typical for a \
home-cooked dish) — do not fold it silently into the main item's calories, and do not skip it.
- When a photo is given, use the plate, bowl, or utensil in frame as your scale reference (a standard \
dinner plate is ~26-28cm across; a fork is ~18-20cm) rather than guessing portion size from the food alone.
- If this user's own typical portion for a food is listed below, prefer it — unless this description or \
photo clearly shows a different amount this time (e.g. "half a plate", "double rice").
- Vague quantity words matter: "a plate of X" means a full plate (see above), "a bowl of X" means a full \
bowl, "half" or "small" halves the usual portion, "big"/"large"/"double" roughly doubles it — don't ignore them.

For every item also give your own best per-100g kcal/carbs/protein/fat estimate as a fallback field — it is \
only used if no real nutrition-database match is found for that food, so make it a genuine best guess, not a \
placeholder.

Call report_meal_items with one entry per distinct food actually present. Never combine different foods into \
one item, and never invent a food that isn't described or visible.`;

function portionMemoryBlock(portionMemory: PortionMemoryEntry[]): string {
  if (portionMemory.length === 0) return '';
  const lines = portionMemory
    .slice(0, 20)
    .map((entry) => `- ${entry.food}: ~${entry.grams} g typical`)
    .join('\n');
  return `\n\nThis user's own remembered portions (from past corrections):\n${lines}`;
}

/** Reads report_meal_items' raw tool input into a validated ParsedItem[], dropping any entry missing a positive `grams`. */
export function parseReportToolInput(raw: unknown): ParsedItem[] {
  const items = (raw as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];

  const out: ParsedItem[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const grams = Number(e.grams);
    const food = typeof e.food === 'string' ? e.food.trim() : '';
    if (!food || !Number.isFinite(grams) || grams <= 0) continue;

    const confidence: Confidence = e.confidence === 'high' || e.confidence === 'med' || e.confidence === 'low'
      ? e.confidence
      : 'low';

    out.push({
      food,
      grams,
      prep: typeof e.prep === 'string' ? e.prep : '',
      confidence,
      portionNote: typeof e.portionNote === 'string' ? e.portionNote : '',
      fallbackPer100g: {
        kcal: Number(e.fallbackKcal100g) || 0,
        c: Number(e.fallbackC100g) || 0,
        p: Number(e.fallbackP100g) || 0,
        f: Number(e.fallbackF100g) || 0,
      },
    });
  }
  return out;
}

/**
 * Exported (not just used internally as defaultDeps.parseMeal) so
 * estimator.eval.ts can exercise the REAL step-1 model call while still
 * injecting lightweight/no-DB grounding for steps 2-3 — see that file.
 */
export async function parseMealWithClaude(input: ParseMealInput): Promise<ParsedItem[]> {
  const content: ContentBlockParam[] = [];
  if (input.imageB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: input.imageB64 },
    });
  }
  content.push({
    type: 'text',
    text:
      (input.text ? `Meal description: "${input.text}"` : 'Estimate the meal shown in the photo.') +
      portionMemoryBlock(input.portionMemory),
  });

  const messages: MessageParam[] = [{ role: 'user', content }];

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: REPORT_TOOL.name },
    messages,
  });

  const toolUse = msg.content.find(
    (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
  );
  if (!toolUse) return [];
  return parseReportToolInput(toolUse.input);
}

// ─── Step 2: grounding (pure — unit-testable without network) ────────────────

/** True when `a` and `b` share at least one normalized word — the mismatch guard for step 3. */
export function namesOverlap(a: string, b: string): boolean {
  const wordsOf = (s: string) => normalizeName(s).split(/[\s,()-]+/).filter(Boolean);
  const aWords = new Set(wordsOf(a));
  return wordsOf(b).some((w) => aWords.has(w));
}

/** Clamps a per-100g macro profile to a plausible range (step 3). */
export function clampPer100g(p: Per100g): Per100g {
  const clampMacro = (v: number) => {
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(MAX_MACRO_PER_100G, v);
  };
  const kcal = !Number.isFinite(p.kcal) ? MIN_KCAL_PER_100G : Math.min(MAX_KCAL_PER_100G, Math.max(MIN_KCAL_PER_100G, p.kcal));
  return { kcal, c: clampMacro(p.c), p: clampMacro(p.p), f: clampMacro(p.f) };
}

/**
 * Grounds one parsed item: picks the first of (historyMatch, providerMatch,
 * the model's own fallback) whose matched name isn't a clear mismatch for
 * `item.food` (namesOverlap), clamps the chosen per-100g profile, and scales
 * it by `item.grams`. Never throws — a missing/garbage match just falls
 * through to the next source, and the model's fallback is always usable.
 */
export function groundItem(
  item: ParsedItem,
  historyMatch: GroundingMatch | null,
  providerMatch: GroundingMatch | null,
): GroundedItem {
  let per100g: Per100g;
  let source: GroundedItem['source'];

  if (historyMatch && namesOverlap(historyMatch.name, item.food)) {
    per100g = historyMatch.per100g;
    source = 'history';
  } else if (providerMatch && namesOverlap(providerMatch.name, item.food)) {
    per100g = providerMatch.per100g;
    source = providerMatch.source;
  } else {
    per100g = item.fallbackPer100g;
    source = 'model';
  }

  const clamped = clampPer100g(per100g);
  const scale = item.grams / 100;

  return {
    food: item.food,
    grams: item.grams,
    kcal: Math.round(clamped.kcal * scale),
    c: Math.round(clamped.c * scale),
    p: Math.round(clamped.p * scale),
    f: Math.round(clamped.f * scale),
    source,
    confidence: item.confidence,
    portionNote: item.portionNote,
  };
}

// ─── Default (real) grounding lookups ─────────────────────────────────────────

/** One item from a past estimator-logged meal's `payload.estimatorItems` — see quickLog.ts / the photo route for the write side. */
interface HistoryItemRow {
  food: string;
  grams: number;
  kcal: number;
  c: number;
  p: number;
  f: number;
}

function readEstimatorItems(payload: unknown): HistoryItemRow[] {
  const raw = (payload as { estimatorItems?: unknown } | null)?.estimatorItems;
  if (!Array.isArray(raw)) return [];
  const out: HistoryItemRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const grams = Number(e.grams);
    const food = typeof e.food === 'string' ? e.food : '';
    if (!food || !Number.isFinite(grams) || grams <= 0) continue;
    out.push({
      food,
      grams,
      kcal: Number(e.kcal) || 0,
      c: Number(e.c) || 0,
      p: Number(e.p) || 0,
      f: Number(e.f) || 0,
    });
  }
  return out;
}

/**
 * Pure selector: the most recent (rows are assumed already ordered newest
 * first) exact-normalized-name match for `food` across previously-logged
 * item breakdowns, converted to a per-100g profile. Exported so the DB
 * plumbing (default lookupHistory below) can be tested against fake rows.
 */
export function pickHistoryPer100g(rows: Array<{ payload: unknown }>, food: string): GroundingMatch | null {
  const target = normalizeName(food);
  for (const row of rows) {
    for (const item of readEstimatorItems(row.payload)) {
      if (normalizeName(item.food) === target) {
        const scale = 100 / item.grams;
        return {
          name: item.food,
          per100g: { kcal: item.kcal * scale, c: item.c * scale, p: item.p * scale, f: item.f * scale },
          source: 'history',
        };
      }
    }
  }
  return null;
}

async function lookupHistoryDefault(userId: string, food: string): Promise<GroundingMatch | null> {
  // Lazy import — @/db throws at import time without DATABASE_URL, so this
  // module stays importable (and its pure helpers testable) without one.
  // Same pattern as lib/nutrition/candidates.ts's loadDb.
  const { db } = await import('@/db');
  const rows = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged')))
    .orderBy(desc(schema.events.timestamp))
    .limit(HISTORY_SCAN_LIMIT);
  return pickHistoryPer100g(rows, food);
}

async function lookupProviderDefault(food: string): Promise<GroundingMatch | null> {
  const match = await lookupProviderPer100g(food);
  if (!match) return null;
  return { name: match.name, per100g: match.per100g, source: match.source };
}

// Lazy import — like lookupHistoryDefault's @/db above, this keeps
// estimator.ts importable (and its pure helpers testable) without a
// DATABASE_URL: ./portionMemory -> @/lib/memory -> @/lib/memoryFilesStore
// imports @/db at MODULE SCOPE (eagerly), which throws without one. A
// static top-level `import { loadPortionMemory } from './portionMemory'`
// here would defeat that even for callers who never touch this default.
async function loadPortionMemoryDefault(userId: string): Promise<PortionMemoryEntry[]> {
  const { loadPortionMemory } = await import('./portionMemory');
  return loadPortionMemory(userId);
}

const defaultDeps: EstimatorDeps = {
  parseMeal: parseMealWithClaude,
  lookupHistory: lookupHistoryDefault,
  lookupProvider: lookupProviderDefault,
  loadPortionMemory: loadPortionMemoryDefault,
};

// ─── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Parses `input` into food items (step 1), grounds each one's macros against
 * real data (step 2 + 3), and sums the result. `deps` defaults to the real
 * Anthropic/DB-backed implementations; tests inject fakes for all four.
 */
export async function estimateMeal(input: EstimatorInput, deps: EstimatorDeps = defaultDeps): Promise<EstimateResult> {
  const portionMemory = await deps.loadPortionMemory(input.userId);
  const parsedItems = await deps.parseMeal({ text: input.text, imageB64: input.imageB64, portionMemory });

  const items = await Promise.all(
    parsedItems.map(async (item) => {
      const [historyMatch, providerMatch] = await Promise.all([
        deps.lookupHistory(input.userId, item.food),
        deps.lookupProvider(item.food),
      ]);
      return groundItem(item, historyMatch, providerMatch);
    }),
  );

  const totals = items.reduce(
    (acc, it) => ({ kcal: acc.kcal + it.kcal, c: acc.c + it.c, p: acc.p + it.p, f: acc.f + it.f }),
    { kcal: 0, c: 0, p: 0, f: 0 },
  );

  return {
    name: items.map((i) => i.food).join(', ') || (input.text?.trim() ?? 'Meal'),
    kcal: Math.round(totals.kcal),
    c: Math.round(totals.c),
    p: Math.round(totals.p),
    f: Math.round(totals.f),
    items,
  };
}
