import XCTest
@testable import Vital

/// Pure-function coverage for `MealReceiptRow.displayTitle(items:fallbackName:)`
/// and `MealReceiptRow.biggestGuess(items:)` — both `nonisolated static`, so
/// these run with no actor isolation and no view/API setup at all.
final class MealReceiptItemHelpersTests: XCTestCase {

    private func item(_ food: String, grams: Int = 100, kcal: Int = 100, confidence: String = "med") -> MealReceiptRow.Item {
        MealReceiptRow.Item(food: food, grams: grams, kcal: kcal, confidence: confidence)
    }

    // MARK: - displayTitle

    func testDisplayTitleFallsBackToNameWhenThereAreNoItems() {
        XCTAssertEqual(MealReceiptRow.displayTitle(items: [], fallbackName: "white rice, cooked"), "white rice, cooked")
    }

    func testDisplayTitleTitleCasesASingleItem() {
        XCTAssertEqual(
            MealReceiptRow.displayTitle(items: [item("white rice, cooked")], fallbackName: "irrelevant"),
            "White Rice, Cooked"
        )
    }

    func testDisplayTitleJoinsTwoItemsWithAnAmpersand() {
        XCTAssertEqual(
            MealReceiptRow.displayTitle(items: [item("white rice, cooked"), item("chicken curry")], fallbackName: "irrelevant"),
            "White Rice, Cooked & Chicken Curry"
        )
    }

    /// Three or more items collapse to "first & N more" rather than a long
    /// (or raw lowercase) comma list — the owner's original complaint.
    func testDisplayTitleCollapsesThreeOrMoreItemsToFirstPlusCount() {
        XCTAssertEqual(
            MealReceiptRow.displayTitle(
                items: [item("white rice, cooked"), item("chicken curry"), item("naan")],
                fallbackName: "irrelevant"
            ),
            "White Rice, Cooked & 2 more"
        )
    }

    // MARK: - biggestGuess

    func testBiggestGuessReturnsNilForNoItems() {
        XCTAssertNil(MealReceiptRow.biggestGuess(items: []))
    }

    func testBiggestGuessPicksTheLowestConfidenceItem() {
        let rice = item("white rice, cooked", kcal: 200, confidence: "high")
        let curry = item("chicken curry", kcal: 100, confidence: "low")
        XCTAssertEqual(MealReceiptRow.biggestGuess(items: [rice, curry]), curry)
    }

    /// A confidence tie is broken by the larger kcal item — the one that
    /// moves the total the most if it's wrong.
    func testBiggestGuessBreaksATieByLargerKcal() {
        let small = item("naan", kcal: 150, confidence: "med")
        let big = item("chicken curry", kcal: 400, confidence: "med")
        XCTAssertEqual(MealReceiptRow.biggestGuess(items: [small, big]), big)
    }

    func testBiggestGuessOnASingleItemReturnsThatItem() {
        let only = item("white rice, cooked", confidence: "high")
        XCTAssertEqual(MealReceiptRow.biggestGuess(items: [only]), only)
    }
}
