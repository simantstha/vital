# Give HealthKit denial a way back

**Date:** 2026-09-05
**Branch:** `fix/healthkit-denial-recovery` (off `main`)
**Source:** `docs/audits/2026-08-31-product-audit.md` P0 #5
**Auto-mergeable:** iOS presentation + one persisted flag. No schema, no backend, no health calculations.

Denying HealthKit is currently an unrecoverable dead end, and it fails in the project's
release-blocking way: **it looks exactly like having no data.**

`HealthKitManager.swift:83-91`:

```swift
func requestAuthorization() async {
    guard HKHealthStore.isHealthDataAvailable() else { return }
    do {
        try await store.requestAuthorization(toShare: [], read: readTypes)
    } catch {
        // Authorization denied or unavailable — callers handle via nil returns.
        print("[HealthKit] Authorization failed: \(error.localizedDescription)")
    }
}
```

Nothing is recorded. `OnboardingViewModel.swift:77` calls it once at flow start and moves on. A
user who taps "Don't Allow" gets an empty Today screen forever, with no explanation and no path
back — the app never asks again and never mentions Health.

## ⚠️ Read this before writing any detection code

**HealthKit deliberately will not tell you that read access was denied.** From Apple's docs on
`authorizationStatus(for:)`: to prevent apps inferring health conditions from a refusal, an app
cannot determine whether the user granted *read* permission. Denied reads are indistinguishable
from an empty store — you get no data either way.

Consequences, all of which the implementation must respect:

- `authorizationStatus(for:)` is only meaningful for **share** types. This app requests
  `toShare: []`, so it will not give you a denial signal. Do not build on it.
- `requestAuthorization` does **not** throw on denial. It throws on genuine errors. The current
  `catch` is not a denial path, and the comment claiming it is, is wrong — fix that comment.
- Calling `requestAuthorization` again after a denial does **not** re-prompt. iOS shows the sheet
  once. A "Grant access" button that just re-calls it silently does nothing — that would be a new
  dead end dressed as a fix.

So denial cannot be *detected*. It can only be **inferred**, and the copy must reflect that
uncertainty rather than assert it.

## The change

**1. Record that we asked.** Persist a flag (UserDefaults is fine) when the authorization sheet
has been presented at least once. Without this, "no data" on first launch is ambiguous with
"asked and got nothing."

**2. Infer the probable case.** Asked at least once + zero samples across *all* requested read
types = probably not granted. Surface a recovery affordance in that state only. If any read type
returns data, do not show it — a user who granted sleep but not HRV is not locked out.

**3. Give a real way back.** iOS will not re-prompt, so the affordance must route the user to
where the toggle actually lives. Note that HealthKit permissions are **not** on the app's own
Settings page — they live in the Health app under Sharing → Apps. Verify the deep link you choose
actually opens somewhere useful on a real simulator before committing to it, and fall back to
plain written steps if it doesn't. **Do not ship a button that goes nowhere.** That is the same
dead end with extra steps.

**4. Copy must not assert what we cannot know.** We do not know the user denied — we know we
asked and have no data. Write it that way ("Vital isn't seeing any Health data" + how to check),
not as an accusation ("You denied access"). A user who simply has no data in Health yet will see
this too, and telling them they refused something they didn't would be a false statement of the
kind this project treats as release-blocking.

## Out of scope

- Re-designing onboarding, or moving where the prompt happens.
- The WHOOP connection path — it has its own, already-human error copy.
- Any change to what the metrics themselves display when nil — #143 and #146 already handle that.
- Backend, schema, `fly.toml`.

## Verification

- `xcodebuild -project ios/Vital/Vital.xcodeproj -scheme Vital -destination 'platform=iOS Simulator,id=A51CC39E-580F-4ED3-AF06-214AB94E3DD4' test`
- Baseline is **357 tests, 0 failures** if PR #147 has merged, **341** if it has not. Establish
  the baseline yourself before changing anything so you can attribute any failure.
- Tests must pin the inference rule, since it is the part most likely to regress: never asked →
  no affordance; asked + some data → no affordance; asked + no data anywhere → affordance shown.
- The simulator cannot meaningfully exercise a real HealthKit denial, so **do not claim device
  verification.** State plainly in the PR what was verified by test versus what needs a device.
