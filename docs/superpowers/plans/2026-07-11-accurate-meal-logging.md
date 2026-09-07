# Accurate Meal Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make meal logging safe and retry-proof first, then progressively improve nutrition accuracy through explicit portions, item-level provenance, trusted sources, personal corrections, and recipes.

**Architecture:** Keep the append-only `events` ledger as the canonical meal history, but introduce a versioned item-level meal payload and a shared server-side validation/calculation boundary. Identification (Claude/text/photo), nutrient evidence (USDA/manufacturer/Open Food Facts), and consumed quantity are separate concerns; Claude may suggest candidates but never supplies authoritative nutrition without an explicit `estimated` quality label.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Drizzle/Postgres, Node test runner, Swift 5/SwiftUI, XCTest, USDA FoodData Central API, branded/manufacturer data, Open Food Facts.

## Global Constraints

- Deliver the initial release as the smallest high-impact slice: idempotency, strict validation, fast database-only saves, explicit coach confirmation, and mandatory portion confirmation.
- Never silently assume 100 g. Missing quantity is a validation error or an explicitly approximate draft requiring confirmation.
- The server computes persisted meal totals from item quantities and nutrient references; clients never author authoritative totals after Phase 2.
- Unknown nutrients are `null`, never `0`.
- Nutrition source priority is: user-verified personal entry → exact manufacturer/branded record → USDA FoodData Central generic record → Open Food Facts barcode fallback → AI/photo estimate.
- Claude is used for identification, candidate generation, and optional coaching only; it is not on the meal-save critical path.
- Preserve the append-only event model: corrections, undo, and deletion are compensating events, not destructive updates.
- Every write endpoint accepts an idempotency key scoped to the authenticated user.
- Never push directly to `main`; each phase is implemented on a feature branch, committed, pushed, and opened as a PR for user review.

## File Map

- `lib/meals/contracts.ts`: versioned meal draft, item, provenance, quantity, and measurement-quality types.
- `lib/meals/validate.ts`: strict request validation and numeric limits shared by all meal writers.
- `lib/meals/calculate.ts`: server-side item scaling and total calculation with null propagation.
- `lib/meals/repository.ts`: idempotent append-only meal and correction event writes.
- `lib/nutrition/providers/*.ts`: provider adapters and source-priority orchestration.
- `app/api/meals/log/route.ts`: thin authenticated persistence endpoint.
- `app/api/nutrition/*/route.ts`: candidate lookup endpoints; never persist meals.
- `app/api/coach/route.ts`: produces a confirmable draft and writes only after explicit confirmation.
- `ios/Vital/Sources/Core/APIClient.swift`: versioned API contracts and idempotency keys.
- `ios/Vital/Sources/Features/Logging/*`: portion confirmation, item editing, quality labels, and save states.
- `db/schema.ts` and a generated `db/migrations/0005_*.sql`: idempotency support and personal-food records.

---

## Phase 1 — Simple, High-Impact Safety and Portion Accuracy

### Task 1: Add strict meal-input validation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/meals/validate.ts`
- Create: `lib/meals/validate.test.ts`
- Modify: `app/api/meals/log/route.ts`

**Interfaces:**
- Produces: `parseLegacyMealLog(input: unknown): LegacyMealLog`, throwing `MealValidationError` with field-specific messages.
- Numeric policy: `0 <= kcal <= 10000`, `0 <= c/p/f <= 2000`; name length `1...200`; source length `1...50`; `imageThumb` maximum 256 KiB encoded.

- [ ] **Step 1: Add the TypeScript test runner**

Run: `npm install --save-dev tsx`
Expected: `tsx` is recorded in `devDependencies` and the lockfile is updated.

- [ ] **Step 2: Write failing validation tests**

```ts
test('rejects negative, non-finite, and implausibly large nutrition', () => {
  for (const kcal of [-1, Number.NaN, Number.POSITIVE_INFINITY, 10001]) {
    assert.throws(() => parseLegacyMealLog({ name: 'Lunch', kcal, c: 20, p: 30, f: 10, source: 'text' }), MealValidationError);
  }
});

test('accepts finite nutrition inside documented limits', () => {
  assert.equal(parseLegacyMealLog({ name: 'Lunch', kcal: 650, c: 70, p: 40, f: 20, source: 'text' }).kcal, 650);
});
```

- [ ] **Step 3: Run the tests and verify failure**

Run: `npx tsx --test lib/meals/validate.test.ts`
Expected: FAIL because `lib/meals/validate.ts` does not exist.

- [ ] **Step 4: Implement the validator and replace `isValidBody`**

```ts
export class MealValidationError extends Error {}

export function boundedNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new MealValidationError(`${field} must be a finite number from 0 to ${max}.`);
  }
  return value;
}
```

Parse strings with trimmed length limits, validate the optional thumbnail size, and make the route return status `400` with `{ error }` for `MealValidationError`.

- [ ] **Step 5: Run focused and project checks**

Run: `npx tsx --test lib/meals/validate.test.ts && npm run lint`
Expected: all tests PASS and ESLint exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/meals/validate.ts lib/meals/validate.test.ts app/api/meals/log/route.ts
git commit -m "fix: validate meal nutrition inputs"
```

### Task 2: Make meal saves idempotent and database-only

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/0005_meal_idempotency.sql`
- Create: `lib/meals/repository.ts`
- Create: `lib/meals/repository.test.ts`
- Modify: `app/api/meals/log/route.ts`

**Interfaces:**
- Consumes: `LegacyMealLog` from Task 1.
- Produces: `appendMealOnce(userId: string, idempotencyKey: string, meal: LegacyMealLog): Promise<{ eventId: string; duplicate: boolean }>`.
- Response: `{ ok: true, eventId: string, duplicate: boolean }`; remove `coachReaction`.

- [ ] **Step 1: Write failing repository tests**

```ts
test('the same user and idempotency key returns the original event', async () => {
  const first = await repository.appendMealOnce(userId, 'request-1', meal);
  const retry = await repository.appendMealOnce(userId, 'request-1', meal);
  assert.equal(retry.eventId, first.eventId);
  assert.equal(retry.duplicate, true);
  assert.equal(fakeDb.events.length, 1);
});
```

Also assert that the same key for two users does not collide and a missing/blank key is rejected by the route.

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx tsx --test lib/meals/repository.test.ts`
Expected: FAIL because `appendMealOnce` is not defined.

- [ ] **Step 3: Add structural idempotency**

Add nullable `idempotency_key` to `events`, then a partial unique index:

```sql
ALTER TABLE "events" ADD COLUMN "idempotency_key" text;
CREATE UNIQUE INDEX "events_user_idempotency_idx"
  ON "events" ("user_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
```

Mirror this in `db/schema.ts`. Implement insert-on-conflict handling followed by a scoped lookup of the existing event.

- [ ] **Step 4: Remove Claude from the save route**

Delete the Anthropic client, `assembleContext`, and coach-reaction call from `app/api/meals/log/route.ts`. Read `Idempotency-Key`, call `appendMealOnce`, and return immediately after persistence.

- [ ] **Step 5: Verify migration, tests, and build**

Run: `npx tsx --test lib/meals/repository.test.ts && npm run lint && npm run build`
Expected: tests PASS, lint exits 0, and Next.js build succeeds without Anthropic usage in the save route.

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations/0005_meal_idempotency.sql lib/meals/repository.ts lib/meals/repository.test.ts app/api/meals/log/route.ts
git commit -m "fix: make meal saves idempotent"
```

### Task 3: Make iOS retries safe and reject invalid numeric text

**Files:**
- Modify: `ios/Vital/Sources/Core/APIClient.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealViewModel.swift`
- Modify: `ios/Vital/Sources/Features/Today/MealDetailViewModel.swift`
- Create: `ios/Vital/Tests/LogMealViewModelTests.swift`

**Interfaces:**
- Consumes: Phase 1 response `{ ok, eventId, duplicate }`.
- Produces: `APIClient.logMeal(..., idempotencyKey: UUID)` and a stable key retained for one logical submit until success or draft reset.

- [ ] **Step 1: Add failing XCTest cases**

```swift
func testInvalidNumericTextDoesNotBecomeZero() async {
    viewModel.editedKcal = "six hundred"
    await viewModel.logMeal()
    XCTAssertEqual(viewModel.errorMessage, "Enter a valid calorie value.")
    XCTAssertEqual(api.logMealCallCount, 0)
}

func testRetryReusesIdempotencyKey() async {
    await viewModel.logMeal()
    await viewModel.logMeal()
    XCTAssertEqual(api.seenIdempotencyKeys.count, 2)
    XCTAssertEqual(api.seenIdempotencyKeys[0], api.seenIdempotencyKeys[1])
}
```

- [ ] **Step 2: Run XCTest and verify failure**

Run: `xcodegen generate --spec ios/Vital/project.yml && xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: FAIL because invalid text currently becomes zero and no idempotency key is sent.

- [ ] **Step 3: Implement strict local parsing and stable keys**

Use `guard let` for every numeric field, reject negative values, attach `Idempotency-Key` in `APIClient`, keep the UUID through transient failures, and generate a new UUID only when the draft changes after a successful save or is reset. Remove `coachReaction` from `LogMealResponse` and the logging UI state.

- [ ] **Step 4: Run XCTest**

Run: `xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: all VitalTests PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/Vital/Sources/Core/APIClient.swift ios/Vital/Sources/Features/Logging/LogMealViewModel.swift ios/Vital/Sources/Features/Today/MealDetailViewModel.swift ios/Vital/Tests/LogMealViewModelTests.swift
git commit -m "fix: make iOS meal retries safe"
```

### Task 4: Require explicit portion confirmation and coach confirmation

**Files:**
- Modify: `app/api/nutrition/barcode/route.ts`
- Modify: `app/api/nutrition/search/route.ts`
- Modify: `app/api/coach/route.ts`
- Modify: `lib/brain/coach.ts`
- Modify: `ios/Vital/Sources/Core/APIClient.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealViewModel.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealView.swift`
- Create: `app/api/nutrition/barcode/route.test.ts`
- Create: `ios/Vital/Tests/MealPortionConfirmationTests.swift`

**Interfaces:**
- Nutrition candidates return `portionRequired: true`, `referenceGrams`, and unscaled nutrient evidence.
- Coach produces a pending meal draft; only an explicit user confirmation invokes the same idempotent repository used by `/api/meals/log`.

- [ ] **Step 1: Write failing route and UI tests**

```ts
test('barcode lookup without grams never returns a fabricated 100 g consumed total', async () => {
  const response = await POST(request({ barcode: '0123456789012' }));
  const body = await response.json();
  assert.equal(body.portionRequired, true);
  assert.equal(body.grams, null);
  assert.equal(body.kcal, null);
});
```

```swift
func testCandidateCannotBeSavedUntilPortionIsConfirmed() {
    viewModel.apply(candidateWithNoConsumedQuantity)
    XCTAssertFalse(viewModel.canLogMeal)
}
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx --test app/api/nutrition/barcode/route.test.ts`
Expected: FAIL because barcode currently defaults to 100 g.

- [ ] **Step 3: Remove all implicit portion defaults**

When grams are absent, return nutrient reference data but `grams/kcal/c/p/f: null`. Text search must flag parser-defaulted quantities as requiring confirmation. The iOS confirmation card must require grams or a serving count plus grams-per-serving before enabling **Log Meal**.

- [ ] **Step 4: Gate coach writes behind explicit confirmation**

Change the coach tool flow from immediate `meal_logged` insertion to a pending draft response. A subsequent affirmative confirmation uses `appendMealOnce`; cancellation discards the draft. Do not create an event from food-identification language alone.

- [ ] **Step 5: Run full Phase 1 verification**

Run: `npx tsx --test 'lib/**/*.test.ts' 'app/**/*.test.ts' && npm run lint && npm run build`
Expected: all backend tests PASS, lint exits 0, build succeeds.

Run: `xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: all VitalTests PASS.

- [ ] **Step 6: Commit and open the Phase 1 PR**

```bash
git add app/api/nutrition app/api/coach/route.ts lib/brain/coach.ts ios/Vital/Sources ios/Vital/Tests
git commit -m "feat: require meal portion confirmation"
git push -u origin HEAD
gh pr create --base main --title "feat: make meal logging safe and portion-aware" --body "Phase 1 adds strict validation, idempotent saves, explicit coach confirmation, and removes silent 100 g portions."
```

## Phase 2 — Item-Level Drafts, Provenance, and Trusted Sources

### Task 5: Define the versioned item-level meal contract and calculator

**Files:**
- Create: `lib/meals/contracts.ts`
- Create: `lib/meals/calculate.ts`
- Create: `lib/meals/calculate.test.ts`
- Modify: `lib/meals/validate.ts`
- Modify: `lib/meals/repository.ts`
- Modify: `app/api/meals/log/route.ts`

**Interfaces:**
- Produces: `MealDraftV2`, `MealItemV2`, `NutrientEvidence`, `ConsumedQuantity`, `MeasurementQuality` (`verified_weighed | verified_serving | estimated_portion | photo_estimate`).
- Produces: `calculateMeal(items: MealItemV2[]): MealTotals`, with each macro typed `number | null`.

- [ ] **Step 1: Write failing calculation tests**

```ts
test('scales per-100-g evidence by consumed grams', () => {
  const result = calculateMeal([item({ quantity: { grams: 150 }, evidence: { referenceGrams: 100, kcal: 200, proteinG: 20 } })]);
  assert.equal(result.kcal, 300);
  assert.equal(result.proteinG, 30);
});

test('keeps an unknown nutrient null instead of inventing zero', () => {
  assert.equal(calculateMeal([item({ evidence: { referenceGrams: 100, kcal: 80, proteinG: null } })]).proteinG, null);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test lib/meals/calculate.test.ts`
Expected: FAIL because the calculator does not exist.

- [ ] **Step 3: Implement contracts and calculation**

Persist payload version `2`, item-level consumed quantity, source/provider ID, lookup timestamp, preparation state, evidence reference amount, calculated item totals, overall totals, and measurement quality. Validate all item inputs and ignore any client-submitted total in favor of server calculation.

- [ ] **Step 4: Preserve read compatibility**

Keep existing `meal_logged` consumers able to read v1 payloads while all new writes produce v2. Add fixture tests for both versions.

- [ ] **Step 5: Verify and commit**

Run: `npx tsx --test lib/meals/*.test.ts && npm run lint && npm run build`
Expected: PASS and successful build.

```bash
git add lib/meals app/api/meals/log/route.ts
git commit -m "feat: add item-level meal evidence"
```

### Task 6: Add source-prioritized nutrition providers and retire CalorieNinjas

**Files:**
- Create: `lib/nutrition/providers/types.ts`
- Create: `lib/nutrition/providers/usda.ts`
- Create: `lib/nutrition/providers/branded.ts`
- Create: `lib/nutrition/providers/openFoodFacts.ts`
- Create: `lib/nutrition/search.ts`
- Create: `lib/nutrition/search.test.ts`
- Modify: `app/api/nutrition/search/route.ts`
- Modify: `app/api/nutrition/barcode/route.ts`
- Modify: `.env.example`
- Delete: `lib/nutritionix.ts`

**Interfaces:**
- Produces: `searchNutrition(query, userId): Promise<NutritionCandidate[]>` ordered by personal → branded → USDA → Open Food Facts.
- `NutritionCandidate` always includes `provider`, `providerFoodId`, `referenceQuantity`, `nutrients`, `retrievedAt`, and `measurementQuality`.

- [ ] **Step 1: Write failing provider-priority tests**

```ts
test('prefers an exact branded result over generic and OFF candidates', async () => {
  const results = await searchNutrition('0123456789012', userId, providers);
  assert.deepEqual(results.map(r => r.provider), ['manufacturer', 'usda', 'open_food_facts']);
});
```

Cover USDA unit conversion, nullable missing nutrients, provider timeout isolation, and no automatic selection when candidates conflict.

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test lib/nutrition/search.test.ts`
Expected: FAIL because provider adapters do not exist.

- [ ] **Step 3: Implement USDA and fallback adapters**

Use `USDA_FDC_API_KEY`; map FoodData Central Foundation/FNDDS foods for generic searches and branded/manufacturer data for packaged foods. Use Open Food Facts only when higher-priority exact barcode data is absent. Keep network clients injectable for deterministic tests.

- [ ] **Step 4: Remove CalorieNinjas**

Replace every `lookupNutrition` import, delete `lib/nutritionix.ts`, remove its API key documentation, and verify `rg -n "CalorieNinjas|CALORIE_NINJAS|nutritionix" . --glob '!docs/**'` returns no matches.

- [ ] **Step 5: Verify and commit**

Run: `npx tsx --test lib/nutrition/*.test.ts && npm run lint && npm run build`
Expected: PASS, with no live network required by tests.

```bash
git add lib/nutrition app/api/nutrition .env.example
git rm lib/nutritionix.ts
git commit -m "feat: prioritize trusted nutrition sources"
```

### Task 7: Add the unified iOS item draft and measurement-quality UI

**Files:**
- Modify: `ios/Vital/Sources/Core/APIClient.swift`
- Create: `ios/Vital/Sources/Features/Logging/MealDraft.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealViewModel.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealView.swift`
- Create: `ios/Vital/Tests/MealDraftTests.swift`

**Interfaces:**
- Consumes: `MealDraftV2` candidate and save contracts.
- Produces: a single item editor shared by text, barcode, voice, and photo entry with visible provider and quality labels.

- [ ] **Step 1: Add failing model tests**

```swift
func testUnknownProteinRemainsNil() throws {
    let draft = try decoder.decode(MealDraft.self, from: fixture("meal-with-unknown-protein"))
    XCTAssertNil(draft.items[0].nutrients.proteinG)
}

func testPhotoEstimateDisplaysApproximateLabel() {
    XCTAssertEqual(MeasurementQuality.photoEstimate.displayName, "Rough estimate")
}
```

- [ ] **Step 2: Run and verify failure**

Run: `xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: FAIL because v2 draft types are absent.

- [ ] **Step 3: Implement unified draft editing**

Decode item-level evidence, let users choose a candidate and edit grams/servings, show `Verified · weighed`, `Verified · serving`, `Estimated portion`, or `Rough estimate`, and submit items rather than editable aggregate totals.

- [ ] **Step 4: Verify and commit**

Run: `xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: all VitalTests PASS.

```bash
git add ios/Vital/Sources/Core/APIClient.swift ios/Vital/Sources/Features/Logging ios/Vital/Tests/MealDraftTests.swift
git commit -m "feat: unify item-level meal confirmation"
```

## Phase 3 — Personal Verification and Corrections

### Task 8: Add personal verified foods and append-only meal corrections

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/0006_personal_foods.sql`
- Create: `lib/meals/personalFoods.ts`
- Create: `lib/meals/personalFoods.test.ts`
- Create: `app/api/meals/[eventId]/route.ts`
- Create: `app/api/meals/[eventId]/route.test.ts`
- Modify: `lib/nutrition/search.ts`
- Modify: `ios/Vital/Sources/Core/APIClient.swift`
- Modify: `ios/Vital/Sources/Features/Logs/LogsViewModel.swift`
- Modify: `ios/Vital/Sources/Features/Logs/LogsView.swift`

**Interfaces:**
- Produces: user-scoped `personal_foods` records with evidence and verification timestamps.
- Produces: `meal_corrected` and `meal_voided` events referencing the original `meal_logged` event; `POST /undo` creates the inverse compensating event.

- [ ] **Step 1: Write failing personal-priority and correction tests**

```ts
test('a user verified food is ranked before external providers', async () => {
  assert.equal((await searchNutrition('morning oats', userId))[0].provider, 'personal');
});

test('voiding a meal appends an event and leaves the original untouched', async () => {
  await voidMeal(userId, mealEventId, 'undo-key');
  assert.equal(fakeDb.originalDeleted, false);
  assert.equal(fakeDb.events.at(-1)?.type, 'meal_voided');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test lib/meals/personalFoods.test.ts app/api/meals/'[eventId]'/route.test.ts`
Expected: FAIL because personal foods and correction routes are absent.

- [ ] **Step 3: Implement migration and backend**

Store normalized names, optional barcode, item evidence, last-verified timestamp, and user ID. Resolve effective meal state by applying correction/void events in timestamp order. Apply the same idempotency and ownership checks as logging.

- [ ] **Step 4: Add edit, delete, and undo UI**

Expose correction from the meal log, label destructive UI as **Remove from diary**, and offer a short-lived **Undo** action that appends a compensating event.

- [ ] **Step 5: Verify and commit**

Run: `npx tsx --test lib/meals/*.test.ts app/api/meals/**/*.test.ts && npm run lint && npm run build`
Expected: backend PASS.

Run: `xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: iOS PASS.

```bash
git add db/schema.ts db/migrations/0006_personal_foods.sql lib/meals app/api/meals ios/Vital/Sources ios/Vital/Tests
git commit -m "feat: add verified foods and meal corrections"
```

## Phase 4 — Recipes and Honest Photo Estimates

### Task 9: Add weighed recipes with yield-based servings

**Files:**
- Create: `lib/meals/recipes.ts`
- Create: `lib/meals/recipes.test.ts`
- Modify: `app/api/meals/recipe/route.ts`
- Modify: `ios/Vital/Sources/Core/APIClient.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealViewModel.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealView.swift`
- Create: `ios/Vital/Tests/RecipeCalculationTests.swift`

**Interfaces:**
- Produces: recipe drafts containing ingredient evidence, raw/cooked state, ingredient weights, final cooked yield grams, and consumed serving grams.
- Formula: `consumed nutrient = total ingredient nutrient × consumed serving grams / final cooked yield grams`.

- [ ] **Step 1: Write failing yield tests**

```ts
test('scales a cooked recipe by final yield weight', () => {
  const recipe = calculateRecipe({ ingredientTotals: { kcal: 1200 }, yieldGrams: 900, consumedGrams: 300 });
  assert.equal(recipe.kcal, 400);
});
```

Reject zero/negative yield, absent ingredient quantity, and raw/cooked ambiguity when the selected USDA records differ.

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test lib/meals/recipes.test.ts`
Expected: FAIL because recipe calculation is absent.

- [ ] **Step 3: Implement backend and recipe editor**

Require every ingredient quantity, include oils/sauces as ordinary ingredients, require final yield or an explicit number of equal servings, and persist the same provenance fields as standalone foods.

- [ ] **Step 4: Verify and commit**

Run: `npx tsx --test lib/meals/recipes.test.ts && npm run lint && npm run build`
Expected: backend PASS.

Run: `xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: iOS PASS.

```bash
git add lib/meals/recipes.ts lib/meals/recipes.test.ts app/api/meals/recipe/route.ts ios/Vital/Sources ios/Vital/Tests/RecipeCalculationTests.swift
git commit -m "feat: calculate recipes by cooked yield"
```

### Task 10: Make photo-only logging explicitly approximate

**Files:**
- Modify: `app/api/nutrition/photo/route.ts`
- Create: `app/api/nutrition/photo/route.test.ts`
- Modify: `ios/Vital/Sources/Features/Logging/MealDraft.swift`
- Modify: `ios/Vital/Sources/Features/Logging/LogMealView.swift`
- Create: `ios/Vital/Tests/PhotoEstimateTests.swift`

**Interfaces:**
- Photo endpoint produces identification candidates plus `measurementQuality: 'photo_estimate'` and optional calorie/macro ranges; it never marks a point estimate as verified.

- [ ] **Step 1: Write failing approximation tests**

```ts
test('photo fallback cannot return verified nutrition', async () => {
  const result = await classifyPhoto(photoFixture);
  assert.equal(result.measurementQuality, 'photo_estimate');
  assert.ok(result.energyRangeKcal.min < result.energyRangeKcal.max);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test app/api/nutrition/photo/route.test.ts`
Expected: FAIL because the current fallback returns exact-looking totals.

- [ ] **Step 3: Implement honest ranges and upgrade path**

Render `Approximately 600–800 kcal` for unmeasured photo results, require confirmation before saving, and let the user upgrade quality by selecting trusted food records and entering grams. Persist the original photo-estimate quality when no upgrade occurs.

- [ ] **Step 4: Run final verification**

Run: `npx tsx --test 'lib/**/*.test.ts' 'app/**/*.test.ts' && npm run lint && npm run build`
Expected: all backend tests PASS, lint exits 0, and production build succeeds.

Run: `xcodegen generate --spec ios/Vital/project.yml && xcodebuild test -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`
Expected: all VitalTests PASS.

Run: `rg -n "default.*100|grams.*100|coachReaction|CalorieNinjas|CALORIE_NINJAS" app lib ios/Vital/Sources`
Expected: no silent 100 g default, save-path coach reaction, or CalorieNinjas dependency remains.

- [ ] **Step 5: Commit and open the final phase PR**

```bash
git add app/api/nutrition/photo/route.ts app/api/nutrition/photo/route.test.ts ios/Vital/Sources/Features/Logging ios/Vital/Tests/PhotoEstimateTests.swift
git commit -m "feat: label photo nutrition as approximate"
git push -u origin HEAD
gh pr create --base main --title "feat: complete accurate meal logging" --body "Adds verified foods, corrections, weighed recipes, and honest photo-estimate ranges."
```

## Explicit Non-Goals

- Do not claim clinical, laboratory, or metabolic-wearable precision.
- Do not infer absorbed calories, digestion, or individual metabolic response.
- Do not require weighing every meal in the default experience; strict weighing is an opt-in high-accuracy behavior, while every unweighed result remains visibly estimated.
- Do not build micronutrient targets, restaurant menu partnerships, label OCR, or crowdsourced global food editing in these phases.
- Do not train a custom vision model or use user corrections to modify shared provider data.
- Do not destructively update or delete ledger events.
- Do not make coach prose a prerequisite for successful logging.

## Release Sequence

1. Ship Phase 1 independently; it fixes duplicate writes, invalid numbers, blocking Claude calls, premature coach writes, and the silent 100 g error without waiting for a new food database.
2. Ship Phase 2 behind a server capability/version check so older clients can continue reading v1 events during rollout.
3. Ship Phase 3 after effective-event resolution is used consistently by Today, Logs, context assembly, and profile counts.
4. Ship Phase 4 after item-level provenance and null-aware calculations are stable.
5. For each phase: create a feature branch, commit in the task-sized increments above, push, open a PR, and stop for user review; merging to `main` triggers the automatic backend and TestFlight release workflow.
