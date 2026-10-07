import XCTest
@testable import Vital

final class LogRowFormatTests: XCTestCase {

    func testMealSubtitleLeadsWithKcal() {
        XCTAssertEqual(LogRowFormat.subtitle(type: "meal_logged", subtitle: "Logged · Snacks", kcal: 220), "220 kcal · Snacks")
    }

    func testMealWithoutKcalKeepsSubtitle() {
        XCTAssertEqual(LogRowFormat.subtitle(type: "meal_logged", subtitle: "Logged · Snacks", kcal: nil), "Logged · Snacks")
        XCTAssertEqual(LogRowFormat.subtitle(type: "meal_logged", subtitle: "Logged · Snacks", kcal: 0), "Logged · Snacks")
    }

    func testBareLoggedSubtitleBecomesJustKcal() {
        XCTAssertEqual(LogRowFormat.subtitle(type: "meal_logged", subtitle: "Logged", kcal: 310), "310 kcal")
    }

    func testNonMealRowsAreUntouched() {
        XCTAssertEqual(LogRowFormat.subtitle(type: "workout_completed", subtitle: "Run", kcal: 220), "Run")
    }

    func testAlreadyContainsKcalIsUntouched() {
        XCTAssertEqual(LogRowFormat.subtitle(type: "meal_logged", subtitle: "220 kcal · Snacks", kcal: 220), "220 kcal · Snacks")
    }

    func testOnlyTodaysMealRowsOpenDietSheet() {
        XCTAssertTrue(LogRowFormat.opensDietSheet(type: "meal_logged", isToday: true))
        XCTAssertFalse(LogRowFormat.opensDietSheet(type: "meal_logged", isToday: false))
        XCTAssertFalse(LogRowFormat.opensDietSheet(type: "nutrition_healthkit", isToday: true))
    }
}
