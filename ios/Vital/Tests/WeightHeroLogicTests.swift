import XCTest
@testable import Vital

/// Unit tests for the pure decision logic backing the weight_loss hero and
/// the "Next up" row (docs/ux-spec-v4.md §4.1, §5.3; owner decisions and
/// dietitian-review follow-ups, 2026-09-23) — see `WeightHeroLogic.swift`.
final class WeightHeroLogicTests: XCTestCase {

    // MARK: - Next up

    private func item(id: String, timeMinutes: Int, status: PlanItem.Status) -> PlanItem {
        PlanItem(
            id: id, timeMinutes: timeMinutes, title: "Item \(id)", subtitle: "",
            sfSymbol: "circle", status: status, source: .coach, kind: .meal
        )
    }

    func testNextUpPicksEarliestUpcomingNotDoneOrSkipped() {
        let items = [
            item(id: "a", timeMinutes: 600, status: .done),
            item(id: "b", timeMinutes: 900, status: .later),
            item(id: "c", timeMinutes: 750, status: .now),
            item(id: "d", timeMinutes: 700, status: .skipped),
        ]
        // now = 700 — "c" (750) and "b" (900) both qualify; "c" is earlier.
        XCTAssertEqual(WeightHeroLogic.nextUpItem(from: items, nowMinutes: 700)?.id, "c")
    }

    func testNextUpIsNilWhenEverythingIsDoneOrSkipped() {
        let items = [
            item(id: "a", timeMinutes: 600, status: .done),
            item(id: "b", timeMinutes: 900, status: .skipped),
        ]
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: items, nowMinutes: 700))
    }

    func testNextUpIsNilForEmptyPlan() {
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: [], nowMinutes: 700))
    }

    /// Screenshot-review regression: a 7:00 AM breakfast that's still
    /// "later" (never marked done/skipped) must not show as Next up at
    /// 3:25 PM — it's hours in the past, not upcoming.
    func testNextUpExcludesItemsWellInThePast() {
        let breakfast = item(id: "breakfast", timeMinutes: 7 * 60, status: .later)
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: [breakfast], nowMinutes: 15 * 60 + 25))
    }

    /// The 30-minute grace window (`nextUpGraceMinutes`) is inclusive at
    /// exactly -30 and exclusive one minute further back.
    func testNextUpGraceBoundaryIncludesExactlyMinus30() {
        let item9_30 = item(id: "a", timeMinutes: 570, status: .later) // 9:30
        XCTAssertEqual(WeightHeroLogic.nextUpItem(from: [item9_30], nowMinutes: 600)?.id, "a") // now 10:00
    }

    func testNextUpGraceBoundaryExcludesMinus31() {
        let item9_29 = item(id: "a", timeMinutes: 569, status: .later) // 9:29
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: [item9_29], nowMinutes: 600)) // now 10:00
    }

    func testNextUpIsNilWhenEveryUpcomingCandidateHasAlreadyPassed() {
        let items = [
            item(id: "a", timeMinutes: 420, status: .later),
            item(id: "b", timeMinutes: 480, status: .now),
        ]
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: items, nowMinutes: 1000))
    }

    func testNextUpStillExcludesDoneAndSkippedEvenWhenUpcoming() {
        let items = [
            item(id: "a", timeMinutes: 950, status: .done),
            item(id: "b", timeMinutes: 960, status: .skipped),
            item(id: "c", timeMinutes: 1000, status: .later),
        ]
        XCTAssertEqual(WeightHeroLogic.nextUpItem(from: items, nowMinutes: 900)?.id, "c")
    }

    // MARK: - Sparkline Y-domain (screenshot-review fix)

    func testSparklineDomainAddsPaddingForNormalRange() {
        let domain = WeightHeroLogic.sparklineDomain(values: [80, 82, 84], minSpan: 1.0)
        // span = 4, padding = 4 * 0.15 = 0.6
        XCTAssertEqual(domain?.lowerBound ?? .nan, 79.4, accuracy: 0.0001)
        XCTAssertEqual(domain?.upperBound ?? .nan, 84.6, accuracy: 0.0001)
    }

    func testSparklineDomainCentersMinSpanForFlatSeries() {
        let domain = WeightHeroLogic.sparklineDomain(values: [82, 82, 82], minSpan: 1.0)
        XCTAssertEqual(domain?.lowerBound ?? .nan, 81.5, accuracy: 0.0001)
        XCTAssertEqual(domain?.upperBound ?? .nan, 82.5, accuracy: 0.0001)
    }

    func testSparklineDomainEnforcesFloorForNarrowNonFlatRange() {
        // 0.3 kg observed range, under the 1.0 kg floor — gets the floor's
        // exact width, centered on the data's own midpoint.
        let domain = WeightHeroLogic.sparklineDomain(values: [81.9, 82.0, 82.2], minSpan: 1.0)
        let mid = (81.9 + 82.2) / 2
        XCTAssertEqual(domain?.lowerBound ?? .nan, mid - 0.5, accuracy: 0.0001)
        XCTAssertEqual(domain?.upperBound ?? .nan, mid + 0.5, accuracy: 0.0001)
    }

    func testSparklineDomainNilForEmptySeries() {
        XCTAssertNil(WeightHeroLogic.sparklineDomain(values: [], minSpan: 1.0))
    }

    // MARK: - Entry/trend test fixtures

    /// `daysAgo`, relative to a fixed anchor (`2026-09-20`) — entirely
    /// deterministic, no dependency on the current date.
    private func entry(daysAgo: Int, weight: Double = 82, source: String = "manual") -> WeightLogEntryDTO {
        WeightLogEntryDTO(date: day(daysAgo: daysAgo), weight: weight, unit: "kg", source: source)
    }

    private func day(daysAgo: Int) -> String {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let anchor = utc.date(from: DateComponents(year: 2026, month: 9, day: 20))!
        let date = utc.date(byAdding: .day, value: -daysAgo, to: anchor)!
        let f = DateFormatter()
        f.calendar = utc
        f.timeZone = utc.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    // MARK: - Trend headline / honesty gate (§4.1)

    func testTrendHeadlineIsPlaceholderWhenNil() {
        XCTAssertEqual(
            WeightHeroLogic.trendHeadline(trend: nil, system: .metric),
            WeightHeroLogic.trendPlaceholderText
        )
    }

    func testTrendHeadlineIsPlaceholderWhenNotEstablished() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82, trendKg: 82.1)],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.4, established: false
        )
        XCTAssertEqual(
            WeightHeroLogic.trendHeadline(trend: trend, system: .metric),
            WeightHeroLogic.trendPlaceholderText
        )
        XCTAssertNil(
            WeightHeroLogic.weeklyChangeText(trend: trend, entries: [entry(daysAgo: 0)], system: .metric),
            "Never fabricate a weekly-change number before the trend is established"
        )
    }

    func testTrendHeadlineShowsLatestTrendWeightWhenEstablished() {
        let trend = WeightTrendDTO(
            days: [
                WeightTrendDayDTO(day: day(daysAgo: 1), rawKg: 82.5, trendKg: 82.4),
                WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82.0, trendKg: 82.3),
            ],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.35, established: true
        )
        XCTAssertEqual(WeightHeroLogic.trendHeadline(trend: trend, system: .metric), "Trend 82.3\u{00A0}kg")
        // Hero header drops the duplicate once established; placeholder otherwise.
        XCTAssertNil(WeightHeroLogic.heroHeaderTrendText(trend: trend, system: .metric))
        XCTAssertEqual(
            WeightHeroLogic.heroHeaderTrendText(trend: nil, system: .metric),
            WeightHeroLogic.trendPlaceholderText
        )
    }

    // MARK: - Weekly-change text: span gate + pace guard (dietitian review)

    func testWeeklyChangeHiddenUntilEntriesSpanAtLeast7Days() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82, trendKg: 82)],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.4, established: true
        )
        let sparseEntries = [entry(daysAgo: 5), entry(daysAgo: 2), entry(daysAgo: 0)] // spans 5 days
        XCTAssertNil(
            WeightHeroLogic.weeklyChangeText(trend: trend, entries: sparseEntries, system: .metric),
            "5-day span is < the 7-day minimum for showing a weekly rate at all"
        )

        let wideEntries = [entry(daysAgo: 7), entry(daysAgo: 3), entry(daysAgo: 0)] // spans exactly 7 days
        XCTAssertNotNil(WeightHeroLogic.weeklyChangeText(trend: trend, entries: wideEntries, system: .metric))
    }

    func testDaySpanNilForFewerThanTwoDistinctDays() {
        XCTAssertNil(WeightHeroLogic.daySpan(entries: []))
        XCTAssertNil(WeightHeroLogic.daySpan(entries: [entry(daysAgo: 0)]))
        // Two same-day entries (e.g. two manual logs) still count as one day.
        XCTAssertNil(WeightHeroLogic.daySpan(entries: [entry(daysAgo: 0), entry(daysAgo: 0, weight: 81)]))
    }

    func testDaySpanIsEarliestToLatestDistinctDay() {
        let entries = [entry(daysAgo: 20), entry(daysAgo: 10), entry(daysAgo: 0)]
        XCTAssertEqual(WeightHeroLogic.daySpan(entries: entries), 20)
    }

    func testWeeklyChangeFallsBackTo30dWhen7dMissing() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82, trendKg: 82)],
            delta7dKgPerWeek: nil, delta30dKgPerWeek: -0.2, established: true
        )
        let entries = [entry(daysAgo: 10), entry(daysAgo: 0)]
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric),
                        "\u{2212}0.2\u{00A0}kg/wk this week")
    }

    func testWeeklyChangeUsesGoalProgressFourWeekRateWhenProvided() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82, trendKg: 82)],
            delta7dKgPerWeek: -0.8, delta30dKgPerWeek: -0.4, established: true
        )
        let entries = [entry(daysAgo: 10), entry(daysAgo: 0)]
        XCTAssertEqual(
            WeightHeroLogic.weeklyChangeText(
                trend: trend, entries: entries, system: .metric, goalRateKgPerWeek: -0.4, goalRateWindowDays: 28
            ),
            "\u{2212}0.4\u{00A0}kg/wk over 4 weeks"
        )
        // Not established: still nothing, even with a goal rate.
        let young = WeightTrendDTO(days: [], delta7dKgPerWeek: nil, delta30dKgPerWeek: nil, established: false)
        XCTAssertNil(WeightHeroLogic.weeklyChangeText(trend: young, entries: entries, system: .metric, goalRateKgPerWeek: -0.4))
    }

    func testWeeklyChangePositiveRateShowsPlusSign() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 79, trendKg: 79)],
            delta7dKgPerWeek: 0.3, delta30dKgPerWeek: 0.3, established: true
        )
        let entries = [entry(daysAgo: 10, weight: 79), entry(daysAgo: 0, weight: 79)]
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric),
                        "+0.3\u{00A0}kg/wk this week")
    }

    func testFastLossAppendsNeutralPaceNote() {
        // 82 kg trend losing 1 kg/wk ≈ 1.22%/wk — over the 1% threshold.
        XCTAssertTrue(WeightHeroLogic.isFasterThanRecommended(deltaPerWeek: -1.0, currentTrendKg: 82))

        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82, trendKg: 82)],
            delta7dKgPerWeek: -1.0, delta30dKgPerWeek: -1.0, established: true
        )
        let entries = [entry(daysAgo: 10, weight: 83), entry(daysAgo: 0, weight: 82)]
        XCTAssertEqual(
            WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric),
            "\u{2212}1.0\u{00A0}kg/wk this week · faster than recommended"
        )
    }

    func testModeratePaceHasNoNote() {
        // 0.6 kg/wk on an 82 kg trend ≈ 0.73%/wk — under the threshold.
        XCTAssertFalse(WeightHeroLogic.isFasterThanRecommended(deltaPerWeek: -0.6, currentTrendKg: 82))
    }

    func testGainingRateNeverGetsTheFasterThanRecommendedNote() {
        // Only a LOSS is flagged — a symmetric-magnitude gain must not be.
        XCTAssertFalse(WeightHeroLogic.isFasterThanRecommended(deltaPerWeek: 1.0, currentTrendKg: 82))
    }

    func testFasterThanRecommendedNeverTriggersWithoutATrendWeight() {
        XCTAssertFalse(WeightHeroLogic.isFasterThanRecommended(deltaPerWeek: -5.0, currentTrendKg: nil))
        XCTAssertFalse(WeightHeroLogic.isFasterThanRecommended(deltaPerWeek: -5.0, currentTrendKg: 0))
    }

    // MARK: - Weigh-in chip (§5.3, dietitian review: never leads with a raw number)

    func testWeighInChipShowsConfirmTodaysWeightWhenHealthKitHasTodayReading() {
        let chip = WeightHeroLogic.weighInChip(healthKitTodayKg: 82.4)
        XCTAssertTrue(chip.isOneTapConfirm)
        XCTAssertEqual(chip.confirmValueKg, 82.4)
        XCTAssertEqual(chip.title, "Confirm today's weight")
    }

    func testWeighInChipIsPlainWeighInWithNoHealthKitReading() {
        let chip = WeightHeroLogic.weighInChip(healthKitTodayKg: nil)
        XCTAssertFalse(chip.isOneTapConfirm)
        XCTAssertNil(chip.confirmValueKg)
        XCTAssertEqual(chip.title, "Weigh in")
    }

    func testLastWeightKgPicksMostRecentDate() {
        let entries = [
            WeightLogEntryDTO(date: "2026-09-18", weight: 84, unit: "kg", source: "manual"),
            WeightLogEntryDTO(date: "2026-09-20", weight: 82.4, unit: "kg", source: "manual"),
            WeightLogEntryDTO(date: "2026-09-19", weight: 83, unit: "kg", source: "manual"),
        ]
        XCTAssertEqual(WeightHeroLogic.lastWeightKg(entries: entries), 82.4)
    }

    func testLastWeightKgNilForEmptyEntries() {
        XCTAssertNil(WeightHeroLogic.lastWeightKg(entries: []))
    }

    // MARK: - Weigh-in toast (dietitian review: leads with the trend, not the raw number)

    func testWeighInToastLeadsWithTrendWhenEstablished() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82.4, trendKg: 82.1)],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.4, established: true
        )
        let entries = [entry(daysAgo: 10), entry(daysAgo: 0, weight: 82.4)]
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: trend, system: .metric),
            "Logged \u{00b7} trend 82.1\u{00A0}kg (\u{2212}0.4/wk)"
        )
    }

    /// While the server reads the scale itself (early / returning / plateau) it
    /// withholds a pace, so the toast quotes none either; an older server is unchanged.
    func testWeighInToastQuotesNoRateWhileTheServerReadsTheScale() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82.4, trendKg: 82.1)],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.35, established: true
        )
        let entries = [entry(daysAgo: 10), entry(daysAgo: 0, weight: 82.4)]
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: trend, system: .metric, withholdsLocalRate: true),
            "Logged \u{00b7} trend 82.1\u{00A0}kg"
        )
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: trend, system: .imperial, withholdsLocalRate: true),
            "Logged \u{00b7} trend \(UnitFormat.weight(kg: 82.1, .imperial))"
        )
        // Older server (the default): the rate stays.
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: trend, system: .metric, withholdsLocalRate: false),
            "Logged \u{00b7} trend 82.1\u{00A0}kg (\u{2212}0.4/wk)"
        )
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: trend, system: .metric),
            "Logged \u{00b7} trend 82.1\u{00A0}kg (\u{2212}0.4/wk)"
        )
        // Not established: the honest count, with or without a server read.
        let young = WeightTrendDTO(days: [], delta7dKgPerWeek: nil, delta30dKgPerWeek: nil, established: false)
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: young, system: .metric, withholdsLocalRate: true),
            "Logged \u{2014} trend appears after 3 weigh-ins (2 of 3)"
        )
    }

    func testWeighInToastShowsRealCountWhenNotEstablished() {
        let trend = WeightTrendDTO(days: [], delta7dKgPerWeek: nil, delta30dKgPerWeek: nil, established: false)
        let entries = [entry(daysAgo: 3), entry(daysAgo: 0)]
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: trend, system: .metric),
            "Logged \u{2014} trend appears after 3 weigh-ins (2 of 3)"
        )
    }

    func testWeighInToastCountCapsAtThree() {
        let entries = [entry(daysAgo: 4), entry(daysAgo: 3), entry(daysAgo: 2), entry(daysAgo: 1), entry(daysAgo: 0)]
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: nil, system: .metric),
            "Logged \u{2014} trend appears after 3 weigh-ins (3 of 3)"
        )
    }

    func testWeighInToastCountsDistinctDaysNotRawEntries() {
        // Two manual corrections on the same day count once.
        let entries = [entry(daysAgo: 0), entry(daysAgo: 0, weight: 81)]
        XCTAssertEqual(
            WeightHeroLogic.weighInToastMessage(entries: entries, trend: nil, system: .metric),
            "Logged \u{2014} trend appears after 3 weigh-ins (1 of 3)"
        )
    }

    // MARK: - First-run checklist gating (§4.2)

    func testFirstRunChecklistShowsOnlyWhileCalibratingWithNoData() {
        XCTAssertTrue(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: "calibrating", hasAnyBiometric: false))
        XCTAssertFalse(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: "calibrating", hasAnyBiometric: true))
        XCTAssertFalse(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: "ready", hasAnyBiometric: false))
        XCTAssertFalse(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: nil, hasAnyBiometric: false))
    }

    // MARK: - Weigh-in sheet plausibility bounds (dietitian review)

    func testPlausibleWeightBounds() {
        XCTAssertFalse(WeightHeroLogic.isPlausibleWeight(kg: 24.9))
        XCTAssertTrue(WeightHeroLogic.isPlausibleWeight(kg: 25))
        XCTAssertTrue(WeightHeroLogic.isPlausibleWeight(kg: 82))
        XCTAssertTrue(WeightHeroLogic.isPlausibleWeight(kg: 350))
        XCTAssertFalse(WeightHeroLogic.isPlausibleWeight(kg: 350.1))
    }

    func testTrendDeltaThresholdTriggersOverThreePercent() {
        // 82 kg trend, 86 kg entry: (86-82)/82 = 4.88% — over 3%.
        XCTAssertTrue(WeightHeroLogic.exceedsTrendDeltaThreshold(enteredKg: 86, currentTrendKg: 82))
        // 82 kg trend, 83.8 kg entry: 2.2% — under 3%.
        XCTAssertFalse(WeightHeroLogic.exceedsTrendDeltaThreshold(enteredKg: 83.8, currentTrendKg: 82))
    }

    func testTrendDeltaThresholdNeverTriggersWithoutATrend() {
        XCTAssertFalse(WeightHeroLogic.exceedsTrendDeltaThreshold(enteredKg: 200, currentTrendKg: nil))
        XCTAssertFalse(WeightHeroLogic.exceedsTrendDeltaThreshold(enteredKg: 200, currentTrendKg: 0))
    }

    // MARK: - UnitFormat.weightDelta / weightDeltaCompact (unit formatting of the delta)

    func testWeightDeltaMetricRoundsToOneDecimalWithMinusSign() {
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: -0.6, .metric), "\u{2212}0.6\u{00A0}kg/wk")
    }

    func testWeightDeltaImperialConvertsFromKg() {
        // -0.6 kg/wk ≈ -1.3 lb/wk
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: -0.6, .imperial), "\u{2212}1.3\u{00A0}lb/wk")
    }

    func testWeightDeltaZeroHasNoSign() {
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: 0, .metric), "0.0\u{00A0}kg/wk")
    }

    func testWeightDeltaPositiveHasPlusSign() {
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: 0.42, .metric), "+0.4\u{00A0}kg/wk")
    }

    func testWeightDeltaCompactOmitsUnitLetters() {
        XCTAssertEqual(UnitFormat.weightDeltaCompact(kgPerWeek: -0.4, .metric), "\u{2212}0.4/wk")
        XCTAssertEqual(UnitFormat.weightDeltaCompact(kgPerWeek: 0.42, .metric), "+0.4/wk")
    }

    // MARK: - Server weight read (wave 19): no local rate while the server withholds a pace

    /// An established trend whose 7-day rate WOULD print "−0.8 kg/wk this week" — the
    /// jumpy number the server deliberately withholds during an early read.
    private func hero() -> (trend: WeightTrendDTO, entries: [WeightLogEntryDTO]) {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 82, trendKg: 82)],
            delta7dKgPerWeek: -0.8, delta30dKgPerWeek: -0.4, established: true
        )
        return (trend, [entry(daysAgo: 10), entry(daysAgo: 0)])
    }

    private func progress(
        _ state: GoalProgressDTO.WeightRead.State?, headline: String, rateKg: Double? = nil,
        lastWeighInDaysAgo: Int? = nil
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76),
            current: .init(weightKg: 83.5, startWeightKg: 83.7),
            ratePerWeek: .init(kg: rateKg),
            verdict: .progressing,
            headline: headline,
            lastWeighInDaysAgo: lastWeighInDaysAgo,
            weightRead: state.map { GoalProgressDTO.WeightRead(state: $0) }
        )
    }

    /// What `TodayViewModel.heroWithholdsLocalRate` / `heroServerWeightRead` feed the hero.
    private func heroText(_ goal: GoalProgressDTO?, goalRate: Double? = nil, windowDays: Int? = nil) -> String? {
        let (trend, entries) = hero()
        return WeightHeroLogic.weeklyChangeText(
            trend: trend, entries: entries, system: .metric, goalRateKgPerWeek: goalRate, goalRateWindowDays: windowDays,
            withholdsLocalRate: goal.map(GoalProgressLogic.usesServerWeightRead) ?? false,
            serverRead: goal.flatMap(WeightHeroLogic.serverReadSlotText)
        )
    }

    private let earlyHeadline = "Early read — down 0.7 kg on the scale in 7 days"
    private let returningHeadline = "Welcome back — the scale is down 1.1 kg since May 10"
    private let plateauHeadline = "Plateau — weekly average ~89.4 kg for 3 weeks"
    private let movingAgainHeadline = "Moving again — weekly average down 0.5 kg from the plateau"

    /// The goal line under the hero already says the server's read in full, so the
    /// hero's rate slot carries a short complement — and still no local rate.
    func testHeroShowsAShortComplementAndNoLocalRateWhileTheGoalLineSaysTheRead() {
        let reads: [(GoalProgressDTO.WeightRead.State, String, String)] = [
            (.early, earlyHeadline, "Pace settles after 3\u{00A0}weeks"),
            (.returning, returningHeadline, "Welcome back — weigh in a few more days"),
            (.plateau, plateauHeadline, "Flat for 3\u{00A0}weeks"),
            (.movingAgain, movingAgainHeadline, "Moving again after a plateau"),
        ]
        for (state, headline, expected) in reads {
            let goal = progress(state, headline: headline)
            XCTAssertTrue(GoalProgressLogic.goalLineShowsServerRead(goal), "\(state)")
            let text = heroText(goal)
            XCTAssertEqual(text, expected, "\(state)")
            XCTAssertFalse(text?.contains("/wk") ?? false, "\(state): no weekly rate of its own")
            // Not even the goal rate the card would show may sneak back in.
            XCTAssertEqual(heroText(progress(state, headline: headline, rateKg: -0.4), goalRate: -0.4), text, "\(state)")
        }
        XCTAssertEqual(WeightHeroLogic.earlyReadHeroText, "Pace settles after 3 weeks")
        XCTAssertEqual(WeightHeroLogic.returningReadHeroText, "Welcome back — weigh in a few more days")
        XCTAssertEqual(WeightHeroLogic.plateauReadHeroText, "Flat for 3 weeks")
        XCTAssertEqual(WeightHeroLogic.movingAgainReadHeroText, "Moving again after a plateau")
    }

    /// When the goal line is showing the stale-weigh-in nudge instead, nothing else
    /// says the read — the hero carries it in full.
    func testHeroCarriesTheFullReadWhileTheGoalLineShowsTheStaleWeighInNudge() {
        let stale = progress(.early, headline: earlyHeadline, lastWeighInDaysAgo: 6)
        XCTAssertFalse(GoalProgressLogic.goalLineShowsServerRead(stale))
        XCTAssertEqual(
            GoalProgressLogic.compactText(stale, system: .metric),
            "Last weigh-in 6 days ago — step on the scale to update"
        )
        // Units stay glued to their numbers.
        XCTAssertEqual(heroText(stale), "Early read — down 0.7\u{00A0}kg on the scale in 7 days")
        // A weigh-in 3 days old is not stale yet: the goal line is the read again.
        XCTAssertEqual(heroText(progress(.early, headline: earlyHeadline, lastWeighInDaysAgo: 3)), "Pace settles after 3\u{00A0}weeks")
    }

    /// One place says the full read; nothing is said twice.
    func testTheFullReadIsSaidInExactlyOnePlace() {
        let reads: [(GoalProgressDTO.WeightRead.State, String)] = [
            (.early, earlyHeadline), (.returning, returningHeadline), (.plateau, plateauHeadline),
            (.movingAgain, movingAgainHeadline),
        ]
        for (state, headline) in reads {
            for age in [nil, 0, 3, 4, 6] as [Int?] {
                let goal = progress(state, headline: headline, lastWeighInDaysAgo: age)
                let goalLine = GoalProgressLogic.compactText(goal, system: .metric)
                let hero = heroText(goal)
                let sayings = [goalLine == headline, hero == GoalProgressLogic.nonBreaking(headline)]
                XCTAssertEqual(sayings.filter { $0 }.count, 1, "\(state) age \(String(describing: age)): goal line \(goalLine) / hero \(String(describing: hero))")
                XCTAssertNotNil(hero, "\(state) age \(String(describing: age)): the hero still has a line")
            }
        }
    }

    func testHeroShowsNothingRatherThanALocalRateWhenTheServerSentNoReadText() {
        XCTAssertNil(heroText(progress(.early, headline: "")))
        XCTAssertNil(heroText(progress(.plateau, headline: "   ")))
    }

    func testHeroKeepsItsOwnFallbackWithoutAWeightReadOrDuringAPace() {
        let local = "\u{2212}0.8\u{00A0}kg/wk this week"
        XCTAssertEqual(heroText(nil), local, "no goal progress yet")
        XCTAssertEqual(heroText(progress(nil, headline: "Early read — down 0.7 kg")), local, "older server: no weightRead")
        XCTAssertEqual(heroText(progress(.pace, headline: "On track — 6 kg to go")), local)
        XCTAssertEqual(heroText(progress(.reached, headline: "Goal reached")), local)
        // The 4-week goal rate still wins over the local one, as before.
        XCTAssertEqual(
            heroText(progress(.pace, headline: "On track", rateKg: -0.4), goalRate: -0.4, windowDays: 28),
            "\u{2212}0.4\u{00A0}kg/wk over 4 weeks"
        )
    }

    func testServerReadSlotTextIsNilOutsideAServerRead() {
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(progress(.pace, headline: "On track")))
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(progress(.reached, headline: "Goal reached")))
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(progress(nil, headline: earlyHeadline)), "older server")
        let muscle = GoalProgressDTO(
            goal: "muscle", verdict: .progressing, headline: "Progressing", weightRead: .init(state: .early)
        )
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(muscle))
        // The server sent a read state but no text and the goal line is not the read: nothing, not a rate.
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(progress(.early, headline: "")))
    }

    func testHeroStaysSilentForANonEstablishedTrendEvenWithAServerRead() {
        let young = WeightTrendDTO(days: [], delta7dKgPerWeek: nil, delta30dKgPerWeek: nil, established: false)
        XCTAssertNil(WeightHeroLogic.weeklyChangeText(
            trend: young, entries: [entry(daysAgo: 10), entry(daysAgo: 0)], system: .metric,
            withholdsLocalRate: true, serverRead: "Early read — down 0.7 kg on the scale in 7 days"
        ))
    }

    // MARK: - Wave 20: the early read for an older goal

    /// An early-read payload whose `weightRead` carries the goal's age (`goalAgeDays`, absent from an older server).
    private func earlyRead(goalAgeDays: Int?, state: GoalProgressDTO.WeightRead.State = .early) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76),
            current: .init(weightKg: 83.5, startWeightKg: 83.7),
            verdict: .progressing,
            headline: earlyHeadline,
            weightRead: GoalProgressDTO.WeightRead(state: state, goalAgeDays: goalAgeDays)
        )
    }

    /// "Pace settles after 3 weeks" is true only for a goal under 21 days old. Past that the server
    /// (`paceWaitClause` in `lib/brain/openerText.ts`) says the pace is a few weigh-ins away, and so does the hero.
    func testHeroEarlyReadSaysFewMoreWeighInsOnceTheGoalIsThreeWeeksOld() {
        XCTAssertEqual(WeightHeroLogic.paceSettleDays, 21)
        XCTAssertEqual(WeightHeroLogic.olderGoalEarlyReadHeroText, "A few more weigh-ins and your pace is back")
        for age in [1, 10, 20] {
            XCTAssertEqual(WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: age)), "Pace settles after 3 weeks", "age \(age)")
        }
        for age in [21, 22, 40, 400] {
            XCTAssertEqual(
                WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: age)), "A few more weigh-ins and your pace is back", "age \(age)"
            )
        }
        XCTAssertEqual(WeightHeroLogic.earlyReadSlotText(goalAgeDays: 21), WeightHeroLogic.olderGoalEarlyReadHeroText)
        XCTAssertEqual(WeightHeroLogic.earlyReadSlotText(goalAgeDays: 20), WeightHeroLogic.earlyReadHeroText)
    }

    /// An older server sends no age: the hero keeps today's text, whatever the goal's real age.
    func testHeroEarlyReadKeepsTodaysTextWithoutAGoalAge() {
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: nil)), "Pace settles after 3 weeks")
        XCTAssertEqual(WeightHeroLogic.earlyReadSlotText(goalAgeDays: nil), WeightHeroLogic.earlyReadHeroText)
        XCTAssertNil(progress(.early, headline: earlyHeadline).weightRead?.goalAgeDays)
        XCTAssertEqual(heroText(progress(.early, headline: earlyHeadline)), "Pace settles after 3\u{00A0}weeks")
    }

    /// The age only touches the early read: a return after a gap and a plateau say what they said.
    func testGoalAgeOnlyChangesTheEarlyRead() {
        XCTAssertEqual(
            WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: 60, state: .returning)),
            "Welcome back — weigh in a few more days"
        )
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: 60, state: .plateau)), "Flat for 3 weeks")
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: 60, state: .pace)))
        XCTAssertNil(WeightHeroLogic.serverReadSlotText(earlyRead(goalAgeDays: 60, state: .reached)))
    }

    /// What the hero's rate slot shows for an older goal: the new line, still no rate of its own.
    func testHeroShowsTheOlderGoalLineAndNoLocalRate() {
        let (trend, entries) = hero()
        let goal = earlyRead(goalAgeDays: 30)
        let text = WeightHeroLogic.weeklyChangeText(
            trend: trend, entries: entries, system: .metric,
            withholdsLocalRate: GoalProgressLogic.usesServerWeightRead(goal),
            serverRead: WeightHeroLogic.serverReadSlotText(goal)
        )
        XCTAssertEqual(text, "A few more weigh-ins and your pace is back")
        XCTAssertFalse(text?.contains("/wk") ?? true)
    }

    // MARK: - Wave 21: moving again, and one displayed weight

    /// A moving-again payload; `plan` is the week plan the server sends with it (`nil` = none).
    private func movingAgain(plan: GoalProgressDTO.WeightRead.Plan?) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76),
            current: .init(weightKg: 83.5, startWeightKg: 83.7),
            verdict: .progressing,
            headline: movingAgainHeadline,
            weightRead: GoalProgressDTO.WeightRead(state: .movingAgain, plan: plan)
        )
    }

    /// The 14 days after a plateau: no pace, no date. The hero must not compute a rate of its own, and must not
    /// say the plateau's "Flat for 3 weeks" — the plateau is over.
    func testMovingAgainHasItsOwnHeroTextAndNoLocalRate() {
        let goal = movingAgain(plan: nil)
        XCTAssertTrue(GoalProgressLogic.usesServerWeightRead(goal))
        XCTAssertEqual(GoalProgressLogic.serverWeightRead(goal), movingAgainHeadline)
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(goal), "Moving again after a plateau")
        XCTAssertNotEqual(WeightHeroLogic.serverReadSlotText(goal), WeightHeroLogic.plateauReadHeroText)
        let text = heroText(goal)
        XCTAssertEqual(text, "Moving again after a plateau")
        XCTAssertFalse(text?.contains("/wk") ?? true, "no weekly rate of its own")
        // The 4-week goal rate does not sneak back in either.
        XCTAssertEqual(heroText(goal, goalRate: -0.4), text)
    }

    /// With the week plan the slot carries the plan's one action (the same line the card's reasons end on), so the
    /// goal line's "Moving again — ..." is not said twice; a plan that is not about moving again, or has no text, falls back.
    func testMovingAgainSlotCarriesThePlansActionWhenThereIsOne() {
        let action = GoalProgressDTO.WeightRead.Plan.Action(kind: "keep_what_worked", text: "Keep doing what restarted it")
        let plan = GoalProgressDTO.WeightRead.Plan(weekStart: "2026-10-12", state: .movingAgain, action: action)
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(movingAgain(plan: plan)), "Keep doing what restarted it")
        XCTAssertEqual(WeightHeroLogic.movingAgainSlotText(plan: plan), "Keep doing what restarted it")
        XCTAssertEqual(heroText(movingAgain(plan: plan)), "Keep doing what restarted it")

        let paceAction = GoalProgressDTO.WeightRead.Plan.Action(kind: "keep_going", text: "Keep your routine — it is working")
        let other = GoalProgressDTO.WeightRead.Plan(weekStart: "2026-10-12", state: .pace, action: paceAction)
        XCTAssertEqual(WeightHeroLogic.movingAgainSlotText(plan: other), "Moving again after a plateau")
        let blank = GoalProgressDTO.WeightRead.Plan(
            state: .movingAgain, action: GoalProgressDTO.WeightRead.Plan.Action(text: "   ")
        )
        XCTAssertEqual(WeightHeroLogic.movingAgainSlotText(plan: blank), "Moving again after a plateau")
        XCTAssertEqual(
            WeightHeroLogic.movingAgainSlotText(plan: GoalProgressDTO.WeightRead.Plan(state: .movingAgain)),
            "Moving again after a plateau"
        )
        XCTAssertEqual(WeightHeroLogic.movingAgainSlotText(plan: nil), "Moving again after a plateau")
    }

    /// While the goal line shows the stale-weigh-in nudge instead, the hero carries the full read, as for every server read.
    func testMovingAgainHeroCarriesTheFullReadWhileTheGoalLineShowsTheStaleNudge() {
        let stale = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 76), current: .init(weightKg: 83.5, startWeightKg: 83.7),
            verdict: .progressing, headline: movingAgainHeadline, lastWeighInDaysAgo: 6,
            weightRead: GoalProgressDTO.WeightRead(state: .movingAgain)
        )
        XCTAssertFalse(GoalProgressLogic.goalLineShowsServerRead(stale))
        XCTAssertEqual(heroText(stale), "Moving again — weekly average down 0.5\u{00A0}kg from the plateau")
    }

    /// The hero's middle caption quotes the goal's progress weight with the label that is true for it, only on a
    /// wave 21 server (`current.trendKg` present); an older server keeps the trend's "Now".
    func testSparklineCaptionNamesTheProgressWeightTruthfully() {
        for label in ["This week", "Weekly avg", "Latest"] {
            let weight = GoalProgressLogic.ProgressWeight(kg: 82.3, label: label)
            let captions = WeightHeroLogic.sparklineCaptions(
                firstKg: 83.7, lastKg: 82, targetKg: 76, system: .metric, progressWeight: weight
            )
            XCTAssertEqual(captions?.now, "\(label) 82.3\u{00A0}kg")
            XCTAssertEqual(captions?.start, "Start 83.7\u{00A0}kg", "the line is still the trend: only the caption changes")
            XCTAssertEqual(captions?.target, "Goal 76\u{00A0}kg")
        }
        XCTAssertEqual(
            WeightHeroLogic.sparklineCaptions(
                firstKg: 83.7, lastKg: 82, targetKg: nil, system: .imperial,
                progressWeight: GoalProgressLogic.ProgressWeight(kg: 82.3, label: "This week")
            )?.now,
            "This week 181\u{00A0}lb"
        )
        // No progress weight (an older server, other goals): the trend's "Now", exactly as before.
        XCTAssertEqual(WeightHeroLogic.sparklineCaptions(firstKg: 83.7, lastKg: 82, targetKg: 76, system: .metric)?.now, "Now 82\u{00A0}kg")
        XCTAssertEqual(
            WeightHeroLogic.sparklineCaptions(firstKg: 83.7, lastKg: 82, targetKg: 76, system: .metric, progressWeight: nil)?.now,
            "Now 82\u{00A0}kg"
        )
        // Still nil without points, whatever the weight.
        XCTAssertNil(WeightHeroLogic.sparklineCaptions(
            firstKg: nil, lastKg: 82, targetKg: 76, system: .metric,
            progressWeight: GoalProgressLogic.ProgressWeight(kg: 82.3, label: "This week")
        ))
    }

    /// A weight-loss payload as a wave 21 server sends it: `weightKg` is the progress weight, `trendKg` the trend, the
    /// weekly average (`weightRead.weekMeanKg`) present only with 3+ weigh-ins in the 7 days up to the newest.
    private func payload(
        goal: String = "weight_loss", trendKg: Double? = 82, weightKg: Double? = 82.3,
        weekMeanKg: Double? = 82.3, lastWeighInDaysAgo: Int? = 0, hasWeightRead: Bool = true
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: goal, current: .init(weightKg: weightKg, startWeightKg: 83.7, trendKg: trendKg), verdict: .onTrack,
            lastWeighInDaysAgo: lastWeighInDaysAgo,
            weightRead: hasWeightRead ? GoalProgressDTO.WeightRead(state: .pace, weekMeanKg: weekMeanKg) : nil
        )
    }

    /// All four labels: "This week" (a weekly average of a weigh-in at most 6 days old), "Weekly avg" (an average of an
    /// older weigh-in), "Latest" (one scale reading: fewer than 3 weigh-ins in the week), "Now" (an older server).
    func testProgressWeightLabelFollowsTheAverageAndTheAgeOfTheWeighIn() {
        func label(_ progress: GoalProgressDTO) -> String? { GoalProgressLogic.progressWeight(progress)?.label }
        // This week: the average, and the newest weigh-in is at most 6 days old.
        XCTAssertEqual(label(payload(lastWeighInDaysAgo: 0)), "This week")
        XCTAssertEqual(label(payload(lastWeighInDaysAgo: 3)), "This week")
        XCTAssertEqual(label(payload(lastWeighInDaysAgo: GoalProgressLogic.thisWeekMaxWeighInAgeDays)), "This week")
        XCTAssertEqual(GoalProgressLogic.thisWeekMaxWeighInAgeDays, 6)
        // Weekly avg: still an average, but of an older week (or of an unknown age: no claim about "this week").
        XCTAssertEqual(label(payload(lastWeighInDaysAgo: 7)), "Weekly avg")
        XCTAssertEqual(label(payload(lastWeighInDaysAgo: 11)), "Weekly avg")
        XCTAssertEqual(label(payload(lastWeighInDaysAgo: nil)), "Weekly avg")
        // Latest: no weekly average, so it is one scale reading, however old.
        XCTAssertEqual(label(payload(weekMeanKg: nil, lastWeighInDaysAgo: 0)), "Latest")
        XCTAssertEqual(label(payload(weekMeanKg: nil, lastWeighInDaysAgo: 10)), "Latest")
        XCTAssertEqual(label(payload(weekMeanKg: nil, lastWeighInDaysAgo: nil)), "Latest")
        // Now: an older server (no trendKg) sends no progress weight at all; the trend stays "Now".
        XCTAssertNil(GoalProgressLogic.progressWeight(payload(trendKg: nil)))
        XCTAssertEqual(GoalProgressLogic.currentWeightLabel(payload(trendKg: nil)), "Now")
        XCTAssertEqual(GoalProgressLogic.currentWeightLabel(payload(trendKg: nil, weekMeanKg: nil)), "Now")
        // ...as do other goals, and a payload with no weight read to say which it is (no claim either way).
        XCTAssertNil(GoalProgressLogic.progressWeight(payload(goal: "muscle")))
        XCTAssertEqual(GoalProgressLogic.currentWeightLabel(payload(goal: "muscle")), "Now")
        XCTAssertEqual(GoalProgressLogic.progressWeight(payload(hasWeightRead: false))?.label, "Now")
        // The weight itself is `current.weightKg`; nothing without one.
        XCTAssertEqual(GoalProgressLogic.progressWeight(payload())?.kg, 82.3)
        XCTAssertNil(GoalProgressLogic.progressWeight(payload(weightKg: nil)))
        XCTAssertNil(GoalProgressLogic.progressWeight(payload(weightKg: 0)))
        XCTAssertNil(GoalProgressLogic.progressWeight(nil))
        // A weekly average that is not a real number is no average.
        XCTAssertEqual(label(payload(weekMeanKg: 0)), "Latest")
        XCTAssertEqual(label(payload(weekMeanKg: Double.nan)), "Latest")
    }

    /// What Today feeds the hero: the same label the goal sheet's stat row uses.
    func testTheGoalSheetRowAndTheHeroCaptionSayTheSameThing() {
        for (progress, expected) in [
            (payload(lastWeighInDaysAgo: 2), "This week"),
            (payload(lastWeighInDaysAgo: 9), "Weekly avg"),
            (payload(weekMeanKg: nil), "Latest"),
            (payload(trendKg: nil), "Now"),
        ] {
            let row = GoalProgressLogic.statRows(progress, system: .metric).first { $0.label == expected }
            XCTAssertEqual(row?.value, "82.3\u{00A0}kg", expected)
            if expected != "Now" {
                let caption = WeightHeroLogic.sparklineCaptions(
                    firstKg: 83.7, lastKg: 82, targetKg: nil, system: .metric,
                    progressWeight: GoalProgressLogic.progressWeight(progress)
                )
                XCTAssertEqual(caption?.now, "\(expected) 82.3\u{00A0}kg")
            }
        }
    }

    // MARK: - Wave 22w: the flat fortnight, the server's pace range, a stale week

    private let fortnightHeadline = "Two flat weeks — common; your plan holds"
    private let onPaceHeadline = "On track for Jan 15 — about 6.3 kg to go"
    /// The plan's one action in a stale week (`lib/weightWeekPlan.ts`): the server's own words, shown on the Trends card.
    private let staleAction = "No weigh-in since May 10 — step on the scale when you can; your plan picks up from there"
    private let rangeDash = "\u{2060}\u{2013}\u{2060}"

    /// A weight-loss payload for a given read; a nil `state` is an older server (no `weightRead` at all).
    private func wave22(
        _ state: GoalProgressDTO.WeightRead.State?, headline: String, rateKg: Double? = nil,
        lastWeighInDaysAgo: Int? = nil, verdict: GoalVerdict = .onTrack, plan: GoalProgressDTO.WeightRead.Plan? = nil,
        paceWindowDays: Int? = 28
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76, date: "2027-01-15"),
            current: .init(weightKg: 82.3, startWeightKg: 83.7, changeKg: -1.4, progressPct: 18, trendKg: 82),
            ratePerWeek: .init(kg: rateKg),
            verdict: verdict,
            headline: headline,
            lastWeighInDaysAgo: lastWeighInDaysAgo,
            weightRead: state.map { GoalProgressDTO.WeightRead(state: $0, weekMeanKg: 82.3, paceWindowDays: paceWindowDays, plan: plan) }
        )
    }

    private func fortnightPlan(flatWeeks: Int?) -> GoalProgressDTO.WeightRead.Plan {
        GoalProgressDTO.WeightRead.Plan(weekStart: "2026-10-19", state: .plateau, flatWeeks: flatWeeks)
    }

    /// An on-pace week's plan: the pace now and, when given, the pace a week earlier.
    private func paceWeek(
        now: Double? = -0.59, earlier: Double? = -0.37, staleSince: String? = nil,
        actionText: String = "Keep your routine — it is working"
    ) -> GoalProgressDTO.WeightRead.Plan {
        GoalProgressDTO.WeightRead.Plan(
            weekStart: "2026-10-19", state: .pace,
            action: .init(kind: "keep_going", text: actionText),
            pace: now.map { GoalProgressDTO.WeightRead.Plan.Pace(kgPerWeek: $0) },
            earlierPace: earlier.map { GoalProgressDTO.WeightRead.Plan.Pace(kgPerWeek: $0) },
            staleSince: staleSince
        )
    }

    /// What `TodayView` feeds the hero for this payload (`TodayViewModel.heroGoalRateKgPerWeek` /
    /// `heroGoalRateRange` / `heroWithholdsRate` / `heroServerWeightRead`).
    private func wiredHeroText(_ goal: GoalProgressDTO, system: UnitSystem = .metric) -> String? {
        let (trend, entries) = hero()
        return WeightHeroLogic.weeklyChangeText(
            trend: trend, entries: entries, system: system,
            goalRateKgPerWeek: goal.ratePerWeek.kg, goalRateWindowDays: goal.weightRead?.paceWindowDays,
            goalRateRange: GoalProgressLogic.paceRange(goal),
            withholdsLocalRate: GoalProgressLogic.withholdsWeeklyRate(goal),
            serverRead: WeightHeroLogic.serverReadSlotText(goal)
        )
    }

    // MARK: Flat fortnight

    /// Two flat weeks after a confirmed loss pace arrive as a plateau of `flatWeeks` 2: the goal line says "Two flat
    /// weeks — common; your plan holds", and the hero's slot must not say three.
    func testFlatFortnightHeroSaysTwoWeeksNotThree() {
        let fortnight = wave22(.plateau, headline: fortnightHeadline, plan: fortnightPlan(flatWeeks: 2))
        XCTAssertTrue(GoalProgressLogic.usesServerWeightRead(fortnight))
        XCTAssertTrue(GoalProgressLogic.goalLineShowsServerRead(fortnight))
        XCTAssertEqual(GoalProgressLogic.compactText(fortnight, system: .metric), fortnightHeadline)
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(fortnight), "Flat for 2 weeks — common")
        XCTAssertEqual(WeightHeroLogic.flatFortnightReadHeroText, "Flat for 2 weeks — common")
        XCTAssertEqual(WeightHeroLogic.plateauSlotText(flatWeeks: 2), WeightHeroLogic.flatFortnightReadHeroText)
        // Units stay glued to their numbers; still no weekly rate of its own, whatever rate the payload carries.
        XCTAssertEqual(wiredHeroText(fortnight), "Flat for 2\u{00A0}weeks — common")
        let withRate = wave22(.plateau, headline: fortnightHeadline, rateKg: -0.4, plan: fortnightPlan(flatWeeks: 2))
        XCTAssertEqual(wiredHeroText(withRate), wiredHeroText(fortnight))
        XCTAssertFalse(wiredHeroText(withRate)?.contains("/wk") ?? true)
    }

    /// A plateau of three flat weeks, a plan with no `flatWeeks` and an older server (no plan at all) keep the text they had.
    func testPlateauHeroKeepsThreeWeeksForThreeNilAndAnOlderServer() {
        for flatWeeks in [3, nil, 0, 1, 4] as [Int?] {
            let plateau = wave22(.plateau, headline: plateauHeadline, plan: fortnightPlan(flatWeeks: flatWeeks))
            XCTAssertEqual(
                WeightHeroLogic.serverReadSlotText(plateau), "Flat for 3 weeks", "flatWeeks \(String(describing: flatWeeks))"
            )
        }
        let older = wave22(.plateau, headline: plateauHeadline)
        XCTAssertNil(older.weightRead?.plan)
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(older), "Flat for 3 weeks")
        XCTAssertEqual(wiredHeroText(older), "Flat for 3\u{00A0}weeks")
        XCTAssertEqual(WeightHeroLogic.plateauSlotText(flatWeeks: 3), WeightHeroLogic.plateauReadHeroText)
        XCTAssertEqual(WeightHeroLogic.plateauSlotText(flatWeeks: nil), WeightHeroLogic.plateauReadHeroText)
        XCTAssertEqual(WeightHeroLogic.plateauReadHeroText, "Flat for 3 weeks")
    }

    /// `flatWeeks` only speaks for a plateau: another state's slot is untouched by it.
    func testFlatWeeksOnlyChangesAPlateausSlot() {
        let early = wave22(.early, headline: earlyHeadline, plan: fortnightPlan(flatWeeks: 2))
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(early), "Pace settles after 3 weeks")
        let moving = wave22(.movingAgain, headline: movingAgainHeadline, plan: fortnightPlan(flatWeeks: 2))
        XCTAssertEqual(WeightHeroLogic.serverReadSlotText(moving), "Moving again after a plateau")
    }

    /// While the goal line shows the stale-weigh-in nudge instead, the hero carries the full read — the fortnight's
    /// headline, not a plateau's — and the read is still said in exactly one place.
    func testFlatFortnightReadIsSaidInExactlyOnePlace() {
        for age in [nil, 0, 3, 4, 6, 7, 9, 14] as [Int?] {
            let goal = wave22(.plateau, headline: fortnightHeadline, lastWeighInDaysAgo: age, plan: fortnightPlan(flatWeeks: 2))
            let goalLine = GoalProgressLogic.compactText(goal, system: .metric)
            let hero = wiredHeroText(goal)
            let sayings = [goalLine == fortnightHeadline, hero == GoalProgressLogic.nonBreaking(fortnightHeadline)]
            XCTAssertEqual(sayings.filter { $0 }.count, 1, "age \(String(describing: age)): goal line \(goalLine) / hero \(String(describing: hero))")
            XCTAssertNotNil(hero, "age \(String(describing: age)): the hero still has a line")
        }
    }

    // MARK: Pace range

    /// "On pace" rests on two paces either side of the target date: the card says "Down 0.4–0.6 kg/wk", so the hero says
    /// that, never "−0.6 kg/wk over 4 weeks" beside it.
    func testHeroSaysTheServersRangeNotASingleRateOnAnOnPaceWeek() {
        let ranged = wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, lastWeighInDaysAgo: 0, plan: paceWeek())
        XCTAssertEqual(wiredHeroText(ranged), "Down 0.4\(rangeDash)0.6\u{00A0}kg/wk")
        XCTAssertEqual(wiredHeroText(ranged, system: .imperial), "Down 0.8\(rangeDash)1.3\u{00A0}lb/wk")
        let text = wiredHeroText(ranged) ?? ""
        XCTAssertFalse(text.contains("over 4 weeks"))
        XCTAssertFalse(text.contains("\u{2212}"), "a range is not a signed single rate")
        // Whichever order the two paces come in.
        let swapped = wave22(.pace, headline: onPaceHeadline, rateKg: -0.37, lastWeighInDaysAgo: 0, plan: paceWeek(now: -0.37, earlier: -0.59))
        XCTAssertEqual(wiredHeroText(swapped), wiredHeroText(ranged))
    }

    /// An older server sends no `earlierPace` (or no plan, or no weightRead): the hero is exactly as it was.
    func testHeroKeepsTheSingleRateWithoutAnEarlierPace() {
        let single = "\u{2212}0.6\u{00A0}kg/wk over 4 weeks"
        XCTAssertEqual(wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, plan: paceWeek(earlier: nil))), single)
        XCTAssertEqual(wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.59)), single, "wave 21: a pace read with no plan")
        XCTAssertEqual(wiredHeroText(wave22(nil, headline: onPaceHeadline, rateKg: -0.59)), single, "older: no weightRead")
        // Neither pace a loss: the server prints no range either.
        XCTAssertEqual(
            wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, plan: paceWeek(earlier: 0.05))), single
        )
        // No goal progress at all: the hero's own 7-day rate.
        XCTAssertEqual(heroText(nil), "\u{2212}0.8\u{00A0}kg/wk this week")
    }

    func testWeeklyChangeTextRangeBeatsTheSingleRateAndYieldsToAServerRead() {
        let (trend, entries) = hero()
        let range = GoalProgressLogic.PaceRange(slowKgPerWeek: 0.37, fastKgPerWeek: 0.59)
        let expected = "Down 0.4\(rangeDash)0.6\u{00A0}kg/wk"
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric, goalRateRange: range), expected)
        XCTAssertEqual(
            WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric, goalRateKgPerWeek: -0.59, goalRateRange: range),
            expected
        )
        // A nil range is the old behaviour, the parameter defaulted.
        XCTAssertEqual(
            WeightHeroLogic.weeklyChangeText(
                trend: trend, entries: entries, system: .metric, goalRateKgPerWeek: -0.59, goalRateWindowDays: 28, goalRateRange: nil
            ),
            "\u{2212}0.6\u{00A0}kg/wk over 4 weeks"
        )
        // The server's own read, and the honesty gate on the trend, both still come first.
        XCTAssertNil(WeightHeroLogic.weeklyChangeText(
            trend: trend, entries: entries, system: .metric, goalRateRange: range, withholdsLocalRate: true
        ))
        XCTAssertEqual(
            WeightHeroLogic.weeklyChangeText(
                trend: trend, entries: entries, system: .metric, goalRateRange: range,
                withholdsLocalRate: true, serverRead: "Flat for 2 weeks — common"
            ),
            "Flat for 2\u{00A0}weeks — common"
        )
        let young = WeightTrendDTO(days: [], delta7dKgPerWeek: nil, delta30dKgPerWeek: nil, established: false)
        XCTAssertNil(WeightHeroLogic.weeklyChangeText(
            trend: young, entries: [entry(daysAgo: 10), entry(daysAgo: 0)], system: .metric, goalRateRange: range
        ))
    }

    // MARK: Stale week

    /// The server keeps the previous plan through a stale week (the newest weigh-in 7+ days old), so its pace is still on the
    /// payload. Today's hero must not print it as this week's: it prints no rate (the goal line under it carries the
    /// "Last weigh-in N days ago" nudge, and the plan's own "No weigh-in since…" action is on the Trends card's reasons).
    func testHeroPrintsNoRateInAStaleWeek() {
        for age in [7, 8, 10, 14, 30] {
            let single = wave22(.pace, headline: onPaceHeadline, rateKg: -0.4, lastWeighInDaysAgo: age, plan: paceWeek(now: -0.4, earlier: nil))
            let ranged = wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, lastWeighInDaysAgo: age, plan: paceWeek())
            let older = wave22(nil, headline: onPaceHeadline, rateKg: -0.4, lastWeighInDaysAgo: age)
            for goal in [single, ranged, older] {
                XCTAssertTrue(GoalProgressLogic.withholdsWeeklyRate(goal), "age \(age)")
                XCTAssertNil(wiredHeroText(goal), "age \(age): no fresh-looking rate")
                XCTAssertEqual(
                    GoalProgressLogic.compactText(goal, system: .metric),
                    "Last weigh-in \(age) days ago — step on the scale to update", "age \(age)"
                )
            }
        }
    }

    /// Under a week old it is still this week's rate — the single rate or the range, as before.
    func testHeroKeepsItsRateWhileTheWeighInIsUnderAWeekOld() {
        for age in [nil, 0, 3, 6] as [Int?] {
            let single = wave22(.pace, headline: onPaceHeadline, rateKg: -0.4, lastWeighInDaysAgo: age, plan: paceWeek(now: -0.4, earlier: nil))
            let ranged = wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, lastWeighInDaysAgo: age, plan: paceWeek())
            XCTAssertFalse(GoalProgressLogic.withholdsWeeklyRate(single), "age \(String(describing: age))")
            XCTAssertEqual(wiredHeroText(single), "\u{2212}0.4\u{00A0}kg/wk over 4 weeks", "age \(String(describing: age))")
            XCTAssertEqual(wiredHeroText(ranged), "Down 0.4\(rangeDash)0.6\u{00A0}kg/wk", "age \(String(describing: age))")
        }
    }

    /// `plan.staleSince` is the server's own word that the week began without a fresh weigh-in: it withholds the rate
    /// even when the payload omits `lastWeighInDaysAgo`, and the stale action's text is the plan's, never the hero's.
    func testAPlanThatSaysStaleWithholdsTheRateWithoutTheDays() {
        let plan = paceWeek(now: -0.4, earlier: nil, staleSince: "2026-05-10", actionText: staleAction)
        let stale = wave22(.pace, headline: onPaceHeadline, rateKg: -0.4, lastWeighInDaysAgo: nil, plan: plan)
        XCTAssertEqual(stale.weightRead?.plan?.staleSince, "2026-05-10")
        XCTAssertEqual(stale.weightRead?.plan?.action?.text, staleAction)
        XCTAssertNil(wiredHeroText(stale))
        // The range goes with it: a stale week prints neither.
        let ranged = wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, plan: paceWeek(staleSince: "2026-05-10", actionText: staleAction))
        XCTAssertNil(wiredHeroText(ranged))
        // A plan that is not stale and a payload with no days are as they were.
        XCTAssertEqual(
            wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.4, plan: paceWeek(now: -0.4, earlier: nil))),
            "\u{2212}0.4\u{00A0}kg/wk over 4 weeks"
        )
    }

    /// A server read keeps saying its read in a stale week (the full read, since the goal line carries the nudge), and a
    /// reached goal is not held to the rule.
    func testStaleWeekLeavesServerReadsAndAReachedGoalAlone() {
        for age in [7, 9, 14] {
            let fortnight = wave22(.plateau, headline: fortnightHeadline, lastWeighInDaysAgo: age, plan: fortnightPlan(flatWeeks: 2))
            XCTAssertEqual(wiredHeroText(fortnight), GoalProgressLogic.nonBreaking(fortnightHeadline), "age \(age)")
            let plateau = wave22(.plateau, headline: plateauHeadline, lastWeighInDaysAgo: age)
            XCTAssertEqual(wiredHeroText(plateau), GoalProgressLogic.nonBreaking(plateauHeadline), "age \(age)")
        }
        let reached = wave22(.reached, headline: "Goal reached — 76 kg", rateKg: -0.3, lastWeighInDaysAgo: 20, verdict: .reached)
        XCTAssertFalse(GoalProgressLogic.withholdsWeeklyRate(reached))
        XCTAssertEqual(wiredHeroText(reached), "\u{2212}0.3\u{00A0}kg/wk over 4 weeks")
    }

    // MARK: Pace window (the hero named "4 weeks" whatever the server fitted)

    func testPaceWindowPhraseNamesTheServersWindowInWholeWeeks() {
        XCTAssertEqual(WeightHeroLogic.paceWindowPhrase(days: 21), "over 3 weeks")
        XCTAssertEqual(WeightHeroLogic.paceWindowPhrase(days: 28), "over 4 weeks")
        XCTAssertEqual(WeightHeroLogic.paceWindowPhrase(days: 7), "over 1 week")
        XCTAssertEqual(WeightHeroLogic.paceWindowPhrase(days: 20), "over 3 weeks", "rounded to the nearest week")
    }

    func testPaceWindowPhraseIsNilWithoutAUsableWindow() {
        XCTAssertNil(WeightHeroLogic.paceWindowPhrase(days: nil))
        XCTAssertNil(WeightHeroLogic.paceWindowPhrase(days: 0))
        XCTAssertNil(WeightHeroLogic.paceWindowPhrase(days: -7))
        XCTAssertNil(WeightHeroLogic.paceWindowPhrase(days: 2), "under half a week names no window")
    }

    func testHeroNamesTheServersPaceWindow() {
        XCTAssertEqual(
            wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, plan: paceWeek(earlier: nil), paceWindowDays: 21)),
            "\u{2212}0.6\u{00A0}kg/wk over 3 weeks"
        )
        XCTAssertEqual(
            wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, plan: paceWeek(earlier: nil), paceWindowDays: 28)),
            "\u{2212}0.6\u{00A0}kg/wk over 4 weeks"
        )
    }

    /// An older server sends no `paceWindowDays`: the rate stands alone, never with a guessed window.
    func testHeroDropsTheWindowPhraseWhenTheServerSendsNone() {
        XCTAssertEqual(
            wiredHeroText(wave22(.pace, headline: onPaceHeadline, rateKg: -0.59, plan: paceWeek(earlier: nil), paceWindowDays: nil)),
            "\u{2212}0.6\u{00A0}kg/wk"
        )
        let (trend, entries) = hero()
        XCTAssertEqual(
            WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric, goalRateKgPerWeek: -0.4),
            "\u{2212}0.4\u{00A0}kg/wk"
        )
    }

    func testFasterThanRecommendedSuffixFollowsTheWindowPhrase() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 60, trendKg: 60)],
            delta7dKgPerWeek: -1.2, delta30dKgPerWeek: -1.2, established: true
        )
        let text = WeightHeroLogic.weeklyChangeText(
            trend: trend, entries: [entry(daysAgo: 10), entry(daysAgo: 0)], system: .metric,
            goalRateKgPerWeek: -1.2, goalRateWindowDays: 21
        )
        XCTAssertEqual(text, "\u{2212}1.2\u{00A0}kg/wk over 3 weeks · faster than recommended")
    }

    func testWeightReadDecodesPaceWindowDaysTolerantly() throws {
        func read(_ json: String) throws -> GoalProgressDTO.WeightRead {
            try JSONDecoder().decode(GoalProgressDTO.WeightRead.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try read(#"{"state":"pace","paceWindowDays":21}"#).paceWindowDays, 21)
        XCTAssertEqual(try read(#"{"state":"pace","paceWindowDays":28.0}"#).paceWindowDays, 28)
        XCTAssertNil(try read(#"{"state":"pace","paceWindowDays":null}"#).paceWindowDays)
        XCTAssertNil(try read(#"{"state":"pace"}"#).paceWindowDays, "older server")
        XCTAssertNil(try read(#"{"state":"pace","paceWindowDays":"soon"}"#).paceWindowDays)
    }
}
