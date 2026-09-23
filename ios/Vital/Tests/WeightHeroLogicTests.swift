import XCTest
@testable import Vital

/// Unit tests for the pure decision logic backing the weight_loss hero and
/// the "Next up" row (docs/ux-spec-v4.md §4.1, §5.3; owner decisions
/// 2026-09-23) — see `WeightHeroLogic.swift`.
final class WeightHeroLogicTests: XCTestCase {

    // MARK: - Next up

    private func item(id: String, timeMinutes: Int, status: PlanItem.Status) -> PlanItem {
        PlanItem(
            id: id, timeMinutes: timeMinutes, title: "Item \(id)", subtitle: "",
            sfSymbol: "circle", status: status, source: .coach, kind: .meal
        )
    }

    func testNextUpPicksEarliestNotDoneOrSkipped() {
        let items = [
            item(id: "a", timeMinutes: 600, status: .done),
            item(id: "b", timeMinutes: 900, status: .later),
            item(id: "c", timeMinutes: 750, status: .now),
            item(id: "d", timeMinutes: 700, status: .skipped),
        ]
        XCTAssertEqual(WeightHeroLogic.nextUpItem(from: items)?.id, "c")
    }

    func testNextUpIsNilWhenEverythingIsDoneOrSkipped() {
        let items = [
            item(id: "a", timeMinutes: 600, status: .done),
            item(id: "b", timeMinutes: 900, status: .skipped),
        ]
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: items))
    }

    func testNextUpIsNilForEmptyPlan() {
        XCTAssertNil(WeightHeroLogic.nextUpItem(from: []))
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
            days: [WeightTrendDayDTO(day: "2026-09-20", rawKg: 82, trendKg: 82.1)],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.4, established: false
        )
        XCTAssertEqual(
            WeightHeroLogic.trendHeadline(trend: trend, system: .metric),
            WeightHeroLogic.trendPlaceholderText
        )
        XCTAssertNil(WeightHeroLogic.weeklyChangeText(trend: trend, system: .metric),
                      "Never fabricate a weekly-change number before the trend is established")
    }

    func testTrendHeadlineShowsLatestTrendWeightWhenEstablished() {
        let trend = WeightTrendDTO(
            days: [
                WeightTrendDayDTO(day: "2026-09-19", rawKg: 82.5, trendKg: 82.4),
                WeightTrendDayDTO(day: "2026-09-20", rawKg: 82.0, trendKg: 82.3),
            ],
            delta7dKgPerWeek: -0.4, delta30dKgPerWeek: -0.35, established: true
        )
        XCTAssertEqual(WeightHeroLogic.trendHeadline(trend: trend, system: .metric), "Trend 82.3 kg")
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, system: .metric), "\u{2212}0.4 kg/wk this week")
    }

    func testWeeklyChangeFallsBackTo30dWhen7dMissing() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: "2026-09-20", rawKg: 82, trendKg: 82)],
            delta7dKgPerWeek: nil, delta30dKgPerWeek: -0.2, established: true
        )
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, system: .metric), "\u{2212}0.2 kg/wk this week")
    }

    func testWeeklyChangePositiveRateShowsPlusSign() {
        let trend = WeightTrendDTO(
            days: [WeightTrendDayDTO(day: "2026-09-20", rawKg: 79, trendKg: 79)],
            delta7dKgPerWeek: 0.3, delta30dKgPerWeek: 0.3, established: true
        )
        XCTAssertEqual(WeightHeroLogic.weeklyChangeText(trend: trend, system: .metric), "+0.3 kg/wk this week")
    }

    // MARK: - Weigh-in chip (§5.3)

    func testWeighInChipShowsConfirmWhenHealthKitHasTodayReading() {
        let chip = WeightHeroLogic.weighInChip(lastWeightKg: 83, healthKitTodayKg: 82.4, system: .metric)
        XCTAssertTrue(chip.isOneTapConfirm)
        XCTAssertEqual(chip.confirmValueKg, 82.4)
        XCTAssertEqual(chip.title, "Confirm 82.4 kg")
    }

    func testWeighInChipShowsLastWeightWhenNoHealthKitReading() {
        let chip = WeightHeroLogic.weighInChip(lastWeightKg: 83, healthKitTodayKg: nil, system: .metric)
        XCTAssertFalse(chip.isOneTapConfirm)
        XCTAssertNil(chip.confirmValueKg)
        XCTAssertEqual(chip.title, "Weigh in · 83 kg?")
    }

    func testWeighInChipPlainLabelWithNoPriorWeighIn() {
        let chip = WeightHeroLogic.weighInChip(lastWeightKg: nil, healthKitTodayKg: nil, system: .metric)
        XCTAssertFalse(chip.isOneTapConfirm)
        XCTAssertEqual(chip.title, "Weigh in")
    }

    func testWeighInChipConvertsToImperialDisplay() {
        let chip = WeightHeroLogic.weighInChip(lastWeightKg: nil, healthKitTodayKg: 82, system: .imperial)
        XCTAssertEqual(chip.title, "Confirm 181 lb")
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

    // MARK: - First-run checklist gating (§4.2)

    func testFirstRunChecklistShowsOnlyWhileCalibratingWithNoData() {
        XCTAssertTrue(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: "calibrating", hasAnyBiometric: false))
        XCTAssertFalse(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: "calibrating", hasAnyBiometric: true))
        XCTAssertFalse(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: "ready", hasAnyBiometric: false))
        XCTAssertFalse(WeightHeroLogic.shouldShowFirstRunChecklist(calibrationStatus: nil, hasAnyBiometric: false))
    }

    // MARK: - UnitFormat.weightDelta (unit formatting of the delta)

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
}
