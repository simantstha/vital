# Problem 02 — Barcode scan can't log food (JSON decode type mismatch)

**Status:** ✅ Fixed on branch `fix/barcode-decode-mismatch`
**Reported:** 2026-07-09
**Area:** iOS — `BarcodeResult` decode model vs. backend `/api/nutrition/barcode` payload

**Fix applied:** removed the mistyped `per100g: Bool?` property from
`BarcodeResult` (`APIClient.swift`). The app only uses the already-scaled
top-level `kcal/c/p/f`, and `Decodable` ignores undeclared keys — so the
object-typed `per100g` no longer causes a `typeMismatch`. Verified by decoding a
real backend payload (with `per100g` as an object): decodes cleanly.

---

## Symptom

Scanning a product barcode in Log Food never produces a confirmable meal. The
scan appears to "not work" — no confirm card, food can't be logged. (On a real
device the camera opens and detects the code; it's what happens *after* the scan
that fails.)

## Expected

Scan a barcode → backend looks up Open Food Facts → the confirm card appears
pre-filled with name + macros → user taps "Log Meal".

## Root cause

The iOS decode model declares `per100g` as a **`Bool?`**, but the backend sends
`per100g` as a **macro object**. The plain `JSONDecoder` throws a `typeMismatch`
on that field, which fails the whole `BarcodeResult` decode. Every successful
Open Food Facts lookup is therefore turned into an error before it can be shown.

### Evidence (files + lines)

1. **Backend response — `app/api/nutrition/barcode/route.ts:50-59`** returns
   `per100g` as an object:
   ```ts
   return NextResponse.json({
     name, brand,
     per100g: product.per100g,          // { kcal, c, p, f }  ← OBJECT
     grams,
     kcal, c, p, f,
   });
   ```

2. **iOS model — `ios/Vital/Sources/Core/APIClient.swift:626-635`** declares it
   as a Bool:
   ```swift
   struct BarcodeResult: Decodable {
       let name: String
       let brand: String?
       let kcal: Double
       let c: Double
       let p: Double
       let f: Double
       let per100g: Bool?   // ← WRONG: backend sends an object, not a bool
       let grams: Double?
   }
   ```

3. **Decoder is plain — `APIClient.swift:68`** (`private let decoder =
   JSONDecoder()`), no key/type coercion. For the optional property, Swift
   synthesizes `decodeIfPresent(Bool.self, forKey: .per100g)`. That returns nil
   only if the key is **absent or JSON null**. The backend always sends a
   non-null object, so the decoder attempts `Bool` on an object and **throws
   `typeMismatch`**, failing the entire `BarcodeResult` decode at
   `APIClient.swift:319`.

4. **Error surfaces as a failed scan — `LogMealViewModel.handleBarcode`
   (~lines 131-140):** the thrown decode error is caught and shown as
   `"Barcode lookup failed: …"`; `applyResult(...)` is never reached, so the
   confirm card (`LogMealView.confirmCard`) never renders.

### Not the cause

- **Camera / permissions are fine.** `NSCameraUsageDescription` is present in
  both `ios/Vital/Sources/App/Info.plist:32-33` and `ios/Vital/project.yml:66`.
- **Scanner is fine.** `BarcodeScannerView` (VisionKit `DataScannerViewController`,
  `LogMealView.swift:583-632`) guards on `isSupported`, single-fires via
  `didScan`, and calls back with the payload string.
- **Backend / Open Food Facts is fine.** `lib/openFoodFacts.ts` `lookupBarcode`
  returns per-100g macros; route scales by grams. A not-found product returns
  502 (a *different*, correctly-surfaced error) — but a *found* product still
  fails on the iOS side due to the type mismatch.

## Proposed fix (for the fix session — do NOT implement yet)

The client only consumes the already-scaled top-level `kcal/c/p/f`. Two options:

- **Simplest:** change `per100g` in `BarcodeResult` to match the payload — either
  a nested `struct Per100g: Decodable { let kcal, c, p, f: Double }` typed field,
  or drop the property entirely (the app doesn't use it). Dropping an unused key
  is safe: `Decodable` ignores keys it doesn't declare.
- Confirm no other call site reads `BarcodeResult.per100g` (grep shows the app
  uses the scaled top-level macros via `applyResult`).

### Files likely touched
- `ios/Vital/Sources/Core/APIClient.swift` (`BarcodeResult` definition, ~626)
- (Optional) tighten backend/iOS contract so the served shape and the model
  can't silently diverge again.

## Verification plan (after fix)
- On a real device, scan a known product (e.g. a common packaged good with an
  Open Food Facts entry) and confirm the confirm card appears pre-filled and
  "Log Meal" succeeds.
- Decode a captured sample response in a unit test / playground to confirm
  `BarcodeResult` decodes without throwing.
- Scan an unknown barcode and confirm the 502 path still shows a clean
  "product not found" style message (unchanged behavior).
