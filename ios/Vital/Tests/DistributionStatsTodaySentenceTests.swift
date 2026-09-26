import XCTest
@testable import Vital

/// Coverage for `DistributionStats.todaySentence`, the detail view's
/// "Today is higher/lower than N% of your last 90 days" line — kept separate
/// from the existing `DistributionStatsTests.swift` (which covers `caption`,
/// left unchanged) so this doesn't collide with another engineer's edits to
/// that file.
final class DistributionStatsTodaySentenceTests: XCTestCase {

    func testSaysHigherThanWhenAboveMedian() {
        let values = Array(stride(from: 1.0, through: 100.0, by: 1.0)) // median 50.5
        let result = DistributionStats.compute(values: values, latest: 90)!
        let sentence = DistributionStats.todaySentence(result: result, latest: 90, values: values)
        XCTAssertTrue(sentence.hasPrefix("Today is higher than"))
        XCTAssertTrue(sentence.contains("100 days"))
    }

    func testSaysLowerThanWhenAtOrBelowMedian() {
        let values = Array(stride(from: 1.0, through: 100.0, by: 1.0))
        let result = DistributionStats.compute(values: values, latest: 10)!
        let sentence = DistributionStats.todaySentence(result: result, latest: 10, values: values)
        XCTAssertTrue(sentence.hasPrefix("Today is lower than"))
    }

    func testSentenceCitesActualSampleCount() {
        let values: [Double] = [40, 42, 44, 46, 48, 50]
        let result = DistributionStats.compute(values: values, latest: 50)!
        let sentence = DistributionStats.todaySentence(result: result, latest: 50, values: values)
        XCTAssertTrue(sentence.contains("6 days"))
    }
}
