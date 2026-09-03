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

    // MARK: - sleepFootnote — missing-night integrity
    //
    // Regression coverage for the bug where 2 of 7 synced nights (both near
    // goal) rendered as "Every night near your 8h goal this week." — an
    // absolute claim about 7 nights built from data about 2. These pin: (a)
    // the full 7/7 copy is untouched, (b) any partial week states coverage
    // before making a claim, and (c) "Every" never appears when a night is
    // missing.

    func testSleepFootnoteWithFullWeekSyncedAndNoShortNightsKeepsUnqualifiedEveryCopy() {
        // 7 of 7 synced, none short — the one case allowed to say "Every".
        let values: [Double?] = [6.0, 6.5, 7.0, 7.5, 8.0, 8.2, 7.9]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, .plain("Every night near your 8h goal this week."))
    }

    func testSleepFootnoteWithTwoOfSevenSyncedAndNoShortNightsStatesCoverageBeforeClaim() {
        // The exact bug scenario: 2 nights synced, both near goal. Must not
        // claim "Every night" — must say 2 of 7 synced first.
        let values: [Double?] = [nil, nil, nil, nil, nil, 7.5, 8.0]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Only ",
            bold: "2 of 7 nights",
            suffix: " synced — both near your 8h goal."
        ))
    }

    func testSleepFootnoteWithOneOfSevenSyncedUsesSingularClaim() {
        let values: [Double?] = [nil, nil, nil, nil, nil, nil, 7.8]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Only ",
            bold: "1 of 7 nights",
            suffix: " synced — it's near your 8h goal."
        ))
    }

    func testSleepFootnoteWithThreeOfSevenSyncedAndNoShortNightsUsesAllClaim() {
        let values: [Double?] = [nil, nil, nil, nil, 6.5, 7.0, 7.5]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Only ",
            bold: "3 of 7 nights",
            suffix: " synced — all near your 8h goal."
        ))
    }

    func testSleepFootnoteWithTwoOfSevenSyncedAndOneShortNightCountsAgainstSyncedNotSeven() {
        // 1 short night out of 2 synced — the bold span must read "1 of 2
        // synced nights", not "1 of 7 nights" (which would imply 6 more
        // nights of data that were never observed).
        let values: [Double?] = [nil, nil, nil, nil, nil, 5.0, 7.5]

        let footnote = TrendsSummary.sleepFootnote(values)

        XCTAssertEqual(footnote, TrendsSummary.Footnote(
            prefix: "Under 6h on ",
            bold: "1 of 2 synced nights",
            suffix: ". Gray bars are short nights."
        ))
    }

    func testSleepFootnoteWithZeroOfSevenSyncedStillReportsNoData() {
        XCTAssertEqual(
            TrendsSummary.sleepFootnote(Array(repeating: nil, count: 7)),
            .plain("No sleep synced yet.")
        )
    }

    func testSleepFootnoteNeverSaysEveryWhenAnyNightIsMissing() {
        let partialScenarios: [[Double?]] = [
            [nil, nil, nil, nil, nil, nil, 7.8],                 // 1/7, no short
            [nil, nil, nil, nil, nil, 7.5, 8.0],                 // 2/7, no short
            [nil, nil, nil, nil, 6.5, 7.0, 7.5],                 // 3/7, no short
            [nil, nil, nil, nil, nil, 5.0, 7.5],                 // 2/7, 1 short
            [5.9, 7.1, nil, 5.9, 5.7, nil, 5.5],                 // 5/7, some short
        ]

        for values in partialScenarios {
            let footnote = TrendsSummary.sleepFootnote(values)
            XCTAssertFalse(footnote.prefix.contains("Every"), "prefix leaked an absolute claim for \(values)")
            XCTAssertFalse((footnote.bold ?? "").contains("Every"), "bold leaked an absolute claim for \(values)")
            XCTAssertFalse(footnote.suffix.contains("Every"), "suffix leaked an absolute claim for \(values)")
        }
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

// MARK: - TrendsViewModel.load() — batch loader integrity

/// Coverage for the grid index's batch loader: `load()` now fetches every
/// catalog metric in one `fetchTrendsBatch` round trip instead of one
/// `fetchTrends` per tap, keyed by raw metric name rather than bound to a
/// single `selectedMetric`. The race-guard regression this class used to
/// pin (a slow response landing after a faster, newer one) still applies —
/// it's now a pull-to-refresh racing a fresh `load()` instead of two taps —
/// so `testSlowFirstBatchResponseDoesNotOverwriteNewerSecondResponse` below
/// is the direct descendant of that original test.
@MainActor
final class TrendsViewModelLoadTests: XCTestCase {

    private func point(_ dateKey: String, _ value: Double) -> TrendPoint {
        TrendPoint(date: dateKey, value: value)
    }

    private func hrvSeries(
        value: Double,
        dataDays: Int = 20,
        established: Bool = true,
        baseline: TrendsBaselineDTO? = nil
    ) -> TrendsSeriesDTO {
        TrendsSeriesDTO(
            metric: "hrv_sdnn", label: "HRV", unit: "ms",
            points: [point("2026-07-01", value)],
            baseline: baseline, dataDays: dataDays, established: established, lastDate: nil
        )
    }

    func testSuccessfulLoadPopulatesLoadedKeyedByRawMetricName() async {
        let fake = FakeTrendsAPI()
        fake.batchResponse = TrendsBatchResponse(
            days: 30,
            series: ["hrv_sdnn": hrvSeries(value: 48)],
            unknownMetrics: [],
            calibration: CalibrationStatus(status: "ready", metrics: [:])
        )
        let vm = TrendsViewModel(apiClient: fake)

        await vm.load()

        XCTAssertEqual(vm.loaded["hrv_sdnn"]?.points.first?.value, 48)
        XCTAssertEqual(vm.calibration?.status, "ready")
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
    }

    /// A key the batch response returns that isn't in `MetricCatalog` (an
    /// older client requesting a name a newer/older backend doesn't
    /// recognize, or vice versa) must be dropped, not crash or surface as a
    /// tile with no spec to render against.
    func testKeyNotInCatalogIsDroppedFromLoaded() async {
        let fake = FakeTrendsAPI()
        fake.batchResponse = TrendsBatchResponse(
            days: 30,
            series: [
                "hrv_sdnn": hrvSeries(value: 48),
                "not_a_real_metric": hrvSeries(value: 1),
            ],
            unknownMetrics: [],
            calibration: nil
        )
        let vm = TrendsViewModel(apiClient: fake)

        await vm.load()

        XCTAssertNotNil(vm.loaded["hrv_sdnn"])
        XCTAssertNil(vm.loaded["not_a_real_metric"])
    }

    /// A refresh failure must not wipe the grid back to empty — the
    /// previous `loaded` content stays on screen (with an `ErrorCard` above
    /// it) rather than every tile vanishing because pull-to-refresh hit a
    /// transient network error.
    func testFailedLoadSetsErrorMessageButPreservesPreviousLoaded() async {
        let fake = FakeTrendsAPI()
        fake.batchResponse = TrendsBatchResponse(
            days: 30, series: ["hrv_sdnn": hrvSeries(value: 48)], unknownMetrics: [], calibration: nil
        )
        let vm = TrendsViewModel(apiClient: fake)
        await vm.load()
        XCTAssertFalse(vm.loaded.isEmpty, "precondition: first load should have succeeded")

        fake.batchError = TestFailure.unavailable
        await vm.load()

        XCTAssertNotNil(vm.errorMessage)
        XCTAssertEqual(vm.loaded["hrv_sdnn"]?.points.first?.value, 48, "stale-but-valid data must survive a failed refresh")
    }

    /// The generation-guard regression test, ported from the explorer's
    /// two-taps scenario to the batch loader's pull-to-refresh scenario: a
    /// slow first `load()` must not overwrite a faster second `load()` that
    /// completed while the first was still in flight.
    func testSlowFirstBatchResponseDoesNotOverwriteNewerSecondResponse() async {
        let fake = FakeTrendsAPI()
        fake.batchResponse = TrendsBatchResponse(
            days: 30, series: ["hrv_sdnn": hrvSeries(value: 999)], unknownMetrics: [], calibration: nil
        )
        fake.delayNextBatch = true

        let vm = TrendsViewModel(apiClient: fake)
        // Await the first load actually suspending inside `fetchTrendsBatch`.
        // This used to be a single `await Task.yield()`, which is a bet that
        // one scheduling hop is enough to get the task there. If it isn't,
        // the *second* `load()` below consumes `delayNextBatch` instead and
        // suspends on a continuation that `releaseBatch()` never reaches —
        // the test then hangs rather than failing, which is the worst way for
        // a suite to be untrustworthy. The fake now says when it has arrived.
        let firstLoadSuspended = expectation(description: "the first load suspends inside fetchTrendsBatch")
        fake.onBatchSuspended = { firstLoadSuspended.fulfill() }
        let firstLoad = Task { await vm.load() }
        await fulfillment(of: [firstLoadSuspended], timeout: 10)
        fake.onBatchSuspended = nil

        fake.batchResponse = TrendsBatchResponse(
            days: 30, series: ["hrv_sdnn": hrvSeries(value: 60)], unknownMetrics: [], calibration: nil
        )
        await vm.load() // resolves immediately — not the delayed call

        XCTAssertEqual(vm.loaded["hrv_sdnn"]?.points.first?.value, 60, "the faster, newer response should win")

        fake.releaseBatch() // now let the stale first response land
        await firstLoad.value

        XCTAssertEqual(vm.loaded["hrv_sdnn"]?.points.first?.value, 60, "a superseded response must not overwrite the newer one")
    }
}

// MARK: - TrendsViewModel.makeSeries — unit conversion happens exactly once

/// Pure coverage (no network) for the decode-time conversion: `displayScale`
/// applied once to **both** `points[].value` and every `baseline` field.
/// `MetricCatalogTests` already pins `displayScale` itself; this is the
/// integration point that proves `makeSeries` actually applies it to both
/// places rather than just the headline value. `@MainActor` because
/// `makeSeries` lives on `TrendsViewModel`, which is itself `@MainActor`.
@MainActor
final class TrendsViewModelMakeSeriesTests: XCTestCase {

    func testDisplayScaleAppliesOnceToBothPointsAndBaselineForImperial() {
        let spec = MetricCatalog.spec(for: "body_mass_kg")!
        let dto = TrendsSeriesDTO(
            metric: "body_mass_kg", label: "Weight", unit: "kg",
            points: [TrendPoint(date: "2026-07-01", value: 70.0)],
            baseline: TrendsBaselineDTO(mean7: 70.0, mean30: 70.0, mean60: 70.0, sd30: 0.05, p25: 69.5, p50: 70.0, p75: 70.5),
            dataDays: 30, established: true, lastDate: "2026-07-01"
        )

        let series = TrendsViewModel.makeSeries(from: dto, spec: spec, system: .imperial)

        let scale = UnitConvert.lbPerKg
        XCTAssertEqual(series.points.first?.value ?? 0, 70.0 * scale, accuracy: 1e-9)
        XCTAssertEqual(series.baseline?.mean30 ?? 0, 70.0 * scale, accuracy: 1e-9)
        XCTAssertEqual(series.baseline?.sd30 ?? 0, 0.05 * scale, accuracy: 1e-9, "sd30 must scale too — a smart-scale wobble must stay the same fraction of the mean after conversion")
        XCTAssertEqual(series.baseline?.p75 ?? 0, 70.5 * scale, accuracy: 1e-9)
    }

    func testDisplayScaleIsANoOpForMetricSystem() {
        let spec = MetricCatalog.spec(for: "body_mass_kg")!
        let dto = TrendsSeriesDTO(
            metric: "body_mass_kg", label: "Weight", unit: "kg",
            points: [TrendPoint(date: "2026-07-01", value: 70.0)],
            baseline: nil, dataDays: 30, established: true, lastDate: nil
        )

        let series = TrendsViewModel.makeSeries(from: dto, spec: spec, system: .metric)

        XCTAssertEqual(series.points.first?.value, 70.0)
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
    var batchError: Error?
    /// When true, the NEXT `fetchTrendsBatch` call suspends until
    /// `releaseBatch()` is called — lets a test start a slow `load()`, let a
    /// second (fast) `load()` finish first, and prove the slow one can't
    /// clobber the fresher result once it's finally released.
    var delayNextBatch = false
    private var batchContinuation: CheckedContinuation<Void, Never>?

    /// Fired when `fetchTrendsBatch` has actually suspended on
    /// `delayNextBatch`. Lets a test await the slow load reaching the network
    /// rather than assuming a scheduling hop got it there.
    var onBatchSuspended: (@MainActor () -> Void)? = nil

    func fetchTrends(metric: String, days: Int) async throws -> TrendsResponse {
        if metric == delayedMetric {
            await withCheckedContinuation { continuation = $0 }
        }
        if let error { throw error }
        return responses[metric] ?? TrendsResponse(metric: metric, points: [], calibration: nil)
    }

    func fetchTrendsBatch(metrics: [String], days: Int) async throws -> TrendsBatchResponse {
        if delayNextBatch {
            delayNextBatch = false
            await withCheckedContinuation {
                batchContinuation = $0
                onBatchSuspended?()
            }
        }
        if let batchError { throw batchError }
        return batchResponse
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }

    func releaseBatch() {
        batchContinuation?.resume()
        batchContinuation = nil
    }
}
