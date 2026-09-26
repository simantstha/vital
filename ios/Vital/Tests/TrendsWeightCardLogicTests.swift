import XCTest
@testable import Vital

final class TrendsWeightCardLogicTests: XCTestCase {

    private func trend(established: Bool = true, delta7d: Double? = -0.6, days: [WeightTrendDayDTO]) -> WeightTrendDTO {
        WeightTrendDTO(days: days, delta7dKgPerWeek: delta7d, delta30dKgPerWeek: nil, established: established)
    }

    private func entry(_ date: String, _ weight: Double) -> WeightLogEntryDTO {
        WeightLogEntryDTO(date: date, weight: weight, unit: "kg", source: "manual")
    }

    private let sevenDayEntries: [WeightLogEntryDTO] = [
        WeightLogEntryDTO(date: "2026-09-01", weight: 85, unit: "kg", source: "manual"),
        WeightLogEntryDTO(date: "2026-09-08", weight: 82, unit: "kg", source: "manual"),
    ]

    // MARK: - ratePill

    func testRatePillIsPositiveAndArrowsDownForALoss() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(delta7d: -0.6, days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: sevenDayEntries,
            system: .metric
        )
        XCTAssertEqual(pill?.text, "↓ 0.6 kg/wk")
        XCTAssertEqual(pill?.tone, .positive)
    }

    func testRatePillIsCautionAndArrowsUpForAGain() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(delta7d: 0.3, days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: sevenDayEntries,
            system: .metric
        )
        XCTAssertEqual(pill?.text, "↑ 0.3 kg/wk")
        XCTAssertEqual(pill?.tone, .caution)
    }

    func testRatePillIsNeutralForAFlatWeek() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(delta7d: 0.0, days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: sevenDayEntries,
            system: .metric
        )
        XCTAssertEqual(pill?.text, "→ 0.0 kg/wk")
        XCTAssertEqual(pill?.tone, .neutral)
    }

    func testRatePillIsNilWhenTrendIsNotEstablished() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(established: false, days: []),
            entries: sevenDayEntries,
            system: .metric
        )
        XCTAssertNil(pill)
    }

    func testRatePillIsNilWhenEntriesSpanFewerThanSevenDays() {
        let shortSpanEntries = [entry("2026-09-05", 83), entry("2026-09-08", 82)]
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: shortSpanEntries,
            system: .metric
        )
        XCTAssertNil(pill)
    }

    func testRatePillConvertsToImperial() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(delta7d: -0.5, days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: sevenDayEntries,
            system: .imperial
        )
        // -0.5 kg/wk * 2.2046226218 ≈ -1.1023 lb/wk → rounds to 1.1.
        XCTAssertEqual(pill?.text, "↓ 1.1 lb/wk")
    }

    // MARK: - sublineText

    func testSublineTextShowsALossWithASignAndTheStartDate() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 85.1, lastValue: 82.0, firstDayLabel: "28 Aug", system: .metric)
        XCTAssertEqual(text, "−3.1 kg since 28 Aug")
    }

    func testSublineTextShowsAGainWithAPlusSign() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 80.0, lastValue: 81.5, firstDayLabel: "1 Sep", system: .metric)
        XCTAssertEqual(text, "+1.5 kg since 1 Sep")
    }

    func testSublineTextNormalizesANearZeroDeltaToAPlainZero() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 80.0, lastValue: 80.0, firstDayLabel: "1 Sep", system: .metric)
        XCTAssertEqual(text, "0.0 kg since 1 Sep")
    }

    func testSublineTextUsesTheImperialUnit() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 180.0, lastValue: 177.0, firstDayLabel: "28 Aug", system: .imperial)
        XCTAssertEqual(text, "−3.0 lb since 28 Aug")
    }
}
