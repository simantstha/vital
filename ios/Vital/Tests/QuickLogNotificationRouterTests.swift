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

    // MARK: - runQuickLogAction (background-task-wrapped) fully awaits the
    // network call before returning — this is the fix for the bug where
    // `didReceive`'s `completionHandler()` used to fire before the quick log
    // had actually finished, letting iOS suspend the process mid-request.

    @MainActor
    func testRunQuickLogActionAwaitsTheServiceCallBeforeReturning() async {
        let fake = FakeQuickLogService()
        fake.result = QuickLogResult(id: "event-1", name: "two eggs", kcal: 200, slot: "breakfast")

        await NotificationManager.shared.runQuickLogAction(text: "two eggs", service: fake)

        // If `runQuickLogAction` returned before awaiting the service call
        // (the original bug's shape, just one layer up), this call would
        // not have landed yet by the time we get here.
        XCTAssertEqual(fake.quickLogCalls, ["two eggs"])
    }

    @MainActor
    func testRunQuickLogActionCompletesEvenWhenTheServiceThrows() async {
        let fake = FakeQuickLogService()
        fake.error = APIError.mealNotFound

        // Must not hang or crash (e.g. a double `endBackgroundTask`) on the
        // failure path — best-effort/silent per `handleQuickLogAction`'s doc.
        await NotificationManager.shared.runQuickLogAction(text: "unobtainium soup", service: fake)

        XCTAssertEqual(fake.quickLogCalls, ["unobtainium soup"])
    }
}
