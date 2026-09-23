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
        XCTAssertEqual(WeightHeroLogic.trendHeadline(trend: trend, system: .metric), "Trend 82.3 kg")
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
                        "\u{2212}0.2 kg/wk this week")
    }

    func testWeeklyChangePositiveRateShowsPlusSign() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: day(daysAgo: 0), rawKg: 79, trendKg: 79)],
            delta7dKgPerWeek: 0.3, delta30dKgPerWeek: 0.3, established: true
        )
        let entries = [entry(daysAgo: 10, weight: 79), entry(daysAgo: 0, weight: 79)]
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: .metric),
                        "+0.3 kg/wk this week")
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
            "\u{2212}1.0 kg/wk this week · faster than recommended"
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
            "Logged \u{00b7} trend 82.1 kg (\u{2212}0.4/wk)"
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
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: -0.6, .metric), "\u{2212}0.6 kg/wk")
    }

    func testWeightDeltaImperialConvertsFromKg() {
        // -0.6 kg/wk ≈ -1.3 lb/wk
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: -0.6, .imperial), "\u{2212}1.3 lb/wk")
    }

    func testWeightDeltaZeroHasNoSign() {
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: 0, .metric), "0.0 kg/wk")
    }

    func testWeightDeltaPositiveHasPlusSign() {
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: 0.42, .metric), "+0.4 kg/wk")
    }

    func testWeightDeltaCompactOmitsUnitLetters() {
        XCTAssertEqual(UnitFormat.weightDeltaCompact(kgPerWeek: -0.4, .metric), "\u{2212}0.4/wk")
        XCTAssertEqual(UnitFormat.weightDeltaCompact(kgPerWeek: 0.42, .metric), "+0.4/wk")
    }
}
