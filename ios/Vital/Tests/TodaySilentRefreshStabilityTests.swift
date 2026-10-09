import Combine
import XCTest
@testable import Vital

/// The post-load silent `/api/today` refresh (`startPostLoadSync`) re-applies
/// the response while the user may already be tapping Today. Re-applying an
/// identical response must publish nothing and leave the derived layout state
/// (goal, metric-tile visibility, metrics, diet card) untouched — otherwise
/// the content can jump under a tap.
@MainActor
final class TodaySilentRefreshStabilityTests: XCTestCase {

    private func makeResponse() throws -> TodayResponse {
        try JSONDecoder().decode(TodayResponse.self, from: Data("""
        {
          "metrics": {
            "hrv": {"value": 52, "unit": "ms", "deltaPct": 4},
            "sleep": {"value": 7.5, "unit": "hours", "deltaPct": 2},
            "restingHr": {"value": 58, "unit": "bpm", "deltaPct": -1}
          },
          "dietBudget": {
            "targetKcal": 2400, "consumedKcal": 600, "remaining": 1800,
            "protein": 40, "carbs": 80, "fat": 20,
            "goal": "endurance"
          },
          "insight": "Steady day.",
          "plan": [],
          "calibration": null
        }
        """.utf8))
    }

    func testReapplyingIdenticalResponseLeavesLayoutStateUnchanged() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 3) })
        try viewModel.applyTodayResponse(makeResponse())

        let goal = viewModel.goal
        let showTiles = viewModel.showMetricTiles
        let isEndurance = viewModel.isEnduranceGoal
        let hrv = viewModel.hrv
        let sleep = viewModel.sleep
        let restingHR = viewModel.restingHR
        let diet = viewModel.diet
        let insight = viewModel.coachInsight

        var emissions = 0
        let cancellable = viewModel.objectWillChange.sink { emissions += 1 }
        defer { cancellable.cancel() }

        try viewModel.applyTodayResponse(makeResponse())

        XCTAssertEqual(emissions, 0, "an identical silent refresh must not publish anything")
        XCTAssertEqual(viewModel.goal, goal)
        XCTAssertEqual(viewModel.isEnduranceGoal, isEndurance)
        XCTAssertEqual(viewModel.showMetricTiles, showTiles)
        XCTAssertEqual(viewModel.hrv, hrv)
        XCTAssertEqual(viewModel.sleep, sleep)
        XCTAssertEqual(viewModel.restingHR, restingHR)
        XCTAssertEqual(viewModel.diet, diet)
        XCTAssertEqual(viewModel.coachInsight, insight)
    }

    func testReapplyingChangedDietStillPublishes() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 3) })
        try viewModel.applyTodayResponse(makeResponse())
        let changed = try JSONDecoder().decode(TodayResponse.self, from: Data("""
        {
          "metrics": {
            "hrv": {"value": 52, "unit": "ms", "deltaPct": 4},
            "sleep": {"value": 7.5, "unit": "hours", "deltaPct": 2},
            "restingHr": {"value": 58, "unit": "bpm", "deltaPct": -1}
          },
          "dietBudget": {
            "targetKcal": 2400, "consumedKcal": 900, "remaining": 1500,
            "protein": 60, "carbs": 120, "fat": 30,
            "goal": "endurance"
          },
          "insight": "Steady day.",
          "plan": [],
          "calibration": null
        }
        """.utf8))

        viewModel.applyTodayResponse(changed)

        XCTAssertEqual(viewModel.diet.kcalConsumed, 900)
    }
}
