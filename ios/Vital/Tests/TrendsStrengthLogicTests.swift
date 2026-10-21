import XCTest
@testable import Vital

final class TrendsStrengthLogicTests: XCTestCase {

    // 2026-10-07 is a Wednesday; its (UTC, Monday-start) week begins 2026-10-05.
    private let today = Date(timeIntervalSince1970: 1_791_374_400) // 2026-10-07T12:00:00Z

    private var keys: [String] { TrendsStrengthLogic.weekKeys(endingAt: today, count: 8) }

    private func stat(
        _ week: String,
        e1rm: Double?,
        sets: Int = 3,
        volume: Double = 0
    ) -> WorkoutWeeklyStatDTO {
        WorkoutWeeklyStatDTO(
            weekStart: week,
            bestEstimatedOneRepMaxKg: e1rm,
            volumeKg: volume,
            totalSets: sets,
            totalReps: sets * 5
        )
    }

    // MARK: - Weeks

    func testWeekKeysAreConsecutiveMondaysEndingAtTheCurrentWeek() {
        XCTAssertEqual(keys, [
            "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07",
            "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05",
        ])
    }

    func testWeekStartKeyUsesMondayStartInUTC() {
        // Wednesday, the Sunday that ends the week, and the next Monday.
        XCTAssertEqual(TrendsStrengthLogic.weekStartKey(for: today), "2026-10-05")
        XCTAssertEqual(TrendsStrengthLogic.weekStartKey(for: today.addingTimeInterval(4 * 86_400)), "2026-10-05") // Sun 10-11
        XCTAssertEqual(TrendsStrengthLogic.weekStartKey(for: today.addingTimeInterval(5 * 86_400)), "2026-10-12") // Mon 10-12
    }

    func testWeeklySeriesLaysSparseWeeksOntoTheDenseGrid() {
        let series = TrendsStrengthLogic.weeklySeries(
            [stat("2026-09-07", e1rm: 100), stat("2026-10-05", e1rm: 110)],
            keys: keys
        )
        XCTAssertEqual(series.count, 8)
        XCTAssertEqual(series[3]?.bestEstimatedOneRepMaxKg, 100)
        XCTAssertEqual(series[7]?.bestEstimatedOneRepMaxKg, 110)
        XCTAssertNil(series[0])
        XCTAssertNil(series[5])
    }

    // MARK: - status

    func testStatusIsNewWithFewerThanTwoWeeksOfData() {
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, nil, nil, nil, nil, 100], system: .metric),
            TrendsStrengthLogic.Status(text: "New", tone: .neutral)
        )
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, nil, nil, nil, nil, nil], system: .metric).text,
            "New"
        )
    }

    // Dense 8-week series, last index = current week. Recent = indices 7,6;
    // baseline = indices 3,2 (the two weeks ending 4 weeks before the current one).

    func testStatusReportsGainVsFourWeeksAgoAsGood() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 110]
        let status = TrendsStrengthLogic.status(e1rm: e1rm, system: .metric)
        XCTAssertEqual(status.text, "+10\u{00A0}kg vs 4\u{00A0}wk ago")
        XCTAssertEqual(status.tone, .good)
    }

    /// e1RM is an estimate: whole kg, with the change taken from the rounded
    /// endpoints (100 -> 102.5 shows 100 -> 103, so +3 kg).
    func testStatusShowsWholeKgForFractionalMetricGain() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 102.5]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "+3\u{00A0}kg vs 4\u{00A0}wk ago")
    }

    /// The persona-review case: 99.2 -> 107.9 is +8.7 kg unrounded, which printed
    /// "+8.8 kg (99.2 -> 107.9)". Now 99 -> 108 and +9, and the numbers add up.
    func testDisplayChangeIsComputedFromRoundedEndpoints() {
        let c = TrendsStrengthLogic.LiftChange(baselineKg: 99.2, recentKg: 107.9, changeKg: 8.7)
        XCTAssertEqual(
            TrendsStrengthLogic.displayChange(c, system: .metric),
            TrendsStrengthLogic.DisplayChange(baseline: 99, recent: 108, change: 9)
        )
        // Parity with liftDisplayChange (lib/liftChange.test.ts): 100 -> 105 kg is 220 -> 231 lb.
        XCTAssertEqual(
            TrendsStrengthLogic.displayChange(.init(baselineKg: 100, recentKg: 105, changeKg: 5), system: .imperial),
            TrendsStrengthLogic.DisplayChange(baseline: 220, recent: 231, change: 11)
        )
    }

    func testStatusConvertsGainToPoundsForImperialUsers() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 110]
        // 100 kg = 220 lb, 110 kg = 243 lb (rounded endpoints) -> +23 lb
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .imperial).text, "+23\u{00A0}lb vs 4\u{00A0}wk ago")
    }

    func testStatusReportsNoChangeAsWatch() {
        let flat: [Double?] = [100, 100, 100, 100, 100, 100, 100, 100]
        let status = TrendsStrengthLogic.status(e1rm: flat, system: .metric)
        XCTAssertEqual(status.text, "No change vs 4\u{00A0}wk ago")
        XCTAssertEqual(status.tone, .watch)
    }

    func testStatusTreatsSubThresholdChangeAsNoChange() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 100.6]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "No change vs 4\u{00A0}wk ago")
    }

    func testStatusProgressThresholdIsOnePercentOfBaseline() {
        // 100 -> 101 is exactly +1%: progressing. 100 -> 100.9 is not.
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, 100, nil, nil, nil, 101], system: .metric).text,
            "+1\u{00A0}kg vs 4\u{00A0}wk ago"
        )
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, 100, nil, nil, nil, 100.9], system: .metric).text,
            "No change vs 4\u{00A0}wk ago"
        )
        // The bar scales with the lift: +1 kg on 200 kg is only +0.5% (stall),
        // while +1 kg on 50 kg is +2% (progress) — a fixed 1 kg would call both progress.
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, 200, nil, nil, nil, 201], system: .metric).text,
            "No change vs 4\u{00A0}wk ago"
        )
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, 50, nil, nil, nil, 51], system: .metric).text,
            "+1\u{00A0}kg vs 4\u{00A0}wk ago"
        )
        // Small dips under 1% of baseline are also "no change", not a decline.
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, 200, nil, nil, nil, 199], system: .metric).text,
            "No change vs 4\u{00A0}wk ago"
        )
        XCTAssertEqual(
            TrendsStrengthLogic.status(e1rm: [nil, nil, nil, 200, nil, nil, nil, 198], system: .metric).text,
            "\u{2212}2\u{00A0}kg vs 4\u{00A0}wk ago"
        )
    }

    func testStatusReportsDeclineAsWatchWithTypographicMinus() {
        let e1rm: [Double?] = [nil, nil, nil, 110, nil, nil, nil, 100]
        let status = TrendsStrengthLogic.status(e1rm: e1rm, system: .metric)
        XCTAssertEqual(status.text, "\u{2212}10\u{00A0}kg vs 4\u{00A0}wk ago")
        XCTAssertEqual(status.tone, .watch)
    }

    func testStatusUsesTheBestOfTheLastTwoWeeksAndTheBestOfTheBaselineWeeks() {
        // recent = best(104, 103) = 104; baseline = best(100, 98) = 100.
        let e1rm: [Double?] = [nil, nil, 98, 100, nil, nil, 104, 103]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "+4\u{00A0}kg vs 4\u{00A0}wk ago")
    }

    func testStatusIsNewWhenNothingExistsFourWeeksBack() {
        // Two points, but index 4 and 5 are outside the baseline window (3, 2).
        let e1rm: [Double?] = [nil, nil, nil, nil, 100, nil, nil, 110]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "New")
    }

    func testStatusFlagsALiftNotTrainedInTheLastThreeWeeks() {
        // Newest e1RM 3 weeks back (index 4 of 8): outside the server's 3-week end search.
        let status = TrendsStrengthLogic.status(e1rm: [100, 102, nil, nil, 105, nil, nil, nil], system: .metric)
        XCTAssertEqual(status.text, "Not logged in 3\u{00A0}wk")
        XCTAssertEqual(status.tone, .watch)
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: [100, 102, nil, nil, nil, nil, nil, nil], system: .metric).text, "Not logged in 6\u{00A0}wk")
    }

    func testStatusStillReportsChangeWhenLastLoggedTwoWeeksBack() {
        // Newest e1RM 2 weeks back (index 5): within the end search, so the
        // server reports a change and so does iOS: recent 105 vs baseline 102.
        let e1rm: [Double?] = [100, 102, nil, nil, nil, 105, nil, nil]
        let status = TrendsStrengthLogic.status(e1rm: e1rm, system: .metric)
        XCTAssertEqual(status.text, "+3\u{00A0}kg vs 4\u{00A0}wk ago")
        XCTAssertEqual(status.tone, .good)
    }

    // MARK: - Parity with lib/liftChange.test.ts (same fixture, same numbers)

    /// Anchor Monday 2026-10-05 → dense keys 2026-08-17 … 2026-10-05 (8 weeks),
    /// recent = {10-05, 09-28}, baseline = {09-07, 08-31}.
    func testLiftChangeParityWithTypeScriptFixture() {
        let k = keys
        func series(_ points: [String: Double]) -> [Double?] { k.map { points[$0] } }

        let bench = series(["2026-08-31": 100, "2026-09-07": 102.1, "2026-09-28": 107.9, "2026-10-05": 105])
        XCTAssertEqual(
            TrendsStrengthLogic.change(e1rm: bench),
            TrendsStrengthLogic.LiftChange(baselineKg: 102.1, recentKg: 107.9, changeKg: 5.8)
        )
        // Whole kg from rounded endpoints: 102.1 -> 107.9 shows 102 -> 108 = +6.
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: bench, system: .metric).text, "+6\u{00A0}kg vs 4\u{00A0}wk ago")

        let squat = series(["2026-09-07": 140, "2026-10-05": 138.2])
        XCTAssertEqual(
            TrendsStrengthLogic.change(e1rm: squat),
            TrendsStrengthLogic.LiftChange(baselineKg: 140, recentKg: 138.2, changeKg: -1.8)
        )

        // Weeks 09-14 / 09-21 are outside both windows.
        XCTAssertNil(TrendsStrengthLogic.change(e1rm: series(["2026-09-14": 180, "2026-10-05": 190])))
        XCTAssertNil(TrendsStrengthLogic.change(e1rm: series(["2026-09-07": 100])))
    }

    /// Same fixture as `lib/liftChange.test.ts` "empty current week": the
    /// current week (10-05) has no sets, so `end` = 09-28; recent =
    /// {09-28, 09-21}, baseline = {08-31, 08-24}.
    func testLiftChangeSkipsAnEmptyCurrentWeek() {
        let k = keys
        func series(_ points: [String: Double]) -> [Double?] { k.map { points[$0] } }

        let bench = series(["2026-08-24": 100, "2026-08-31": 101, "2026-09-21": 103, "2026-09-28": 106.4])
        XCTAssertEqual(
            TrendsStrengthLogic.change(e1rm: bench),
            TrendsStrengthLogic.LiftChange(baselineKg: 101, recentKg: 106.4, changeKg: 5.4)
        )
        // 101 -> 106.4 shows 101 -> 106 = +5.
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: bench, system: .metric).text, "+5\u{00A0}kg vs 4\u{00A0}wk ago")

        // The end week is searched only 3 weeks back (10-05, 09-28, 09-21).
        XCTAssertNil(TrendsStrengthLogic.change(e1rm: series(["2026-09-14": 100])))
    }

    // MARK: - card

    private func exercises() -> [String: [WorkoutWeeklyStatDTO]] {
        let k = keys
        return [
            "squat": [
                stat(k[3], e1rm: 100), stat(k[4], e1rm: 102), stat(k[5], e1rm: 104),
                stat(k[6], e1rm: 106, volume: 1500), stat(k[7], e1rm: 108, volume: 1620),
            ],
            "bench press": [
                stat(k[6], e1rm: 80, volume: 900), stat(k[7], e1rm: 82, volume: 1000),
            ],
            "deadlift": [stat(k[7], e1rm: 150, volume: 2000)],
            "overhead press": [stat(k[0], e1rm: 50)],
        ]
    }

    func testCardRanksByRecentFrequencyAndKeepsTheTopThree() throws {
        let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        XCTAssertEqual(card.lifts.map(\.key), ["squat", "bench press", "deadlift"])
        XCTAssertEqual(card.lifts.map(\.name), ["Squat", "Bench Press", "Deadlift"])
    }

    func testCardLiftCarriesUnitFormattedCurrentValueSparklineAndStatus() throws {
        let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        let squat = try XCTUnwrap(card.lifts.first)
        XCTAssertEqual(squat.currentText, "108\u{00A0}kg")
        XCTAssertEqual(squat.sparkline.count, 8)
        XCTAssertNil(squat.sparkline[0])
        XCTAssertEqual(squat.sparkline[7], 108)
        XCTAssertEqual(squat.status.text, "+8\u{00A0}kg vs 4\u{00A0}wk ago")
        XCTAssertEqual(squat.changeKg, 8)
        XCTAssertEqual(squat.status.tone, .good)
        XCTAssertEqual(card.lifts[2].status.text, "New") // deadlift: one week of data
    }

    func testCardFormatsCurrentValueInPoundsForImperialUsers() throws {
        let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .imperial, today: today))
        XCTAssertEqual(card.lifts.first?.currentText, "238\u{00A0}lb") // 108 kg
    }

    func testCardVolumeLineComparesThisWeekToLastWeek() throws {
        let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        // This week: squat 3 + bench 3 + deadlift 3 = 9 sets, 1620 + 1000 + 2000 kg.
        XCTAssertEqual(card.volume.thisWeek, "This week: 9 sets · 4.6\u{00A0}t lifted")
        // Last week: squat 3 + bench 3 = 6 sets, 1500 + 900 kg.
        XCTAssertEqual(card.volume.comparison, "vs 6 sets · 2.4\u{00A0}t last week")
    }

    func testCardVolumeLineHandlesAnEmptyCurrentWeek() throws {
        let k = keys
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [stat(k[5], e1rm: 100), stat(k[6], e1rm: 102, volume: 1500)],
        ])
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        XCTAssertEqual(card.volume.thisWeek, "This week: no sets yet")
        XCTAssertEqual(card.volume.comparison, "vs 3 sets · 1.5\u{00A0}t last week")
    }

    func testCardIsHiddenWhenNothingIsLogged() {
        let empty = WorkoutSummaryResponse(days: 84, exercises: [:])
        XCTAssertNil(TrendsStrengthLogic.card(from: empty, system: .metric, today: today))
        let zeroSets = WorkoutSummaryResponse(days: 84, exercises: ["squat": []])
        XCTAssertNil(TrendsStrengthLogic.card(from: zeroSets, system: .metric, today: today))
    }

    func testBodyweightOnlyHistoryShowsVolumeButNoLiftRows() throws {
        let k = keys
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "pull up": [stat(k[7], e1rm: nil, sets: 1)],
        ])
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        XCTAssertTrue(card.lifts.isEmpty)
        XCTAssertEqual(card.volume.thisWeek, "This week: 1 set")
    }

    // MARK: - tonnage / magnitude formatting

    func testTonnageText() {
        XCTAssertEqual(TrendsStrengthLogic.tonnageText(kg: 5200, system: .metric), "5.2\u{00A0}t")
        XCTAssertEqual(TrendsStrengthLogic.tonnageText(kg: 5200, system: .imperial), "11.5k\u{00A0}lb")
        XCTAssertEqual(TrendsStrengthLogic.tonnageText(kg: 100, system: .imperial), "220\u{00A0}lb")
    }

    func testMagnitudeText() {
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: 3, system: .metric), "3\u{00A0}kg")
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: 2.4, system: .metric), "2\u{00A0}kg")
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: -2.5, system: .metric), "3\u{00A0}kg")
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: 2.5, system: .imperial), "6\u{00A0}lb")
    }

    /// Every number+unit pair the card builds is glued with U+00A0, so a narrow
    /// chip / row wraps BETWEEN tokens ("+8 kg" / "vs 4 wk ago"), never
    /// "+8" / "kg".
    func testNoPlainSpaceBetweenADigitAndAUnit() throws {
        for system in [UnitSystem.metric, .imperial] {
            let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
            let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: system, today: today))
            for lift in card.lifts {
                assertNoBreakableUnitSpace(lift.currentText)
                assertNoBreakableUnitSpace(lift.status.text)
                assertNoBreakableUnitSpace(lift.accessibilityLabel)
            }
            assertNoBreakableUnitSpace(card.volume.thisWeek)
            assertNoBreakableUnitSpace(card.volume.comparison ?? "")
            assertNoBreakableUnitSpace(TrendsStrengthLogic.magnitudeText(kg: 2.5, system: system))
            assertNoBreakableUnitSpace(TrendsStrengthLogic.tonnageText(kg: 5200, system: system))
            assertNoBreakableUnitSpace(TrendsStrengthLogic.tonnageText(kg: 100, system: system))
        }
        // Gain, loss, flat and stale chips.
        let series: [[Double?]] = [
            [nil, nil, nil, 100, nil, nil, nil, 110],
            [nil, nil, nil, 110, nil, nil, nil, 100],
            [100, 100, 100, 100, 100, 100, 100, 100],
            [100, 102, nil, nil, nil, nil, nil, nil],
        ]
        for e1rm in series {
            assertNoBreakableUnitSpace(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text)
            assertNoBreakableUnitSpace(TrendsStrengthLogic.status(e1rm: e1rm, system: .imperial).text)
        }
    }

    // MARK: - goal ordering

    func testOnlyTheMuscleGoalLeadsWithStrength() {
        XCTAssertTrue(TrendsGoalOrdering.leadsWithStrength(for: "muscle"))
        XCTAssertFalse(TrendsGoalOrdering.leadsWithStrength(for: "weight_loss"))
        XCTAssertFalse(TrendsGoalOrdering.leadsWithStrength(for: "endurance"))
        XCTAssertFalse(TrendsGoalOrdering.leadsWithStrength(for: "general"))
    }

    // MARK: - Headline lift (the server's rule, lib/liftChange.ts rankLifts / pickHeadlineLift)

    /// 9 consecutive Mondays ending at the current week: indices 0...7 are the 8
    /// COMPLETED weeks the server ranks over (2026-08-10 ... 2026-09-28), index 8
    /// is the current week (2026-10-05, the server's anchor).
    private var rankKeys: [String] { TrendsStrengthLogic.weekKeys(endingAt: today, count: 9) }

    private func counted(_ week: String, e1rm: Double? = 100, sessions: Int?, sets: Int = 3) -> WorkoutWeeklyStatDTO {
        WorkoutWeeklyStatDTO(
            weekStart: week, bestEstimatedOneRepMaxKg: e1rm, volumeKg: 0,
            totalSets: sets, totalReps: sets * 5, sessions: sessions, topLoadKg: nil
        )
    }

    /// One stat per index of `rankKeys`, each with `sessions` sessions.
    private func trained(_ weeks: [Int], sessions: Int?, e1rm: Double = 100, sets: Int = 3) -> [WorkoutWeeklyStatDTO] {
        weeks.map { counted(rankKeys[$0], e1rm: e1rm, sessions: sessions, sets: sets) }
    }

    private func rank(_ exercises: [String: [WorkoutWeeklyStatDTO]]) -> [String] {
        TrendsStrengthLogic.rankedLiftKeys(in: WorkoutSummaryResponse(days: 84, exercises: exercises), today: today)
    }

    func testRankOrdersByCompletedWeekSessionsNotBySetsOrChange() {
        XCTAssertEqual(rank([
            "squat": trained([1, 2, 3, 4, 5, 6, 7], sessions: 1, sets: 12), // 7 sessions, lots of sets
            "bench press": trained([3, 4, 5, 6, 7], sessions: 2, sets: 2),   // 10 sessions
            "deadlift": trained([7, 8], sessions: 3),                         // 3 completed + 3 this week (not counted)
        ]), ["bench press", "squat", "deadlift"])
    }

    func testRankBreaksTiesByTheFixedMainLiftOrderThenAlphabetically() {
        var exercises: [String: [WorkoutWeeklyStatDTO]] = [:]
        for key in ["row", "overhead press", "pull up", "deadlift", "bench press", "squat", "curl"] {
            exercises[key] = trained([6, 7], sessions: 1)
        }
        XCTAssertEqual(rank(exercises), ["squat", "bench press", "deadlift", "overhead press", "curl", "pull up", "row"])
    }

    /// The week being trained would make the ranking swing day to day, so only the
    /// completed weeks count — until none has completed (a brand-new lifter).
    func testRankIgnoresTheCurrentWeekUnlessNothingHasCompleted() {
        XCTAssertEqual(rank([
            "a lift": trained([5], sessions: 1) + trained([8], sessions: 9),
            "b lift": trained([6, 7], sessions: 1),
        ]), ["b lift", "a lift"])
        XCTAssertEqual(rank([
            "a lift": trained([8], sessions: 1),
            "b lift": trained([8], sessions: 3),
        ]), ["b lift", "a lift"])
    }

    func testRankCountsAWeekWithoutASessionCountAsOneAndDropsLiftsOutOfRotation() {
        XCTAssertEqual(rank([
            "squat": trained([5, 6, 7], sessions: nil),       // no counts: one per trained week = 3
            "bench press": trained([6, 7], sessions: 2),       // 4
            "old lift": trained([0], sessions: 9),             // last e1RM 9 weeks back: out of rotation
        ]), ["bench press", "squat"])
    }

    func testHeadlineLiftIsTheMostTrainedLiftThatHasAFourWeekChange() {
        let k = rankKeys
        // Bench is the most trained (6 completed sessions) but started 3 weeks ago: no
        // baseline 4 weeks back, so no change — the server skips it for squat.
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "bench press": [6, 7, 8].map { counted(k[$0], sessions: 3) },
            "squat": [3, 4, 7, 8].map { counted(k[$0], sessions: 1) },
        ])
        XCTAssertEqual(TrendsStrengthLogic.rankedLiftKeys(in: summary, today: today), ["bench press", "squat"])
        XCTAssertEqual(TrendsStrengthLogic.headlineLift(in: summary, today: today), "squat")

        let single = WorkoutSummaryResponse(days: 84, exercises: ["squat": [counted(k[8], sessions: 1)]])
        XCTAssertNil(TrendsStrengthLogic.headlineLift(in: single, today: today), "no lift has a comparable change")
    }

    func testHeadlineLiftIsNeverPickedByTheBiggestChange() {
        let k = rankKeys
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [3, 4, 5, 6, 7, 8].map { counted(k[$0], e1rm: $0 >= 7 ? 102 : 100, sessions: 1) },  // +2 kg, 5 completed sessions
            "bench press": [3, 4, 7, 8].map { counted(k[$0], e1rm: $0 >= 7 ? 130 : 100, sessions: 1) },   // +30 kg, 3 completed sessions
        ])
        XCTAssertEqual(TrendsStrengthLogic.headlineLift(in: summary, today: today), "squat")
    }

    func testCardFollowsTheServerRuleOnlyWhenTheStatsCarrySessions() throws {
        let k = rankKeys
        // Bench: one heavy-volume session a week (the old recent-sets rule puts it first).
        // Squat: two lighter sessions a week (the server's most-trained-lift rule puts it first).
        func exercises(withSessions: Bool) -> [String: [WorkoutWeeklyStatDTO]] {
            [
                "bench press": [3, 4, 5, 6, 7, 8].map { counted(k[$0], e1rm: 100 + Double($0), sessions: withSessions ? 1 : nil, sets: 9) },
                "squat": [3, 4, 5, 6, 7, 8].map { counted(k[$0], e1rm: 100 + Double($0), sessions: withSessions ? 2 : nil, sets: 4) },
            ]
        }
        let served = try XCTUnwrap(TrendsStrengthLogic.card(
            from: WorkoutSummaryResponse(days: 84, exercises: exercises(withSessions: true)), system: .metric, today: today
        ))
        XCTAssertEqual(served.lifts.map(\.key), ["squat", "bench press"])
        let older = try XCTUnwrap(TrendsStrengthLogic.card(
            from: WorkoutSummaryResponse(days: 84, exercises: exercises(withSessions: false)), system: .metric, today: today
        ))
        XCTAssertEqual(older.lifts.map(\.key), ["bench press", "squat"], "an older server keeps the recent-sets order")
    }

    func testCardLeadsWithTheHeadlineLiftEvenWhenAMoreTrainedLiftHasNoChangeYet() throws {
        let k = rankKeys
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "bench press": [6, 7, 8].map { counted(k[$0], sessions: 3) },
            "squat": [3, 4, 7, 8].map { counted(k[$0], sessions: 1) },
        ])
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        XCTAssertEqual(card.lifts.map(\.key), ["squat", "bench press"])
        XCTAssertEqual(card.lifts.last?.status.text, "New")
    }

    /// Wave 22: the server's headline lift is sticky (another lift takes the lead only by
    /// out-training it by 2+ sessions for 2 weeks running), which the local ranking does not
    /// replay. When the goal card sends its key the Strength card leads with it, whatever the
    /// local rule says; without a usable key the local rule stands.
    func testCardLeadsWithTheServersStickyHeadlineLift() throws {
        let k = rankKeys
        // Bench: 10 completed sessions, squat: 3 - the local rule puts bench first.
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "bench press": [3, 4, 5, 6, 7, 8].map { counted(k[$0], sessions: 2) },
            "squat": [3, 4, 7, 8].map { counted(k[$0], sessions: 1) },
        ])
        XCTAssertEqual(TrendsStrengthLogic.headlineLift(in: summary, today: today), "bench press")
        let local = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        XCTAssertEqual(local.lifts.map(\.key), ["bench press", "squat"])

        let served = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today, headlineLift: "squat"))
        XCTAssertEqual(served.lifts.map(\.key), ["squat", "bench press"])
        // The key is matched the way the server normalises lift keys.
        let spelled = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today, headlineLift: "Squat"))
        XCTAssertEqual(spelled.lifts.map(\.key), ["squat", "bench press"])
        // A key that is not in rotation (or an empty one) falls back to the local rule.
        let unknown = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today, headlineLift: "overhead press"))
        XCTAssertEqual(unknown.lifts.map(\.key), ["bench press", "squat"])
        let empty = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today, headlineLift: ""))
        XCTAssertEqual(empty.lifts.map(\.key), ["bench press", "squat"])
        // The server's lift stays first next to a break return, whichever lift is being rebuilt.
        let rebuilding = try XCTUnwrap(TrendsStrengthLogic.card(
            from: summary, system: .metric, today: today,
            liftReturn: GoalProgressDTO.LiftReturn(
                exercise: "bench press", name: "Bench Press", breakDays: 14, endedOn: "2026-09-20",
                preBreakKg: 100, recentKg: 96, pct: 96, regained: false
            ),
            headlineLift: "squat"
        ))
        XCTAssertEqual(rebuilding.lifts.map(\.key), ["squat", "bench press"])
    }

    // MARK: - Building back after a break (GoalProgressDTO.liftReturn)

    private func liftReturn(
        _ exercise: String = "squat", preBreakKg: Double = 142, pct: Int = 96, regained: Bool = false,
        recentKg: Double? = 136.3
    ) -> GoalProgressDTO.LiftReturn {
        GoalProgressDTO.LiftReturn(
            exercise: exercise, name: exercise.capitalized, breakDays: 14, endedOn: "2026-09-20",
            preBreakKg: preBreakKg, recentKg: recentKg, pct: pct, regained: regained
        )
    }

    func testBuildingBackStatusIsNeutralAndNamesThePreBreakBest() {
        XCTAssertEqual(
            TrendsStrengthLogic.buildingBackStatus(liftReturn: liftReturn(), forLift: "squat", system: .metric),
            TrendsStrengthLogic.Status(text: "Building back — est. 1RM 136 of 142\u{00A0}kg pre-break", tone: .neutral)
        )
        // 142 kg = 313 lb, 136.3 kg = 300 lb.
        XCTAssertEqual(
            TrendsStrengthLogic.buildingBackStatus(liftReturn: liftReturn(), forLift: "squat", system: .imperial)?.text,
            "Building back — est. 1RM 300 of 313\u{00A0}lb pre-break"
        )
        // The key is matched the way the server normalises it.
        XCTAssertNotNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: liftReturn("Bench-Press"), forLift: "bench press", system: .metric))
    }

    func testBuildingBackStatusOnlyForTheRebuildingLiftAndOnlyUntilRegained() {
        XCTAssertNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: liftReturn(), forLift: "bench press", system: .metric))
        XCTAssertNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: liftReturn(regained: true), forLift: "squat", system: .metric))
        XCTAssertNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: nil, forLift: "squat", system: .metric))
    }

    /// The server's headline is "Building back — Squat est. 1RM 136 of 142 kg pre-break"
    /// (`liftReturnOutcome`): the row names the lift itself, so the chip is that same
    /// sentence without the name — never "96% of pre-break", which the server no longer says.
    func testBuildingBackStatusIsTheServersSentenceWithoutTheLiftName() throws {
        let serverHeadline = "Building back — Squat est. 1RM 136 of 142\u{00A0}kg pre-break"
        let status = try XCTUnwrap(
            TrendsStrengthLogic.buildingBackStatus(liftReturn: liftReturn(), forLift: "squat", system: .metric)
        )
        XCTAssertEqual(status.text, serverHeadline.replacingOccurrences(of: "Squat ", with: ""))
        XCTAssertEqual(status.tone, .neutral)
        XCTAssertFalse(status.text.contains("%"))
    }

    /// Each number is rounded to the nearest whole kg (lb) on its own, exactly as the
    /// server prints it (`liftReturnDisplay` in `lib/liftChange.ts`), and the chip never
    /// claims "142 of 142" before the pre-break best is regained.
    func testBuildingBackStatusRoundsTheNumbersLikeTheServer() {
        func text(_ pre: Double, _ recent: Double?, _ system: UnitSystem = .metric) -> String? {
            TrendsStrengthLogic.buildingBackStatus(
                liftReturn: liftReturn(preBreakKg: pre, recentKg: recent), forLift: "squat", system: system
            )?.text
        }
        XCTAssertEqual(text(142.2, 136.4), "Building back — est. 1RM 136 of 142\u{00A0}kg pre-break")
        // Nearest, not down: 141.6 -> 142 and 135.5 -> 136.
        XCTAssertEqual(text(141.6, 135.5), "Building back — est. 1RM 136 of 142\u{00A0}kg pre-break")
        // A recent number that rounds up to the pre-break one is shown one unit under it.
        XCTAssertEqual(text(142.4, 141.6), "Building back — est. 1RM 141 of 142\u{00A0}kg pre-break")
        XCTAssertEqual(text(142, 141.5), "Building back — est. 1RM 141 of 142\u{00A0}kg pre-break")
        // Pounds are converted with the app's one formatter, then rounded: 140 kg = 309 lb, 132.5 kg = 292 lb.
        XCTAssertEqual(text(140, 132.5, .imperial), "Building back — est. 1RM 292 of 309\u{00A0}lb pre-break")
        // The unit is glued to the pre-break number with U+00A0, so a narrow chip never strands it.
        XCTAssertFalse((text(142, 136.3) ?? "").contains(" kg"))
    }

    /// Without `recentKg` (it is optional on the wire) there are no numbers to print, so
    /// the chip keeps the percentage wording it had.
    func testBuildingBackStatusKeepsThePercentageWithoutARecentWeight() {
        func text(_ recent: Double?, _ system: UnitSystem = .metric) -> String? {
            TrendsStrengthLogic.buildingBackStatus(
                liftReturn: liftReturn(recentKg: recent), forLift: "squat", system: system
            )?.text
        }
        XCTAssertEqual(text(nil), "Building back — 96% of pre-break 142\u{00A0}kg")
        XCTAssertEqual(text(nil, .imperial), "Building back — 96% of pre-break 313\u{00A0}lb")
        // A recent weight that is not a real weight is no weight.
        XCTAssertEqual(text(0), "Building back — 96% of pre-break 142\u{00A0}kg")
        XCTAssertEqual(text(-5), "Building back — 96% of pre-break 142\u{00A0}kg")
        XCTAssertEqual(text(Double.nan), "Building back — 96% of pre-break 142\u{00A0}kg")
    }

    func testLiftReturnShownMirrorsTheServersDisplayNumbers() throws {
        let metric = try XCTUnwrap(TrendsStrengthLogic.liftReturnShown(preBreakKg: 142.2, recentKg: 136.4, system: .metric))
        XCTAssertEqual(metric.pre, 142)
        XCTAssertEqual(metric.recent, 136)
        let imperial = try XCTUnwrap(TrendsStrengthLogic.liftReturnShown(preBreakKg: 142, recentKg: 136.3, system: .imperial))
        XCTAssertEqual(imperial.pre, 313)
        XCTAssertEqual(imperial.recent, 300)
        let clamped = try XCTUnwrap(TrendsStrengthLogic.liftReturnShown(preBreakKg: 142, recentKg: 142.2, system: .metric))
        XCTAssertEqual(clamped.recent, 141, "still rebuilding: never equal to, or above, the pre-break number")
        XCTAssertNil(TrendsStrengthLogic.liftReturnShown(preBreakKg: 0, recentKg: 100, system: .metric))
        XCTAssertNil(TrendsStrengthLogic.liftReturnShown(preBreakKg: 142, recentKg: 0, system: .metric))
        XCTAssertNil(TrendsStrengthLogic.liftReturnShown(preBreakKg: .infinity, recentKg: 100, system: .metric))
    }

    /// A lift whose e1RM is 10 kg under four weeks ago would read "−10 kg" (amber) and
    /// count as a header "to watch"; while the server says the user is rebuilding it
    /// after a break, the card is neutral and the header does not count it.
    func testCardShowsBuildingBackInsteadOfADeclineForTheReturningLift() throws {
        let k = keys
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [stat(k[2], e1rm: 110), stat(k[3], e1rm: 110), stat(k[6], e1rm: 100), stat(k[7], e1rm: 100)],
            "bench press": [stat(k[2], e1rm: 80), stat(k[3], e1rm: 80), stat(k[6], e1rm: 90), stat(k[7], e1rm: 90)],
        ])
        func lifts(_ liftReturn: GoalProgressDTO.LiftReturn?) throws -> (squat: TrendsStrengthLogic.Lift, bench: TrendsStrengthLogic.Lift, moves: TrendsHeadline.GoalMoves) {
            let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today, liftReturn: liftReturn))
            let moves = TrendsHeadline.GoalMoves.make(goal: "muscle", weightTrend: nil, strength: card, weightAlreadyCounted: false)
            return (
                try XCTUnwrap(card.lifts.first { $0.key == "squat" }),
                try XCTUnwrap(card.lifts.first { $0.key == "bench press" }),
                moves
            )
        }

        let without = try lifts(nil)
        XCTAssertEqual(without.squat.status.text, "\u{2212}10\u{00A0}kg vs 4\u{00A0}wk ago")
        XCTAssertEqual(without.squat.status.tone, .watch)
        XCTAssertEqual(without.moves.liftsDown, 1)

        let rebuilding = try lifts(liftReturn(preBreakKg: 110, pct: 91, recentKg: 100))
        XCTAssertEqual(rebuilding.squat.status, TrendsStrengthLogic.Status(text: "Building back — est. 1RM 100 of 110\u{00A0}kg pre-break", tone: .neutral))
        XCTAssertNil(rebuilding.squat.changeKg)
        XCTAssertNil(rebuilding.squat.baselineKg)
        XCTAssertEqual(rebuilding.squat.accessibilityLabel, "Squat, estimated one-rep max 100\u{00A0}kg, Building back — est. 1RM 100 of 110\u{00A0}kg pre-break")
        XCTAssertEqual(rebuilding.moves.liftsDown, 0)
        // The other lift is untouched, and so is everything once the pre-break best is regained.
        XCTAssertEqual(rebuilding.bench, without.bench)
        XCTAssertEqual(rebuilding.moves.liftsUp, 1)
        let regained = try lifts(liftReturn(preBreakKg: 110, pct: 100, regained: true))
        XCTAssertEqual(regained.squat, without.squat)
        // A return about a lift not on the card changes nothing.
        XCTAssertEqual(try lifts(liftReturn("deadlift")).squat, without.squat)
    }

    // MARK: - Building back, lift by lift (GoalProgressDTO.liftReturns, wave 21)

    /// The mixed state the server's headline names ("Squat back above pre-break; deadlift at
    /// 98% ..."): the squat is back and is the headline lift (first), the deadlift is still
    /// under its pre-break best.
    private var squatBackDeadliftBehind: [GoalProgressDTO.LiftReturn] {
        [
            liftReturn("squat", preBreakKg: 110, pct: 109, regained: true, recentKg: 120),
            liftReturn("deadlift", preBreakKg: 160, pct: 94, regained: false, recentKg: 150),
        ]
    }

    /// Squat up 10 kg on four weeks ago; deadlift 10 kg under it (the dip a break leaves).
    private var squatUpDeadliftDown: WorkoutSummaryResponse {
        let k = keys
        return WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [stat(k[2], e1rm: 110), stat(k[3], e1rm: 110), stat(k[6], e1rm: 120), stat(k[7], e1rm: 120)],
            "deadlift": [stat(k[2], e1rm: 160), stat(k[3], e1rm: 160), stat(k[6], e1rm: 150), stat(k[7], e1rm: 150)],
        ])
    }

    func testBuildingBackStatusReadsTheEntryForTheLiftFromTheList() {
        let list = squatBackDeadliftBehind
        // Not the headline lift, still under its pre-break best: "Building back".
        XCTAssertEqual(
            TrendsStrengthLogic.buildingBackStatus(liftReturn: list[0], liftReturns: list, forLift: "deadlift", system: .metric),
            TrendsStrengthLogic.Status(text: "Building back — est. 1RM 150 of 160\u{00A0}kg pre-break", tone: .neutral)
        )
        // The lift that is back is not, and neither is a lift with no entry.
        XCTAssertNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: list[0], liftReturns: list, forLift: "squat", system: .metric))
        XCTAssertNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: list[0], liftReturns: list, forLift: "bench press", system: .metric))
        // The key is matched the way the server normalises it, on both sides.
        let hyphenated = [liftReturn("Bench-Press", preBreakKg: 100, pct: 90, recentKg: 90)]
        XCTAssertNotNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: nil, liftReturns: hyphenated, forLift: "bench press", system: .metric))
        XCTAssertNotNil(TrendsStrengthLogic.buildingBackStatus(liftReturn: nil, liftReturns: list, forLift: "Deadlift", system: .metric))
        // Pounds: 160 kg = 353 lb, 150 kg = 331 lb.
        XCTAssertEqual(
            TrendsStrengthLogic.buildingBackStatus(liftReturn: nil, liftReturns: list, forLift: "deadlift", system: .imperial)?.text,
            "Building back — est. 1RM 331 of 353\u{00A0}lb pre-break"
        )
    }

    func testCardShowsBuildingBackForANonHeadlineLiftThatIsStillRebuilding() throws {
        let list = squatBackDeadliftBehind
        let card = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: list[0], liftReturns: list
        ))
        let deadlift = try XCTUnwrap(card.lifts.first { $0.key == "deadlift" })
        XCTAssertEqual(deadlift.status, TrendsStrengthLogic.Status(text: "Building back — est. 1RM 150 of 160\u{00A0}kg pre-break", tone: .neutral))
        XCTAssertNil(deadlift.changeKg)
        XCTAssertNil(deadlift.baselineKg)
        // The lift that is back keeps its ordinary progress chip.
        let squat = try XCTUnwrap(card.lifts.first { $0.key == "squat" })
        XCTAssertEqual(squat.status, TrendsStrengthLogic.Status(text: "+10\u{00A0}kg vs 4\u{00A0}wk ago", tone: .good))
        XCTAssertEqual(squat.changeKg, 10)

        // The header counts the squat as up and does not count the rebuilding deadlift as down.
        let moves = TrendsHeadline.GoalMoves.make(goal: "muscle", weightTrend: nil, strength: card, weightAlreadyCounted: false)
        XCTAssertEqual(moves.liftsUp, 1)
        XCTAssertEqual(moves.liftsDown, 0)

        // With only the headline `liftReturn` (the squat, back) the deadlift's dip would read as a decline.
        let headlineOnly = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: list[0]
        ))
        let declined = try XCTUnwrap(headlineOnly.lifts.first { $0.key == "deadlift" })
        XCTAssertEqual(declined.status, TrendsStrengthLogic.Status(text: "\u{2212}10\u{00A0}kg vs 4\u{00A0}wk ago", tone: .watch))
    }

    func testCardDoesNotShowBuildingBackForALiftThatIsBack() throws {
        // Every lift regained: both read their ordinary chip, the deadlift as the decline it is.
        let list = [
            liftReturn("squat", preBreakKg: 110, pct: 109, regained: true, recentKg: 120),
            liftReturn("deadlift", preBreakKg: 160, pct: 100, regained: true, recentKg: 160),
        ]
        let card = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: list[0], liftReturns: list
        ))
        for lift in card.lifts {
            XCTAssertFalse(lift.status.text.hasPrefix("Building back"), lift.key)
            XCTAssertNotNil(lift.changeKg, lift.key)
        }
        XCTAssertEqual(card.lifts.first { $0.key == "deadlift" }?.status.tone, .watch)
    }

    func testCardFallsBackToTheSingleLiftReturnWithoutTheList() throws {
        let rebuildingSquat = liftReturn("squat", preBreakKg: 130, pct: 92, regained: false, recentKg: 120)
        let fromSingle = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: rebuildingSquat
        ))
        // Explicit nil is the same as leaving it out, and the same as an empty list (which the server never sends).
        let explicitNil = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: rebuildingSquat, liftReturns: nil
        ))
        let emptyList = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: rebuildingSquat, liftReturns: []
        ))
        XCTAssertEqual(fromSingle, explicitNil)
        XCTAssertEqual(fromSingle, emptyList)
        let squat = try XCTUnwrap(fromSingle.lifts.first { $0.key == "squat" })
        XCTAssertEqual(squat.status, TrendsStrengthLogic.Status(text: "Building back — est. 1RM 120 of 130\u{00A0}kg pre-break", tone: .neutral))
        // Only the headline lift is read from the single liftReturn; the deadlift is not.
        let deadlift = try XCTUnwrap(fromSingle.lifts.first { $0.key == "deadlift" })
        XCTAssertEqual(deadlift.status.tone, .watch)
        XCTAssertNotNil(deadlift.changeKg)
        // Neither given: unchanged from before the return existed.
        let none = try XCTUnwrap(TrendsStrengthLogic.card(from: squatUpDeadliftDown, system: .metric, today: today))
        XCTAssertEqual(none.lifts.first { $0.key == "squat" }?.status.text, "+10\u{00A0}kg vs 4\u{00A0}wk ago")
        // The one-entry list says what the single liftReturn does.
        let oneEntry = try XCTUnwrap(TrendsStrengthLogic.card(
            from: squatUpDeadliftDown, system: .metric, today: today, liftReturn: rebuildingSquat, liftReturns: [rebuildingSquat]
        ))
        XCTAssertEqual(oneEntry, fromSingle)
    }

    // MARK: - Weekly stat decoding (sessions / topLoadKg)

    func testWeeklyStatDecodesSessionsAndTopLoadTolerantly() throws {
        func decode(_ extra: String) throws -> WorkoutWeeklyStatDTO {
            let json = "{\"weekStart\":\"2026-10-05\",\"bestEstimatedOneRepMaxKg\":163.3,\"volumeKg\":2100,\"totalSets\":3,\"totalReps\":15\(extra)}"
            return try JSONDecoder().decode(WorkoutWeeklyStatDTO.self, from: Data(json.utf8))
        }
        let full = try decode(",\"sessions\":2,\"topLoadKg\":140")
        XCTAssertEqual(full.sessions, 2)
        XCTAssertEqual(full.topLoadKg, 140)
        XCTAssertEqual(full.weekStart, "2026-10-05")
        XCTAssertEqual(full.bestEstimatedOneRepMaxKg, 163.3)
        XCTAssertEqual(full.totalReps, 15)

        // Older payloads decode exactly as before.
        let older = try decode("")
        XCTAssertNil(older.sessions)
        XCTAssertNil(older.topLoadKg)
        XCTAssertEqual(older, WorkoutWeeklyStatDTO(weekStart: "2026-10-05", bestEstimatedOneRepMaxKg: 163.3, volumeKg: 2100, totalSets: 3, totalReps: 15))
        let nulls = try decode(",\"sessions\":null,\"topLoadKg\":null")
        XCTAssertNil(nulls.sessions)
        XCTAssertNil(nulls.topLoadKg)

        // Wrong-typed or nonsensical additive values drop only themselves.
        let wrong = try decode(",\"sessions\":\"two\",\"topLoadKg\":\"heavy\"")
        XCTAssertNil(wrong.sessions)
        XCTAssertNil(wrong.topLoadKg)
        XCTAssertEqual(wrong.totalSets, 3)
        XCTAssertEqual(try decode(",\"sessions\":2.0").sessions, 2)
        XCTAssertNil(try decode(",\"sessions\":-1").sessions)

        // A bodyweight-only week has no e1RM; the original required fields stay required.
        XCTAssertNil(try JSONDecoder().decode(
            WorkoutWeeklyStatDTO.self,
            from: Data(#"{"weekStart":"2026-10-05","bestEstimatedOneRepMaxKg":null,"volumeKg":0,"totalSets":2,"totalReps":20}"#.utf8)
        ).bestEstimatedOneRepMaxKg)
        XCTAssertThrowsError(try JSONDecoder().decode(
            WorkoutWeeklyStatDTO.self, from: Data(#"{"weekStart":"2026-10-05","sessions":2}"#.utf8)
        ))
    }

    func testSummaryResponseCarriesSessionCountsPerWeek() throws {
        let json = #"{"days":84,"exercises":{"squat":[{"weekStart":"2026-10-05","bestEstimatedOneRepMaxKg":163.3,"volumeKg":2100,"totalSets":3,"totalReps":15,"sessions":2,"topLoadKg":140}]}}"#
        let summary = try JSONDecoder().decode(WorkoutSummaryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(summary.exercises["squat"]?.first?.sessions, 2)
        XCTAssertTrue(TrendsStrengthLogic.carriesSessionCounts(summary))
        XCTAssertFalse(TrendsStrengthLogic.carriesSessionCounts(WorkoutSummaryResponse(days: 84, exercises: exercises())))
    }
}
