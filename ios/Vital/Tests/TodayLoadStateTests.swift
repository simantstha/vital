import XCTest
@testable import Vital

/// Regression tests for `docs/superpowers/plans/2026-09-05-today-load-state-tri-state.md`:
/// a failed load must not render an error banner stacked on top of an empty
/// dashboard, but a partial failure (some data already on screen) must never
/// be blanked out from underneath the user.
@MainActor
final class TodayLoadStateTests: XCTestCase {

    func testFailedLoadWithNoDataRendersFailedNotLoaded() {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })

        let result = viewModel.loadStateAfterFailure(message: "Server returned HTTP 500.")

        XCTAssertEqual(result, .failed("Server returned HTTP 500."))
    }

    func testPartialFailureAfterSuccessfulLoadPreservesData() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })
        let response = try JSONDecoder().decode(TodayResponse.self, from: Data("""
        {
          "metrics": {
            "hrv": {"value": 52, "unit": "ms", "deltaPct": 4},
            "sleep": {"value": 7.5, "unit": "hours", "deltaPct": 2},
            "restingHr": {"value": 58, "unit": "bpm", "deltaPct": -1}
          },
          "dietBudget": {
            "targetKcal": 2000, "consumedKcal": 0, "remaining": 2000,
            "protein": 0, "carbs": 0, "fat": 0
          },
          "insight": "",
          "plan": [],
          "calibration": null
        }
        """.utf8))
        viewModel.applyTodayResponse(response)

        let result = viewModel.loadStateAfterFailure(message: "Server returned HTTP 500.")

        XCTAssertEqual(result, .loaded)
        XCTAssertEqual(viewModel.hrv.displayValue, "52")
        XCTAssertEqual(viewModel.sleep.formatted, "7h 30m")
        XCTAssertEqual(viewModel.restingHR.displayValue, "58")
    }

    func testPartialFailureWithOnlyDietDataPreservesData() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })
        let response = try JSONDecoder().decode(TodayResponse.self, from: Data("""
        {
          "metrics": {
            "hrv": {"value": null, "unit": "ms", "deltaPct": null},
            "sleep": {"value": null, "unit": "hours", "deltaPct": null},
            "restingHr": {"value": null, "unit": "bpm", "deltaPct": null}
          },
          "dietBudget": {
            "targetKcal": 2000, "consumedKcal": 0, "remaining": 2000,
            "protein": 0, "carbs": 0, "fat": 0
          },
          "insight": "",
          "plan": [],
          "calibration": null
        }
        """.utf8))
        viewModel.applyTodayResponse(response)

        let result = viewModel.loadStateAfterFailure(message: "Server returned HTTP 500.")

        XCTAssertEqual(result, .loaded)
    }

    func testPartialFailureWithOnlyPlanItemsPreservesData() {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })
        viewModel.planItems = [
            PlanItem(
                id: "server-1",
                timeMinutes: 480,
                title: "Morning walk",
                subtitle: "",
                sfSymbol: "figure.walk",
                status: .later,
                source: .user,
                kind: .move
            )
        ]

        let result = viewModel.loadStateAfterFailure(message: "Server returned HTTP 500.")

        XCTAssertEqual(result, .loaded)
    }

    func testLoadStateEquality() {
        XCTAssertEqual(TodayViewModel.LoadState.failed("a"), TodayViewModel.LoadState.failed("a"))
        XCTAssertNotEqual(TodayViewModel.LoadState.failed("a"), TodayViewModel.LoadState.failed("b"))
        XCTAssertNotEqual(TodayViewModel.LoadState.loading, TodayViewModel.LoadState.loaded)
    }

    func testCancelledRefreshWithContentOnScreenDoesNotStrandSkeleton() {
        let result = TodayViewModel.loadStateAfterCancellation(from: .loaded)

        XCTAssertEqual(result, .loaded)
        XCTAssertNotEqual(result, .loading)
    }

    func testCancelledFirstLoadRecoversFromLoading() {
        let result = TodayViewModel.loadStateAfterCancellation(from: .loading)

        XCTAssertEqual(result, .loaded)
    }

    func testCancelledLoadPreservesFailedState() {
        let result = TodayViewModel.loadStateAfterCancellation(from: .failed("Server returned HTTP 500."))

        XCTAssertEqual(result, .failed("Server returned HTTP 500."))
    }

    func testRefreshWithExistingContentNeverEntersLoading() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })
        let response = try JSONDecoder().decode(TodayResponse.self, from: Data("""
        {
          "metrics": {
            "hrv": {"value": 52, "unit": "ms", "deltaPct": 4},
            "sleep": {"value": 7.5, "unit": "hours", "deltaPct": 2},
            "restingHr": {"value": 58, "unit": "bpm", "deltaPct": -1}
          },
          "dietBudget": {
            "targetKcal": 2000, "consumedKcal": 0, "remaining": 2000,
            "protein": 0, "carbs": 0, "fat": 0
          },
          "insight": "",
          "plan": [],
          "calibration": null
        }
        """.utf8))
        viewModel.applyTodayResponse(response)

        XCTAssertFalse(viewModel.shouldShowLoadingSkeleton)
    }

    func testFirstLoadWithNoContentShowsSkeleton() {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })

        XCTAssertTrue(viewModel.shouldShowLoadingSkeleton)
    }
}
