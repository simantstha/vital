import XCTest
@testable import Vital

final class TrendBarChartLogicTests: XCTestCase {

    // MARK: - chartMax

    func testChartMaxIs112PercentOfGoalWhenNoNightBeatsTheGoal() {
        XCTAssertEqual(TrendBarChartLogic.chartMax(values: [6, 7, nil, 7.5], goalHours: 8), 8.96, accuracy: 0.001)
    }

    func testChartMaxGrowsToFitANightTallerThanTheGoalHeadroom() {
        // 9.2h beats 8 * 1.12 = 8.96h, so the ceiling grows to fit it instead
        // of clipping the bar flat.
        XCTAssertEqual(TrendBarChartLogic.chartMax(values: [6, 9.2, nil], goalHours: 8), 9.2, accuracy: 0.001)
    }

    func testChartMaxFallsBackToADefaultGoalOfOneHourWhenGoalIsNonPositive() {
        XCTAssertEqual(TrendBarChartLogic.chartMax(values: [nil, nil], goalHours: 0), 1.12, accuracy: 0.001)
    }

    // MARK: - fraction

    func testFractionIsValueOverChartMax() {
        XCTAssertEqual(TrendBarChartLogic.fraction(value: 4, chartMax: 8), 0.5, accuracy: 0.0001)
    }

    func testFractionClampsToZeroAndOne() {
        XCTAssertEqual(TrendBarChartLogic.fraction(value: -2, chartMax: 8), 0)
        XCTAssertEqual(TrendBarChartLogic.fraction(value: 20, chartMax: 8), 1)
    }

    func testFractionIsZeroForANonPositiveChartMax() {
        XCTAssertEqual(TrendBarChartLogic.fraction(value: 4, chartMax: 0), 0)
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
