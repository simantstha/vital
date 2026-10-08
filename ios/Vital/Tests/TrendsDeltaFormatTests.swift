import XCTest
@testable import Vital

final class TrendsDeltaFormatTests: XCTestCase {

    private var hrvSpec: MetricSpec { MetricCatalog.spec(for: "hrv_sdnn")! } // 0 decimals, unit "ms"
    private var weightSpec: MetricSpec { MetricCatalog.spec(for: "body_mass_kg")! } // 1 decimal
    private var stepsSpec: MetricSpec { MetricCatalog.spec(for: "steps")! } // unitless

    func testNormalPillInsideBandNamesTheNormalRange() {
        XCTAssertEqual(TrendsDeltaFormat.normalPillText(value: 52, lower: 49, upper: 55, spec: hrvSpec, system: .metric), "Within your normal range (49\u{2013}55)")
        XCTAssertEqual(TrendsDeltaFormat.normalPillText(value: 55, lower: 49, upper: 55, spec: hrvSpec, system: .metric), "Within your normal range (49\u{2013}55)")
    }

    /// Normal value = middle of the band (mean30 = 52); 58 is 6 above it, not 3
    /// above the band edge.
    func testNormalPillAboveMeasuresToTheNormalValue() {
        XCTAssertEqual(TrendsDeltaFormat.normalPillText(value: 58, lower: 49, upper: 55, spec: hrvSpec, system: .metric), "\u{2191} 6 ms above your normal (52 ms)")
    }

    func testNormalPillBelowMeasuresToTheNormalValue() {
        XCTAssertEqual(TrendsDeltaFormat.normalPillText(value: 45, lower: 49, upper: 55, spec: hrvSpec, system: .metric), "\u{2193} 7 ms below your normal (52 ms)")
    }

    /// The Trends example: HRV 51 vs a 30-day normal of 57 reads "6 ms below your
    /// normal (57 ms)" on the detail pill too (band 54-60 here).
    func testNormalPillStatesTheSameReferenceAsTheTrendsRow() {
        XCTAssertEqual(TrendsDeltaFormat.normalPillText(value: 51, lower: 54, upper: 60, spec: hrvSpec, system: .metric), "\u{2193} 6 ms below your normal (57 ms)")
    }

    func testArrowIsUpForNonNegativeDeltaIncludingZero() {
        XCTAssertEqual(TrendsDeltaFormat.arrow(7), "↑")
        XCTAssertEqual(TrendsDeltaFormat.arrow(0), "↑")
    }

    func testArrowIsDownForNegativeDelta() {
        XCTAssertEqual(TrendsDeltaFormat.arrow(-4), "↓")
    }

    func testMagnitudeTextRoundsToSpecDecimalsAndTakesAbsoluteValue() {
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(-7.3, spec: hrvSpec, system: .metric, includeUnit: false), "7")
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(1.23, spec: weightSpec, system: .metric, includeUnit: false), "1.2")
    }

    func testMagnitudeTextAppendsUnitOnlyWhenRequestedAndNonEmpty() {
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(7, spec: hrvSpec, system: .metric, includeUnit: true), "7 ms")
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(7, spec: hrvSpec, system: .metric, includeUnit: false), "7")
    }

    func testMagnitudeTextOmitsUnitForAUnitlessMetricEvenWhenRequested() {
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(500, spec: stepsSpec, system: .metric, includeUnit: true), "500")
    }

    func testMagnitudeTextRespectsImperialUnitConversionMetrics() {
        // body_mass_kg's `unit(_:)` (not `magnitudeText`'s own logic) switches
        // by system — this just confirms the plumbing reaches it.
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(2, spec: weightSpec, system: .imperial, includeUnit: true), "2 lb")
    }

    func testFormattedNumberUsesGroupingSeparatorForLargeValues() {
        XCTAssertEqual(TrendsDeltaFormat.formattedNumber(12345, decimals: 0), "12,345")
    }

    func testFormattedNumberIsStableAcrossRepeatedCallsWithDifferentDecimals() {
        // Exercises the per-decimals formatter cache — a second call with a
        // different `decimals` must not reuse (and misformat with) the
        // first call's cached formatter.
        XCTAssertEqual(TrendsDeltaFormat.formattedNumber(1.2345, decimals: 0), "1")
        XCTAssertEqual(TrendsDeltaFormat.formattedNumber(1.2345, decimals: 2), "1.23")
        XCTAssertEqual(TrendsDeltaFormat.formattedNumber(1.2345, decimals: 0), "1")
    }

    // MARK: - Sleep reads as a duration

    private var sleepSpec: MetricSpec { MetricCatalog.spec(for: "sleep_minutes")! } // series in hours, unit "h"

    func testDurationTextIsHoursAndMinutes() {
        XCTAssertEqual(TrendsDeltaFormat.durationText(hours: 5.8), "5h 48m")
        XCTAssertEqual(TrendsDeltaFormat.durationText(hours: 8.1), "8h 06m", "same format as TrendsSummary.hoursMinutesText")
        XCTAssertEqual(TrendsDeltaFormat.durationText(hours: 1.0), "1h 00m")
        XCTAssertEqual(TrendsDeltaFormat.durationText(hours: 0.99999), "1h 00m")
        XCTAssertEqual(TrendsDeltaFormat.durationText(hours: 0.6), "36m")
        XCTAssertEqual(TrendsDeltaFormat.durationText(hours: -0.6), "36m", "unsigned: callers add the arrow / word")
    }

    func testValueTextAndUnitLabelTreatOnlySleepAsADuration() {
        XCTAssertEqual(TrendsDeltaFormat.valueText(5.8, spec: sleepSpec), "5h 48m")
        XCTAssertEqual(TrendsDeltaFormat.unitLabel(spec: sleepSpec, system: .metric), "", "the duration already carries h/m")
        XCTAssertEqual(TrendsDeltaFormat.valueText(51, spec: hrvSpec), "51")
        XCTAssertEqual(TrendsDeltaFormat.unitLabel(spec: hrvSpec, system: .metric), "ms")
        XCTAssertEqual(TrendsDeltaFormat.valueText(1.26, spec: weightSpec), "1.3")
        XCTAssertEqual(TrendsDeltaFormat.unitLabel(spec: nil, system: .metric), "")
        XCTAssertEqual(sleepSpec.format(5.8, .metric), "5h 48m", "no more \"5.8 h\"")
        XCTAssertEqual(hrvSpec.format(51, .metric), "51 ms")
    }

    func testSleepDeltasAndPillsReadAsDurations() {
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(-0.6, spec: sleepSpec, system: .metric, includeUnit: true), "36m")
        XCTAssertEqual(TrendsDeltaFormat.magnitudeText(-0.6, spec: sleepSpec, system: .metric, includeUnit: false), "36m")
        XCTAssertEqual(
            TrendsDeltaFormat.normalPillText(value: 5.8, lower: 6.9, upper: 7.5, spec: sleepSpec, system: .metric),
            "\u{2193} 1h 24m below your normal (7h 12m)"
        )
        XCTAssertEqual(
            TrendsDeltaFormat.normalPillText(value: 7.0, lower: 6.9, upper: 7.5, spec: sleepSpec, system: .metric),
            "Within your normal range (6h 54m\u{2013}7h 30m)"
        )
        XCTAssertEqual(
            TrendsMetricRowLogic.movedSecondary(value: 6.6, mean30: 7.2, spec: sleepSpec, rising: false, unitSystem: .metric).text,
            "\u{2193} 36m below normal"
        )
    }

}
