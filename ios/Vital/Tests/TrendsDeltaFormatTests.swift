import XCTest
@testable import Vital

final class TrendsDeltaFormatTests: XCTestCase {

    private var hrvSpec: MetricSpec { MetricCatalog.spec(for: "hrv_sdnn")! } // 0 decimals, unit "ms"
    private var weightSpec: MetricSpec { MetricCatalog.spec(for: "body_mass_kg")! } // 1 decimal
    private var stepsSpec: MetricSpec { MetricCatalog.spec(for: "steps")! } // unitless

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
