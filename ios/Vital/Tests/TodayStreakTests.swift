import XCTest
@testable import Vital

@MainActor
final class TodayStreakTests: XCTestCase {
    func testStreakResponseDecodes() throws {
        let response = try JSONDecoder().decode(
            StreakResponse.self,
            from: Data(#"{"streakDays":14}"#.utf8)
        )

        XCTAssertEqual(response.streakDays, 14)
    }

    func testSuccessfulRefreshPublishesFetchedStreak() async {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 7) })

        await viewModel.refreshStreak()

        XCTAssertEqual(viewModel.streakDays, 7)
    }

    func testFailedRefreshPreservesLastDisplayedStreak() async {
        enum TestError: Error { case unavailable }
        var result = StreakResponse(streakDays: 5)
        var shouldFail = false
        let viewModel = TodayViewModel(fetchStreak: {
            if shouldFail { throw TestError.unavailable }
            return result
        })
        await viewModel.refreshStreak()
        result = StreakResponse(streakDays: 99)
        shouldFail = true

        await viewModel.refreshStreak()

        XCTAssertEqual(viewModel.streakDays, 5)
    }

    func testSuccessfulServerPlanDeletionRefreshesStreak() async {
        let deleted = expectation(description: "plan item deleted")
        let refreshed = expectation(description: "streak refreshed")
        let viewModel = TodayViewModel(
            fetchStreak: {
                refreshed.fulfill()
                return StreakResponse(streakDays: 2)
            },
            deletePlanItem: { id in
                XCTAssertEqual(id, "server-done")
                deleted.fulfill()
            }
        )
        viewModel.planItems = [
            PlanItem(
                id: "server-done",
                timeMinutes: 480,
                title: "Morning walk",
                subtitle: "",
                sfSymbol: "figure.walk",
                status: .done,
                source: .user,
                kind: .move
            )
        ]

        viewModel.removeItem(id: "server-done")
        await fulfillment(of: [deleted, refreshed], timeout: 1)

        XCTAssertEqual(viewModel.streakDays, 2)
        XCTAssertTrue(viewModel.planItems.isEmpty)
    }
}
