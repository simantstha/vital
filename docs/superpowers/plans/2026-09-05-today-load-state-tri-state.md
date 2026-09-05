# Give Today a real load state

**Date:** 2026-09-05
**Branch:** `fix/today-load-state` (off `main` — PR #145 is open and unrelated, do not stack)
**Source:** `docs/audits/2026-08-31-product-audit.md` P0 #3, plus the motion polish the user asked for
**Auto-mergeable:** iOS presentation only. No schema, no backend, no prompts, no health calculations.

Two things that look separate are the same defect: a server outage renders identically to
"you have no data," and the screen pops from a bare spinner to fully-formed content. Both come
from `isLoading: Bool` + `errorMessage: String?` being unable to express what actually happened.

## The current state

`TodayViewModel.swift:87-88`:

```swift
@Published var isLoading = true
@Published var errorMessage: String? = nil
```

`TodayView.swift:40` gates on `vm.isLoading` — spinner if true, **everything** if false. When a
load fails, `isLoading` is false, so the view renders `ErrorCard` *and then* the calibration card,
the metrics grid with `—` placeholders, the fuel strip, and so on. The user sees an error message
stacked on top of a confident-looking empty dashboard. That is the contradiction P0 #3 describes.

## The change

**1. Replace the boolean with a state enum.** Something like:

```swift
enum LoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}
```

Derive it in the view model; do not leave `isLoading` and the enum both live as independent
sources of truth. If `isLoading` is still needed by an existing call site, make it a computed
property over the enum rather than a stored `@Published`.

**2. `.failed` must not render empty content underneath.** This is the actual P0 fix. But apply
it with a rule, not a blanket blank-out — see "Partial failures" below.

**3. `.loading` renders a skeleton in the shape of the content, not a centered spinner.**
`SkeletonView` already exists and `TrendsView.swift:163` consumes it. Today's skeleton should
mirror Today's real geometry: a coach-bubble block, the 2-up metrics grid, and the fuel strip.
Reuse or generalize `SkeletonView` rather than writing a second placeholder idiom.

## Partial failures — read this before writing the enum

`loadTodayResponse()` and `loadPlanResponse()` are **independent fetches that both write to the
same `errorMessage`**. If the plan request fails but the today request succeeded, the user still
has real HRV, sleep, and resting-HR data on hand.

Blanking the screen in that case would be a regression — it would hide real data behind an error,
which is its own species of lying about state.

The rule: **`.failed` replaces the content only when there is no content to show.** If some data
loaded, render the data and surface the failure as a non-blocking affordance instead. Decide
where that line sits based on what the fetches actually populate, and write a test that pins it —
a partial failure must not blank a screen that has real numbers on it.

## Motion constraints — non-negotiable, these are established policy

- **No shimmer. No `repeatForever`.** `SkeletonView`'s doc comment and the `Theme.Motion` policy
  both forbid ambient loops; a static `.redacted(reason: .placeholder)` shape communicates
  loading without one. Do not add a gradient sweep.
- **Never animate a `.refreshable` container.** `TodayView` is `.refreshable`, and this repo has
  been bitten by this before. `loadHealthData()` already wraps the state flip in
  `withAnimation(Theme.Motion.appear)` — keep the animation on the *state value*, do not attach
  `.animation()` to the scroll view or its container.
- Use the existing named curves in `Theme.Motion`. Do not introduce new durations.
- The loading → loaded transition should cross-fade via the existing `.motionTransition(.fade)`,
  which already degrades to opacity under Reduce Motion.

## Also fix while you are here

`SkeletonView.swift`'s doc comment ends with "Not yet consumed by any screen." That is stale —
`TrendsView.swift:163` consumes it. Correct the comment.

## Out of scope

- `matchedGeometryEffect` / shared-element transitions on Trends. Separate change, deliberately
  deferred.
- P0 #4 (raw error strings like `"Server returned HTTP 500."` shown to users) and P0 #5 (HealthKit
  denial dead end). This PR changes *when* an error renders, not *what the copy says* — resist
  rewriting error copy here, it belongs with #4.
- Any backend, schema, or `fly.toml` change.

## Verification

- Build: `xcodebuild -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,id=A51CC39E-580F-4ED3-AF06-214AB94E3DD4' build`
- Test: same command with `test`. The suite is ~331 tests and must stay green.
- **PR #145 is not merged**, so the `Task.yield()` flakiness fix is NOT on `main`. If you hit an
  intermittent failure in `CoachSpecialistStateTests` or `TrendsSummaryTests`, that is the known
  pre-existing flake — report it, do not "fix" it here and do not paper over it.
- New tests must cover behavior, not storage: a failed load with no data renders the error and
  **not** the empty dashboard; a partial failure still renders the data it has; `.loading` renders
  placeholders rather than real-looking zeros.
