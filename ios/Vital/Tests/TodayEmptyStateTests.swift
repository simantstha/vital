import XCTest
@testable import Vital

/// Regression tests for `docs/superpowers/plans/2026-09-02-stop-rendering-absent-data.md`:
/// absent data (an empty brief, an unmeasured metric) must never render as if
/// it were real — no empty container shells, no fabricated `0`.
@MainActor
final class TodayEmptyStateTests: XCTestCase {

    // MARK: - Defect 1: empty insight / plan render no container

    func testCoachBubbleIsEmptyForBlankOrWhitespaceMessage() {
        XCTAssertTrue(CoachBubble.isEmpty(""))
        XCTAssertTrue(CoachBubble.isEmpty("   \n\t "))
        XCTAssertFalse(CoachBubble.isEmpty("Protein's low today — add a snack."))
    }

    func testPlanTimelineViewIsEmptyForEmptyItems() {
        let empty = PlanTimelineView(
            items: [],
            onItemTap: { _ in },
            onLogItem: { _ in },
            onOpenAdd: {}
        )
        XCTAssertTrue(empty.isEmpty)

        let nonEmpty = PlanTimelineView(
            items: [
                PlanItem(
                    id: "1",
                    timeMinutes: 480,
                    title: "Breakfast",
                    subtitle: "",
                    sfSymbol: "sunrise.fill",
                    status: .later,
                    source: .coach,
                    kind: .meal
                )
            ],
            onItemTap: { _ in },
            onLogItem: { _ in },
            onOpenAdd: {}
        )
        XCTAssertFalse(nonEmpty.isEmpty)
    }

    /// The exact production scenario from the audit: the brief cache misses
    /// and `/api/today` returns `insight: ''` and `plan: []`. Neither the
    /// coach bubble nor the plan timeline should have anything to show.
    func testEmptyBriefPayloadRendersNeitherContainer() throws {
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
        viewModel.applyPlanResult(nil, todayPlan: response.plan)

        XCTAssertTrue(CoachBubble.isEmpty(viewModel.coachInsight))
        XCTAssertTrue(viewModel.planItems.isEmpty)
    }

    // MARK: - Defect 2: null metrics render the "—" placeholder, not 0

    func testNullHRVPayloadRendersPlaceholderNotZero() throws {
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
          "insight": "Welcome to Vital.",
          "plan": [],
          "calibration": null
        }
        """.utf8))

        viewModel.applyTodayResponse(response)

        XCTAssertNil(viewModel.hrv.value)
        XCTAssertEqual(viewModel.hrv.displayValue, "—")
        XCTAssertEqual(viewModel.hrv.displayUnit, "")

        XCTAssertNil(viewModel.sleep.hours)
        XCTAssertNil(viewModel.sleep.minutes)
        XCTAssertEqual(viewModel.sleep.formatted, "—")

        XCTAssertNil(viewModel.restingHR.bpm)
        XCTAssertEqual(viewModel.restingHR.displayValue, "—")
        XCTAssertEqual(viewModel.restingHR.displayUnit, "")
    }

    /// A real, measured `0` must still render as `0` — the fix distinguishes
    /// "not measured" from "measured zero"; it must not treat every zero as
    /// absent.
    func testMeasuredZeroHRVRendersAsZeroNotPlaceholder() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })
        let response = try JSONDecoder().decode(TodayResponse.self, from: Data("""
        {
          "metrics": {
            "hrv": {"value": 0, "unit": "ms", "deltaPct": 0},
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

        XCTAssertEqual(viewModel.hrv.value, 0)
        XCTAssertEqual(viewModel.hrv.displayValue, "0")
        XCTAssertEqual(viewModel.hrv.displayUnit, "ms")
    }

    func testRealMetricsOverwriteSeededPlaceholder() throws {
        let viewModel = TodayViewModel(fetchStreak: { StreakResponse(streakDays: 0) })
        XCTAssertNil(viewModel.hrv.value) // seeded default is nil, not 0

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

        XCTAssertEqual(viewModel.hrv.displayValue, "52")
        XCTAssertEqual(viewModel.sleep.formatted, "7h 30m")
        XCTAssertEqual(viewModel.restingHR.displayValue, "58")
    }
}
