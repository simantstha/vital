import XCTest
@testable import Vital

final class TrendsWhatMovedTests: XCTestCase {

    private func chartTile(
        key: String,
        value: Double,
        verdict: Verdict,
        mean30: Double,
        sd30: Double
    ) -> TrendsTile {
        TrendsTile(
            key: key,
            content: .chart(value: value, sparklineValues: [mean30, mean30, value], verdict: verdict),
            baseline: TrendsBaselineDTO(mean7: mean30, mean30: mean30, mean60: mean30, sd30: sd30, p25: nil, p50: nil, p75: nil)
        )
    }

    // MARK: - Selection: only .above/.below with a usable baseline qualify

    func testNormalCalibratingAndNoDataAreNeverIncluded() {
        let sections = [
            TrendsSection(group: .recovery, tiles: [
                chartTile(key: "hrv_sdnn", value: 50, verdict: .normal, mean30: 50, sd30: 5),
                TrendsTile(key: "resting_hr", content: .chart(value: 55, sparklineValues: [55, 55, 55], verdict: .calibrating(daysRemaining: 3))),
                TrendsTile(key: "hr_avg", content: .chart(value: 70, sparklineValues: [70, 70, 70], verdict: .noData)),
            ]),
        ]
        XCTAssertTrue(TrendsWhatMoved.movedRows(sections: sections).isEmpty)
    }

    func testMissingBaselineExcludesAnAboveBelowTileEvenThoughTheVerdictItselfIsSet() {
        // `TrendsVerdict.evaluate` can't actually produce `.above` without a
        // baseline, but `TrendsWhatMoved` must not crash or fabricate a row
        // if it ever sees one anyway — defensive, matches the tile/view's
        // own `guard let baseline` fallbacks.
        let tile = TrendsTile(key: "hrv_sdnn", content: .chart(value: 60, sparklineValues: [50, 55, 60], verdict: .above(z: 2)))
        let sections = [TrendsSection(group: .recovery, tiles: [tile])]
        XCTAssertTrue(TrendsWhatMoved.movedRows(sections: sections).isEmpty)
    }

    func testUnknownMetricKeyIsExcluded() {
        let tile = chartTile(key: "not_a_real_metric", value: 60, verdict: .above(z: 2), mean30: 50, sd30: 5)
        let sections = [TrendsSection(group: .recovery, tiles: [tile])]
        XCTAssertTrue(TrendsWhatMoved.movedRows(sections: sections).isEmpty)
    }

    // MARK: - Good/watch bucketing mirrors TrendDirection.resolve

    func testHigherIsBetterAboveIsGood() {
        // hrv_sdnn is higherIsBetter.
        let tile = chartTile(key: "hrv_sdnn", value: 61, verdict: .above(z: 1.4), mean30: 54, sd30: 5)
        let rows = TrendsWhatMoved.movedRows(sections: [TrendsSection(group: .recovery, tiles: [tile])])
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].isGood)
    }

    func testLowerIsBetterAboveIsWatch() {
        // resting_hr is lowerIsBetter — rising above normal is unfavorable.
        let tile = chartTile(key: "resting_hr", value: 65, verdict: .above(z: 1.4), mean30: 58, sd30: 5)
        let rows = TrendsWhatMoved.movedRows(sections: [TrendsSection(group: .recovery, tiles: [tile])])
        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(rows[0].isGood)
    }

    func testNeutralPolarityIsNeverGood() {
        // body_mass_kg is polarity-neutral — no favorable direction exists.
        let aboveTile = chartTile(key: "body_mass_kg", value: 85, verdict: .above(z: 1.2), mean30: 80, sd30: 4)
        let belowTile = chartTile(key: "body_mass_kg", value: 75, verdict: .below(z: -1.2), mean30: 80, sd30: 4)
        for tile in [aboveTile, belowTile] {
            let rows = TrendsWhatMoved.movedRows(sections: [TrendsSection(group: .body, tiles: [tile])])
            XCTAssertFalse(rows[0].isGood)
        }
    }

    // MARK: - Sort: |z| descending, across sections

    func testRowsSortByAbsoluteZDescendingAcrossSections() {
        let small = chartTile(key: "hrv_sdnn", value: 56, verdict: .above(z: 1.1), mean30: 54, sd30: 2)
        let large = chartTile(key: "resting_hr", value: 70, verdict: .above(z: 3.0), mean30: 58, sd30: 4)
        let sections = [
            TrendsSection(group: .recovery, tiles: [small]),
            TrendsSection(group: .body, tiles: [large]),
        ]
        let rows = TrendsWhatMoved.movedRows(sections: sections)
        XCTAssertEqual(rows.map(\.key), ["resting_hr", "hrv_sdnn"])
    }

    // MARK: - topRows caps at maxRows without changing the sort

    func testTopRowsCapsAtMaxRowsKeepingTheLargestZFirst() {
        let tiles = (0..<6).map { i -> TrendsTile in
            chartTile(key: "metric_\(i)", value: 50 + Double(i), verdict: .above(z: Double(i + 1)), mean30: 50, sd30: 1)
        }
        // Stand in for real catalog keys so `MetricCatalog.spec(for:)` still
        // resolves — reuse real keys instead of synthetic ones.
        let realKeys = ["hrv_sdnn", "resting_hr", "hr_avg", "steps", "vo2_max", "body_mass_kg"]
        let realTiles = zip(realKeys, tiles).map { key, tile -> TrendsTile in
            guard case .chart(let value, let sparkline, let verdict) = tile.content else { fatalError() }
            return TrendsTile(key: key, content: .chart(value: value, sparklineValues: sparkline, verdict: verdict), baseline: tile.baseline)
        }
        let sections = [TrendsSection(group: .recovery, tiles: realTiles)]
        let top = TrendsWhatMoved.topRows(sections: sections)
        XCTAssertEqual(top.count, TrendsWhatMoved.maxRows)
        XCTAssertEqual(top.map(\.key), ["body_mass_kg", "vo2_max", "steps", "hr_avg"])
    }
}
