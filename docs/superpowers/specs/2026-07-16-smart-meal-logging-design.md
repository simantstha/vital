# Smarter Meal Logging: Candidate Search, History Suggestions, Food Cache

Approved design (brainstormed 2026-07-16). Implementation plan:
`docs/superpowers/plans/2026-07-16-smart-meal-logging.md`.

## Context

Today every logging mode returns exactly **one** candidate: text → CalorieNinjas
(single blended estimate, no brands), barcode → Open Food Facts (single product,
silently assumes 100g), photo → Haiku vision → CalorieNinjas. Nothing is cached —
re-logging the same McDonald's burger hits external APIs again — and past meals
are never suggested, even though every logged meal already sits in the `events`
ledger with full macros.

User decisions:
- **Scope**: focused slice now; the big `docs/superpowers/plans/2026-07-11-accurate-meal-logging.md`
  plan stays future reference.
- **Search source**: USDA FoodData Central for branded/generic candidates.
- **Suggestions**: recents on open + history-first search.
- **Barcode**: portion picker + USDA fallback for unknown barcodes.
- **Architecture**: server-side unified candidate search; iOS renders lists;
  coach reuses the same lib.
- **"Own food DB"**: an organically-grown cache of external lookups + user
  history — not a from-scratch global DB.

## Design

### 1. New table: `food_cache`

Shared (not per-user) cache of every external food ever fetched.

**Sharing boundary (explicit):** `food_cache` holds *provider data only*
(USDA/OFF) and is shared across all users — user A's barcode scan warms the
cache for user B. User-authored data is never shared: history suggestions come
from each user's own `events` rows, and manually-entered macros stay in that
user's personal history (no crowdsourced writes into the shared cache).

```
food_cache:
  id            uuid pk default random
  provider      text        -- 'usda' | 'off'
  provider_food_id text     -- fdcId or OFF code
  barcode       text null
  name          text
  brand         text null
  serving_desc  text null   -- e.g. "1 cake (13g)"
  serving_grams real null
  kcal_100g / protein_100g / carbs_100g / fat_100g  real null  -- null = unknown, never 0
  fetched_at    timestamptz
  UNIQUE (provider, provider_food_id); index on barcode; index on name
```

Migration rules (AI_COMMON.md): edit `db/schema.ts`, `npx drizzle-kit generate`,
commit file under `db/migrations/`. **Never `drizzle-kit push` to prod.**
Additive-only, deploy-window safe.

### 2. New lib: `lib/nutrition/`

- `lib/nutrition/usda.ts` — FDC client (`USDA_FDC_API_KEY`): `searchFoods(query)`
  via `POST /v1/foods/search` (query Branded and Foundation/SR Legacy
  **separately** and interleave deliberately — default mixed-dataType ranking
  puts generic SR Legacy rows above branded products; verified with
  "quaker rice cakes"). Map nutrients 1008/1003/1005/1004 to kcal/p/c/f per
  100g; brandOwner/brandName; servingSize+unit; householdServingFullText.
  Also GTIN/UPC lookup via the same search endpoint for barcode fallback.
- `lib/nutrition/candidates.ts` — the unified merge, used by both the route and
  the coach tool:
  1. **History**: SQL over `events` (`type='meal_logged'`, this user), `ILIKE`
     on the meal name (`payload->>'name'` falling back to
     `payload->>'description'`), dedup by normalized name (lowercase/trim/
     collapse whitespace) keeping the **most recent** occurrence (so later user
     corrections win), limit 5. Skip junk names (empty/`unknown`).
  2. **Cache**: `food_cache` ILIKE name match.
  3. **USDA live**: top ~10, upserted into `food_cache`, deduped against cache
     rows by `(provider, provider_food_id)`.
  4. **CalorieNinjas fallback**: only when USDA returns nothing or the query
     looks like a multi-food phrase (contains digits/"and"/commas — voice input
     produces these); returned as one candidate labeled a generic estimate.
- Candidate shape: `{ origin: 'history'|'cache'|'usda'|'estimate', name, brand?,
  kcal, c, p, f, servingDesc?, servingGrams?, per100g?, lastLoggedAt?, slot? }`.
  History candidates carry consumed totals; provider candidates carry
  per-serving + per-100g so the client can scale.

### 3. Reworked routes

- **`POST /api/nutrition/search`** → adds `candidates: Candidate[]` while
  keeping the existing flat `{name,kcal,c,p,f,items}` top-candidate fields —
  old TestFlight clients keep working (releases auto-deploy on merge, so
  backward compat is mandatory).
- **`GET /api/nutrition/recents?tz=`** (new) → DB-only. Recent+frequent foods
  from the user's `meal_logged` history: dedup by normalized name, rank by
  frequency-weighted recency (count in last 30 days, tiebreak most-recent),
  return ~12 with macros, slot of last log, and thumbnail if present.
  Multi-item coach-logged meals are one suggestion (re-log the whole meal).
- **`POST /api/nutrition/barcode`** → lookup order: `food_cache` by barcode →
  OFF (current `lib/openFoodFacts.ts`) → USDA GTIN search → miss response that
  tells the client to offer text search of a typed product name. Successful
  lookups upsert into `food_cache`. Response gains `servingGrams`/`servingDesc`/
  `per100g`; legacy 100g-scaled fields retained for old clients only.
- **Coach** `log_meal` tool (`lib/brain/tools.ts`): swap its `lookupNutrition`
  call for the `lib/nutrition/candidates.ts` top candidate — history-first, so
  telling the coach "had my usual McDonald's burger" reuses your saved macros.
  No other coach changes.
- **Photo route unchanged** this round.

### 4. iOS (`ios/Vital/Sources/Features/Logging/` + `Core/APIClient.swift`)

- **Recents on open**: log sheet fetches `GET /api/nutrition/recents` (rendered
  as a tappable list/chips above the input). Last response cached
  (UserDefaults/memory) so the section paints instantly on next open; refreshed
  in background. Tap → prefilled confirm card, zero lookups.
- **Candidate list for text/voice search**: `searchByText()` now shows a result
  list — history items badged (e.g. "Logged Jul 12"), brand + serving under the
  name, kcal at right. Tap → confirm card. The existing `applyResult()` confirm
  card remains the single choke point.
- **Portion controls on the confirm card** when the candidate has
  `servingGrams`/`per100g`: serving stepper (×0.5/×1/×1.5/×2…) or custom grams;
  macros recompute locally. History candidates default to "same as last time"
  with the multiplier available. No silent 100g anywhere.
- **Barcode**: result shows portion picker (defaults to 1 serving when
  `servingGrams` known, else grams entry). On lookup miss: friendly fallback
  offering text search instead of a bare error.
- New `APIClient` methods + Decodable structs for candidates/recents (mind the
  `per100g` decode-bug history — keep types exact).

### 5. Critical-thinking guards (beyond the happy path)

- Dedup normalization keeps *latest* macros per name → user corrections
  propagate to future suggestions.
- Junk/verbose photo-log names are still valid history entries but rank below
  exact matches; empty names excluded.
- `food_cache` macros nullable — unknown stays `null`, never fabricated 0.
- USDA down/slow: history+cache candidates still return
  (Promise.allSettled; USDA timeout ~4s).
- Response stays backward compatible; migration additive → safe with
  auto-release on merge.

### 6. Config

- `USDA_FDC_API_KEY`: add to `.env.example`; the Fly secret must be set
  before/at merge (free key from api.data.gov). Missing key ⇒ search degrades
  gracefully to history+cache+CalorieNinjas.

## Non-goals (this slice)

Photo accuracy, item-level payload v2, idempotency keys, `personal_foods`
management UI, recipes, retiring CalorieNinjas entirely.

## PR split

**PR 1** backend (schema+migration, lib/nutrition, routes, coach tool swap,
tests) → **PR 2** iOS (recents UI, candidate list, portion controls, barcode
UX). PR 1 is compat-safe alone. Branch `feat/smart-meal-logging` off main;
PR only, user merges (auto-release on merge).
