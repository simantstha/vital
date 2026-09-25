/**
 * lib/nutrition/estimator.eval.ts — meal-estimator accuracy eval
 *
 * Runs ~30 common free-text meal phrases through the REAL
 * lib/nutrition/estimator.ts (step 1: real claude-sonnet-5 parse) against
 * reference kcal ranges derived from USDA per-100g values and realistic
 * serving sizes, and prints each phrase's absolute % error against the
 * range midpoint, plus the median across all cases.
 *
 * Design constraints (mirrors scripts/eval-prompt-behaviour.ts):
 *   - NEVER wired into `npm test` or CI — this filename doesn't match
 *     `*.test.ts`, and it makes real, billable Anthropic API calls. Run
 *     explicitly via `npm run eval:meals`.
 *   - No database access: grounding (step 2) uses a live USDA search
 *     (searchFoods — network only, no DATABASE_URL) when USDA_FDC_API_KEY is
 *     set, and falls back to the model's own per-100g estimate otherwise —
 *     never the real DB-backed history/food_cache lookups (this eval has no
 *     user history to draw on anyway).
 *   - Needs ANTHROPIC_API_KEY. If it's not set, this prints a message and
 *     exits 0 (not a failure — see the "don't run it" instruction this
 *     script was built to honor) rather than throwing.
 *
 * Usage:
 *   npm run eval:meals
 */

export {}; // see scripts/eval-prompt-behaviour.ts's identical comment on this line

interface EvalCase {
  phrase: string;
  minKcal: number;
  maxKcal: number;
}

// Reference ranges are hand-derived from USDA FoodData Central per-100g
// values × a realistic AS-SERVED portion (not the smallest plausible
// serving) — the same reasoning lib/nutrition/estimator.ts's system prompt
// asks the model to do. A "MISS" here does not always mean the estimator is
// wrong — these ranges are deliberately narrow-ish targets for a system
// whose whole point is accurate portions, but real dishes vary (recipe,
// restaurant, added fat) more than any fixed range can capture.
const CASES: EvalCase[] = [
  { phrase: 'a plate of rice', minKcal: 390, maxKcal: 520 },
  { phrase: '2 rotis with dal', minKcal: 350, maxKcal: 550 },
  { phrase: 'chicken curry with rice', minKcal: 500, maxKcal: 750 },
  { phrase: 'a bowl of oatmeal with banana', minKcal: 300, maxKcal: 450 },
  { phrase: 'big mac and medium fries', minKcal: 800, maxKcal: 1000 },
  { phrase: 'greek yogurt with honey', minKcal: 150, maxKcal: 260 },
  { phrase: 'a bowl of pasta with marinara sauce', minKcal: 400, maxKcal: 600 },
  { phrase: 'grilled salmon with steamed broccoli', minKcal: 350, maxKcal: 550 },
  { phrase: 'a slice of pepperoni pizza', minKcal: 250, maxKcal: 350 },
  { phrase: '3 slices of pepperoni pizza', minKcal: 750, maxKcal: 1050 },
  { phrase: 'a banana', minKcal: 90, maxKcal: 120 },
  { phrase: 'a large avocado', minKcal: 300, maxKcal: 400 },
  { phrase: 'a handful of almonds', minKcal: 150, maxKcal: 220 },
  { phrase: 'a cheeseburger', minKcal: 450, maxKcal: 650 },
  { phrase: 'a bowl of chicken noodle soup', minKcal: 150, maxKcal: 300 },
  { phrase: 'scrambled eggs with toast', minKcal: 300, maxKcal: 450 },
  { phrase: 'a burrito bowl with chicken, rice, and beans', minKcal: 550, maxKcal: 800 },
  { phrase: 'a protein shake with a banana', minKcal: 250, maxKcal: 400 },
  { phrase: 'two fried eggs and bacon', minKcal: 350, maxKcal: 500 },
  { phrase: 'a bagel with cream cheese', minKcal: 350, maxKcal: 500 },
  { phrase: 'a plate of spaghetti with meatballs', minKcal: 600, maxKcal: 900 },
  { phrase: 'a small bowl of ice cream', minKcal: 200, maxKcal: 350 },
  { phrase: 'a chicken caesar salad', minKcal: 400, maxKcal: 650 },
  { phrase: 'a cup of black coffee', minKcal: 0, maxKcal: 15 },
  { phrase: 'a can of coke', minKcal: 130, maxKcal: 160 },
  { phrase: 'a medium apple', minKcal: 80, maxKcal: 120 },
  { phrase: '4 oz grilled steak', minKcal: 220, maxKcal: 320 },
  { phrase: 'a peanut butter and jelly sandwich', minKcal: 300, maxKcal: 450 },
  { phrase: 'a bowl of chili', minKcal: 300, maxKcal: 500 },
  { phrase: 'a sushi roll, 8 pieces, salmon avocado', minKcal: 300, maxKcal: 500 },
];

async function main(): Promise<void> {
  // Load .env.local BEFORE importing anything that reads process.env at
  // module scope (lib/brain/anthropicClient.ts constructs its Anthropic
  // client at import time) — same ordering trick as
  // scripts/eval-prompt-behaviour.ts / scripts/seed-dev.ts.
  const { config } = await import('dotenv');
  config({ path: process.cwd() + '/.env.local', quiet: true });

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'eval:meals: ANTHROPIC_API_KEY is not set — skipping (this eval makes real, billable ' +
      'Anthropic API calls). Set it in .env.local (see .env.example) to run it.',
    );
    return;
  }

  const { estimateMeal, parseMealWithClaude } = await import('./estimator');
  const { searchFoods } = await import('./usda');
  type EstimatorDeps = import('./estimator').EstimatorDeps;

  if (!process.env.USDA_FDC_API_KEY) {
    console.error(
      'eval:meals: USDA_FDC_API_KEY is not set — grounding will fall back to the model\'s own ' +
      'per-100g estimate for every item (searchFoods returns nothing without it). Results will ' +
      'skew toward the model\'s raw guess rather than the grounded pipeline production runs.',
    );
  }

  const deps: EstimatorDeps = {
    parseMeal: parseMealWithClaude,
    // No user history in an eval run.
    lookupHistory: async () => null,
    // Live USDA search only — no DATABASE_URL/food_cache in this script.
    lookupProvider: async (food) => {
      const hits = await searchFoods(food);
      const hit = hits.find((f) => f.per100g.kcal != null);
      if (!hit) return null;
      return {
        name: hit.name,
        per100g: { kcal: hit.per100g.kcal as number, c: hit.per100g.c ?? 0, p: hit.per100g.p ?? 0, f: hit.per100g.f ?? 0 },
        source: 'usda',
      };
    },
    loadPortionMemory: async () => [],
  };

  interface Result { phrase: string; kcal: number; min: number; max: number; pctError: number; inRange: boolean }
  const results: Result[] = [];

  for (const c of CASES) {
    try {
      const estimate = await estimateMeal({ text: c.phrase, userId: 'eval-user' }, deps);
      const mid = (c.minKcal + c.maxKcal) / 2;
      const pctError = Math.round((Math.abs(estimate.kcal - mid) / mid) * 1000) / 10;
      const inRange = estimate.kcal >= c.minKcal && estimate.kcal <= c.maxKcal;
      results.push({ phrase: c.phrase, kcal: estimate.kcal, min: c.minKcal, max: c.maxKcal, pctError, inRange });
      console.log(
        `${inRange ? 'OK  ' : 'MISS'} ${c.phrase.padEnd(48)} got ${String(estimate.kcal).padStart(5)} kcal` +
        `  ref ${c.minKcal}-${c.maxKcal}  err ${pctError}%`,
      );
    } catch (err) {
      console.error(`ERROR estimating "${c.phrase}":`, err);
    }
  }

  if (results.length === 0) {
    console.error('eval:meals: no cases completed — see errors above.');
    process.exitCode = 1;
    return;
  }

  const errors = results.map((r) => r.pctError).sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)];
  const inRangeCount = results.filter((r) => r.inRange).length;

  console.log('\n' + '─'.repeat(60));
  console.log(`${inRangeCount}/${results.length} within reference range`);
  console.log(`Median absolute % error (vs. range midpoint): ${median}%`);
}

main().catch((err) => {
  console.error('eval:meals: unexpected error:', err);
  process.exitCode = 1;
});
