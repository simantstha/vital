import XCTest
@testable import Vital

/// Pure coverage of `RecoveryStripLogic` (Today's endurance recovery strip)
/// and `TodayHeaderLogic`.
final class RecoveryStripLogicTests: XCTestCase {

    private func input(
        _ kind: RecoveryStripLogic.Kind,
        value: Double?,
        verdict: Verdict,
        mean: Double? = 50,
        sd: Double? = 5,
        text: String = "58",
        unit: String = "ms"
    ) -> RecoveryStripLogic.Input {
        .init(kind: kind, value: value, valueText: text, unit: unit, verdict: verdict, mean30: mean, sd30: sd)
    }

    // MARK: - Range geometry

    func testBandIsMeanPlusMinusOneSDOnAThreeSDDomain() throws {
        let range = try XCTUnwrap(RecoveryStripLogic.range(value: 50, mean: 50, sd: 5))
        XCTAssertEqual(range.bandStart, 1.0 / 3.0, accuracy: 1e-9)
        XCTAssertEqual(range.bandEnd, 2.0 / 3.0, accuracy: 1e-9)
        XCTAssertEqual(range.marker, 0.5, accuracy: 1e-9)
    }

    func testMarkerClampsToTheDomainEnds() throws {
        XCTAssertEqual(try XCTUnwrap(RecoveryStripLogic.range(value: 500, mean: 50, sd: 5)).marker, 1)
        XCTAssertEqual(try XCTUnwrap(RecoveryStripLogic.range(value: -500, mean: 50, sd: 5)).marker, 0)
        // Exactly 3 sd out lands on the end without overshooting.
        XCTAssertEqual(try XCTUnwrap(RecoveryStripLogic.range(value: 65, mean: 50, sd: 5)).marker, 1, accuracy: 1e-9)
    }

    func testRangeNeedsAUsableSpread() {
        XCTAssertNil(RecoveryStripLogic.range(value: 50, mean: 50, sd: 0))
        XCTAssertNil(RecoveryStripLogic.range(value: 50, mean: 50, sd: -1))
        XCTAssertNil(RecoveryStripLogic.range(value: .nan, mean: 50, sd: 5))
    }

    // MARK: - Judged verdicts: band + delta

    func testNormalShowsBandAndInRange() throws {
        let item = try XCTUnwrap(RecoveryStripLogic.item(input(.hrv, value: 52, verdict: .normal)))
        XCTAssertNotNil(item.range)
        XCTAssertEqual(item.deltaText, "In range")
        XCTAssertEqual(item.tone, .neutral)
    }

    func testHRVAboveIsPositiveWithSignedDelta() throws {
        let item = try XCTUnwrap(RecoveryStripLogic.item(input(.hrv, value: 56, verdict: .above(z: 1.2))))
        XCTAssertEqual(item.deltaText, "+6 vs normal")
        XCTAssertEqual(item.tone, .positive)
    }

    func testHRVBelowIsCautionWithMinusSign() throws {
        let item = try XCTUnwrap(RecoveryStripLogic.item(input(.hrv, value: 43, verdict: .below(z: -1.4))))
        XCTAssertEqual(item.deltaText, "\u{2212}7 vs normal")
        XCTAssertEqual(item.tone, .caution)
    }

    func testRestingHRPolarityIsInverted() throws {
        let high = try XCTUnwrap(RecoveryStripLogic.item(
            input(.restingHR, value: 56, verdict: .above(z: 1.2), mean: 50, sd: 5, text: "56", unit: "bpm")))
        XCTAssertEqual(high.deltaText, "+6 vs normal")
        XCTAssertEqual(high.tone, .caution, "a higher resting HR is the bad side")

        let low = try XCTUnwrap(RecoveryStripLogic.item(
            input(.restingHR, value: 45, verdict: .below(z: -1.0), mean: 50, sd: 5, text: "45", unit: "bpm")))
        XCTAssertEqual(low.deltaText, "\u{2212}5 vs normal")
        XCTAssertEqual(low.tone, .positive, "a lower resting HR is the good side")
    }

    func testSleepDeltaIsMinutesShortOrOverAgainstTheMeanInHours() throws {
        // mean 7.0 h, today 6.5 h → 30 min short (bad side).
        let short = try XCTUnwrap(RecoveryStripLogic.item(
            input(.sleep, value: 6.5, verdict: .below(z: -1.5), mean: 7.0, sd: 0.33, text: "6h 30m", unit: "")))
        XCTAssertEqual(short.deltaText, "30 min short")
        XCTAssertEqual(short.tone, .caution)

        let over = try XCTUnwrap(RecoveryStripLogic.item(
            input(.sleep, value: 7.5, verdict: .above(z: 1.5), mean: 7.0, sd: 0.33, text: "7h 30m", unit: "")))
        XCTAssertEqual(over.deltaText, "30 min over")
        XCTAssertEqual(over.tone, .positive)
    }

    // MARK: - Unjudged verdicts: value alone

    func testNoDataAndCalibratingNeverGetABandOrDelta() throws {
        for verdict in [Verdict.noData, .calibrating(daysRemaining: 6)] {
            let item = try XCTUnwrap(RecoveryStripLogic.item(input(.hrv, value: 58, verdict: verdict)))
            XCTAssertEqual(item.valueText, "58")
            XCTAssertNil(item.range, "\(verdict) must not fabricate a range")
            XCTAssertNil(item.deltaText)
            XCTAssertEqual(item.tone, .neutral)
        }
    }

    func testJudgedVerdictWithoutABaselineStillShowsValueAlone() throws {
        for (mean, sd) in [(nil, 5.0), (50.0, nil), (50.0, 0.0)] as [(Double?, Double?)] {
            let item = try XCTUnwrap(RecoveryStripLogic.item(
                input(.hrv, value: 58, verdict: .above(z: 1.6), mean: mean, sd: sd)))
            XCTAssertNil(item.range)
            XCTAssertNil(item.deltaText)
        }
    }

    // MARK: - Which metrics appear

    func testOnlyMetricsWithAValueAppearInOrder() {
        let items = RecoveryStripLogic.items([
            input(.hrv, value: 58, verdict: .normal),
            input(.restingHR, value: nil, verdict: .noData, text: "—"),
            input(.sleep, value: 6.6, verdict: .normal, mean: 7, sd: 0.4, text: "6h 36m", unit: ""),
        ])
        XCTAssertEqual(items.map(\.kind), [.hrv, .sleep])
        XCTAssertTrue(RecoveryStripLogic.items([input(.hrv, value: nil, verdict: .noData)]).isEmpty)
    }

    func testEveryKindHasAnExplanationAndLabel() {
        for kind in RecoveryStripLogic.Kind.allCases {
            XCTAssertNotNil(MetricExplainer.explanation(for: kind.explanationKey), "\(kind)")
            XCTAssertFalse(kind.label.isEmpty)
        }
    }

    // MARK: - Header

    func testMetaLineJoinsDateAndStreakAndOmitsAMissingStreak() {
        XCTAssertEqual(
            TodayHeaderLogic.metaLine(dateSubtitle: "Wednesday · Nov 4", streakText: "12 days in a row"),
            "Wednesday · Nov 4 · 12 days in a row")
        XCTAssertEqual(TodayHeaderLogic.metaLine(dateSubtitle: "Wednesday · Nov 4", streakText: nil),
                       "Wednesday · Nov 4")
    }

    func testTitleIsTheReadinessWordOnlyForLoadedCalibratedEndurance() {
        func title(endurance: Bool = true, loaded: Bool = true, calibrating: String? = nil) -> String {
            TodayHeaderLogic.title(
                greeting: "Good evening", isEnduranceGoal: endurance, isLoaded: loaded,
                calibratingText: calibrating, readinessWord: .readyToPush)
        }
        XCTAssertEqual(title(), "Ready to push")
        XCTAssertEqual(title(loaded: false), "Good evening", "never the word before loaded")
        XCTAssertEqual(title(calibrating: "Calibrating · day 3 of 14"), "Good evening")
        XCTAssertEqual(title(endurance: false), "Good evening")
    }

    // MARK: - Endurance hero content

    func testHeroHasNoContentOnAPlannedDayWithNothingElse() {
        XCTAssertFalse(EnduranceHeroLogic.hasHeroContent(
            calibratingText: nil, raceText: nil, hasSession: true, reconciliationText: nil, hasWeekRow: false))
        // Rest day always carries its note.
        XCTAssertTrue(EnduranceHeroLogic.hasHeroContent(
            calibratingText: nil, raceText: nil, hasSession: false, reconciliationText: nil, hasWeekRow: false))
        XCTAssertTrue(EnduranceHeroLogic.hasHeroContent(
            calibratingText: nil, raceText: "Half marathon", hasSession: true, reconciliationText: nil, hasWeekRow: false))
        XCTAssertTrue(EnduranceHeroLogic.hasHeroContent(
            calibratingText: nil, raceText: nil, hasSession: true, reconciliationText: nil, hasWeekRow: true))
    }

    // MARK: - Misc Today elements

    func testCoachNoteIsEmptyForBlankMessages() {
        XCTAssertTrue(CoachNote.isEmpty(""))
        XCTAssertTrue(CoachNote.isEmpty(" \n\t"))
        XCTAssertFalse(CoachNote.isEmpty("Room for the tempo run."))
    }

    func testVoiceFABStaysAComfortableTouchTarget() {
        XCTAssertGreaterThanOrEqual(VoiceFABView.size, 44)
    }
}
