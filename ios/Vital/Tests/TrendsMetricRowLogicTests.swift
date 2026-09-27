import XCTest
@testable import Vital

final class TrendsMetricRowLogicTests: XCTestCase {

    // MARK: - calibratingProgress

    func testCalibratingProgressComputesDaysDoneFromDaysRemaining() {
        let progress = TrendsMetricRowLogic.calibratingProgress(daysRemaining: 12)
        XCTAssertEqual(progress.daysDone, 2)
        XCTAssertEqual(progress.text, "2 of 14 days")
        XCTAssertEqual(progress.fraction, 2.0 / 14.0, accuracy: 1e-9)
    }

    func testCalibratingProgressAtFullFourteenDaysRemainingIsZeroDone() {
        let progress = TrendsMetricRowLogic.calibratingProgress(daysRemaining: 14)
        XCTAssertEqual(progress.daysDone, 0)
        XCTAssertEqual(progress.text, "0 of 14 days")
    }

    func testCalibratingProgressAtZeroDaysRemainingIsFullyDone() {
        let progress = TrendsMetricRowLogic.calibratingProgress(daysRemaining: 0)
        XCTAssertEqual(progress.daysDone, 14)
        XCTAssertEqual(progress.text, "14 of 14 days")
        XCTAssertEqual(progress.fraction, 1.0, accuracy: 1e-9)
    }

    func testCalibratingProgressClampsDaysRemainingAboveFourteenToZeroDone() {
        // Shouldn't happen from `TrendsVerdict` in practice, but the row
        // must never render a negative "days done" from a corrupt input.
        let progress = TrendsMetricRowLogic.calibratingProgress(daysRemaining: 20)
        XCTAssertEqual(progress.daysDone, 0)
    }

    func testCalibratingProgressClampsNegativeDaysRemainingToFullyDone() {
        let progress = TrendsMetricRowLogic.calibratingProgress(daysRemaining: -3)
        XCTAssertEqual(progress.daysDone, 14)
        XCTAssertEqual(progress.text, "14 of 14 days")
    }

    // MARK: - movedSecondary

    func testMovedSecondaryRisingOnAHigherIsBetterMetricReadsGoodWithUpArrow() {
        let spec = MetricCatalog.spec(for: "hrv_sdnn")! // higherIsBetter
        let result = TrendsMetricRowLogic.movedSecondary(value: 62, mean30: 55, spec: spec, rising: true, unitSystem: .metric)
        XCTAssertEqual(result.text, "↑ 7 above normal")
        XCTAssertTrue(result.isGood)
    }

    func testMovedSecondaryFallingOnAHigherIsBetterMetricReadsCautionWithDownArrow() {
        let spec = MetricCatalog.spec(for: "hrv_sdnn")! // higherIsBetter
        let result = TrendsMetricRowLogic.movedSecondary(value: 48, mean30: 55, spec: spec, rising: false, unitSystem: .metric)
        XCTAssertEqual(result.text, "↓ 7 below normal")
        XCTAssertFalse(result.isGood)
    }

    func testMovedSecondaryRisingOnALowerIsBetterMetricReadsCaution() {
        let spec = MetricCatalog.spec(for: "resting_hr")! // lowerIsBetter
        let result = TrendsMetricRowLogic.movedSecondary(value: 60, mean30: 53, spec: spec, rising: true, unitSystem: .metric)
        XCTAssertEqual(result.text, "↑ 7 above normal")
        XCTAssertFalse(result.isGood)
    }

    func testMovedSecondaryFallingOnALowerIsBetterMetricReadsGood() {
        let spec = MetricCatalog.spec(for: "resting_hr")! // lowerIsBetter
        let result = TrendsMetricRowLogic.movedSecondary(value: 46, mean30: 53, spec: spec, rising: false, unitSystem: .metric)
        XCTAssertEqual(result.text, "↓ 7 below normal")
        XCTAssertTrue(result.isGood)
    }
}
