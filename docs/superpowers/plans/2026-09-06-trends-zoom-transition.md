# Make a Trends tile grow into its detail view

**Date:** 2026-09-06
**Branch:** `feat/trends-zoom-transition` (off `main`)
**Source:** the user's request to make the app feel smoother
**Auto-mergeable:** iOS presentation only. No schema, no backend, no health calculations.

Tapping a metric tile in Trends replaces the screen with a standard push. The tile the user
aimed at plays no part in the transition, so the connection between "the thing I tapped" and
"the thing I'm looking at" is carried entirely by a slide. This is the last remaining item from
the smoothness pass.

## Use the right API — `matchedGeometryEffect` is the wrong one here

An earlier note in this project claimed `matchedGeometryEffect` was the lever, on the strength of
it appearing 0 times in 92 files. **The goal was right; the API was wrong.**
`matchedGeometryEffect` synchronizes geometry between two views in the *same* hierarchy sharing a
`@Namespace`. `TrendsView.swift:67` navigates via `.navigationDestination(for: String.self)`, and
a `NavigationStack` push does not preserve that relationship — the source is torn down as the
destination is pushed.

The deployment target is **iOS 26.0** (`ios/Vital/project.yml:5`), so the zoom navigation
transition is available and is what this case is designed for:

- `.matchedTransitionSource(id:in:)` on the source tile
- `.navigationTransition(.zoom(sourceID:in:))` on the destination

**Verify both signatures against the current SDK before writing them.** Do not trust this
document or your training data on the exact spelling — check, then write. If the API differs from
what is described here, follow the SDK and say so in your report.

## The change

`TrendsView` already navigates on a `String` metric key, and `MetricDetailView(metricKey:)`
receives it. That key is a natural, already-unique transition identifier — use it rather than
inventing a parallel ID.

- Declare a `@Namespace` in `TrendsView` and apply `.matchedTransitionSource` to each tile in
  `gridBody`, keyed on the metric key.
- Apply the matching `.navigationTransition(.zoom(...))` to the `MetricDetailView` inside
  `.navigationDestination`.

## Constraints

- **Reduce Motion.** A zoom is a large movement. Follow the established pattern: the
  `MotionTransition` modifier in `Theme.swift` substitutes a cross-fade for large movement when
  Reduce Motion is on, read from `@Environment(\.accessibilityReduceMotion)` rather than the
  static `Theme.Motion.isReduced` so it responds to a mid-session change. Do the equivalent here
  — if the zoom cannot be conditionally applied, fall back to the default push under Reduce
  Motion rather than forcing the zoom.
- **Never animate the `.refreshable` container.** `TrendsView` is `.refreshable` and this repo has
  been bitten by this before. Do not attach `.animation()` to the scroll view.
- Use only existing `Theme.Motion` curves if any explicit animation is needed. Do not introduce
  new durations.
- Do not change what the tiles or the detail view *render* — this is transition-only. The Trends
  data layer, the ±1σ baseline band, and `TrendsSummary` are all out of scope.

## Out of scope

- The `SkeletonView` loading grid (`TrendsView.swift:163`) — already correct.
- Any other screen. Coach, Today, Logs, and Profile transitions are not part of this.
- Backend, schema, `fly.toml`.

## Verification

- `xcodebuild -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,id=A51CC39E-580F-4ED3-AF06-214AB94E3DD4' test`
- Regenerate the project from `ios/Vital/` first (`xcodegen generate` — note it is `ios/Vital/`,
  NOT `ios/`, where it fails with "No project spec found" and a stale project silently hides new
  test files).
- Baseline on `main` is **352 tests, 0 failures**. Establish it yourself before changing anything.
- A navigation transition is largely not unit-testable. Do not manufacture a hollow test to claim
  coverage — say plainly what is verified by build and what needs a human to look at it.
- `TrendsSummaryTests` was hardened in PR #145; it must stay green.
