import XCTest
@testable import Vital

final class TrendsHeadlineTests: XCTestCase {

    func testZeroMovedProducesEverythingNormalCopyWithNoBoldPrefix() {
        let summary = TrendsHeadline.summary(goodCount: 0, watchCount: 0, period: .thirtyDays)
        XCTAssertEqual(summary.boldText, "")
        XCTAssertEqual(summary.trailingText, "Everything's in your normal range.")
        XCTAssertEqual(summary.fullText, "Everything's in your normal range.")
    }

    func testMixedGoodAndWatchSpellsOutBothCounts() {
        let summary = TrendsHeadline.summary(goodCount: 2, watchCount: 1, period: .thirtyDays)
        XCTAssertEqual(summary.boldText, "Three things moved this month")
        XCTAssertEqual(summary.trailingText, " — two good, one to watch.")
    }

    func testOnlyGoodOmitsTheWatchSideAndUsesBothForExactlyTwo() {
        let summary = TrendsHeadline.summary(goodCount: 2, watchCount: 0, period: .thirtyDays)
        XCTAssertEqual(summary.boldText, "Two things moved this month")
        XCTAssertEqual(summary.trailingText, " — both good.")
    }

    func testOnlyWatchWithSingularCountReadsOneToWatch() {
        let summary = TrendsHeadline.summary(goodCount: 0, watchCount: 1, period: .thirtyDays)
        XCTAssertEqual(summary.boldText, "One thing moved this month")
        XCTAssertEqual(summary.trailingText, " — one to watch.")
    }

    func testOnlyGoodWithSingularCountUsesSingularThing() {
        let summary = TrendsHeadline.summary(goodCount: 1, watchCount: 0, period: .thirtyDays)
        XCTAssertEqual(summary.boldText, "One thing moved this month")
        XCTAssertEqual(summary.trailingText, " — one good.")
    }

    func testPeriodWordVariesByPeriod() {
        XCTAssertEqual(TrendsHeadline.summary(goodCount: 1, watchCount: 0, period: .sevenDays).boldText, "One thing moved this week")
        XCTAssertEqual(TrendsHeadline.summary(goodCount: 1, watchCount: 0, period: .thirtyDays).boldText, "One thing moved this month")
        XCTAssertEqual(TrendsHeadline.summary(goodCount: 1, watchCount: 0, period: .ninetyDays).boldText, "One thing moved in the last 3 months")
    }

    func testWordForCountSpellsOutOneThroughNineThenFallsBackToDigits() {
        XCTAssertEqual(TrendsHeadline.wordForCount(0), "zero")
        XCTAssertEqual(TrendsHeadline.wordForCount(1), "one")
        XCTAssertEqual(TrendsHeadline.wordForCount(9), "nine")
        XCTAssertEqual(TrendsHeadline.wordForCount(10), "10")
        XCTAssertEqual(TrendsHeadline.wordForCount(19), "19")
    }

    func testLargeMixedCountsStillProduceAWellFormedSentence() {
        // Exercises the digit fallback inside the full sentence, not just
        // `wordForCount` in isolation.
        let summary = TrendsHeadline.summary(goodCount: 6, watchCount: 5, period: .sevenDays)
        XCTAssertEqual(summary.boldText, "11 things moved this week")
        XCTAssertEqual(summary.trailingText, " — six good, five to watch.")
    }

    // MARK: - status(verdicts:goodCount:watchCount:period:) — calm-layout revamp

    func testStatusIsLearningWhenEveryVerdictShownIsCalibrating() {
        let status = TrendsHeadline.status(
            verdicts: [.calibrating(daysRemaining: 9), .calibrating(daysRemaining: 3)],
            goodCount: 0, watchCount: 0, period: .thirtyDays
        )
        guard case .learning(let progress) = status else {
            return XCTFail("expected .learning, got \(status)")
        }
        // Smallest remaining across the calibrating verdicts shown, not an
        // average or the slowest metric's — see the doc comment.
        XCTAssertEqual(progress.daysRemaining, 3)
    }

    func testStatusIsLearningWhenNoMetricShownHasAVerdictAtAll() {
        // An empty `verdicts` list is exactly as "still learning" as every
        // verdict being `.calibrating` — `allSatisfy` on empty is vacuously
        // true, which is the deliberate behavior here.
        let status = TrendsHeadline.status(verdicts: [], goodCount: 0, watchCount: 0, period: .thirtyDays)
        guard case .learning(let progress) = status else {
            return XCTFail("expected .learning, got \(status)")
        }
        XCTAssertEqual(progress.daysRemaining, 14)
    }

    func testStatusIsSteadyWhenEstablishedAndNothingMoved() {
        let status = TrendsHeadline.status(
            verdicts: [.normal, .normal, .above(z: 0.5)], // .above(z: 0.5) below is unreachable in practice but harmless here — status only cares about goodCount/watchCount for this branch.
            goodCount: 0, watchCount: 0, period: .sevenDays
        )
        guard case .steady(let period) = status else {
            return XCTFail("expected .steady, got \(status)")
        }
        XCTAssertEqual(period, .sevenDays)
    }

    func testStatusIsMovedWhenAnythingMoved() {
        let status = TrendsHeadline.status(verdicts: [.normal], goodCount: 1, watchCount: 0, period: .thirtyDays)
        guard case .moved(let summary) = status else {
            return XCTFail("expected .moved, got \(status)")
        }
        XCTAssertEqual(summary.boldText, "One thing moved this month")
    }

    func testStatusPrefersMovedOverSteadyWhenNotAllVerdictsAreCalibrating() {
        // A mix of calibrating and established verdicts is NOT the learning
        // state (`allSatisfy` requires every one to be calibrating) — with
        // something moved, `.moved` wins.
        let status = TrendsHeadline.status(
            verdicts: [.calibrating(daysRemaining: 5), .above(z: 2)],
            goodCount: 1, watchCount: 0, period: .thirtyDays
        )
        guard case .moved = status else {
            return XCTFail("expected .moved, got \(status)")
        }
    }

    // MARK: - LearningProgress

    func testLearningProgressRingLabelAndBodyTextForMultipleDaysRemaining() {
        let progress = TrendsHeadline.LearningProgress(daysRemaining: 12)
        XCTAssertEqual(progress.daysDone, 2)
        XCTAssertEqual(progress.ringLabel, "2/14")
        XCTAssertEqual(progress.bodyText, "Twelve more days and I'll tell you what's unusual. Until then, here's what I'm seeing.")
    }

    func testLearningProgressUsesSingularDayForExactlyOneRemaining() {
        let progress = TrendsHeadline.LearningProgress(daysRemaining: 1)
        XCTAssertEqual(progress.bodyText, "One more day and I'll tell you what's unusual. Until then, here's what I'm seeing.")
    }

    func testLearningProgressAtZeroRemainingReadsNotEnoughVariationRatherThanZeroDays() {
        let progress = TrendsHeadline.LearningProgress(daysRemaining: 0)
        XCTAssertEqual(progress.daysDone, 14)
        XCTAssertEqual(progress.ringLabel, "14/14")
        XCTAssertEqual(progress.bodyText, "I don't have enough variation yet to tell you what's unusual. Here's what I'm seeing.")
        XCTAssertFalse(progress.bodyText.contains("Zero"), "must never say \"Zero more days\"")
    }

    func testLearningProgressClampsDaysDoneToTheFourteenDayWindow() {
        // A `daysRemaining` above 14 (shouldn't happen from `TrendsVerdict`,
        // but this is a value type with no invariant enforced at init) must
        // never produce a negative `daysDone`.
        let progress = TrendsHeadline.LearningProgress(daysRemaining: 20)
        XCTAssertEqual(progress.daysDone, 0)
        XCTAssertEqual(progress.ringLabel, "0/14")
    }

    // MARK: - steadyHeadlineText / steadySubline

    func testSteadyHeadlineTextUsesThePeriodsBareNoun() {
        XCTAssertEqual(TrendsHeadline.steadyHeadlineText(period: .sevenDays), "A steady week.")
        XCTAssertEqual(TrendsHeadline.steadyHeadlineText(period: .thirtyDays), "A steady month.")
        XCTAssertEqual(TrendsHeadline.steadyHeadlineText(period: .ninetyDays), "A steady quarter.")
    }

    func testSteadySublineIsFixedRegardlessOfPeriod() {
        XCTAssertEqual(TrendsHeadline.steadySubline, "Nothing moved outside your normal.")
    }
}
