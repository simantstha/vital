# Implementation Plan: Smart Meal Logging (Candidate Search, Recents, Food Cache)

Spec: `docs/superpowers/specs/2026-07-16-smart-meal-logging-design.md`
Branch: `feat/smart-meal-logging` (PR 1, backend). iOS work stacks on it as
`feat/smart-meal-logging-ios` (PR 2).

## Global Constraints

- **Backward compatibility is mandatory.** Merging auto-deploys to prod and old
  TestFlight builds keep calling these routes. `POST /api/nutrition/search`
  must keep returning flat `{ name, kcal, c, p, f, items }`;
  `POST /api/nutrition/barcode` must keep returning
  `{ name, brand, per100g, grams, kcal, c, p, f }` with legacy semantics
  (macros scaled by `grams/100`, `grams` defaulting to 100) on success.
- **Migrations**: edit `db/schema.ts` then `npx drizzle-kit generate`; commit
  the generated file under `db/migrations/`. NEVER run `drizzle-kit push`.
  Additive-only.
- **Never fabricate macros**: unknown nutrition values stay `null`, never 0.
- **Graceful degradation**: missing `USDA_FDC_API_KEY`, or USDA down/slow
  (timeout ~4s), must still return history + cache (+ CalorieNinjas fallback)
  candidates. External calls run under `Promise.allSettled`.
- **USDA ranking gotcha**: never issue one mixed-dataType search — query
  `Branded` and `Foundation,SR Legacy` separately and interleave, else generic
  SR Legacy rows drown out branded products.
- **Sharing boundary**: `food_cache` rows come from providers (USDA/OFF) only.
  Never write user-authored macros or history into `food_cache`.
- Tests run with `npm test -- <files>` (node test runner via tsx, module mocks
  enabled). Lint with `npx eslint <files>`; full gate is
  `npm run lint && npm run build`.
- Conventional commit messages. Do not push; the controller handles push/PR.

## Task 1: `food_cache` table (schema + generated migration)

**Files**: `db/schema.ts`, generated file under `db/migrations/`.

Add to `db/schema.ts` (follow the file's existing style — `p.` helpers, snake_case
columns, comment block explaining purpose and the provider-data-only sharing
boundary):

```ts
export const food_cache = p.pgTable('food_cache', {
  id:               p.uuid('id').primaryKey().defaultRandom(),
  provider:         p.text('provider').notNull(),          // 'usda' | 'off'
  provider_food_id: p.text('provider_food_id').notNull(),  // fdcId or OFF barcode
  barcode:          p.text('barcode'),                     // GTIN/UPC when known
  name:             p.text('name').notNull(),
  brand:            p.text('brand'),
  serving_desc:     p.text('serving_desc'),                // e.g. "1 cake (13g)"
  serving_grams:    p.real('serving_grams'),
  kcal_100g:        p.real('kcal_100g'),                   // null = unknown, never 0
  protein_100g:     p.real('protein_100g'),
  carbs_100g:       p.real('carbs_100g'),
  fat_100g:         p.real('fat_100g'),
  fetched_at:       p.timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.uniqueIndex('food_cache_provider_food_idx').on(t.provider, t.provider_food_id),
  p.index('food_cache_barcode_idx').on(t.barcode),
  p.index('food_cache_name_idx').on(t.name),
]);
```

Then run `npx drizzle-kit generate` and commit the new migration file +
`db/migrations/meta` updates. Verify the generated SQL is additive only
(one CREATE TABLE + indexes, no ALTER/DROP of existing tables).

**Verify**: `npx drizzle-kit generate` produced exactly one new migration;
`npm run lint` passes on changed files. No unit tests for this task.

## Task 2: `lib/nutrition/usda.ts` — FoodData Central client + tests

**Files**: `lib/nutrition/usda.ts`, `lib/nutrition/usda.test.ts` (new dir).

Public API:

```ts
export interface UsdaFood {
  fdcId: number;
  name: string;                       // description, title-cased as-is
  brand: string | null;               // brandOwner ?? brandName (Branded only)
  dataType: 'Branded' | 'Foundation' | 'SR Legacy';
  barcode: string | null;             // gtinUpc (Branded only)
  servingGrams: number | null;        // servingSize when servingSizeUnit is g/GRM/ml
  servingDesc: string | null;         // householdServingFullText
  per100g: { kcal: number | null; p: number | null; c: number | null; f: number | null };
}
export async function searchFoods(query: string): Promise<UsdaFood[]>;
export async function searchByGtin(barcode: string): Promise<UsdaFood | null>;
```

- Endpoint: `POST https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${process.env.USDA_FDC_API_KEY}`
  with JSON body `{ query, dataType, pageSize }`.
- `searchFoods`: two parallel requests — `dataType: ['Branded']` (pageSize 10)
  and `dataType: ['Foundation', 'SR Legacy']` (pageSize 5) — then interleave
  branded-first (B,G,B,G,… then remainder), cap at 10 results total.
- Nutrient mapping from each hit's `foodNutrients[]` by `nutrientId`:
  1008 → kcal, 1003 → protein, 1005 → carbs, 1004 → fat. Values are per 100g.
  A missing nutrient stays `null` (never 0). Skip hits with no `description`.
- `servingGrams`: only when `servingSizeUnit` (case-insensitive) is `g`, `grm`,
  or `ml`; otherwise null.
- `searchByGtin(barcode)`: `dataType: ['Branded']`, `query` = barcode,
  pageSize 5; return the first hit whose `gtinUpc` equals the barcode when both
  are compared with leading zeros stripped; else null.
- Missing/empty `USDA_FDC_API_KEY` → return `[]` / `null` without fetching.
- Every fetch uses `AbortSignal.timeout(4000)`; any error/timeout/non-OK →
  `[]` / `null` (log via `console.warn`, never throw).

**Tests** (mock `fetch` via `t.mock.method` or module mock, follow an existing
`lib/*.test.ts` for style): nutrient-id mapping incl. missing nutrient → null;
branded/generic interleave order and cap; gtin match with leading-zero
normalization and mismatch → null; missing API key short-circuit; timeout/
non-OK → empty.

**Verify**: `npm test -- lib/nutrition/usda.test.ts` green;
`npx eslint lib/nutrition` clean.

## Task 3: `lib/nutrition/candidates.ts` — unified candidate merge + tests

**Files**: `lib/nutrition/candidates.ts`, `lib/nutrition/candidates.test.ts`.

```ts
export interface Candidate {
  origin: 'history' | 'cache' | 'usda' | 'estimate';
  name: string;
  brand?: string | null;
  kcal: number; c: number; p: number; f: number;   // default-portion totals
  servingDesc?: string | null;
  servingGrams?: number | null;
  per100g?: { kcal: number; c: number; p: number; f: number } | null;
  lastLoggedAt?: string | null;                    // ISO — history only
  slot?: string | null;                            // history only
}
export async function searchCandidates(userId: string, query: string): Promise<Candidate[]>;
```

Sources, merged in this order:

1. **History (always first).** Query `events`: `user_id = userId`,
   `type = 'meal_logged'`, name ILIKE `%query%` where name is
   `COALESCE(payload->>'name', payload->>'description')` (route logs use
   `name`, coach logs use `description`). Escape `%`/`_` in the user query.
   Order `timestamp DESC`, limit 50 rows, then in TS: normalize names
   (lowercase, trim, collapse whitespace), drop empty/`unknown`, dedup keeping
   the most recent row per normalized name (latest macros win — user
   corrections propagate), take 5. Emit with the payload's kcal/c/p/f totals,
   `slot` and timestamp; rank exact normalized-name matches before substring
   matches.
2. **Cache + USDA (provider candidates, cap 10 combined).** In parallel via
   `Promise.allSettled`: (a) `food_cache` where `name ILIKE %query%`, limit 10;
   (b) `searchFoods(query)`. Upsert USDA results into `food_cache`
   (`onConflictDoUpdate` on `(provider, provider_food_id)`, refreshing macros +
   `fetched_at`). Dedup USDA rows against cache rows by
   `(provider, provider_food_id)` — cache row wins position, origin stays
   `'cache'`. Skip provider rows whose kcal is null. Default-portion macros =
   per-serving (`per100g × servingGrams/100`, rounded) when `servingGrams`
   known, else per-100g with `servingDesc ?? '100 g'`.
3. **Estimate (last).** Only when USDA returned nothing OR the query looks like
   a multi-food phrase (`/\d/`, `/\band\b/i`, or `,`): call
   `lookupNutrition(query)` (CalorieNinjas, existing `lib/nutritionix.ts`);
   emit one candidate `{ origin: 'estimate', name: query, … }` carrying its
   totals. Expose the CalorieNinjas per-item `foods` via a second export so the
   route can keep the legacy `items` field:
   `searchCandidates` should therefore actually return
   `{ candidates: Candidate[], estimateFoods: NutritionixResult['foods'] | null }`
   (adjust the signature accordingly).

Also export a pure helper used by the recents route (Task 4):

```ts
export function aggregateRecents(rows: { name: string | null; description: string | null;
  kcal: number; c: number; p: number; f: number; slot: string | null;
  imageThumb: string | null; timestamp: Date }[]): RecentFood[];
```

which normalizes+dedups by name (same rules), keeps latest macros/slot/thumb per
name, counts occurrences, sorts by (count desc, latest timestamp desc), returns
top 12 as `{ name, kcal, c, p, f, slot, lastLoggedAt, imageThumb }`.

Structure the module so the merge/normalization/dedup logic is pure and
unit-testable (e.g. exported `normalizeName`, `dedupHistory`,
`mergeProviderCandidates`, `needsEstimate`, `aggregateRecents`); keep DB/fetch
IO in thin wrappers. History and provider fetches both run under
`Promise.allSettled` — a failed source yields its candidates as absent, never a
thrown error.

**Tests** (pure helpers + mocked usda module where needed): normalization/dedup
(latest wins, junk skipped, exact-before-substring), provider merge dedup by
provider id + null-kcal skip + per-serving scaling, `needsEstimate` triggers
(digits/and/comma/empty USDA), `aggregateRecents` ranking and top-12 cap.

**Verify**: `npm test -- lib/nutrition/candidates.test.ts` green;
`npx eslint lib/nutrition` clean.

## Task 4: Routes — search rework, new recents, barcode rework, env example

**Files**: `app/api/nutrition/search/route.ts`,
`app/api/nutrition/recents/route.ts` (new),
`app/api/nutrition/barcode/route.ts`, `.env.example`.

All three routes resolve the user with `getUserIdFromRequest` exactly the way
`app/api/meals/log/route.ts` does (including its error handling). Keep
`export const dynamic = 'force-dynamic';`.

**search**: keep body validation. Call `searchCandidates(userId, query)`.
- Zero candidates → keep today's 502 `{ error: … }`.
- Else respond `{ name, kcal, c, p, f, items, candidates }` where the flat
  fields mirror `candidates[0]` (name = candidate name, macros = its totals)
  and `items` = the CalorieNinjas `estimateFoods` when present, else `[]`.
  `candidates` is the full array.

**recents** (new `GET /api/nutrition/recents?tz=`): DB-only, no external calls.
Select the user's `meal_logged` events from the last 30 days (cap 500 rows,
newest first), map payload fields (`name`/`description`, kcal, c, p, f, `slot`,
`imageThumb`), run `aggregateRecents`, respond `{ items: RecentFood[] }`.
`tz` is accepted but currently unused (reserved) — don't 400 on it.

**barcode**: keep body validation and the `grams` default of 100. New lookup
order, stopping at first hit:
1. `food_cache` by `barcode` (newest `fetched_at` first) where `kcal_100g` is
   not null → respond from cache.
2. `lookupBarcode` (OFF, unchanged lib) → upsert into `food_cache`
   (provider 'off', provider_food_id = barcode, barcode, name, brand,
   per-100g macros; serving fields null).
3. `searchByGtin(barcode)` (USDA) → upsert (provider 'usda',
   provider_food_id = String(fdcId), barcode, serving fields, macros).
4. Miss → `404` with `{ error: 'Product not found.', offerTextSearch: true }`.

Success response (all sources): legacy fields exactly as today —
`{ name, brand, per100g, grams, kcal, c, p, f }` (macros = per100g × grams/100,
rounded) — plus `servingGrams`, `servingDesc`, and `source: 'cache'|'off'|'usda'`.
Rule: only respond from a source whose kcal is known (null kcal ⇒ try the next
source). Within a responding row, null protein/carbs/fat map to 0 in the legacy
`per100g` object and scaled fields (the legacy shape requires numbers);
`servingGrams`/`servingDesc` stay `null` when unknown.

**.env.example**: add `USDA_FDC_API_KEY=` with a one-line comment
(free key: https://api.data.gov/signup, used for nutrition candidate search).

**Verify**: `npm run lint && npm run build` pass. Add/extend route-level unit
tests only if an existing pattern for route tests exists; otherwise rely on
lib tests + the controller's live end-to-end check.

## Task 5: Coach `log_meal` swap to candidate search

**Files**: `lib/brain/tools.ts` (text path of `log_meal` only, ~line 1134),
optionally a small test if the existing `tools.*.test.ts` pattern fits.

Replace the CalorieNinjas call in the **text path** with
`searchCandidates(userId, text)`:
- Take `candidates[0]` (history-first by construction). If none →  keep the
  current "Could not find nutrition data…" message.
- Insert the `meal_logged` event with the candidate's totals; payload keeps the
  existing shape (`kcal,c,p,f,description:text,source`) with `source` set from
  the candidate origin (`'history'|'cache'|'usda'|'calorieninjas'`); include
  `items` only when estimate foods exist (same formatting as today).
- Tool result JSON: keep `{ ok, query, kcal, c, p, f }`, add
  `matched: candidate.name` and `origin`, keep `foods` only for estimates.
- Barcode digits path unchanged this round.

**Verify**: `npm test -- lib/brain/tools.getSchedule.test.ts` still green (no
regression in shared module), plus any new test; `npm run lint && npm run build`.

## Task 6: iOS — APIClient candidate/recents support

**Files**: `ios/Vital/Sources/Core/APIClient.swift` (+ model files if the
project keeps DTOs separate).

- New Decodable structs matching backend exactly: `NutritionCandidate`
  (`origin, name, brand?, kcal, c, p, f, servingDesc?, servingGrams?,
  per100g?{kcal,c,p,f}, lastLoggedAt?, slot?`) and `RecentFood`
  (`name, kcal, c, p, f, slot?, lastLoggedAt?, imageThumb?`). Optionals must be
  genuinely optional (`Double?`/`String?`) — this client had a per100g decode
  bug before; keep types exact and total macros as the same numeric type used
  by existing nutrition models.
- Extend the existing search response model with `candidates: [NutritionCandidate]?`
  (optional so the app still works against an old server).
- Extend the barcode response model with `servingGrams: Double?`,
  `servingDesc: String?`, `source: String?`; barcode miss now surfaces a
  distinguishable "not found, offer text search" case (404 +
  `offerTextSearch`) instead of a generic error.
- New method `fetchNutritionRecents()` → `GET /api/nutrition/recents`
  (authed like the other GETs) returning `[RecentFood]`.

**Verify**: `cd ios && xcodegen generate && xcodebuild -project Vital.xcodeproj
-scheme Vital -destination 'generic/platform=iOS Simulator' build` (match the
invocation used by this repo's CI/scripts if different).

## Task 7: iOS — Log sheet UX (recents, candidate list, portion controls, barcode fallback)

**Files**: `ios/Vital/Sources/Features/Logging/` (LogMealView/ViewModel and
friends).

- **Recents on open**: fetch recents when the log sheet appears; render as a
  tappable section above the input. Cache the last response (UserDefaults or
  in-memory) so it paints instantly next open, refresh in background. Tap →
  the existing confirm card prefilled with that food's macros, zero network.
- **Candidate list**: text/voice search shows the `candidates` list — history
  items badged ("Logged Jul 12"-style using `lastLoggedAt`), brand + serving
  description as subtitle, kcal trailing. Tap → confirm card via the existing
  `applyResult()` choke point. If the server sent no `candidates` (old
  server), fall back to current single-result behavior.
- **Portion controls on the confirm card** when `servingGrams`/`per100g`
  present: serving multiplier stepper (0.5 steps) or custom grams entry;
  macros recompute locally from per100g. History candidates default to "same
  as last time" (×1 of stored totals). No silent 100g default anywhere.
- **Barcode**: on success show the portion picker (default 1 serving when
  `servingGrams` known, else grams entry). On the new not-found case, show a
  friendly fallback that offers text search (pre-focus the search field)
  instead of a bare error.
- Follow existing SwiftUI patterns/styles in the Logging feature; no new
  dependencies.

**Verify**: `xcodegen generate` + `xcodebuild build` as in Task 6. Simulator QA
is run by the controller afterwards.
