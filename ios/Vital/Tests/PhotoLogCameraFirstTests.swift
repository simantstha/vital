import XCTest
@testable import Vital

/// Coverage for the three pieces of "photo-log-camera-first" that don't
/// require a network mock (`APIClient` is a plain, non-injectable `struct`
/// here — see `DietSheetViewModelTests`' header comment for the same
/// constraint): the shared time-of-day slot helper, the photo auto-log
/// decision gate, and the duplicate-log guard.
@MainActor
final class PhotoLogCameraFirstTests: XCTestCase {

    // MARK: - Time-of-day slot helper (boundaries)
    //
    // `ReminderScheduler.fallbackSlot(forHour:)` is the ONE shared helper —
    // both the meal-reminder suppression logic and `DietSheetViewModel`'s
    // default `selectedSlot` call through it. Pins every boundary hour so a
    // future edit to one call site can't silently drift from the other.

    func testFallbackSlotBoundaries() {
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 0), .breakfast)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 10), .breakfast)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 11), .lunch)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 14), .lunch)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 15), .snacks)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 17), .snacks)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 18), .dinner)
        XCTAssertEqual(ReminderScheduler.fallbackSlot(forHour: 23), .dinner)
    }

    func testTimeAppropriateSlotMatchesFallbackSlotForHour() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let noon = calendar.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: 12))!

        XCTAssertEqual(
            ReminderScheduler.timeAppropriateSlot(for: noon, calendar: calendar),
            .lunch
        )
    }

    func testDietSheetViewModelDefaultsToTimeAppropriateSlotNotAlwaysBreakfast() {
        // Regression: `selectedSlot` used to hard-code `.breakfast` (line
        // ~57 in the pre-fix version), so opening the sheet at dinnertime
        // still landed on the Breakfast tab. It must now agree with the
        // shared helper for "right now", whatever that resolves to.
        let vm = DietSheetViewModel(initialTarget: 2000, onRefreshToday: {})
        XCTAssertEqual(vm.selectedSlot, ReminderScheduler.timeAppropriateSlot())
    }

    // MARK: - Auto-log decision

    func testShouldAutoLogWithValidNameAndKcal() {
        XCTAssertTrue(PhotoLogDecision.shouldAutoLog(name: "Chicken bowl", kcal: 620))
    }

    func testShouldAutoLogRejectsZeroKcal() {
        XCTAssertFalse(PhotoLogDecision.shouldAutoLog(name: "Chicken bowl", kcal: 0))
    }

    func testShouldAutoLogRejectsNegativeKcal() {
        XCTAssertFalse(PhotoLogDecision.shouldAutoLog(name: "Chicken bowl", kcal: -5))
    }

    func testShouldAutoLogRejectsEmptyName() {
        XCTAssertFalse(PhotoLogDecision.shouldAutoLog(name: "", kcal: 620))
    }

    func testShouldAutoLogRejectsWhitespaceOnlyName() {
        XCTAssertFalse(PhotoLogDecision.shouldAutoLog(name: "   ", kcal: 620))
    }

    func testShouldAutoLogRejectsBothZeroKcalAndEmptyName() {
        XCTAssertFalse(PhotoLogDecision.shouldAutoLog(name: "", kcal: 0))
    }

    // MARK: - Duplicate-log guard
    //
    // The bug: `LogMealViewModel.logMeal()` never cleared `showConfirmCard`
    // on success, so the still-visible, still-enabled "Log Meal" button let
    // a second tap fire a second `POST /api/meals/log` for the same meal.
    // The fix clears it right after a successful log; the pre-existing
    // `guard showConfirmCard else { return }` at the top of `logMeal()` is
    // what then makes a second tap a genuine no-op. This pins that guard
    // directly (deterministic, no network involved) — the fix is what makes
    // `showConfirmCard` false for the second tap in the first place.

    func testLogMealIsNoOpOnceConfirmCardIsCleared() async {
        let vm = LogMealViewModel()
        vm.editedName = "Chicken bowl"
        vm.editedKcal = "620"
        vm.showConfirmCard = false // state right after a successful log, post-fix

        await vm.logMeal()

        XCTAssertFalse(vm.isLoading, "a cleared confirm card must never start a second network log")
        XCTAssertFalse(vm.isLogged, "no second log should have gone through")
        XCTAssertNil(vm.errorMessage)
    }

    func testClearResultAlsoClearsConfirmCard() {
        // `clearResult()` is the other path back to "no confirm card up" —
        // pinning it alongside the post-log guard so both routes into the
        // no-op state stay in sync.
        let vm = LogMealViewModel()
        vm.showConfirmCard = true
        vm.editedName = "Chicken bowl"

        vm.clearResult()

        XCTAssertFalse(vm.showConfirmCard)
    }
}
