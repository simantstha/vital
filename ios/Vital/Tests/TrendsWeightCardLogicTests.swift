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
        XCTAssertEqual(pill?.text, "↓\u{00A0}0.6\u{00A0}kg/wk")
        XCTAssertEqual(pill?.tone, .positive)
    }

    func testRatePillIsCautionAndArrowsUpForAGain() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(delta7d: 0.3, days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: sevenDayEntries,
            system: .metric
        )
        XCTAssertEqual(pill?.text, "↑\u{00A0}0.3\u{00A0}kg/wk")
        XCTAssertEqual(pill?.tone, .caution)
    }

    func testRatePillIsNeutralForAFlatWeek() {
        let pill = TrendsWeightCardLogic.ratePill(
            trend: trend(delta7d: 0.0, days: [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]),
            entries: sevenDayEntries,
            system: .metric
        )
        XCTAssertEqual(pill?.text, "→\u{00A0}0.0\u{00A0}kg/wk")
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
        XCTAssertEqual(pill?.text, "↓\u{00A0}1.1\u{00A0}lb/wk")
    }

    // MARK: - sublineText

    func testSublineTextShowsALossWithASignAndTheStartDate() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 85.1, lastValue: 82.0, firstDayLabel: "28 Aug", system: .metric)
        XCTAssertEqual(text, "−3.1\u{00A0}kg since 28 Aug")
    }

    func testSublineTextShowsAGainWithAPlusSign() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 80.0, lastValue: 81.5, firstDayLabel: "1 Sep", system: .metric)
        XCTAssertEqual(text, "+1.5\u{00A0}kg since 1 Sep")
    }

    func testSublineTextNormalizesANearZeroDeltaToAPlainZero() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 80.0, lastValue: 80.0, firstDayLabel: "1 Sep", system: .metric)
        XCTAssertEqual(text, "0.0\u{00A0}kg since 1 Sep")
    }

    func testSublineTextUsesTheImperialUnit() {
        let text = TrendsWeightCardLogic.sublineText(firstValue: 180.0, lastValue: 177.0, firstDayLabel: "28 Aug", system: .imperial)
        XCTAssertEqual(text, "−3.0\u{00A0}lb since 28 Aug")
    }

    // MARK: - non-breaking joins

    /// The pill and the since-line glue every value to its unit (and the pill's
    /// arrow to its value) with U+00A0, so a narrow header wraps between
    /// tokens, never "0.6" / "kg/wk".
    func testNoPlainSpaceBetweenADigitAndAUnit() throws {
        let days = [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]
        for system in [UnitSystem.metric, .imperial] {
            for delta in [-0.6, 0.3, 0.0] {
                let pill = try XCTUnwrap(TrendsWeightCardLogic.ratePill(
                    trend: trend(delta7d: delta, days: days), entries: sevenDayEntries, system: system
                ))
                assertNoBreakableUnitSpace(pill.text)
                XCTAssertFalse(pill.text.contains(" "), "plain space left in \(pill.text.debugDescription)")
            }
            for (first, last) in [(85.1, 82.0), (80.0, 81.5), (80.0, 80.0)] {
                let text = TrendsWeightCardLogic.sublineText(
                    firstValue: first, lastValue: last, firstDayLabel: "28 Aug", system: system
                )
                assertNoBreakableUnitSpace(text)
                XCTAssertTrue(text.contains("\u{00A0}\(system.weightUnit) since 28 Aug"), text)
            }
        }
    }

    // MARK: - chartDate

    func testChartDateParsesValidISODay() {
        let date = TrendsWeightCardLogic.chartDate("2026-09-15")
        XCTAssertNotNil(date)

        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents([.year, .month, .day], from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 9)
        XCTAssertEqual(components.day, 15)
    }

    func testChartDateExtractsFirstTenCharactersFromLongerTimestamp() {
        let date = TrendsWeightCardLogic.chartDate("2026-09-15T10:30:00Z")
        XCTAssertNotNil(date)

        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents([.year, .month, .day], from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 9)
        XCTAssertEqual(components.day, 15)
    }

    func testChartDateReturnsNilForGarbageInput() {
        let date = TrendsWeightCardLogic.chartDate("not-a-date")
        XCTAssertNil(date)
    }

    func testChartDateOrderingLaterDayAfterEarlierDay() {
        let earlierDate = TrendsWeightCardLogic.chartDate("2026-09-01")
        let laterDate = TrendsWeightCardLogic.chartDate("2026-09-15")

        XCTAssertNotNil(earlierDate)
        XCTAssertNotNil(laterDate)
        XCTAssertLessThan(earlierDate!, laterDate!)
    }

    // MARK: - ratePill while the server reads the scale (wave 19)

    func testRatePillIsDroppedWhileTheServerWithholdsAPace() {
        let days = [WeightTrendDayDTO(day: "2026-09-08", rawKg: 82, trendKg: 82)]
        XCTAssertNotNil(TrendsWeightCardLogic.ratePill(trend: trend(days: days), entries: sevenDayEntries, system: .metric))
        XCTAssertNil(TrendsWeightCardLogic.ratePill(
            trend: trend(days: days), entries: sevenDayEntries, system: .metric, withholdsLocalRate: true
        ))
        // Defaulted: an older server (no weightRead) keeps the pill exactly as before.
        XCTAssertEqual(
            TrendsWeightCardLogic.ratePill(trend: trend(days: days), entries: sevenDayEntries, system: .metric, withholdsLocalRate: false),
            TrendsWeightCardLogic.ratePill(trend: trend(days: days), entries: sevenDayEntries, system: .metric)
        )
    }

    // MARK: - The big number on a wave 21 weight-loss goal (the goal's progress weight)

    private let trendDays = [
        WeightTrendDayDTO(day: "2026-09-01", rawKg: 83.5, trendKg: 83.4),
        WeightTrendDayDTO(day: "2026-09-08", rawKg: 82.1, trendKg: 82.0),
    ]

    /// Without a progress weight (an older server, other goals) the big number is the trend's newest point, exactly as before.
    func testHeadlineWeightIsTheTrendWithoutAProgressWeight() {
        let headline = TrendsWeightCardLogic.headlineWeight(trend: trend(days: trendDays), system: .metric)
        XCTAssertEqual(headline, TrendsWeightCardLogic.HeadlineWeight(magnitude: "82", unit: "kg", label: nil))
        XCTAssertEqual(
            TrendsWeightCardLogic.headlineWeight(trend: trend(days: trendDays), progressWeight: nil, system: .imperial),
            TrendsWeightCardLogic.HeadlineWeight(magnitude: "181", unit: "lb", label: nil)
        )
        XCTAssertEqual(TrendsWeightCardLogic.spokenHeadline(trend: trend(days: trendDays), system: .metric), "Trend 82\u{00A0}kg")
    }

    /// With the goal's progress weight the big number is that weight and carries its label; the trend line is not touched.
    func testHeadlineWeightIsTheGoalsProgressWeightWithItsLabel() {
        for label in ["This week", "Weekly avg", "Latest"] {
            let weight = GoalProgressLogic.ProgressWeight(kg: 82.3, label: label)
            XCTAssertEqual(
                TrendsWeightCardLogic.headlineWeight(trend: trend(days: trendDays), progressWeight: weight, system: .metric),
                TrendsWeightCardLogic.HeadlineWeight(magnitude: "82.3", unit: "kg", label: label)
            )
            XCTAssertEqual(
                TrendsWeightCardLogic.spokenHeadline(trend: trend(days: trendDays), progressWeight: weight, system: .metric),
                "\(label) 82.3\u{00A0}kg"
            )
        }
        // Pounds: 82.3 kg = 181 lb.
        XCTAssertEqual(
            TrendsWeightCardLogic.headlineWeight(
                trend: trend(days: trendDays), progressWeight: GoalProgressLogic.ProgressWeight(kg: 82.3, label: "This week"),
                system: .imperial
            ),
            TrendsWeightCardLogic.HeadlineWeight(magnitude: "181", unit: "lb", label: "This week")
        )
        // The rate pill and the subline still come from the trend (the chart), not from the progress weight.
        XCTAssertEqual(
            TrendsWeightCardLogic.ratePill(trend: trend(days: trendDays), entries: sevenDayEntries, system: .metric)?.text,
            "↓\u{00A0}0.6\u{00A0}kg/wk"
        )
    }

    /// The same honesty gate as before: no established trend, no number — a progress weight does not bypass it.
    func testHeadlineWeightStaysHiddenUntilTheTrendIsEstablished() {
        let weight = GoalProgressLogic.ProgressWeight(kg: 82.3, label: "This week")
        XCTAssertNil(TrendsWeightCardLogic.headlineWeight(trend: trend(established: false, days: trendDays), progressWeight: weight, system: .metric))
        XCTAssertNil(TrendsWeightCardLogic.headlineWeight(trend: trend(days: []), progressWeight: weight, system: .metric))
        XCTAssertNil(TrendsWeightCardLogic.headlineWeight(trend: nil, progressWeight: weight, system: .metric))
        // ...and the spoken headline falls back to the trend's own placeholder.
        XCTAssertEqual(
            TrendsWeightCardLogic.spokenHeadline(trend: nil, progressWeight: weight, system: .metric),
            WeightHeroLogic.trendPlaceholderText
        )
    }

    /// End to end from a goal payload: the card's number is the goal's, and an older server's is the trend.
    func testCardNumberFollowsTheGoalPayload() {
        func headline(_ trendKg: Double?) -> TrendsWeightCardLogic.HeadlineWeight? {
            let goal = GoalProgressDTO(
                goal: "weight_loss", current: .init(weightKg: 82.3, startWeightKg: 83.7, trendKg: trendKg), verdict: .onTrack,
                lastWeighInDaysAgo: 0, weightRead: GoalProgressDTO.WeightRead(state: .pace, weekMeanKg: 82.3)
            )
            return TrendsWeightCardLogic.headlineWeight(
                trend: trend(days: trendDays), progressWeight: GoalProgressLogic.progressWeight(goal), system: .metric
            )
        }
        XCTAssertEqual(headline(82), TrendsWeightCardLogic.HeadlineWeight(magnitude: "82.3", unit: "kg", label: "This week"))
        XCTAssertEqual(headline(nil), TrendsWeightCardLogic.HeadlineWeight(magnitude: "82", unit: "kg", label: nil))
    }
}
