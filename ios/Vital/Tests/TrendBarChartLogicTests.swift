import XCTest
@testable import Vital

final class TrendBarChartLogicTests: XCTestCase {

    // MARK: - layout

    private func slots(_ values: [Double?], goal: Double = 8) -> [TrendBarChartLogic.Slot] {
        TrendBarChartLogic.layout(values: values, goalHours: goal).slots
    }

    func testLayoutAllShortNightsHangFromALineAtTheTop() {
        // 7h15 (-45m), 7h (-60m), 6h40 (-80m): span = 80m, nothing above goal.
        let layout = TrendBarChartLogic.layout(values: [7.25, 7.0, 6 + 40.0 / 60], goalHours: 8)
        XCTAssertEqual(layout.slots.map(\.minutesVsGoal), [-45, -60, -80])
        XCTAssertEqual(layout.goalLineFraction, 0, accuracy: 1e-9)
        XCTAssertEqual(layout.slots[0].shortFraction, 45.0 / 80, accuracy: 1e-9)
        XCTAssertEqual(layout.slots[1].shortFraction, 60.0 / 80, accuracy: 1e-9)
        XCTAssertEqual(layout.slots[2].shortFraction, 1, accuracy: 1e-9)
        XCTAssertTrue(layout.slots.allSatisfy { $0.overFraction == 0 })
    }

    func testLayoutMixedOverAndShortSplitsTheSpanAroundTheGoalLine() {
        // +30m over, -90m short: span 120m, goal line a quarter of the way down.
        let layout = TrendBarChartLogic.layout(values: [8.5, 6.5, 7.0], goalHours: 8)
        XCTAssertEqual(layout.slots.map(\.minutesVsGoal), [30, -90, -60])
        XCTAssertEqual(layout.goalLineFraction, 30.0 / 120, accuracy: 1e-9)
        XCTAssertEqual(layout.slots[0].overFraction, 30.0 / 120, accuracy: 1e-9)
        XCTAssertEqual(layout.slots[0].shortFraction, 0)
        XCTAssertEqual(layout.slots[1].shortFraction, 90.0 / 120, accuracy: 1e-9)
        XCTAssertEqual(layout.slots[1].overFraction, 0)
        XCTAssertEqual(layout.slots[2].shortFraction, 60.0 / 120, accuracy: 1e-9)
        // Bars plus the line never leave the plot: over + short fit in 0...1.
        XCTAssertEqual(layout.goalLineFraction + layout.slots[1].shortFraction, 1, accuracy: 1e-9)
    }

    func testLayoutMissingNightsHaveNoMinutesAndNoHeight() {
        let result = slots([nil, 7.0, nil])
        XCTAssertNil(result[0].minutesVsGoal)
        XCTAssertEqual(result[0].shortFraction, 0)
        XCTAssertEqual(result[0].overFraction, 0)
        XCTAssertEqual(result[1].minutesVsGoal, -60)
        XCTAssertNil(result[2].minutesVsGoal)
    }

    func testLayoutAllMissingDoesNotCrashAndDrawsNothing() {
        let layout = TrendBarChartLogic.layout(values: [nil, nil, nil], goalHours: 8)
        XCTAssertEqual(layout.slots.count, 3)
        XCTAssertTrue(layout.slots.allSatisfy { $0.minutesVsGoal == nil && $0.shortFraction == 0 && $0.overFraction == 0 })
        XCTAssertEqual(layout.goalLineFraction, 0)
        XCTAssertTrue(TrendBarChartLogic.layout(values: [], goalHours: 8).slots.isEmpty)
    }

    func testLayoutNightExactlyAtGoalIsZeroMinutesWithNoBar() {
        let layout = TrendBarChartLogic.layout(values: [8.0, 7.0], goalHours: 8)
        XCTAssertEqual(layout.slots[0].minutesVsGoal, 0)
        XCTAssertEqual(layout.slots[0].shortFraction, 0)
        XCTAssertEqual(layout.slots[0].overFraction, 0)
        XCTAssertEqual(layout.goalLineFraction, 0)
    }

    func testLayoutOneNightOnly() {
        let short = TrendBarChartLogic.layout(values: [nil, nil, 6.0], goalHours: 8)
        XCTAssertEqual(short.slots[2].minutesVsGoal, -120)
        XCTAssertEqual(short.slots[2].shortFraction, 1, accuracy: 1e-9)
        XCTAssertEqual(short.goalLineFraction, 0)

        let over = TrendBarChartLogic.layout(values: [nil, 9.0, nil], goalHours: 8)
        XCTAssertEqual(over.slots[1].minutesVsGoal, 60)
        XCTAssertEqual(over.slots[1].overFraction, 1, accuracy: 1e-9)
        XCTAssertEqual(over.goalLineFraction, 1, accuracy: 1e-9)
    }

    func testLayoutNonPositiveGoalFallsBackToEightHoursWithoutCrashing() {
        for goal in [0.0, -3.0, .nan, -.infinity] {
            let layout = TrendBarChartLogic.layout(values: [7.0, 9.0, nil], goalHours: goal)
            XCTAssertEqual(layout.slots.map(\.minutesVsGoal), [-60, 60, nil], "goal \(goal)")
            XCTAssertEqual(layout.goalLineFraction, 0.5, accuracy: 1e-9, "goal \(goal)")
        }
    }

    func testLayoutSpanHasASixtyMinuteFloorSoSmallGapsStaySmall() {
        // 12 minutes short alone would fill the plot; the floor keeps it at 12/60.
        let layout = TrendBarChartLogic.layout(values: [7.8, 8.0], goalHours: 8)
        XCTAssertEqual(layout.slots[0].minutesVsGoal, -12)
        XCTAssertEqual(layout.slots[0].shortFraction, 12.0 / 60, accuracy: 1e-9)
        // Exactly 60 minutes of span is not floored upward.
        let exact = TrendBarChartLogic.layout(values: [7.0], goalHours: 8)
        XCTAssertEqual(exact.slots[0].shortFraction, 1, accuracy: 1e-9)
        // Mixed small gaps share the floor too: +10 and -20 over a 60m span.
        let mixed = TrendBarChartLogic.layout(values: [8 + 10.0 / 60, 8 - 20.0 / 60], goalHours: 8)
        XCTAssertEqual(mixed.goalLineFraction, 10.0 / 60, accuracy: 1e-9)
        XCTAssertEqual(mixed.slots[1].shortFraction, 20.0 / 60, accuracy: 1e-9)
    }

    func testLayoutRoundsMinutesToTheNearestMinute() {
        // 7.508h = 450.48m vs 480m -> -29.52 -> -30
        XCTAssertEqual(slots([7.508])[0].minutesVsGoal, -30)
        // 7.5h goal, 7.5h night -> exactly 0
        XCTAssertEqual(slots([7.5], goal: 7.5)[0].minutesVsGoal, 0)
    }

    // MARK: - deltaLabel

    func testDeltaLabelFormatsShortOverAndZero() {
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: -45), "\u{2212}45m")
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: 12), "+12m")
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: 0), "0m")
    }

    func testDeltaLabelSwitchesToHoursAtSixtyMinutes() {
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: -59), "\u{2212}59m")
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: -60), "\u{2212}1h00")
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: -80), "\u{2212}1h20")
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: -125), "\u{2212}2h05")
        XCTAssertEqual(TrendBarChartLogic.deltaLabel(minutes: 75), "+1h15")
    }

    func testDeltaLabelUsesTheTrueMinusSignNotAHyphen() {
        XCTAssertFalse(TrendBarChartLogic.deltaLabel(minutes: -5).contains("-"))
    }

    // MARK: - compactHoursLabel

    func testCompactHoursLabelFormatsHoursAndZeroPaddedMinutes() {
        XCTAssertEqual(TrendBarChartLogic.compactHoursLabel(8.1), "8h06")
        XCTAssertEqual(TrendBarChartLogic.compactHoursLabel(7.0), "7h00")
    }

    // MARK: - accessibilityLabel

    func testAccessibilityLabelIncludesHoursAndMinutesForAnAvailableNight() {
        XCTAssertEqual(
            TrendBarChartLogic.accessibilityLabel(fullDayName: "Monday", hours: 7.4, shortThresholdHours: 6),
            "Monday, 7 hours 24 minutes"
        )
    }

    func testAccessibilityLabelAppendsShortNightBelowThreshold() {
        XCTAssertEqual(
            TrendBarChartLogic.accessibilityLabel(fullDayName: "Tuesday", hours: 5.5, shortThresholdHours: 6),
            "Tuesday, 5 hours 30 minutes, short night"
        )
    }

    func testAccessibilityLabelOmitsShortNightAtExactlyTheThreshold() {
        XCTAssertEqual(
            TrendBarChartLogic.accessibilityLabel(fullDayName: "Wednesday", hours: 6, shortThresholdHours: 6),
            "Wednesday, 6 hours 0 minutes"
        )
    }

    func testAccessibilityLabelForAMissingNight() {
        XCTAssertEqual(
            TrendBarChartLogic.accessibilityLabel(fullDayName: "Thursday", hours: nil, shortThresholdHours: 6),
            "Thursday, no sleep synced"
        )
    }
}
