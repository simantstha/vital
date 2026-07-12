import XCTest
@testable import Vital

@MainActor
final class TrendsSummaryTests: XCTestCase {

    // MARK: - Test fixtures

    /// A fixed "today" — 2026-07-12 (Sunday), noon UTC — so the 7-day window
    /// mapping is deterministic regardless of when the test suite runs.
    private static let fixedToday: Date = {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 7; comps.day = 12
        comps.hour = 12
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal.date(from: comps)!
    }()

    private func dateKey(_ offsetFromToday: Int) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let day = cal.date(byAdding: .day, value: offsetFromToday, to: Self.fixedToday)!
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = cal.timeZone
        return f.string(from: day)
    }

    // MARK: - weekWindow

    func testWeekWindowMapsSevenDatedPointsOntoTheSevenSlotsOldestToNewest() {
        let points = (-6...0).map { offset in
            TrendPoint(date: dateKey(offset), value: Double(60 + offset))
        }

        let window = TrendsSummary.weekWindow(from: points, today: Self.fixedToday)

        XCTAssertEqual(window.values.count, 7)
        XCTAssertEqual(window.values, [54, 55, 56, 57, 58, 59, 60])
        XCTAssertEqual(window.dayLabels.count, 7)
    }

    func testWeekWindowLeavesMissingDaysNil() {
        // Only the middle day (3 days ago) and the last day (today) have data.
        let points = [
            TrendPoint(date: dateKey(-3), value: 42),
            TrendPoint(date: dateKey(0), value: 47),
        ]

        let window = TrendsSummary.weekWindow(from: points, today: Self.fixedToday)

        XCTAssertEqual(window.values, [nil, nil, nil, 42, nil, nil, 47])
    }

    func testWeekWindowIgnoresPointsOutsideTheSevenDayWindow() {
        let points = [
            TrendPoint(date: dateKey(-30), value: 999), // 30 days ago — out of window
            TrendPoint(date: dateKey(1), value: 999),   // tomorrow — out of window
            TrendPoint(date: dateKey(-1), value: 61),   // in window
        ]

        let window = TrendsSummary.weekWindow(from: points, today: Self.fixedToday)

        XCTAssertEqual(window.values, [nil, nil, nil, nil, nil, 61, nil])
    }

    func testWeekWindowReturnsEmptyValuesForNoPoints() {
        let window = TrendsSummary.weekWindow(from: [], today: Self.fixedToday)

        XCTAssertEqual(window.values, Array(repeating: nil, count: 7))
    }

    // MARK: - sleepAverageText

    func testSleepAverageTextFormatsAsHoursAndMinutes() {
        // Average of [6, 7.5] = 6.75h = 6h 45m
        let text = TrendsSummary.sleepAverageText([6.0, 7.5])
        XCTAssertEqual(text, "6h 45m")
    }

    func testSleepAverageTextIsNilWhenNoNightsAvailable() {
        XCTAssertNil(TrendsSummary.sleepAverageText([nil, nil, nil, nil, nil, nil, nil]))
    }

    // MARK: - sleepFootnote

    func testSleepFootnoteReportsNoDataWhenAllNightsMissing() {
        let footnote = TrendsSummary.sleepFootnote(Array(repeating: nil, count: 7))
        XCTAssertEqual(footnote, .plain("No sleep synced yet."))
    }

    func testSleepFootnoteBoldsShortNightCountWhenAnyNightIsUnderThreshold() {
        // 4 nights under 6h (indices 0, 3, 4, 6), 3 at/above.
        let values: [Double?] = [5.9, 7.1, 7.6, 5.9, 5.7, 6.2, 5.5]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Under 6h on ",
            bold: "4 of 7 nights",
            suffix: ". Gray bars are short nights."
        ))
    }

    func testSleepFootnoteReportsAllGoodWhenEveryNightMeetsThreshold() {
        let values: [Double?] = [6.0, 6.5, 7.0, 7.5, 8.0, 8.2, 7.9]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, .plain("Every night near your 8h goal this week."))
    }

    // MARK: - lineFootnote (HRV / Resting HR)

    func testLineFootnoteReportsNoReadingsWhenAllValuesMissing() {
        let footnote = TrendsSummary.lineFootnote(Array(repeating: nil, count: 7))
        XCTAssertEqual(footnote, .plain("No readings yet."))
    }

    func testLineFootnoteUsesSingularReadingForExactlyOneValue() {
        let values: [Double?] = [nil, nil, nil, nil, nil, nil, 58]

        let footnote = TrendsSummary.lineFootnote(values)

        XCTAssertEqual(
            footnote,
            .plain("Only 1 reading this week — dashed dots haven't synced.")
        )
    }

    func testLineFootnoteUsesPluralReadingsForMultipleValues() {
        let values: [Double?] = [nil, nil, nil, nil, nil, 58, 62]

        let footnote = TrendsSummary.lineFootnote(values)

        XCTAssertEqual(
            footnote,
            .plain("Only 2 readings this week — dashed dots haven't synced.")
        )
    }

    func testLineFootnoteReportsSteadyWhenChangeIsWithinTwoPercent() {
        let values: [Double?] = [48, 48, 48, 48, 48, 48, 49] // +2.08% → rounds to 2%

        let footnote = TrendsSummary.lineFootnote(values)

        XCTAssertEqual(footnote, .plain("Steady this week."))
    }

    func testLineFootnoteReportsDriftingUpWhenChangeExceedsTwoPercent() {
        let values: [Double?] = [47, 47, 48, 48, 49, 49, 49] // +4.26% → 4%

        let footnote = TrendsSummary.lineFootnote(values)

        XCTAssertEqual(footnote, .plain("Drifting up (+4%) this week."))
    }

    func testLineFootnoteReportsTrendingDownWhenChangeIsBelowNegativeTwoPercent() {
        let values: [Double?] = [62, 61, 60, 59, 58, 57, 58] // -6.45% → -6%

        let footnote = TrendsSummary.lineFootnote(values)

        XCTAssertEqual(footnote, .plain("Trending down (−6%) this week."))
    }

    // MARK: - latestAvailable / vitalsNote

    func testLatestAvailableReturnsTheMostRecentNonNilValue() {
        let values: [Double?] = [47, 47, 48, nil, nil, nil, nil]
        XCTAssertEqual(TrendsSummary.latestAvailable(values), 48)
    }

    func testLatestAvailableReturnsNilWhenAllValuesAreMissing() {
        XCTAssertNil(TrendsSummary.latestAvailable(Array(repeating: nil, count: 7)))
    }

    func testVitalsNoteIsSyncingWhenAnyDayIsMissingAndSevenDayOtherwise() {
        XCTAssertEqual(TrendsSummary.vitalsNote([47, 47, 48, 48, 49, 49, nil]), "syncing")
        XCTAssertEqual(TrendsSummary.vitalsNote([47, 47, 48, 48, 49, 49, 49]), "7-day")
    }
}
