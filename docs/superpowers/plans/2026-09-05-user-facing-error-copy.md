# Stop showing users our error strings

**Date:** 2026-09-05
**Branch:** `fix/user-facing-errors` (off `main` — #145 and #146 are merged and verified on main)
**Source:** `docs/audits/2026-08-31-product-audit.md` P0 #4
**Auto-mergeable:** iOS presentation only. No schema, no backend, no prompts, no health calculations.

27 call sites in `ios/Vital/Sources/Features/` pipe `error.localizedDescription` straight into
user-visible copy. PR #146 made this worse rather than better: a failed load on Today now renders
the `ErrorCard` as the *entire screen* instead of one card among content, so
`"Server returned HTTP 500."` is the most prominent thing on the user's daily-moment screen.

## What's actually broken

`APIClient.swift:910-936` — `APIError` is already `LocalizedError`, and **most of its cases are
fine.** `.barcodeNotFound`, `.whoopAuthorizeURLMissing`, and `.whoopConnectFailed` are already
written for humans. Only two leak:

- `.invalidURL` → `"Invalid backend URL."` — the user has no backend and no URL.
- `.serverError(Int)` → `"Server returned HTTP \(c)."` — a status code is not a message.

The larger surface is **non-`APIError` errors reaching the same call sites.** `localizedDescription`
on a `DecodingError` produces `"The data couldn't be read because it isn't in the correct format."`
That is Apple's copy for a developer, shown to someone who just wanted to see their sleep score.

`.coachStreamError(String)` passes a **server-supplied string** through to the UI unmodified.
Treat backend text as untrusted for presentation.

## The change

**1. One mapping, not 27 edits.** Add a single presentation-layer helper that maps any `Error` to
user-facing copy. Call sites go from `error.localizedDescription` to that helper. Do not hand-write
27 different strings — that guarantees drift.

**2. The mapping must distinguish cases the user can act on differently:**

| Situation | Why it's distinct |
|---|---|
| Offline / no connection | The user can fix this. Say so. `URLError` already carries this. |
| Server failure (5xx) | Our problem. Retry is the right affordance; the user can't fix it. |
| Auth / session expired | Needs sign-in, not retry — a retry button here is a dead end. |
| Decoding / unexpected shape | A bug. Generic copy, but it must be logged loudly. |

Collapsing all of these into one generic string is a regression in a different direction — it
would make a fixable problem (airplane mode) look identical to an outage.

**3. Do not lose diagnosability.** Users get friendly copy; the raw underlying error must still
reach the existing `print("[Vital] ...")` logging with full detail. If a fix makes production
failures harder to debug, it is not a fix. Keep the raw string available on the error value even
when the displayed copy is generic.

## Copy constraint — this is the trust-killer, read it carefully

**Never assert an outcome we cannot verify.** A failed *read* may safely say the user's data is
intact. A failed *write* may not — if logging a meal fails, telling the user "your data is safe"
implies the meal was saved when it was not. That is exactly the fabricated-certainty class of bug
this project treats as release-blocking.

Read-path and write-path failures need different copy. `MealDetailViewModel.swift:57,76,96,120`
and `resolveFact` are write paths. `TodayViewModel.loadTodayResponse` is a read path.

Keep copy short, plain, and non-apologetic. Follow the existing `—` / sentence-case idiom already
in `ErrorCard` and `CautionBanner`. No exclamation marks, no "Oops".

## Out of scope

- P0 #5 (HealthKit denial dead end) — separate change.
- `matchedGeometryEffect` on Trends — separate change.
- Any backend, schema, or `fly.toml` change. Do not alter what the server *sends*; this is about
  what the client *shows*.
- Do not change the tri-state machine from #146. This changes the message inside `.failed`, not
  when `.failed` is entered.

## Verification

- Build and test: `xcodebuild -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,id=A51CC39E-580F-4ED3-AF06-214AB94E3DD4' test`
- Baseline is **341 tests, 0 failures** on `main` as of this branch point. Must stay green.
- New tests must pin behavior: a `URLError.notConnectedToInternet` produces connection copy, not
  server copy; a 500 produces neither a status code nor a raw string; a `DecodingError` produces
  generic copy **and** still logs detail; no user-facing string contains `"HTTP"`, a bare status
  code, or the words "decode"/"JSON"/"URL".
- That last one is worth writing as an actual assertion over the mapping's outputs rather than
  checking by eye — it will catch the next person who adds a case.
