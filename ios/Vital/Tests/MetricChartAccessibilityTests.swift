import XCTest
import Accessibility
@testable import Vital

/// Coverage of `MetricChartAccessibility`'s pure summary-label/value string
/// composition, plus `MetricChartDescriptor.makeChartDescriptor()` — the
/// per-point `AXChartDescriptor` that lets VoiceOver swipe through
/// `MetricDetailView`'s chart instead of seeing one opaque image.
final class MetricChartAccessibilityTests: XCTestCase {

    private var hrvSpec: MetricSpec { MetricCatalog.spec(for: "hrv_sdnn")! }

    private func points(_ values: [Double], startingDaysAgo: Int = 4) -> [ChartPoint] {
        values.enumerated().map { index, value in
            ChartPoint(date: Date(timeIntervalSinceNow: TimeInterval(-86400 * (startingDaysAgo - index))), value: value)
        }
    }

    // MARK: - summaryLabel

    func testSummaryLabelIncludesEveryPartWhenAllAreKnown() {
        let label = MetricChartAccessibility.summaryLabel(
            metricName: "HRV",
            rangeLabel: "30 days",
            latest: 52,
            mean30: 47,
            spec: hrvSpec,
            unitSystem: .metric,
            verdict: .above(z: 1.5)
        )
        XCTAssertEqual(label, "HRV chart, last 30 days, latest 52 milliseconds, 30 day average 47 milliseconds, above your normal")
    }

    /// A metric with no readings yet in the window — `latest`/`mean30` are
    /// `nil`, and the sentence must not fabricate a "latest"/"average"
    /// clause for data that doesn't exist.
    func testSummaryLabelOmitsLatestAndMeanWhenNil() {
        let label = MetricChartAccessibility.summaryLabel(
            metricName: "HRV",
            rangeLabel: "14 days",
            latest: nil,
            mean30: nil,
            spec: hrvSpec,
            unitSystem: .metric,
            verdict: .noData
        )
        XCTAssertEqual(label, "HRV chart, last 14 days, no data yet")
    }

    func testSummaryLabelNeverMentionsZScore() {
        let label = MetricChartAccessibility.summaryLabel(
            metricName: "HRV",
            rangeLabel: "30 days",
            latest: 60,
            mean30: 47,
            spec: hrvSpec,
            unitSystem: .metric,
            verdict: .above(z: 4.2)
        )
        XCTAssertFalse(label.contains("4.2"))
    }

    // MARK: - scrubbedValueText

    func testScrubbedValueTextFormatsDateAndValue() {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 3; comps.day = 10; comps.hour = 9
        let calendar = Calendar(identifier: .gregorian)
        let date = calendar.date(from: comps)!

        let text = MetricChartAccessibility.scrubbedValueText(date: date, value: 55, spec: hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.hasSuffix("55 milliseconds"), "expected the value clause to end the string, got: \(text)")
        XCTAssertTrue(text.contains("Mar"), "expected a formatted month in the date clause, got: \(text)")
    }

    // MARK: - MetricChartDescriptor

    func testDescriptorSeriesContainsEveryPoint() {
        let pts = points([45, 46, 47, 50, 52])
        let descriptor = MetricChartDescriptor(
            points: pts, metricName: "HRV", spec: hrvSpec, unitSystem: .metric, yDomain: 40...55
        ).makeChartDescriptor()

        XCTAssertEqual(descriptor.series.count, 1)
        XCTAssertEqual(descriptor.series.first?.dataPoints.count, pts.count)
        XCTAssertTrue(descriptor.series.first?.isContinuous ?? false)
    }

    func testDescriptorYAxisRangeMatchesTheChartsExplicitDomain() {
        let pts = points([45, 46, 47])
        let descriptor = MetricChartDescriptor(
            points: pts, metricName: "HRV", spec: hrvSpec, unitSystem: .metric, yDomain: 40...55
        ).makeChartDescriptor()

        XCTAssertEqual(descriptor.yAxis?.range, 40...55)
    }

    func testDescriptorTitleUsesTheMetricName() {
        let pts = points([45, 46, 47])
        let descriptor = MetricChartDescriptor(
            points: pts, metricName: "HRV", spec: hrvSpec, unitSystem: .metric, yDomain: 40...55
        ).makeChartDescriptor()

        XCTAssertEqual(descriptor.title, "HRV")
    }

    /// A single-point series must not divide by (or produce) a zero-width
    /// X-axis range — `makeChartDescriptor()` pads the upper bound by at
    /// least one second when `min == max`.
    func testDescriptorHandlesASinglePointWithoutACollapsedXRange() {
        let pts = points([45], startingDaysAgo: 0)
        let descriptor = MetricChartDescriptor(
            points: pts, metricName: "HRV", spec: hrvSpec, unitSystem: .metric, yDomain: 40...55
        ).makeChartDescriptor()

        guard let xAxis = descriptor.xAxis as? AXNumericDataAxisDescriptor else {
            return XCTFail("expected a numeric X axis")
        }
        XCTAssertLessThan(xAxis.range.lowerBound, xAxis.range.upperBound)
    }
}
