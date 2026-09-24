import XCTest
import UserNotifications
@testable import Vital

final class QuickLogNotificationRouterTests: XCTestCase {

    func testTextInputActionOnMealReminderRoutesToQuickLog() {
        let input = QuickLogNotificationInput(
            categoryIdentifier: NotificationIdentifiers.mealReminderCategory,
            actionIdentifier: NotificationIdentifiers.logMealAction,
            userText: "  two eggs and toast  "
        )
        XCTAssertEqual(QuickLogNotificationRouter.route(input), .quickLog(text: "two eggs and toast"))
    }

    func testEmptyTextIsNone() {
        let input = QuickLogNotificationInput(
            categoryIdentifier: NotificationIdentifiers.mealReminderCategory,
            actionIdentifier: NotificationIdentifiers.logMealAction,
            userText: "   "
        )
        XCTAssertEqual(QuickLogNotificationRouter.route(input), .none)
    }

    func testPlainTapWithNoTextIsNone() {
        let input = QuickLogNotificationInput(
            categoryIdentifier: NotificationIdentifiers.mealReminderCategory,
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userText: nil
        )
        XCTAssertEqual(QuickLogNotificationRouter.route(input), .none)
    }

    func testWrongCategoryIsNoneEvenWithText() {
        let input = QuickLogNotificationInput(
            categoryIdentifier: NotificationIdentifiers.reminderCategory,
            actionIdentifier: NotificationIdentifiers.logMealAction,
            userText: "two eggs"
        )
        XCTAssertEqual(QuickLogNotificationRouter.route(input), .none)
    }

    func testWrongActionIsNoneEvenWithText() {
        let input = QuickLogNotificationInput(
            categoryIdentifier: NotificationIdentifiers.mealReminderCategory,
            actionIdentifier: "SOME_OTHER_ACTION",
            userText: "two eggs"
        )
        XCTAssertEqual(QuickLogNotificationRouter.route(input), .none)
    }

    // MARK: - Confirmation title formatting

    @MainActor
    func testQuickLogConfirmationTitleFormatsNameAndKcal() {
        XCTAssertEqual(
            NotificationManager.quickLogConfirmationTitle(name: "2 eggs and toast", kcal: 320),
            "Logged 2 eggs and toast · 320 kcal"
        )
    }
}
