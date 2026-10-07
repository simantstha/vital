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
        XCTAssertEqual(progress.bodyText, "Calorie, weight and workout tracking work today. Recovery insights get personal after 14 days of data (2 of 14).")
    }

    func testLearningProgressOneDayRemainingShowsThirteenOfFourteen() {
        let progress = TrendsHeadline.LearningProgress(daysRemaining: 1)
        XCTAssertEqual(progress.bodyText, "Calorie, weight and workout tracking work today. Recovery insights get personal after 14 days of data (13 of 14).")
    }

    func testLearningProgressAtZeroRemainingReadsNotEnoughVariationRatherThanZeroDays() {
        let progress = TrendsHeadline.LearningProgress(daysRemaining: 0)
        XCTAssertEqual(progress.daysDone, 14)
        XCTAssertEqual(progress.ringLabel, "14/14")
        XCTAssertEqual(progress.bodyText, "Your tracking works as usual. Recovery insights need a bit more variety in your data before they get personal.")
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

    // MARK: - Goal-relevant moves (weight trend, strength)

    private func lift(_ key: String, changeKg: Double?, baselineKg: Double? = 100) -> TrendsStrengthLogic.Lift {
        TrendsStrengthLogic.Lift(
            key: key,
            name: key.capitalized,
            currentText: "100 kg",
            sparkline: [],
            status: TrendsStrengthLogic.Status(text: "", tone: .neutral),
            changeKg: changeKg,
            baselineKg: changeKg == nil ? nil : baselineKg
        )
    }

    private func card(_ lifts: [TrendsStrengthLogic.Lift]) -> TrendsStrengthLogic.Card {
        TrendsStrengthLogic.Card(
            lifts: lifts,
            volume: TrendsStrengthLogic.VolumeLine(thisWeek: "", comparison: nil)
        )
    }

    private func weightTrend(from first: Double, to last: Double, established: Bool = true) -> WeightTrendDTO {
        WeightTrendDTO(
            days: [
                WeightTrendDayDTO(day: "2026-09-08", rawKg: first, trendKg: first),
                WeightTrendDayDTO(day: "2026-10-06", rawKg: last, trendKg: last),
            ],
            delta7dKgPerWeek: nil, delta30dKgPerWeek: nil, established: established
        )
    }

    func testSteadyBecomesMovedWhenAStrengthLiftIsUp() {
        let moves = TrendsHeadline.GoalMoves.make(
            goal: "muscle", weightTrend: nil,
            strength: card([lift("squat", changeKg: 20), lift("bench press", changeKg: 0.4)]),
            weightAlreadyCounted: false
        )
        XCTAssertEqual(moves.liftsUp, 1)
        let status = TrendsHeadline.status(verdicts: [.normal], goodCount: 0, watchCount: 0, period: .thirtyDays, goalMoves: moves)
        guard case .moved(let summary) = status else { return XCTFail("expected .moved, got \(status)") }
        XCTAssertEqual(summary.fullText, "One thing moved this month — one good.")
    }

    func testLiftMoveBarIsOnePercentOfBaseline() {
        // +1 kg on a 200 kg lift is 0.5% (noise); on a 50 kg lift it is 2% (a move).
        let moves = TrendsHeadline.GoalMoves.make(
            goal: "muscle", weightTrend: nil,
            strength: card([lift("deadlift", changeKg: 1, baselineKg: 200), lift("press", changeKg: 1, baselineKg: 50), lift("row", changeKg: -1, baselineKg: 200)]),
            weightAlreadyCounted: false
        )
        XCTAssertEqual(moves.liftsUp, 1)
        XCTAssertEqual(moves.liftsDown, 0)
    }

    func testWeightLossTrendDownCountsAsGoodAndUpAsWatch() {
        let down = TrendsHeadline.GoalMoves.make(goal: "weight_loss", weightTrend: weightTrend(from: 84, to: 82.4), strength: nil, weightAlreadyCounted: false)
        XCTAssertEqual(down.goodCount, 1)
        XCTAssertEqual(down.watchCount, 0)
        let up = TrendsHeadline.GoalMoves.make(goal: "weight_loss", weightTrend: weightTrend(from: 82, to: 83), strength: nil, weightAlreadyCounted: false)
        XCTAssertEqual(up.watchCount, 1)
        XCTAssertEqual(up.goodCount, 0)
    }

    func testWeightIsIgnoredForOtherGoalsFlatTrendsUnestablishedTrendsAndDoubleCounting() {
        XCTAssertEqual(TrendsHeadline.GoalMoves.make(goal: "muscle", weightTrend: weightTrend(from: 84, to: 80), strength: nil, weightAlreadyCounted: false), .empty)
        XCTAssertEqual(TrendsHeadline.GoalMoves.make(goal: "weight_loss", weightTrend: weightTrend(from: 82, to: 82.2), strength: nil, weightAlreadyCounted: false).goodCount, 0)
        XCTAssertEqual(TrendsHeadline.GoalMoves.make(goal: "weight_loss", weightTrend: weightTrend(from: 84, to: 80, established: false), strength: nil, weightAlreadyCounted: false), .empty)
        XCTAssertEqual(TrendsHeadline.GoalMoves.make(goal: "weight_loss", weightTrend: weightTrend(from: 84, to: 80), strength: nil, weightAlreadyCounted: true), .empty)
    }

    func testGoalMovesAddToMetricCountsAndDeclinesCountAsWatch() {
        let moves = TrendsHeadline.GoalMoves.make(
            goal: "weight_loss", weightTrend: weightTrend(from: 84, to: 82),
            strength: card([lift("squat", changeKg: -3)]),
            weightAlreadyCounted: false
        )
        let status = TrendsHeadline.status(verdicts: [.normal], goodCount: 1, watchCount: 0, period: .thirtyDays, goalMoves: moves)
        guard case .moved(let summary) = status else { return XCTFail("expected .moved, got \(status)") }
        XCTAssertEqual(summary.fullText, "Three things moved this month — two good, one to watch.")
    }

    func testStaysSteadyWhenNothingMovedIncludingGoalMoves() {
        let status = TrendsHeadline.status(verdicts: [.normal], goodCount: 0, watchCount: 0, period: .thirtyDays, goalMoves: .empty)
        guard case .steady = status else { return XCTFail("expected .steady, got \(status)") }
    }
}
