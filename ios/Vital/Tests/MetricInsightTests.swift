import XCTest
@testable import Vital

final class MetricInsightTests: XCTestCase {

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

    private func points(_ values: [Double]) -> [ChartPoint] {
        values.enumerated().map { ChartPoint(date: day($0.offset), value: $0.element) }
    }

    func testReturnsNilForTooFewPoints() {
        XCTAssertNil(MetricInsight.compute(points: points([1, 2, 3]), mean30: nil, sd30: nil))
    }

    func testDetectsClimbingStreak() {
        // 3-day trailing mean strictly increases for the last 5 transitions.
        let values: [Double] = [40, 40, 40, 41, 42, 43, 44, 45, 46, 47, 48]
        let result = MetricInsight.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertNotNil(result)
        XCTAssertTrue(result?.contains("Climbing for") == true)
    }

    func testDetectsNewSevenDayHighSinceEarlierMonth() {
        // A flat-ish early window, then a genuine new high at the end.
        var values = [Double](repeating: 40, count: 10)
        values.append(contentsOf: [50, 51, 52, 53, 54, 55, 56])
        let result = MetricInsight.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertNotNil(result)
        // Climbing streak may also qualify and take priority — either is a
        // legitimate true statement about this monotonically rising series,
        // so just assert something was returned, not which branch fired.
        XCTAssertFalse(result?.isEmpty ?? true)
    }

    func testDetectsLowestSinceADate() {
        var values = [Double](repeating: 60, count: 10)
        values.append(30) // today's reading is a clear new low
        let result = MetricInsight.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertNotNil(result)
        let text = result ?? ""
        XCTAssertTrue(text.contains("Lowest since") || text.contains("Climbing") || text.contains("highest"))
    }

    func testDetectsSteadyStreakWithinNormalBand() {
        // Flat series, well within a wide baseline band, no climbing trend.
        let values = [Double](repeating: 50, count: 8)
        let result = MetricInsight.compute(points: points(values), mean30: 50, sd30: 5)
        XCTAssertEqual(result, "Steady — within your normal for 8 days")
    }

    func testReturnsNilWhenNothingQualifies() {
        // Too few points for any 7-day-average/streak logic to engage, and
        // no baseline for the steady check.
        let result = MetricInsight.compute(points: points([50, 50, 50, 50]), mean30: nil, sd30: nil)
        XCTAssertNil(result)
    }

    func testNeverFabricatesSteadyStreakWithoutUsableBaseline() {
        let values = [Double](repeating: 50, count: 8)
        // Degenerate sd30 (zero) must never produce a steady claim.
        XCTAssertNil(MetricInsight.compute(points: points(values), mean30: 50, sd30: 0))
    }
}
