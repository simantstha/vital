import XCTest
@testable import Vital

/// Pure coverage of `DistributionStats.compute` — the histogram bucketing,
/// median, and percentile-rank math behind `MetricDistributionView`.
final class DistributionStatsTests: XCTestCase {

    func testEmptyValuesReturnsNil() {
        XCTAssertNil(DistributionStats.compute(values: [], latest: 5))
    }

    func testMedianOfOddCount() {
        let result = DistributionStats.compute(values: [1, 3, 5, 7, 9], latest: 5)
        XCTAssertEqual(result?.median, 5)
    }

    func testMedianOfEvenCountAveragesTheMiddleTwo() {
        let result = DistributionStats.compute(values: [1, 2, 3, 4], latest: 2)
        XCTAssertEqual(result?.median, 2.5)
    }

    /// The latest value is the maximum — it must rank at the 100th
    /// percentile (every value is at or below it).
    func testPercentileRankOfMaximumIsHundred() {
        let result = DistributionStats.compute(values: [10, 20, 30, 40, 50], latest: 50)
        XCTAssertEqual(result?.percentileRank, 100)
    }

    /// The latest value is the minimum — only itself is at-or-below, so 1
    /// of 5 values, 20%.
    func testPercentileRankOfMinimumReflectsOnlyItself() {
        let result = DistributionStats.compute(values: [10, 20, 30, 40, 50], latest: 10)
        XCTAssertEqual(result?.percentileRank, 20)
    }

    func testPercentileRankOfMedianValue() {
        let result = DistributionStats.compute(values: [10, 20, 30, 40, 50], latest: 30)
        XCTAssertEqual(result?.percentileRank, 60) // 3 of 5 at-or-below
    }

    /// Every value identical (e.g. a smart scale's flat reading, or a
    /// single day of data): must not divide by a zero-width range, and must
    /// collapse to one bucket holding every value.
    func testDegenerateSpreadCollapsesToOneBucket() {
        let result = DistributionStats.compute(values: [70, 70, 70, 70], latest: 70)
        XCTAssertEqual(result?.buckets.count, 1)
        XCTAssertEqual(result?.buckets.first?.count, 4)
        XCTAssertEqual(result?.latestBucketIndex, 0)
        XCTAssertEqual(result?.median, 70)
    }

    /// The bucket containing the latest value must actually contain it —
    /// every value sorted into a bucket sums back to the input count, and
    /// the maximum value (an edge case for the half-open-interval math)
    /// must land in the LAST bucket, not overflow past it.
    func testMaximumValueLandsInLastBucketNotOverflow() {
        let values = (0...99).map(Double.init) // 0...99, uniform
        let result = DistributionStats.compute(values: values, latest: 99, bucketCount: 10)
        XCTAssertEqual(result?.latestBucketIndex, 9)
        XCTAssertEqual(result?.buckets.count, 10)
        XCTAssertEqual(result?.buckets.reduce(0) { $0 + $1.count }, 100)
    }

    func testMinimumValueLandsInFirstBucket() {
        let values = (0...99).map(Double.init)
        let result = DistributionStats.compute(values: values, latest: 0, bucketCount: 10)
        XCTAssertEqual(result?.latestBucketIndex, 0)
    }

    func testAllBucketsPartitionEveryValueExactlyOnce() {
        let values: [Double] = [1, 2, 5, 8, 13, 21, 34, 55, 89, 100, 45, 62, 3, 17, 71]
        let result = DistributionStats.compute(values: values, latest: 45, bucketCount: 10)
        XCTAssertEqual(result?.buckets.reduce(0) { $0 + $1.count }, values.count)
    }

    // MARK: - Edge case detection (for caption logic)

    /// isMaximum must identify when the latest value is the highest in the set.
    func testIsMaximumDetectsHighestValue() {
        let values = [10.0, 20.0, 30.0, 40.0, 50.0]
        XCTAssertTrue(DistributionStats.isMaximum(50.0, in: values))
        XCTAssertFalse(DistributionStats.isMaximum(40.0, in: values))
    }

    /// isMinimum must identify when the latest value is the lowest in the set.
    func testIsMinimumDetectsLowestValue() {
        let values = [10.0, 20.0, 30.0, 40.0, 50.0]
        XCTAssertTrue(DistributionStats.isMinimum(10.0, in: values))
        XCTAssertFalse(DistributionStats.isMinimum(20.0, in: values))
    }

    /// When the latest reading is the maximum, the caption should say "highest",
    /// not describe a trivial 100th percentile.
    func testMaximumValueCaptionSaysHighest() {
        let values = [10, 20, 30, 40, 50].map(Double.init)
        XCTAssertTrue(DistributionStats.isMaximum(50, in: values))
        // Verify compute also confirms it's the max
        let result = DistributionStats.compute(values: values, latest: 50)
        XCTAssertEqual(result?.percentileRank, 100)
    }

    /// When the latest reading is the minimum, the caption should say "lowest",
    /// not describe a trivial lower percentile.
    func testMinimumValueCaptionSaysLowest() {
        let values = [10, 20, 30, 40, 50].map(Double.init)
        XCTAssertTrue(DistributionStats.isMinimum(10, in: values))
        // Verify compute shows it's the minimum (1 of 5 = 20%)
        let result = DistributionStats.compute(values: values, latest: 10)
        XCTAssertEqual(result?.percentileRank, 20)
    }

    /// isMaximum and isMinimum should handle edge case where all values are identical.
    func testEdgeCaseDegenerateSpread() {
        let values = [70.0, 70.0, 70.0, 70.0]
        XCTAssertTrue(DistributionStats.isMaximum(70, in: values))
        XCTAssertTrue(DistributionStats.isMinimum(70, in: values))
    }

    /// isMaximum should return false for an empty array.
    func testIsMaximumEmptyArray() {
        XCTAssertFalse(DistributionStats.isMaximum(50, in: []))
    }

    /// isMinimum should return false for an empty array.
    func testIsMinimumEmptyArray() {
        XCTAssertFalse(DistributionStats.isMinimum(50, in: []))
    }
}
