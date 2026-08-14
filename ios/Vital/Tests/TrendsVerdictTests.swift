import XCTest
@testable import Vital

/// Pure gate-by-gate coverage of `TrendsVerdict.evaluate`. Every input is
/// injected — no network, no `Date()` — so each test pins an exact boundary.
final class TrendsVerdictTests: XCTestCase {

    /// Convenience wrapper defaulting every gate to "should pass", so each
    /// test only overrides the inputs relevant to the gate it's proving.
    private func evaluate(
        latest: Double? = 50,
        established: Bool = true,
        dataDays: Int = 30,
        mean30: Double? = 47,
        sd30: Double? = 5,
        minMeaningfulSD: Double = 0.5
    ) -> Verdict {
        TrendsVerdict.evaluate(
            latest: latest,
            established: established,
            dataDays: dataDays,
            mean30: mean30,
            sd30: sd30,
            minMeaningfulSD: minMeaningfulSD
        )
    }

    // MARK: - Gate 1: no usable reading

    func testNoLatestReadingReturnsNoData() {
        XCTAssertEqual(evaluate(latest: nil), .noData)
    }

    /// A non-nil NaN reading used to pass gate 1's bare `guard let`, survive
    /// gates 2–5 (none of which touch `latest`), and reach gate 6 — where
    /// `abs(.nan) < 1` is false and `.nan > 0` is false, so it returned
    /// `.below(z: .nan)` and the user was told "below your normal" on the
    /// strength of garbage. It must be `.noData`: a NaN reading is an absent
    /// reading, not a calibration problem.
    func testNonFiniteNaNLatestReturnsNoDataNotAFabricatedBelow() {
        let verdict = evaluate(latest: .nan, established: true, dataDays: 60, mean30: 46.8, sd30: 5.4, minMeaningfulSD: 1.0)
        XCTAssertEqual(verdict, .noData)
    }

    /// Same shape as the NaN case, but it fabricated `.above(z: .infinity)`.
    func testNonFiniteInfiniteLatestReturnsNoDataNotAFabricatedAbove() {
        let verdict = evaluate(latest: .infinity, established: true, dataDays: 60, mean30: 46.8, sd30: 5.4, minMeaningfulSD: 1.0)
        XCTAssertEqual(verdict, .noData)
    }

    func testNegativeInfiniteLatestReturnsNoData() {
        let verdict = evaluate(latest: -.infinity, established: true, dataDays: 60, mean30: 46.8, sd30: 5.4, minMeaningfulSD: 1.0)
        XCTAssertEqual(verdict, .noData)
    }

    /// Gate 1 must win over the later gates: a non-finite reading reports
    /// `.noData` even when the baseline is ALSO unusable, because an absent
    /// reading is the more fundamental fact.
    func testNonFiniteLatestTakesPrecedenceOverAnUnusableBaseline() {
        XCTAssertEqual(evaluate(latest: .nan, sd30: nil), .noData)
        XCTAssertEqual(evaluate(latest: .nan, mean30: .nan, sd30: 0), .noData)
    }

    // MARK: - Gate 2: not enough calendar history

    func testNotEstablishedReturnsCalibrating() {
        XCTAssertEqual(evaluate(established: false, dataDays: 30), .calibrating(daysRemaining: 0))
    }

    func testFewerThanFourteenDataDaysReturnsCalibratingWithRemainingDays() {
        XCTAssertEqual(evaluate(established: true, dataDays: 5), .calibrating(daysRemaining: 9))
    }

    // MARK: - Gate 3: missing baseline stats — the headline no-fabricated-verdict test

    func testSd30NilReturnsCalibrating() {
        XCTAssertEqual(evaluate(sd30: nil), .calibrating(daysRemaining: 0))
    }

    func testMean30NilReturnsCalibrating() {
        XCTAssertEqual(evaluate(mean30: nil), .calibrating(daysRemaining: 0))
    }

    // MARK: - Gate 4: unusable baseline stats

    func testSd30ZeroReturnsCalibrating() {
        XCTAssertEqual(evaluate(sd30: 0), .calibrating(daysRemaining: 0))
    }

    func testSd30NegativeReturnsCalibrating() {
        XCTAssertEqual(evaluate(sd30: -1), .calibrating(daysRemaining: 0))
    }

    func testSd30NaNReturnsCalibrating() {
        XCTAssertEqual(evaluate(sd30: .nan), .calibrating(daysRemaining: 0))
    }

    func testSd30InfiniteReturnsCalibrating() {
        XCTAssertEqual(evaluate(sd30: .infinity), .calibrating(daysRemaining: 0))
    }

    /// Pins the explicit `mean30.isFinite` check in gate 4. Do NOT assume
    /// gate 5's arithmetic covers this: Swift's free `max(_:_:)` is
    /// `y >= x ? y : x`, and `.nan >= 1.0` is false, so
    /// `max(1.0, 0.02 * abs(.nan))` evaluates to 1.0 — not NaN. With
    /// sd30 = 5.4 that comparison PASSES, so before the explicit check this
    /// input fabricated `.below(z: .nan)`. A broken reference is a
    /// calibration problem (the reading itself is fine), hence
    /// `.calibrating` rather than `.noData`.
    func testNonFiniteNaNMean30ReturnsCalibratingNotAFabricatedVerdict() {
        let verdict = evaluate(latest: 50, established: true, dataDays: 60, mean30: .nan, sd30: 5.4, minMeaningfulSD: 1.0)
        XCTAssertEqual(verdict, .calibrating(daysRemaining: 0))
    }

    /// The infinity case was already swallowed by gate 5's arithmetic
    /// (`0.02 * .infinity` is `.infinity`, and `5.4 >= .infinity` is false),
    /// but it's pinned here so it survives any future rewrite of gate 5.
    func testNonFiniteInfiniteMean30ReturnsCalibrating() {
        let verdict = evaluate(latest: 50, established: true, dataDays: 60, mean30: .infinity, sd30: 5.4, minMeaningfulSD: 1.0)
        XCTAssertEqual(verdict, .calibrating(daysRemaining: 0))
    }

    func testNegativeInfiniteMean30ReturnsCalibrating() {
        let verdict = evaluate(latest: 50, established: true, dataDays: 60, mean30: -.infinity, sd30: 5.4, minMeaningfulSD: 1.0)
        XCTAssertEqual(verdict, .calibrating(daysRemaining: 0))
    }

    /// Direct guard against "simplifying" gate 4 by deleting the explicit
    /// `mean30.isFinite` and leaning on gate 5: this asserts the exact
    /// arithmetic identity that makes that refactor wrong.
    func testMaxDoesNotPropagateNaNWhichIsWhyGateFourChecksMean30Explicitly() {
        XCTAssertEqual(max(1.0, 0.02 * abs(Double.nan)), 1.0)
        XCTAssertTrue(5.4 >= max(1.0, 0.02 * abs(Double.nan)),
                       "a NaN mean30 CLEARS gate 5's comparison — gate 4 must reject it explicitly")
    }

    // MARK: - Gate 5: degenerate σ relative to the mean (the smart-scale case)

    func testSmartScaleWeightWithTinySDCalibratesViaRelativeFloor() {
        // sd30 = 0.05, mean30 = 70.0 — a smart scale reading ~70kg every
        // morning. 0.02 * 70 = 1.4, which dwarfs both the raw sd and any
        // reasonable per-metric minMeaningfulSD, so this must calibrate
        // regardless of the floor passed in.
        XCTAssertEqual(
            evaluate(latest: 70.3, mean30: 70.0, sd30: 0.05, minMeaningfulSD: 0.1),
            .calibrating(daysRemaining: 0)
        )
    }

    func testSDAboveBothFloorsProceedsPastGateFive() {
        // sd30 = 2.0 clears both minMeaningfulSD (0.5) and the relative
        // floor (0.02 * 47 ≈ 0.94), so this reaches the z-score gate instead
        // of calibrating.
        let verdict = evaluate(latest: 47.5, mean30: 47, sd30: 2.0, minMeaningfulSD: 0.5)
        if case .calibrating = verdict {
            XCTFail("expected the verdict to clear gate 5 and resolve a z-score, got \(verdict)")
        }
    }

    // MARK: - Gate 6: z-score boundary

    func testZBoundaryJustUnderOneIsNormal() {
        XCTAssertEqual(evaluate(latest: 0.99, mean30: 0, sd30: 1, minMeaningfulSD: 0), .normal)
    }

    func testZBoundaryExactlyOneIsAbove() {
        XCTAssertEqual(evaluate(latest: 1.0, mean30: 0, sd30: 1, minMeaningfulSD: 0), .above(z: 1.0))
    }

    func testZBoundaryJustPastNegativeOneIsBelow() {
        XCTAssertEqual(evaluate(latest: -1.01, mean30: 0, sd30: 1, minMeaningfulSD: 0), .below(z: -1.01))
    }
}
