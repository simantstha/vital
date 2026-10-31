import XCTest
@testable import Vital

final class MetricRecordsTests: XCTestCase {

    private static let anchor: Date = {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 6; comps.day = 1; comps.hour = 12
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

    func testReturnsNilForEmptyPoints() {
        XCTAssertNil(MetricRecords.compute(points: [], mean30: nil, sd30: nil))
    }

    func testFindsHighestAndLowestWithDates() {
        let values: [Double] = [45, 50, 40, 55, 48]
        let result = MetricRecords.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertEqual(result?.highest.value, 55)
        XCTAssertEqual(result?.highest.date, day(3))
        XCTAssertEqual(result?.lowest.value, 40)
        XCTAssertEqual(result?.lowest.date, day(2))
    }

    /// A tie for the highest reading belongs to the most recent day, so the card's
    /// date agrees with "Today is your highest" when today ties the record.
    func testTiedHighestPicksTheMostRecentDay() {
        let values: [Double] = [50, 58, 52, 49, 58]
        let result = MetricRecords.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertEqual(result?.highest.value, 58)
        XCTAssertEqual(result?.highest.date, day(4))
    }

    func testTiedLowestPicksTheMostRecentDay() {
        let values: [Double] = [51, 55, 60, 51, 57]
        let result = MetricRecords.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertEqual(result?.lowest.value, 51)
        XCTAssertEqual(result?.lowest.date, day(3))
    }

    func testTieIsResolvedByDateNotInputOrder() {
        let shuffled = points([58, 40, 58, 45]).reversed().map { $0 }
        let result = MetricRecords.compute(points: Array(shuffled), mean30: nil, sd30: nil)
        XCTAssertEqual(result?.highest.date, day(2))
    }

    /// The card and the caption must agree when today ties the record.
    func testRecordDateMatchesTodaySentenceWhenTodayTiesTheHighest() throws {
        let values: [Double] = [50, 58, 52, 49, 58]
        let pts = points(values)
        let records = try XCTUnwrap(MetricRecords.compute(points: pts, mean30: nil, sd30: nil))
        let dist = try XCTUnwrap(DistributionStats.compute(values: values, latest: 58))
        XCTAssertTrue(DistributionStats.todaySentence(result: dist, latest: 58, values: values).contains("highest"))
        XCTAssertEqual(records.highest.date, pts.last?.date, "the highest record is today's")
    }

    func testDetectsClimbingStreakOverInNormalStreak() {
        var values = [Double](repeating: 50, count: 5) // in-normal baseline days
        values.append(contentsOf: [55, 60, 65]) // then a clear climb
        let result = MetricRecords.compute(points: points(values), mean30: 50, sd30: 3)
        XCTAssertTrue(result?.streakText?.hasPrefix("Climbing") ?? false)
    }

    func testFallsBackToInNormalStreakWhenNotClimbing() {
        let values = [Double](repeating: 50, count: 6)
        let result = MetricRecords.compute(points: points(values), mean30: 50, sd30: 5)
        XCTAssertEqual(result?.streakText, "In normal 6 days")
    }

    func testStreakIsNilWithoutUsableBaselineAndNoClimb() {
        let values = [Double](repeating: 50, count: 6)
        let result = MetricRecords.compute(points: points(values), mean30: nil, sd30: nil)
        XCTAssertNil(result?.streakText)
    }

    func testNeverFabricatesInNormalStreakFromDegenerateBaseline() {
        let values = [Double](repeating: 50, count: 6)
        let result = MetricRecords.compute(points: points(values), mean30: 50, sd30: 0)
        XCTAssertNil(result?.streakText)
    }
}
