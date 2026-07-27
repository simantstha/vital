import XCTest
@testable import Vital

/// `DietSheetViewModel` holds `APIClient.shared` directly (not injected), so
/// these tests only exercise the pure computed properties —
/// `recentsForSelectedSlot` / `isRecentsFallback` — by constructing the view
/// model through its normal `init` (which does no networking) and setting
/// `recents` / `selectedSlot` directly, without touching production code.
@MainActor
final class DietSheetViewModelTests: XCTestCase {

    private func makeFood(_ name: String, slot: String?) -> RecentFood {
        RecentFood(name: name, kcal: 300, c: 30, p: 20, f: 10, slot: slot, lastLoggedAt: nil, imageThumb: nil)
    }

    private func makeViewModel() -> DietSheetViewModel {
        DietSheetViewModel(initialTarget: 2000, onRefreshToday: {})
    }

    // MARK: - Slot match

    func testRecentsForSelectedSlotReturnsOnlyMatchingSlotWhenAvailable() {
        let vm = makeViewModel()
        vm.recents = [
            makeFood("Oatmeal", slot: "breakfast"),
            makeFood("Steak", slot: "dinner")
        ]
        vm.selectedSlot = .breakfast

        XCTAssertEqual(vm.recentsForSelectedSlot.map(\.name), ["Oatmeal"])
        XCTAssertFalse(vm.isRecentsFallback)
    }

    // MARK: - Fallback

    func testRecentsForSelectedSlotFallsBackToAllRecentsWhenSlotHasNoMatches() {
        let vm = makeViewModel()
        vm.recents = [
            makeFood("Sandwich", slot: "lunch"),
            makeFood("Salad", slot: "lunch")
        ]
        vm.selectedSlot = .dinner

        XCTAssertEqual(vm.recentsForSelectedSlot.map(\.name), ["Sandwich", "Salad"])
        XCTAssertTrue(vm.isRecentsFallback)
    }

    // MARK: - Empty recents

    func testRecentsForSelectedSlotWithEmptyRecentsIsEmptyAndNotFallback() {
        let vm = makeViewModel()
        vm.recents = []
        vm.selectedSlot = .dinner

        XCTAssertTrue(vm.recentsForSelectedSlot.isEmpty)
        XCTAssertFalse(vm.isRecentsFallback)
    }

    // MARK: - nil-slot entries (pre-slot-tracking meals)

    func testRecentsForSelectedSlotFallsBackForNilSlotEntries() {
        let vm = makeViewModel()
        vm.recents = [
            makeFood("Old Meal", slot: nil),
            makeFood("Another Old Meal", slot: nil)
        ]
        vm.selectedSlot = .breakfast

        XCTAssertEqual(vm.recentsForSelectedSlot.map(\.name), ["Old Meal", "Another Old Meal"])
        XCTAssertTrue(vm.isRecentsFallback)
    }
}
