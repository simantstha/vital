import XCTest
@testable import Vital

/// Pure coverage of `MetricTileAccessibility.label` — the single combined
/// VoiceOver label `MetricTileView` attaches instead of exposing name/value/
/// chip/sparkline as four separate nodes. Every input is injected (a real
/// `MetricSpec` pulled from `MetricCatalog`, never a network fetch), so each
/// test pins an exact rendered sentence.
final class MetricTileAccessibilityTests: XCTestCase {

    private var hrvSpec: MetricSpec { MetricCatalog.spec(for: "hrv_sdnn")! }
    private var stepsSpec: MetricSpec { MetricCatalog.spec(for: "steps")! }
    private var weightSpec: MetricSpec { MetricCatalog.spec(for: "body_mass_kg")! }

    // MARK: - .chart content — value + spelled-out unit + verdict

    func testChartLabelAboveVerdictSpellsOutUnit() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 52, sparklineValues: [50, 51, 52], verdict: .above(z: 1.5)))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 52 milliseconds, above your normal")
    }

    func testChartLabelBelowVerdict() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 40, sparklineValues: [50, 51, 40], verdict: .below(z: -1.2)))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 40 milliseconds, below your normal")
    }

    func testChartLabelNormalVerdict() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 48, sparklineValues: [47, 48, 49], verdict: .normal))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 48 milliseconds, in your normal range")
    }

    func testChartLabelCalibratingWithMultipleDaysRemainingUsesPlural() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 48, sparklineValues: [47, 48, 49], verdict: .calibrating(daysRemaining: 3)))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 48 milliseconds, 3 more days until your normal range is known")
    }

    func testChartLabelCalibratingWithOneDayRemainingUsesSingular() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 48, sparklineValues: [47, 48, 49], verdict: .calibrating(daysRemaining: 1)))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 48 milliseconds, 1 more day until your normal range is known")
    }

    func testChartLabelCalibratingWithZeroDaysRemaining() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 48, sparklineValues: [47, 48, 49], verdict: .calibrating(daysRemaining: 0)))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 48 milliseconds, not enough variation yet to know your normal range")
    }

    func testChartLabelNoData() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 48, sparklineValues: [47, 48, 49], verdict: .noData))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 48 milliseconds, no data yet")
    }

    /// `steps` has no spoken unit word (mirrors `unit(_:)`'s empty suffix) —
    /// the label must not leave a dangling trailing space where the unit
    /// would have gone.
    func testChartLabelWithUnitlessMetricOmitsTrailingSpace() {
        let tile = TrendsTile(key: "steps", content: .chart(value: 500, sparklineValues: [400, 450, 500], verdict: .above(z: 1.1)))
        let label = MetricTileAccessibility.label(tile: tile, spec: stepsSpec, unitSystem: .metric)
        XCTAssertEqual(label, "Steps, 500, above your normal")
    }

    // MARK: - Unit system switches the spoken unit word, not just the abbreviation

    func testChartLabelBodyMassMetricSpeaksKilograms() {
        let tile = TrendsTile(key: "body_mass_kg", content: .chart(value: 70.3, sparklineValues: [70, 70.2, 70.3], verdict: .normal))
        let label = MetricTileAccessibility.label(tile: tile, spec: weightSpec, unitSystem: .metric)
        XCTAssertEqual(label, "Weight, 70.3 kilograms, in your normal range")
    }

    func testChartLabelBodyMassImperialSpeaksPounds() {
        let tile = TrendsTile(key: "body_mass_kg", content: .chart(value: 154.2, sparklineValues: [154, 154.1, 154.2], verdict: .normal))
        let label = MetricTileAccessibility.label(tile: tile, spec: weightSpec, unitSystem: .imperial)
        XCTAssertEqual(label, "Weight, 154.2 pounds, in your normal range")
    }

    // MARK: - .sparse content — value + reading count, no verdict

    func testSparseLabelSingularReading() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .sparse(value: 50, readingCount: 1))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 50 milliseconds, 1 reading")
    }

    func testSparseLabelPluralReadings() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .sparse(value: 50, readingCount: 2))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, 50 milliseconds, 2 readings")
    }

    // MARK: - .dimmed content — name + last-synced phrase, no value/verdict

    func testDimmedLabelWithKnownDateMentionsLastSynced() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .dimmed(lastDate: Date(timeIntervalSinceNow: -86400 * 5)))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertTrue(label.hasPrefix("HRV, last synced"), "expected a last-synced phrase, got: \(label)")
    }

    func testDimmedLabelWithNilDate() {
        let tile = TrendsTile(key: "hrv_sdnn", content: .dimmed(lastDate: nil))
        let label = MetricTileAccessibility.label(tile: tile, spec: hrvSpec, unitSystem: .metric)
        XCTAssertEqual(label, "HRV, last synced unknown")
    }

    // MARK: - Missing spec falls back to the raw key

    func testMissingSpecFallsBackToRawKeyAsName() {
        let tile = TrendsTile(key: "some_未知_metric", content: .dimmed(lastDate: nil))
        let label = MetricTileAccessibility.label(tile: tile, spec: nil, unitSystem: .metric)
        XCTAssertEqual(label, "some_未知_metric, last synced unknown")
    }

    // MARK: - `verdictPhrase` never surfaces σ (mirrors `TrendsVerdict`'s rule)

    func testVerdictPhraseNeverMentionsZScore() {
        let phrase = MetricTileAccessibility.verdictPhrase(.above(z: 3.7))
        XCTAssertFalse(phrase.contains("3.7"))
        XCTAssertEqual(phrase, "above your normal")
    }
}
