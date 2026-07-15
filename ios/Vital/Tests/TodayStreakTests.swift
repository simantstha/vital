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
}
