# Stop rendering data we don't have

**Date:** 2026-09-02
**Branch:** `fix/no-fabricated-empty-states` (off `main`)
**Source:** `docs/audits/2026-08-31-product-audit.md` — P0 findings 1 (iOS half) and 2

## Scope

Two presentation-layer defects that both render *absent* data as if it were *real* data. iOS
only — no schema, no infra, no backend.

**Deliberately excluded:** the backend half of P0 #1 (persisting the brief to Postgres, and
`min_machines_running = 0` in `fly.toml`). That needs a schema migration and an infra change,
and this repo has two production incidents from migrations — it should land attended, in its own
PR, not unsupervised. This PR makes the *symptom* honest; it does not claim to fix the cause.

## Defect 1 — empty brief renders as an empty container

`ios/Vital/Sources/DesignSystem/CoachBubble.swift:9` renders `Text(message.asMarkdown)` with no
empty guard. `PlanTimelineView.swift:24-42` `ForEach`es a possibly-empty array inside a
`VitalCard`.

When the brief cache misses — which per the audit is *every* morning in production, because the
Fly machine suspends and the cache is an in-process `Map` — `/api/today` returns `insight: ''`
and `plan: []`. The user gets a pale-lime bubble containing nothing and an empty card.

**Fix:** neither view should render its container when it has no content. Guard at the view
level so an empty payload produces *nothing* rather than an empty shell. Check whether the
parent (`TodayView`) also needs to drop surrounding spacing/dividers, so we don't trade an empty
card for a floating gap.

## Defect 2 — `0` is used to mean "unknown"

`TodayViewModel.swift:93-95` seeds:

```swift
@Published var hrv = HRVMetric(value: 0, trend: .neutral, delta: "—")
@Published var sleep = SleepMetric(hours: 0, minutes: 0, trend: .neutral, delta: "—")
@Published var restingHR = RestingHRMetric(bpm: 0, trend: .neutral, delta: "—")
```

The parser correctly guards with `if let value = m.hrv.value`, so when the backend sends `null`
— which it does, correctly, for a new user — the seeded `0` is never overwritten and
`TodayView.swift:292-316` renders it unconditionally. A new user is shown a measured-looking
**0 ms HRV**.

The backend is already telling the truth. The client discards that truth one layer before
display.

**Fix:** make absence representable. The metric values should be optional (or wrapped in a
state enum) so the view can distinguish "not measured" from "measured zero" and render a
placeholder — the existing `—` idiom is already used for `delta`, so follow it rather than
inventing new copy. Do not paper over this by seeding a sentinel like `-1`.

Note the inline comment at `:92` claims "neutral until real data loads (view is gated on
`isLoading`)". That gating is precisely what fails here: loading *completes*, successfully, with
no data. Update or remove that comment so it stops asserting something untrue.

## Constraints

- Do **not** touch backend, schema, `fly.toml`, or any file outside `ios/`.
- Preserve the existing `—` placeholder idiom rather than introducing new empty-state copy.
- Dynamic Type and the accent/theme system are already established — follow the surrounding
  conventions; this is not a redesign.

## Verification

- `xcodebuild -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS
  Simulator,name=iPhone 17' build` must succeed.
- Add tests: an empty `insight`/`plan` payload renders neither container; a `null` HRV payload
  renders the placeholder and **not** `0`.
- The known-flaky `waitUntil` tests
  (`testInterruptedSpecialistReplyRetainsAuthoritativePersona`,
  `testActionFailureReconcilesAuthoritativeStateWithoutReplacingTranscript`) are pre-existing
  timing flakiness — do not attempt to fix them; just report which failures are pre-existing.
