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
        XCTAssertEqual(status.text, "+10 kg vs 4 wk ago")
        XCTAssertEqual(status.tone, .good)
    }

    func testStatusShowsOneDecimalForFractionalMetricGain() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 102.5]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "+2.5 kg vs 4 wk ago")
    }

    func testStatusConvertsGainToPoundsForImperialUsers() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 110]
        // 10 kg = 22.05 lb
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .imperial).text, "+22 lb vs 4 wk ago")
    }

    func testStatusReportsNoChangeAsWatch() {
        let flat: [Double?] = [100, 100, 100, 100, 100, 100, 100, 100]
        let status = TrendsStrengthLogic.status(e1rm: flat, system: .metric)
        XCTAssertEqual(status.text, "No change vs 4 wk ago")
        XCTAssertEqual(status.tone, .watch)
    }

    func testStatusTreatsSubThresholdChangeAsNoChange() {
        let e1rm: [Double?] = [nil, nil, nil, 100, nil, nil, nil, 100.6]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "No change vs 4 wk ago")
    }

    func testStatusReportsDeclineAsWatchWithTypographicMinus() {
        let e1rm: [Double?] = [nil, nil, nil, 110, nil, nil, nil, 100]
        let status = TrendsStrengthLogic.status(e1rm: e1rm, system: .metric)
        XCTAssertEqual(status.text, "\u{2212}10 kg vs 4 wk ago")
        XCTAssertEqual(status.tone, .watch)
    }

    func testStatusUsesTheBestOfTheLastTwoWeeksAndTheBestOfTheBaselineWeeks() {
        // recent = best(104, 103) = 104; baseline = best(100, 98) = 100.
        let e1rm: [Double?] = [nil, nil, 98, 100, nil, nil, 104, 103]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "+4 kg vs 4 wk ago")
    }

    func testStatusIsNewWhenNothingExistsFourWeeksBack() {
        // Two points, but index 4 and 5 are outside the baseline window (3, 2).
        let e1rm: [Double?] = [nil, nil, nil, nil, 100, nil, nil, 110]
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: e1rm, system: .metric).text, "New")
    }

    func testStatusFlagsALiftNotTrainedInTheLastTwoWeeks() {
        let e1rm: [Double?] = [100, 102, nil, nil, nil, 105, nil, nil]
        let status = TrendsStrengthLogic.status(e1rm: e1rm, system: .metric)
        XCTAssertEqual(status.text, "Not logged in 2 wk")
        XCTAssertEqual(status.tone, .watch)
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: [100, 102, nil, nil, nil, nil, nil, nil], system: .metric).text, "Not logged in 6 wk")
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
        XCTAssertEqual(TrendsStrengthLogic.status(e1rm: bench, system: .metric).text, "+5.8 kg vs 4 wk ago")

        let squat = series(["2026-09-07": 140, "2026-10-05": 138.2])
        XCTAssertEqual(
            TrendsStrengthLogic.change(e1rm: squat),
            TrendsStrengthLogic.LiftChange(baselineKg: 140, recentKg: 138.2, changeKg: -1.8)
        )

        // Weeks 09-14 / 09-21 are outside both windows.
        XCTAssertNil(TrendsStrengthLogic.change(e1rm: series(["2026-09-14": 180, "2026-10-05": 190])))
        XCTAssertNil(TrendsStrengthLogic.change(e1rm: series(["2026-09-07": 100])))
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
        XCTAssertEqual(squat.currentText, "108 kg")
        XCTAssertEqual(squat.sparkline.count, 8)
        XCTAssertNil(squat.sparkline[0])
        XCTAssertEqual(squat.sparkline[7], 108)
        XCTAssertEqual(squat.status.text, "+8 kg vs 4 wk ago")
        XCTAssertEqual(squat.changeKg, 8)
        XCTAssertEqual(squat.status.tone, .good)
        XCTAssertEqual(card.lifts[2].status.text, "New") // deadlift: one week of data
    }

    func testCardFormatsCurrentValueInPoundsForImperialUsers() throws {
        let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .imperial, today: today))
        XCTAssertEqual(card.lifts.first?.currentText, "238 lb") // 108 kg
    }

    func testCardVolumeLineComparesThisWeekToLastWeek() throws {
        let summary = WorkoutSummaryResponse(days: 84, exercises: exercises())
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        // This week: squat 3 + bench 3 + deadlift 3 = 9 sets, 1620 + 1000 + 2000 kg.
        XCTAssertEqual(card.volume.thisWeek, "This week: 9 sets · 4.6 t lifted")
        // Last week: squat 3 + bench 3 = 6 sets, 1500 + 900 kg.
        XCTAssertEqual(card.volume.comparison, "vs 6 sets · 2.4 t last week")
    }

    func testCardVolumeLineHandlesAnEmptyCurrentWeek() throws {
        let k = keys
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [stat(k[5], e1rm: 100), stat(k[6], e1rm: 102, volume: 1500)],
        ])
        let card = try XCTUnwrap(TrendsStrengthLogic.card(from: summary, system: .metric, today: today))
        XCTAssertEqual(card.volume.thisWeek, "This week: no sets yet")
        XCTAssertEqual(card.volume.comparison, "vs 3 sets · 1.5 t last week")
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
        XCTAssertEqual(TrendsStrengthLogic.tonnageText(kg: 5200, system: .metric), "5.2 t")
        XCTAssertEqual(TrendsStrengthLogic.tonnageText(kg: 5200, system: .imperial), "11.5k lb")
        XCTAssertEqual(TrendsStrengthLogic.tonnageText(kg: 100, system: .imperial), "220 lb")
    }

    func testMagnitudeText() {
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: 3, system: .metric), "3 kg")
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: 2.5, system: .metric), "2.5 kg")
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: -2.5, system: .metric), "2.5 kg")
        XCTAssertEqual(TrendsStrengthLogic.magnitudeText(kg: 2.5, system: .imperial), "6 lb")
    }

    // MARK: - goal ordering

    func testOnlyTheMuscleGoalLeadsWithStrength() {
        XCTAssertTrue(TrendsGoalOrdering.leadsWithStrength(for: "muscle"))
        XCTAssertFalse(TrendsGoalOrdering.leadsWithStrength(for: "weight_loss"))
        XCTAssertFalse(TrendsGoalOrdering.leadsWithStrength(for: "endurance"))
        XCTAssertFalse(TrendsGoalOrdering.leadsWithStrength(for: "general"))
    }
}
