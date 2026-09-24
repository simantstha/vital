import Foundation

/// Single source of truth for "now" as it feeds Today's time-of-day-driven
/// layout (the greeting, the "Next up" row, plan items' now/next/later
/// statuses, the calendar-event merge window). Everywhere in production,
/// TestFlight, and the ordinary `VitalTests` unit-test run this is exactly
/// `Date()` — the only place it differs is the DEBUG-only screenshot harness
/// (`-VitalFixture`, see `FixtureMode.swift`), where "now" is pinned to a
/// fixed local time so a given fixture scenario always renders the same
/// layout regardless of the wall-clock time the CI job happens to run at.
///
/// Screenshot-harness flakiness (2026-09-24, PRs #198/#203): `test_endurance`
/// — the first test to run on a cold simulator — intermittently failed to
/// open the Diet sheet from Today's fuel strip. The captured
/// `dietSheet` screenshot was byte-identical to `today`, meaning the sheet
/// never opened even though the test tapped `today.fuelStrip`. Root cause:
/// "Next up" (`WeightHeroLogic.nextUpItem`, fed by wall-clock `Date()` via
/// `TodayViewModel`) only renders when some plan item is still inside its
/// grace window — so a run in the small hours (nothing "next" yet) laid out
/// Today differently than an evening run (an item pending), and the
/// fuel strip's position shifted enough between the two that XCUITest's tap
/// sometimes landed on/near the floating mic FAB (`VoiceFABView`) instead.
/// Pinning "now" removes that source of variance entirely; see
/// `docs/CI-TESTFLIGHT.md`.
enum AppClock {
    /// 15:00 local, on the current calendar day. Chosen by checking every
    /// established-goal fixture's `plan` array in `FixtureData.swift`:
    /// `weight_loss` (960 min = 4:00 PM snack), `muscle` (990 min = 4:30 PM
    /// snack), and `endurance` (990 min = 4:30 PM snack) each have an
    /// afternoon item that is still within `WeightHeroLogic
    /// .nextUpGraceMinutes` (30 min) of 15:00 = 900 minutes — so "Next up"
    /// reliably renders (a snack row, never overlapping the FAB's own fix
    /// below) for every scenario that has plan items at all. `new_user`'s
    /// `plan` is empty, so this choice is a no-op for it either way (no
    /// "Next up" row regardless of the clock).
    private static var pinnedFixtureNow: Date {
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        comps.hour = 15
        comps.minute = 0
        comps.second = 0
        return Calendar.current.date(from: comps) ?? Date()
    }

    /// The current moment. `Date()` in every real launch and in `VitalTests`;
    /// pinned to `pinnedFixtureNow` only under `-VitalFixture` — a DEBUG-only
    /// launch arg that never reaches a shipped build, so production behavior
    /// is byte-identical to calling `Date()` directly.
    static var now: Date {
        #if DEBUG
        if FixtureMode.isActive { return pinnedFixtureNow }
        #endif
        return Date()
    }
}
