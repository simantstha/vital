import XCTest
@testable import Vital

/// Pure coverage of `MetricDetailViewModel`'s two static helpers — no
/// network, no `@MainActor` isolation needed since both are pure functions.
final class MetricDetailViewModelTests: XCTestCase {

    private static let anchor: Date = {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 8; comps.day = 1; comps.hour = 12
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal.date(from: comps)!
    }()

    private func day(_ offset: Int) -> Date {
        Calendar(identifier: .gregorian).date(byAdding: .day, value: offset, to: Self.anchor)!
    }

    // MARK: - nearestPoint(to:in:) — the scrub snap

    func testNearestPointSnapsToExactMatch() {
        let points = [
            ChartPoint(date: day(0), value: 10),
            ChartPoint(date: day(1), value: 20),
            ChartPoint(date: day(2), value: 30),
        ]
        let result = MetricDetailViewModel.nearestPoint(to: day(1), in: points)
        XCTAssertEqual(result?.value, 20)
    }

    /// The continuous plot-space date from `.chartXSelection` almost never
    /// lands exactly on a point — a selection slightly closer to day(1) than
    /// day(2) must snap to day(1), not float in between.
    func testNearestPointSnapsToCloserNeighborWhenBetweenTwoPoints() {
        let points = [
            ChartPoint(date: day(0), value: 10),
            ChartPoint(date: day(1), value: 20),
            ChartPoint(date: day(2), value: 30),
        ]
        let almostDay1 = Calendar(identifier: .gregorian).date(byAdding: .hour, value: 2, to: day(1))!
        let result = MetricDetailViewModel.nearestPoint(to: almostDay1, in: points)
        XCTAssertEqual(result?.value, 20)

        let almostDay2 = Calendar(identifier: .gregorian).date(byAdding: .hour, value: -2, to: day(2))!
        let result2 = MetricDetailViewModel.nearestPoint(to: almostDay2, in: points)
        XCTAssertEqual(result2?.value, 30)
    }

    func testNearestPointSnapsToOnlyPointRegardlessOfDistance() {
        let points = [ChartPoint(date: day(0), value: 42)]
        let farAway = Calendar(identifier: .gregorian).date(byAdding: .day, value: 400, to: day(0))!
        XCTAssertEqual(MetricDetailViewModel.nearestPoint(to: farAway, in: points)?.value, 42)
    }

    func testNearestPointReturnsNilForEmptyPoints() {
        XCTAssertNil(MetricDetailViewModel.nearestPoint(to: day(0), in: []))
    }

    func testNearestPointSnapsBeforeFirstPointToFirstPoint() {
        let points = [ChartPoint(date: day(5), value: 1), ChartPoint(date: day(10), value: 2)]
        let result = MetricDetailViewModel.nearestPoint(to: day(0), in: points)
        XCTAssertEqual(result?.value, 1)
    }

    // MARK: - isDownsampled(_:calendar:) — the "weekly average" subtitle gate

    private func days(_ count: Int) -> [ChartPoint] {
        (0..<count).map { ChartPoint(date: day($0), value: Double($0)) }
    }

    func testIsDownsampledFalseAtExactlyNinetyPoints() {
        XCTAssertFalse(MetricDetailViewModel.isDownsampled(days(90)))
    }

    func testIsDownsampledFalseWellUnderThreshold() {
        XCTAssertFalse(MetricDetailViewModel.isDownsampled(days(14)))
    }

    func testIsDownsampledTrueAboveNinetyPoints() {
        XCTAssertTrue(MetricDetailViewModel.isDownsampled(days(365)))
    }

    func testIsDownsampledFalseForEmptyPoints() {
        XCTAssertFalse(MetricDetailViewModel.isDownsampled([]))
    }

    // MARK: - chartYDomain(rawValues:bandLower:bandUpper:floor:) — the ±1σ band visibility fix

    /// With no band (gated off), the domain must tighten to the data alone —
    /// never fall back to a 0 floor, which is exactly the bug that crushed
    /// all the real variation into the top of the plot.
    func testChartYDomainTightensToDataWhenBandGatedOff() {
        let domain = MetricDetailViewModel.chartYDomain(
            rawValues: [43, 46, 48, 52],
            bandLower: nil,
            bandUpper: nil,
            floor: 1.0
        )
        // pad = max((52-43)*0.12, 1.0) = max(1.08, 1.0) = 1.08
        XCTAssertEqual(domain.lowerBound, 43 - 1.08, accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 52 + 1.08, accuracy: 0.001)
    }

    /// The domain must widen to contain the band even where the band extends
    /// past the raw data's own extremes — otherwise the band's edge would sit
    /// flush against (or past) the plot's edge instead of reading as a zone
    /// with room around it.
    func testChartYDomainWidensToContainBandBeyondDataExtremes() {
        let domain = MetricDetailViewModel.chartYDomain(
            rawValues: [46, 48, 50],
            bandLower: 40,   // below the data's own min of 46
            bandUpper: 49,   // between the data's min and max
            floor: 1.0
        )
        // lower = min(46, 40) = 40; upper = max(50, 49) = 50
        // pad = max((50-40)*0.12, 1.0) = 1.2
        XCTAssertEqual(domain.lowerBound, 40 - 1.2, accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 50 + 1.2, accuracy: 0.001)
    }

    /// A flat series (every reading identical — a smart scale's stuck
    /// reading, or a single day of data) makes `upper == lower`, and a
    /// *percentage* pad of a zero span is still zero. Without the explicit
    /// floor fallback, the returned domain would have zero height and Swift
    /// Charts would render nothing at all.
    func testChartYDomainGuardsFlatSeriesFromCollapsingToZeroHeight() {
        let domain = MetricDetailViewModel.chartYDomain(
            rawValues: [70, 70, 70],
            bandLower: nil,
            bandUpper: nil,
            floor: 0.5
        )
        XCTAssertEqual(domain.lowerBound, 69.5, accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 70.5, accuracy: 0.001)
        XCTAssertGreaterThan(domain.upperBound, domain.lowerBound)
    }

    /// Same degenerate guard, but via a single raw point — the most common
    /// real path into `upper == lower` (day one of a metric's history).
    func testChartYDomainGuardsSinglePointFromCollapsingToZeroHeight() {
        let domain = MetricDetailViewModel.chartYDomain(
            rawValues: [46],
            bandLower: nil,
            bandUpper: nil,
            floor: 1.0
        )
        XCTAssertEqual(domain.lowerBound, 45.0, accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 47.0, accuracy: 0.001)
    }

    /// Degenerate even WITH a band: mean30 == sd30's window collapsing onto
    /// a single-valued data set (e.g. `bandLower == bandUpper == rawValue`).
    func testChartYDomainGuardsFlatSeriesWithDegenerateBand() {
        let domain = MetricDetailViewModel.chartYDomain(
            rawValues: [70, 70],
            bandLower: 70,
            bandUpper: 70,
            floor: 0.15
        )
        XCTAssertEqual(domain.lowerBound, 69.85, accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 70.15, accuracy: 0.001)
        XCTAssertGreaterThan(domain.upperBound, domain.lowerBound)
    }

    /// Empty `rawValues` is defensive-only (callers gate the chart entirely
    /// on `chartPoints.isEmpty` before this is ever called) but must still
    /// return a well-formed, non-zero-height range rather than trapping.
    func testChartYDomainReturnsNonEmptyRangeForEmptyValues() {
        let domain = MetricDetailViewModel.chartYDomain(
            rawValues: [],
            bandLower: nil,
            bandUpper: nil,
            floor: 1.0
        )
        XCTAssertGreaterThan(domain.upperBound, domain.lowerBound)
    }
}
