import XCTest
@testable import Vital

/// Pure coverage of `RecoveryDelta` — Today's recovery-tile delta copy/trend.
final class RecoveryDeltaTests: XCTestCase {

    func testZeroDeltaIsNeutralAtYourNormal() {
        let d = RecoveryDelta.make(deltaPct: 0)
        XCTAssertEqual(d.trend, .neutral)
        XCTAssertEqual(d.text, "at your normal")
    }

    func testZeroDeltaIsNeutralForLowerIsBetterMetric() {
        let d = RecoveryDelta.make(deltaPct: 0, lowerIsBetter: true)
        XCTAssertEqual(d.trend, .neutral)
        XCTAssertEqual(d.text, "at your normal")
    }

    func testPositiveDeltaIsUpGoodWithPlusSign() {
        let d = RecoveryDelta.make(deltaPct: 4)
        XCTAssertEqual(d.trend, .upGood)
        XCTAssertEqual(d.text, "+4% vs normal")
    }

    func testNegativeDeltaIsDownBad() {
        let d = RecoveryDelta.make(deltaPct: -3)
        XCTAssertEqual(d.trend, .downBad)
        XCTAssertEqual(d.text, "\u{2212}3% vs normal")
    }

    /// Today's tile and Trends/detail share ONE reference: the 30-day normal
    /// value. The tile says so; the compact reason line drops the suffix.
    func testTileTextNamesTheNormalAndCompactDropsIt() {
        let d = RecoveryDelta.make(deltaPct: -11)
        XCTAssertEqual(d.text, "\u{2212}11% vs normal")
        XCTAssertEqual(RecoveryDelta.compact(d.text), "\u{2212}11%")
        XCTAssertEqual(RecoveryDelta.compact(RecoveryDelta.make(deltaPct: 8).text), "+8%")
        XCTAssertEqual(RecoveryDelta.compact(RecoveryDelta.atNormalText), "at your normal")
    }

    func testLowerIsBetterInvertsPolarity() {
        XCTAssertEqual(RecoveryDelta.make(deltaPct: -2, lowerIsBetter: true).trend, .downGood)
        XCTAssertEqual(RecoveryDelta.make(deltaPct: 2, lowerIsBetter: true).trend, .upBad)
    }
}
