import XCTest
@testable import Vital

final class MetricCatalogTests: XCTestCase {

    /// The exact 19-key universe `lib/metricCatalog.ts` defines server-side
    /// (11 HealthKit scalars + `sleep_minutes` + 7 `whoop_*`). `workouts` is
    /// deliberately absent — a streak-only `daily_metrics` row, never
    /// returned by `/api/trends`, with no meaningful σ.
    private static let expectedKeys: Set<String> = [
        "hrv_sdnn", "resting_hr", "hr_avg", "steps", "active_energy_kcal",
        "body_mass_kg", "vo2_max", "distance_m", "exercise_min", "flights",
        "basal_energy_kcal", "sleep_minutes",
        "whoop_day_strain", "whoop_recovery", "whoop_hrv_rmssd",
        "whoop_resting_hr", "whoop_spo2", "whoop_skin_temp", "whoop_sleep_min",
    ]

    // MARK: - Catalog membership

    func testCatalogContainsExactlyTheNineteenKnownMetrics() {
        let keys = Set(MetricCatalog.all.map(\.key))
        XCTAssertEqual(keys, Self.expectedKeys)
        XCTAssertEqual(MetricCatalog.all.count, 19)
    }

    func testWorkoutsIsExcludedEntirely() {
        XCTAssertNil(MetricCatalog.spec(for: "workouts"))
    }

    func testSpecForUnknownKeyReturnsNil() {
        XCTAssertNil(MetricCatalog.spec(for: "not_a_real_metric"))
    }

    func testIndexKeysCoversEveryKnownMetricExactlyOnce() {
        XCTAssertEqual(Set(MetricCatalog.indexKeys), Self.expectedKeys)
        XCTAssertEqual(MetricCatalog.indexKeys.count, MetricCatalog.all.count)
    }

    func testKeysInGroupPartitionAllMetricsWithNoOverlap() {
        let byGroup = MetricGroup.allCases.map { MetricCatalog.keys(in: $0) }
        let flattened = byGroup.flatMap { $0 }
        XCTAssertEqual(Set(flattened), Self.expectedKeys, "every metric must belong to exactly one group")
        XCTAssertEqual(flattened.count, Self.expectedKeys.count, "no metric should appear in more than one group")
    }

    // MARK: - Polarity (the plan's explicitly pinned assignments)

    func testBodyMassKgIsNeutralPolarityNotLowerIsBetter() {
        // Regression guard for the fabricated-judgment failure PR #121
        // already fixed once: the app supports muscle-gain goals, so a
        // weight gain must not paint red.
        XCTAssertEqual(MetricCatalog.spec(for: "body_mass_kg")?.polarity, .neutral)
    }

    func testRestingHrIsLowerIsBetter() {
        XCTAssertEqual(MetricCatalog.spec(for: "resting_hr")?.polarity, .lowerIsBetter)
    }

    func testHigherIsBetterMetricsMatchThePlan() {
        for key in ["hrv_sdnn", "sleep_minutes", "steps", "vo2_max", "whoop_recovery"] {
            XCTAssertEqual(MetricCatalog.spec(for: key)?.polarity, .higherIsBetter, "\(key) should be higherIsBetter")
        }
    }

    func testNeutralMetricsMatchThePlan() {
        for key in ["hr_avg", "flights", "whoop_day_strain", "basal_energy_kcal", "whoop_skin_temp"] {
            XCTAssertEqual(MetricCatalog.spec(for: key)?.polarity, .neutral, "\(key) should be neutral")
        }
    }

    /// The literal regression test for the metric-blind trend chip: rising
    /// resting HR and rising HRV must resolve to visibly different colors,
    /// not the same "up = good" tint.
    func testRisingRestingHrAndRisingHrvResolveToDifferentColors() {
        let restingHrPolarity = MetricCatalog.spec(for: "resting_hr")!.polarity
        let hrvPolarity = MetricCatalog.spec(for: "hrv_sdnn")!.polarity

        let restingHrDirection = TrendDirection.resolve(restingHrPolarity, rising: true)
        let hrvDirection = TrendDirection.resolve(hrvPolarity, rising: true)

        XCTAssertEqual(restingHrDirection, .upBad)
        XCTAssertEqual(hrvDirection, .upGood)
        XCTAssertNotEqual(restingHrDirection.color, hrvDirection.color)
    }

    // MARK: - displayScale

    func testDisplayScaleIsOneForEveryMetricUnderMetricSystem() {
        for spec in MetricCatalog.all {
            XCTAssertEqual(spec.displayScale(.metric), 1.0, "\(spec.key) should never scale under .metric")
        }
    }

    /// The required regression test: only body weight and distance convert
    /// further for an imperial user — every other metric (steps, HRV,
    /// WHOOP strain, …) has no imperial/metric distinction at all.
    func testDisplayScaleUnderImperialDiffersOnlyForBodyMassAndDistance() {
        for spec in MetricCatalog.all {
            let scale = spec.displayScale(.imperial)
            if spec.key == "body_mass_kg" || spec.key == "distance_m" {
                XCTAssertNotEqual(scale, 1.0, "\(spec.key) should scale under .imperial")
            } else {
                XCTAssertEqual(scale, 1.0, "\(spec.key) should NOT scale under .imperial")
            }
        }
    }

    func testDisplayScaleConvertsWeightKgToLb() {
        let spec = MetricCatalog.spec(for: "body_mass_kg")!
        XCTAssertEqual(spec.displayScale(.imperial), UnitConvert.lbPerKg, accuracy: 1e-9)
    }

    func testDisplayScaleConvertsDistanceKmToMi() {
        let spec = MetricCatalog.spec(for: "distance_m")!
        XCTAssertEqual(spec.displayScale(.imperial), 1.0 / UnitConvert.kmPerMile, accuracy: 1e-9)
    }
}
