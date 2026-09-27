import XCTest
@testable import Vital

/// Tests for `SleepIntervalMath.unionMinutes`, the pure interval-union helper
/// shared by `HealthKitManager.fetchLastNightSleep` (today's sleep figure)
/// and `HealthKitBackfill.fetchDailySleep` (nightly backfill). Overlapping
/// intervals — e.g. two HealthKit sources reporting sleep for the same
/// stretch of night — must be counted once, not summed.
final class SleepIntervalMathTests: XCTestCase {

    private func minutes(_ n: Double) -> Date {
        Date(timeIntervalSince1970: n * 60)
    }

    private func interval(_ startMin: Double, _ endMin: Double) -> SleepIntervalMath.Interval {
        SleepIntervalMath.Interval(start: minutes(startMin), end: minutes(endMin))
    }

    func testEmptyInputReturnsZero() {
        XCTAssertEqual(SleepIntervalMath.unionMinutes([]), 0)
    }

    func testTwoSourcesCoveringSameNightDoNotDoubleCount() {
        // Apple Watch: 0–420 (7h). A 3rd-party app reports almost the same
        // stretch, slightly offset: 10–430. The union should be 0–430 = 430
        // minutes, not 420 + 420 = 840.
        let watch = interval(0, 420)
        let thirdParty = interval(10, 430)
        XCTAssertEqual(SleepIntervalMath.unionMinutes([watch, thirdParty]), 430, accuracy: 0.001)
    }

    func testNestedIntervalsCountOuterOnly() {
        // A short staged sample (e.g. "asleepDeep") fully inside a broader
        // "asleepUnspecified" sample must not add extra time.
        let outer = interval(0, 400)
        let inner = interval(100, 200)
        XCTAssertEqual(SleepIntervalMath.unionMinutes([outer, inner]), 400, accuracy: 0.001)
    }

    func testDisjointIntervalsWithGapSumIndependently() {
        // Two separate sleep sessions with an awake gap between them (e.g. a
        // nap-like break) should sum their individual lengths; the gap
        // itself must not be counted.
        let first = interval(0, 100)   // 100 minutes
        let second = interval(200, 260) // 60 minutes, gap of 100 minutes in between
        XCTAssertEqual(SleepIntervalMath.unionMinutes([first, second]), 160, accuracy: 0.001)
    }

    func testUnorderedInputIsHandledTheSameAsSorted() {
        let a = interval(200, 260)
        let b = interval(0, 100)
        XCTAssertEqual(
            SleepIntervalMath.unionMinutes([a, b]),
            SleepIntervalMath.unionMinutes([b, a]),
            accuracy: 0.001
        )
    }

    func testZeroLengthIntervalIsIgnored() {
        let real = interval(0, 60)
        let zero = interval(100, 100)
        XCTAssertEqual(SleepIntervalMath.unionMinutes([real, zero]), 60, accuracy: 0.001)
    }

    // MARK: - boundingRange

    func testBoundingRangeEmptyInputReturnsNil() {
        XCTAssertNil(SleepIntervalMath.boundingRange([]))
    }

    func testBoundingRangeSingleInterval() {
        let iv = interval(0, 420)
        let range = SleepIntervalMath.boundingRange([iv])
        XCTAssertEqual(range?.start, minutes(0))
        XCTAssertEqual(range?.end, minutes(420))
    }

    /// The overall bedTime/wakeTime spans the earliest start and latest end
    /// even across overlapping, out-of-order, multi-source intervals — unlike
    /// `unionMinutes`, gaps between disjoint intervals don't shrink the range.
    func testBoundingRangeAcrossMultipleOverlappingIntervals() {
        let watch = interval(10, 430)
        let thirdParty = interval(0, 420)
        let napGap = interval(500, 520)
        let range = SleepIntervalMath.boundingRange([watch, thirdParty, napGap])
        XCTAssertEqual(range?.start, minutes(0))
        XCTAssertEqual(range?.end, minutes(520))
    }
}
