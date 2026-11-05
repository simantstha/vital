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

    // MARK: - normalBand

    private func baseline(mean30: Double?, sd30: Double?) -> TrendsBaselineDTO {
        TrendsBaselineDTO(mean7: nil, mean30: mean30, mean60: nil, sd30: sd30, p25: nil, p50: nil, p75: nil)
    }

    func testNormalBandIsMeanPlusMinusSDForNormalAboveAndBelow() {
        let b = baseline(mean30: 55, sd30: 6)
        for verdict in [Verdict.normal, .above(z: 1.4), .below(z: -1.4)] {
            let band = TrendsMetricRowLogic.normalBand(verdict: verdict, baseline: b)
            XCTAssertEqual(band?.lower ?? .nan, 49, accuracy: 1e-9, "\(verdict)")
            XCTAssertEqual(band?.upper ?? .nan, 61, accuracy: 1e-9, "\(verdict)")
        }
    }

    func testNormalBandIsNilForCalibratingAndNoData() {
        let b = baseline(mean30: 55, sd30: 6)
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .calibrating(daysRemaining: 5), baseline: b))
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .noData, baseline: b))
    }

    func testNormalBandIsNilWithoutABaselineOrWithMissingStats() {
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: nil))
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: baseline(mean30: nil, sd30: 6)))
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: baseline(mean30: 55, sd30: nil)))
    }

    func testNormalBandIsNilForNonFiniteStats() {
        for (mean, sd) in [(Double.nan, 6.0), (.infinity, 6.0), (55.0, .nan), (55.0, .infinity), (-.infinity, 6.0)] {
            XCTAssertNil(
                TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: baseline(mean30: mean, sd30: sd)),
                "mean \(mean) sd \(sd)"
            )
        }
    }

    func testNormalBandIsNilForZeroOrNegativeSpread() {
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: baseline(mean30: 55, sd30: 0)))
        XCTAssertNil(TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: baseline(mean30: 55, sd30: -2)))
    }

    func testNormalBandIgnoresOtherBaselineFields() {
        let b = TrendsBaselineDTO(mean7: 99, mean30: 10, mean60: 99, sd30: 2, p25: 1, p50: 2, p75: 3)
        let band = TrendsMetricRowLogic.normalBand(verdict: .normal, baseline: b)
        XCTAssertEqual(band?.lower ?? .nan, 8, accuracy: 1e-9)
        XCTAssertEqual(band?.upper ?? .nan, 12, accuracy: 1e-9)
    }
}
