import XCTest
@testable import Vital

/// Covers the two client-side pieces of the photo-log per-item breakdown
/// (see `app/api/meals/log/route.ts` / `lib/nutrition/estimator.ts` for the
/// server-side counterpart this mirrors):
///
///  1. `NutritionResult`/`PhotoEstimatorItem` decode `POST /api/nutrition/
///     photo`'s additive `estimatorItems` field correctly, and without it
///     present at all (older-server / non-photo-search compatibility).
///  2. `LogMealViewModel.estimatorItemsMatchTotals` — the pure, `nonisolated
///     static` 5%-tolerance totals-match helper `logMeal()` uses to decide
///     whether a user-edited macro correction has invalidated the photo's
///     item breakdown — is exercised directly, with no `@MainActor`/`await`
///     needed since it's static and pure.
final class PhotoEstimatorItemsTests: XCTestCase {

    // MARK: - Decoding

    func testNutritionResultDecodesEstimatorItems() throws {
        let json = """
        {
          "name": "Rice and chicken",
          "kcal": 640, "c": 84, "p": 54, "f": 7,
          "estimatorItems": [
            {
              "food": "white rice, cooked", "grams": 300, "kcal": 390, "c": 84, "p": 8, "f": 1,
              "source": "usda", "confidence": "high", "portionNote": "full dinner plate"
            },
            {
              "food": "grilled chicken", "grams": 150, "kcal": 250, "c": 0, "p": 46, "f": 6,
              "source": "model", "confidence": "med", "portionNote": "a palm-sized fillet"
            }
          ]
        }
        """.data(using: .utf8)!

        let result = try JSONDecoder().decode(NutritionResult.self, from: json)
        XCTAssertEqual(result.estimatorItems?.count, 2)
        XCTAssertEqual(result.estimatorItems?.first?.food, "white rice, cooked")
        XCTAssertEqual(result.estimatorItems?.first?.grams, 300)
        XCTAssertEqual(result.estimatorItems?.first?.source, "usda")
        XCTAssertEqual(result.estimatorItems?.last?.confidence, "med")
    }

    func testNutritionResultDecodesWithoutEstimatorItems() throws {
        // Legacy/text-search shape — no estimatorItems key at all.
        let json = """
        {"name": "Chicken Salad", "kcal": 400, "c": 20, "p": 30, "f": 15}
        """.data(using: .utf8)!

        let result = try JSONDecoder().decode(NutritionResult.self, from: json)
        XCTAssertNil(result.estimatorItems)
    }

    // MARK: - estimatorItemsMatchTotals (pure, nonisolated static)

    private func item(
        food: String = "white rice, cooked", grams: Double = 300,
        kcal: Double = 390, c: Double = 84, p: Double = 8, f: Double = 1
    ) -> PhotoEstimatorItem {
        PhotoEstimatorItem(
            food: food, grams: grams, kcal: kcal, c: c, p: p, f: f,
            source: "usda", confidence: "high", portionNote: "full dinner plate"
        )
    }

    func testMatchTotalsTrueForExactMatch() {
        let items = [item(kcal: 390, c: 84, p: 8, f: 1)]
        XCTAssertTrue(LogMealViewModel.estimatorItemsMatchTotals(items, kcal: 390, c: 84, p: 8, f: 1))
    }

    func testMatchTotalsTrueWithinFivePercentTolerance() {
        let items = [item(kcal: 300, c: 50, p: 20, f: 5)]
        // 3% over on kcal — still within tolerance.
        XCTAssertTrue(LogMealViewModel.estimatorItemsMatchTotals(items, kcal: 309, c: 50, p: 20, f: 5))
    }

    func testMatchTotalsFalseWhenUserEditedMacrosBeyondFivePercent() {
        let items = [item(kcal: 300, c: 50, p: 20, f: 5)]
        // User dialed kcal down by 20% in the review step.
        XCTAssertFalse(LogMealViewModel.estimatorItemsMatchTotals(items, kcal: 240, c: 50, p: 20, f: 5))
    }

    func testMatchTotalsFalseWhenOnlyOneMacroDriftsBeyondTolerance() {
        let items = [item(kcal: 300, c: 50, p: 20, f: 5)]
        XCTAssertFalse(LogMealViewModel.estimatorItemsMatchTotals(items, kcal: 300, c: 50, p: 20, f: 20))
    }

    func testMatchTotalsTrueForBothZero() {
        let items = [item(kcal: 100, c: 25, p: 0, f: 0)]
        XCTAssertTrue(LogMealViewModel.estimatorItemsMatchTotals(items, kcal: 100, c: 25, p: 0, f: 0))
    }

    func testMatchTotalsFalseForEmptyItems() {
        XCTAssertFalse(LogMealViewModel.estimatorItemsMatchTotals([], kcal: 0, c: 0, p: 0, f: 0))
    }

    func testMatchTotalsSumsMultipleItems() {
        let items = [
            item(food: "rice", kcal: 390, c: 84, p: 8, f: 1),
            item(food: "chicken", kcal: 250, c: 0, p: 46, f: 6),
        ]
        XCTAssertTrue(LogMealViewModel.estimatorItemsMatchTotals(items, kcal: 640, c: 84, p: 54, f: 7))
    }
}
