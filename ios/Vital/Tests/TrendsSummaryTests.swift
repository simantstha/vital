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

    // MARK: - hoursLabel

    func testHoursLabelFormatsWholeNumbersWithoutDecimal() {
        XCTAssertEqual(TrendsSummary.hoursLabel(8.0), "8")
        XCTAssertEqual(TrendsSummary.hoursLabel(6.0), "6")
        XCTAssertEqual(TrendsSummary.hoursLabel(9.0), "9")
    }

    func testHoursLabelFormatsHalfHoursWithOneDecimal() {
        XCTAssertEqual(TrendsSummary.hoursLabel(7.5), "7.5")
        XCTAssertEqual(TrendsSummary.hoursLabel(8.5), "8.5")
        XCTAssertEqual(TrendsSummary.hoursLabel(6.5), "6.5")
    }

    func testHoursLabelNeverEmitsTrailingDecimal() {
        // Ensure no value produces "8.0" or similar
        let result = TrendsSummary.hoursLabel(8.0)
        XCTAssertFalse(result.contains("."), "hoursLabel should never contain a decimal point for whole numbers")
    }

    // MARK: - shortSleepThreshold (75% of goal, snapped to the nearest half hour)

    func testShortSleepThresholdSnapsToTheNearestHalfHour() {
        // Raw 75% would be 5.625 / 6.0 / 6.375 — only the middle is already a
        // half hour, so the outer two prove the snapping.
        XCTAssertEqual(TrendsSummary.shortSleepThreshold(for: 7.5), 5.5)
        XCTAssertEqual(TrendsSummary.shortSleepThreshold(for: 8.0), 6.0)
        XCTAssertEqual(TrendsSummary.shortSleepThreshold(for: 8.5), 6.5)
    }

    func testShortSleepThresholdAlwaysLabelsAsAWholeOrHalfHour() {
        // Whatever the goal, the threshold must render in the app's half-hour
        // vocabulary — never a derived decimal like "5.6".
        for goal in [6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0] {
            let label = TrendsSummary.hoursLabel(TrendsSummary.shortSleepThreshold(for: goal))
            XCTAssertTrue(
                !label.contains(".") || label.hasSuffix(".5"),
                "threshold label \"\(label)\" for goal \(goal)h is not a whole or half hour"
            )
        }
    }

    /// Regression guard for the bug where `TrendBarChart` shaded bars against
    /// its own `goalHours * 0.75` while the footnote counted against the
    /// snapped threshold: at a 7.5h goal a 5.6h night drew as a gray "short"
    /// bar while the caption said no nights were short. Both now read the same
    /// helper, so the chart's classification and the footnote's count agree.
    func testChartThresholdAndFootnoteAgreeOnWhichNightsAreShort() {
        let goal = 7.5
        let values: [Double?] = [5.4, 5.6, 6.1, 7.0, 7.5, 8.0, 8.2]

        // What the chart shades gray: value < shortSleepThreshold(for: goal).
        let threshold = TrendsSummary.shortSleepThreshold(for: goal)
        let chartShortCount = values.compactMap { $0 }.filter { $0 < threshold }.count

        // What the footnote reports.
        let footnote = TrendsSummary.sleepFootnote(values, goalHours: goal)

        XCTAssertEqual(chartShortCount, 1)
        XCTAssertEqual(footnote.bold, "\(chartShortCount) of 7 nights")
        XCTAssertEqual(footnote.prefix, "Under \(TrendsSummary.hoursLabel(threshold))h on ")

        // The 5.6h night specifically: adequate to the chart, uncounted by the
        // footnote — the exact pair that disagreed before the shared helper.
        XCTAssertFalse(5.6 < threshold, "5.6h must not shade as a short bar at a 7.5h goal")
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

    func testSleepFootnoteWith7_5hGoalTreats5_6hAsAdequateAgainstSnapped5_5hThreshold() {
        // 7.5h goal → threshold snaps to 5.5h (raw 75% would be 5.625h).
        // 5.6h is the discriminator: ABOVE the snapped 5.5h (adequate), but
        // BELOW both the unsnapped 5.625h and the old hardcoded 6.0h — under
        // either of those this falls into the short-nights branch instead.
        let values: [Double?] = [5.6, 6.1, 7.0, 7.5, 8.0, 8.2, 7.9]

        let footnote = TrendsSummary.sleepFootnote(values, goalHours: 7.5)

        XCTAssertEqual(footnote, .plain("Every night near your 7.5h goal this week."))
    }

    func testSleepFootnoteWith7_5hGoalCountsOnlyNightsUnderSnapped5_5hThreshold() {
        // 5.4h is short under all three candidate thresholds; 5.6h is short
        // ONLY under the unsnapped 5.625h or the old 6.0h. So only the snapped
        // threshold yields "Under 5.5h on 1 of 7 nights" — unsnapped would say
        // "Under 5.6h on 2 of 7", the old hardcode "Under 6h on 2 of 7".
        let values: [Double?] = [5.4, 5.6, 6.1, 7.0, 7.5, 8.0, 8.2]

        let footnote = TrendsSummary.sleepFootnote(values, goalHours: 7.5)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Under 5.5h on ",
            bold: "1 of 7 nights",
            suffix: ". Gray bars are short nights."
        ))
    }

    func testSleepFootnoteWith8_5hGoalCountsNightsUnderSnapped6_5hThreshold() {
        // 8.5h goal → threshold snaps to 6.5h (raw 75% would be 6.375h).
        // 6.4h discriminates in the opposite direction: BELOW the snapped 6.5h
        // (short), but ABOVE both the unsnapped 6.375h and the old 6.0h —
        // under either of those every night is adequate and the footnote takes
        // the "Every night" branch instead.
        let values: [Double?] = [6.4, 6.6, 7.0, 7.5, 8.0, 8.5, 8.8]

        let footnote = TrendsSummary.sleepFootnote(values, goalHours: 8.5)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Under 6.5h on ",
            bold: "1 of 7 nights",
            suffix: ". Gray bars are short nights."
        ))
    }

    func testSleepFootnoteWith8_5hGoalNamesTheGoalInTheAllGoodCopy() {
        // Locks the goal-derived copy on the "Every night" branch. Note: this
        // case cannot discriminate the snapping — at an 8.5h goal the snapped
        // 6.5h threshold is the highest of the three candidates, so any set
        // clearing it also clears 6.375h and 6.0h.
        let values: [Double?] = [6.6, 7.0, 7.5, 8.0, 8.2, 8.5, 8.8]

        let footnote = TrendsSummary.sleepFootnote(values, goalHours: 8.5)

        XCTAssertEqual(footnote, .plain("Every night near your 8.5h goal this week."))
    }

    func testSleepFootnoteDefaultParameterStillProduces8hStrings() {
        // Regression test: the default 8.0h behavior must remain unchanged.
        let values: [Double?] = [5.9, 7.1, 7.6, 5.9, 5.7, 6.2, 5.5]

        let footnote = TrendsSummary.sleepFootnote(values) // default goalHours: 8.0

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Under 6h on ",
            bold: "4 of 7 nights",
            suffix: ". Gray bars are short nights."
        ))
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

    // MARK: - TrendMetric.unitLabel

    func testUnitLabelConvertsWeightAndDistanceButLeavesNeutralMetricsUnchanged() {
        XCTAssertEqual(TrendMetric.weight.unitLabel(.metric), "kg")
        XCTAssertEqual(TrendMetric.weight.unitLabel(.imperial), "lb")
        XCTAssertEqual(TrendMetric.distance.unitLabel(.metric), "km")
        XCTAssertEqual(TrendMetric.distance.unitLabel(.imperial), "mi")

        for metric: TrendMetric in [.hrv, .sleep, .steps, .vo2, .rhr] {
            XCTAssertEqual(metric.unitLabel(.metric), metric.unitLabel(.imperial),
                            "\(metric) should be unaffected by unit system")
        }
        XCTAssertEqual(TrendMetric.hrv.unitLabel(.metric), "ms")
        XCTAssertEqual(TrendMetric.sleep.unitLabel(.metric), "h")
        XCTAssertEqual(TrendMetric.steps.unitLabel(.metric), "steps")
        XCTAssertEqual(TrendMetric.vo2.unitLabel(.metric), "ml/kg·min")
        XCTAssertEqual(TrendMetric.rhr.unitLabel(.metric), "bpm")
    }
}

// MARK: - TrendsViewModel.load() — metric/response integrity

/// Regression coverage for the mislabeled-metric bug: `selectedMetric` used
/// to change synchronously on tap while `points` only updated after the
/// network round-trip, so the header briefly (or, on error, indefinitely)
/// showed one metric's numbers under another metric's name. `load()` now
/// binds points to the metric/days that produced them via `LoadedSeries`,
/// and a generation counter drops any response superseded by a later tap.
@MainActor
final class TrendsViewModelLoadTests: XCTestCase {

    private func point(_ dateKey: String, _ value: Double) -> TrendPoint {
        TrendPoint(date: dateKey, value: value)
    }

    func testSuccessfulLoadExposesLoadedMatchingTheRequestedMetric() async {
        let fake = FakeTrendsAPI()
        fake.responses["steps"] = TrendsResponse(
            metric: "steps",
            points: [point("2026-07-01", 4200), point("2026-07-02", 5300)],
            calibration: nil
        )
        let vm = TrendsViewModel(apiClient: fake)
        vm.selectedMetric = .steps
        vm.selectedDays = 30

        await vm.load()

        XCTAssertEqual(vm.loaded?.metric, .steps)
        XCTAssertEqual(vm.loaded?.days, 30)
        XCTAssertEqual(vm.loaded?.points.count, 2)
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
    }

    func testFailedLoadClearsLoaded() async {
        let fake = FakeTrendsAPI()
        fake.responses["hrv"] = TrendsResponse(
            metric: "hrv",
            points: [point("2026-07-01", 55)],
            calibration: nil
        )
        let vm = TrendsViewModel(apiClient: fake)
        vm.selectedMetric = .hrv
        vm.selectedDays = 14
        await vm.load()
        XCTAssertNotNil(vm.loaded, "precondition: first load should have succeeded")

        fake.error = TestFailure.unavailable
        await vm.load()

        XCTAssertNil(vm.loaded)
        XCTAssertNotNil(vm.errorMessage)
    }

    /// Two taps in quick succession — a slow first response for the metric
    /// tapped first must not land after (and overwrite) a faster response
    /// for the metric tapped second.
    func testSlowFirstResponseDoesNotOverwriteNewerSecondResponse() async {
        let fake = FakeTrendsAPI()
        fake.responses["hrv"] = TrendsResponse(
            metric: "hrv",
            points: [point("2026-07-01", 55)],
            calibration: nil
        )
        fake.responses["rhr"] = TrendsResponse(
            metric: "rhr",
            points: [point("2026-07-01", 60)],
            calibration: nil
        )
        fake.delayedMetric = "hrv"

        let vm = TrendsViewModel(apiClient: fake)
        vm.selectedMetric = .hrv
        vm.selectedDays = 14

        let firstLoad = Task { await vm.load() }
        await Task.yield() // let the first load reach the fetchTrends("hrv") await

        vm.selectedMetric = .rhr
        await vm.load() // resolves immediately — not the delayed metric

        XCTAssertEqual(vm.loaded?.metric, .rhr, "the faster, newer response should win")

        fake.release() // now let the stale hrv response land
        await firstLoad.value

        XCTAssertEqual(vm.loaded?.metric, .rhr, "a superseded response must not overwrite the newer one")
        XCTAssertEqual(vm.loaded?.points.first?.value, 60)
    }
}

private enum TestFailure: Error {
    case unavailable
}

@MainActor
private final class FakeTrendsAPI: TrendsAPIProviding {
    var responses: [String: TrendsResponse] = [:]
    var error: Error?
    /// When set, `fetchTrends` for this metric suspends until `release()` is
    /// called, so tests can control response ordering deterministically.
    var delayedMetric: String?
    private var continuation: CheckedContinuation<Void, Never>?
    var batchResponse: TrendsBatchResponse = TrendsBatchResponse(
        days: 30,
        series: [:],
        unknownMetrics: [],
        calibration: nil
    )

    func fetchTrends(metric: String, days: Int) async throws -> TrendsResponse {
        if metric == delayedMetric {
            await withCheckedContinuation { continuation = $0 }
        }
        if let error { throw error }
        return responses[metric] ?? TrendsResponse(metric: metric, points: [], calibration: nil)
    }

    func fetchTrendsBatch(metrics: [String], days: Int) async throws -> TrendsBatchResponse {
        return batchResponse
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}
