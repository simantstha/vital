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
}
