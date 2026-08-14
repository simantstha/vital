import XCTest
@testable import Vital

final class TrendsIndexSectionsTests: XCTestCase {

    private static let today: Date = {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 8; comps.day = 13; comps.hour = 12
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal.date(from: comps)!
    }()

    private func day(_ offset: Int) -> Date {
        Calendar(identifier: .gregorian).date(byAdding: .day, value: offset, to: Self.today)!
    }

    private func points(_ count: Int, startingValue: Double = 50) -> [ChartPoint] {
        (0..<count).map { i in
            ChartPoint(date: day(-(count - 1) + i), value: startingValue + Double(i))
        }
    }

    private func series(
        key: String,
        points: [ChartPoint] = [],
        baseline: TrendsBaselineDTO? = TrendsBaselineDTO(mean7: 50, mean30: 50, mean60: 50, sd30: 5, p25: 45, p50: 50, p75: 55),
        dataDays: Int = 30,
        established: Bool = true,
        lastDate: Date? = nil
    ) -> MetricSeries {
        MetricSeries(key: key, points: points, baseline: baseline, dataDays: dataDays, established: established, lastDate: lastDate)
    }

    // MARK: - Hidden

    func testKeyAbsentFromLoadedProducesNoTile() {
        // hrv_sdnn present, resting_hr entirely absent from `loaded`.
        let loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(5)),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        let recoveryTiles = sections.first { $0.group == .recovery }?.tiles ?? []
        XCTAssertFalse(recoveryTiles.contains { $0.key == "resting_hr" })
    }

    func testDataDaysZeroProducesNoTileEvenIfPresent() {
        let loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(5), dataDays: 0),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        XCTAssertTrue(sections.allSatisfy { !$0.tiles.contains { $0.key == "hrv_sdnn" } })
    }

    // MARK: - Dimmed

    func testDataDaysPositiveButNoPointsInWindowIsDimmed() {
        let synced = day(-40)
        let loaded: [String: MetricSeries] = [
            "vo2_max": series(key: "vo2_max", points: [], dataDays: 12, lastDate: synced),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        let tile = sections.flatMap(\.tiles).first { $0.key == "vo2_max" }
        XCTAssertEqual(tile?.content, .dimmed(lastDate: synced))
    }

    // MARK: - Sparse (1-2 points)

    func testOnePointIsSparseWithReadingCountOne() {
        let loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(1, startingValue: 48)),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        let tile = sections.flatMap(\.tiles).first { $0.key == "hrv_sdnn" }
        XCTAssertEqual(tile?.content, .sparse(value: 48, readingCount: 1))
    }

    func testTwoPointsIsSparseWithReadingCountTwo() {
        let loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(2, startingValue: 48)),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        let tile = sections.flatMap(\.tiles).first { $0.key == "hrv_sdnn" }
        if case .sparse(_, let count) = tile?.content {
            XCTAssertEqual(count, 2)
        } else {
            XCTFail("expected .sparse, got \(String(describing: tile?.content))")
        }
    }

    // MARK: - Chart (>=3 points), verdict may still be gated

    func testThreeOrMorePointsWithUnestablishedBaselineShowsCalibratingChip() {
        let loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(5), dataDays: 5, established: false),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        let tile = sections.flatMap(\.tiles).first { $0.key == "hrv_sdnn" }
        guard case .chart(_, _, let verdict) = tile?.content else {
            return XCTFail("expected .chart, got \(String(describing: tile?.content))")
        }
        if case .calibrating = verdict {} else {
            XCTFail("expected a calibrating verdict, got \(verdict)")
        }
    }

    func testThreeOrMorePointsWithEstablishedBaselineResolvesANormalVerdict() {
        // latest = 54 (last of points(5, startingValue: 50) → 50,51,52,53,54),
        // mean30 = 50, sd30 = 5 → z = 0.8, within the normal band.
        let loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(5, startingValue: 50), dataDays: 30, established: true),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        let tile = sections.flatMap(\.tiles).first { $0.key == "hrv_sdnn" }
        guard case .chart(let value, let sparkline, let verdict) = tile?.content else {
            return XCTFail("expected .chart, got \(String(describing: tile?.content))")
        }
        XCTAssertEqual(value, 54)
        XCTAssertEqual(sparkline.count, 5)
        XCTAssertEqual(verdict, .normal)
    }

    // MARK: - Section-level hiding

    func testEveryMetricInAGroupHiddenHidesTheWholeSection() {
        // `.body` only ever contains `body_mass_kg` — hide it and the
        // section (header included) must not appear at all.
        let loaded: [String: MetricSeries] = [
            "body_mass_kg": series(key: "body_mass_kg", points: [], dataDays: 0),
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(5)),
        ]
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        XCTAssertFalse(sections.contains { $0.group == .body })
    }

    func testNoWhoopDataHidesTheWhoopSectionEntirely() {
        var loaded: [String: MetricSeries] = [
            "hrv_sdnn": series(key: "hrv_sdnn", points: points(5)),
        ]
        for key in MetricCatalog.keys(in: .whoop) {
            loaded[key] = series(key: key, points: [], dataDays: 0)
        }
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        XCTAssertFalse(sections.contains { $0.group == .whoop })
    }

    // MARK: - Section order

    func testSectionsAppearInFixedGroupOrderWhenAllHaveData() {
        var loaded: [String: MetricSeries] = [:]
        for group in MetricGroup.allCases {
            guard let firstKey = MetricCatalog.keys(in: group).first else { continue }
            loaded[firstKey] = series(key: firstKey, points: points(5))
        }
        let sections = TrendsIndexSections.build(loaded: loaded, today: Self.today)
        XCTAssertEqual(sections.map(\.group), [.recovery, .sleep, .activity, .body, .whoop])
    }
}
