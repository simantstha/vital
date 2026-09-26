import XCTest
@testable import Vital

/// Trends-phase-1 fixture bugfix coverage: the single-metric 7-day fixture
/// responses (`/api/trends?metric=sleep|hrv|rhr`, which feed
/// `WeeklyHeadlineStrip`'s "THIS WEEK" strip) must report the SAME
/// last-7-days values as the batch series (`/api/trends?metrics=...`, which
/// feeds the tile grid and "What moved") for the same underlying metric —
/// and a scenario's designated out-of-normal metric must ramp into its
/// override over the last 6 days rather than spike only on the latest day.
#if DEBUG
final class FixtureTrendsConsistencyTests: XCTestCase {

    private func points(_ method: String, _ path: String, _ query: String, scenario: FixtureMode.Scenario) -> [[String: Any]] {
        let (status, data) = FixtureData.response(scenario: scenario, method: method, path: path, query: query)
        XCTAssertEqual(status, 200)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return json?["points"] as? [[String: Any]] ?? []
    }

    private func batchPoints(metric: String, scenario: FixtureMode.Scenario, days: Int = 7) -> [[String: Any]] {
        let (status, data) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/trends", query: "metrics=\(metric)&days=\(days)")
        XCTAssertEqual(status, 200)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let series = json?["series"] as? [String: Any]
        let entry = series?[metric] as? [String: Any]
        return entry?["points"] as? [[String: Any]] ?? []
    }

    private func lastNValues(_ points: [[String: Any]], _ n: Int) -> [Double] {
        Array(points.suffix(n)).map { ($0["value"] as? Double) ?? .nan }
    }

    // MARK: - Alignment between the single-metric and batch series

    func test_weightLoss_sleepSingleMatchesBatchSleepMinutes() {
        let single = points("GET", "/api/trends", "metric=sleep", scenario: .weightLoss)
        let batch = batchPoints(metric: "sleep_minutes", scenario: .weightLoss)
        XCTAssertEqual(single.count, 7)
        XCTAssertEqual(lastNValues(single, 7), lastNValues(batch, 7))
    }

    func test_weightLoss_hrvSingleMatchesBatchHrvSdnn() {
        let single = points("GET", "/api/trends", "metric=hrv", scenario: .weightLoss)
        let batch = batchPoints(metric: "hrv_sdnn", scenario: .weightLoss)
        XCTAssertEqual(lastNValues(single, 7), lastNValues(batch, 7))
    }

    func test_endurance_rhrSingleMatchesBatchRestingHr() {
        let single = points("GET", "/api/trends", "metric=rhr", scenario: .endurance)
        let batch = batchPoints(metric: "resting_hr", scenario: .endurance)
        XCTAssertEqual(lastNValues(single, 7), lastNValues(batch, 7))
    }

    func test_endurance_hrvSingleMatchesBatchHrvSdnn() {
        let single = points("GET", "/api/trends", "metric=hrv", scenario: .endurance)
        let batch = batchPoints(metric: "hrv_sdnn", scenario: .endurance)
        XCTAssertEqual(lastNValues(single, 7), lastNValues(batch, 7))
    }

    // MARK: - Ramp, not a one-day spike

    /// weight_loss's `resting_hr` is designated to land BELOW normal (good).
    /// The override should ramp in — day 6 (6 days ago) at the flat
    /// baseline, day 0 (today) at the full ~1.8sd depression — rather than
    /// only today's point moving.
    func test_designatedMetric_rampsOverLast6Days_insteadOfOneDaySpike() {
        let batch = batchPoints(metric: "resting_hr", scenario: .weightLoss)
        let values = lastNValues(batch, 7) // oldest (6 days ago) ... today
        XCTAssertEqual(values.count, 7)

        // Oldest day (6 days ago): no override yet, essentially the flat
        // baseline (well within noise of it).
        let restingHRBase = 57.0 // Profile.weightLoss.restingHR
        XCTAssertEqual(values[0], restingHRBase, accuracy: restingHRBase * 0.1)

        // Monotonically non-increasing toward today (pushed BELOW normal) —
        // a ramp, not a flat run followed by one spike.
        for i in 1..<values.count {
            XCTAssertLessThanOrEqual(values[i], values[i - 1] + 0.001, "day \(i) should not move back up mid-ramp")
        }

        // Today lands at ~1.8 sd below the baseline mean.
        let sd = restingHRBase * 0.06
        XCTAssertEqual(values.last!, restingHRBase - 1.8 * sd, accuracy: 0.01)

        // The day before today is meaningfully different from 6-days-ago —
        // i.e. the shift is spread across multiple days, not concentrated
        // entirely on the last one.
        XCTAssertGreaterThan(values[0] - values[5], sd * 0.5)
    }

    /// A non-designated metric (no entry in `movedMetrics` for this
    /// scenario) never gets the ramp/override and stays within its noise
    /// band around the flat baseline.
    func test_nonDesignatedMetric_staysNearBaseline() {
        let batch = batchPoints(metric: "vo2_max", scenario: .weightLoss)
        let values = lastNValues(batch, 7)
        let base = 42.0
        for value in values {
            XCTAssertEqual(value, base, accuracy: base * 0.15)
        }
    }
}
#endif
