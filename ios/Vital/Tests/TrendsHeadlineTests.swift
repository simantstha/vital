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
}
