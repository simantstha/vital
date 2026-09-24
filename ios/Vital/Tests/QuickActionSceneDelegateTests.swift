import XCTest
import UIKit
@testable import Vital

@MainActor
final class QuickActionHandlingTests: XCTestCase {

    override func tearDown() {
        // `AppRouter.shared` is a singleton — don't leak state into other
        // test files/methods that also touch `logDeepLink`.
        AppRouter.shared.logDeepLink = nil
        super.tearDown()
    }

    func testMatchingShortcutItemSetsComposeTextDeepLinkAndReturnsTrue() {
        AppRouter.shared.logDeepLink = nil
        let item = UIApplicationShortcutItem(
            type: QuickActionHandling.logMealShortcutType,
            localizedTitle: "Log a meal"
        )

        let handled = QuickActionHandling.handle(item)

        XCTAssertTrue(handled)
        XCTAssertEqual(AppRouter.shared.logDeepLink, .compose(.text))
    }

    func testUnknownShortcutTypeReturnsFalseAndLeavesRouteUntouched() {
        AppRouter.shared.logDeepLink = nil
        let item = UIApplicationShortcutItem(
            type: "com.simantstha.vital.quickAction.someOtherAction",
            localizedTitle: "Something else"
        )

        let handled = QuickActionHandling.handle(item)

        XCTAssertFalse(handled)
        XCTAssertNil(AppRouter.shared.logDeepLink)
    }

    func testUnknownShortcutTypeDoesNotClobberAnExistingRoute() {
        AppRouter.shared.logDeepLink = .event("existing-event-id")
        let item = UIApplicationShortcutItem(
            type: "com.simantstha.vital.quickAction.someOtherAction",
            localizedTitle: "Something else"
        )

        XCTAssertFalse(QuickActionHandling.handle(item))
        XCTAssertEqual(AppRouter.shared.logDeepLink, .event("existing-event-id"))
    }
}
