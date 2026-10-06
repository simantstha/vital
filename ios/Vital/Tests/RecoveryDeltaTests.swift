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
        XCTAssertEqual(d.text, "+4 %")
    }

    func testNegativeDeltaIsDownBad() {
        let d = RecoveryDelta.make(deltaPct: -3)
        XCTAssertEqual(d.trend, .downBad)
        XCTAssertEqual(d.text, "-3 %")
    }

    func testLowerIsBetterInvertsPolarity() {
        XCTAssertEqual(RecoveryDelta.make(deltaPct: -2, lowerIsBetter: true).trend, .downGood)
        XCTAssertEqual(RecoveryDelta.make(deltaPct: 2, lowerIsBetter: true).trend, .upBad)
    }
}
