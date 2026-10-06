import XCTest
@testable import Vital

/// The screenshot fixtures used to contradict themselves (one scenario showed
/// three different "last night" sleep durations and an HRV receipt that
/// disagreed with the HRV detail). Each scenario now has ONE value per metric
/// (`Profile` in FixtureData) — these tests pin that every screen reads it.
#if DEBUG
final class FixtureCrossScreenConsistencyTests: XCTestCase {

    private let scenarios: [FixtureMode.Scenario] = [.weightLoss, .muscle, .endurance]

    private func json(_ scenario: FixtureMode.Scenario, _ path: String, _ query: String = "") -> [String: Any] {
        let (status, data) = FixtureData.response(scenario: scenario, method: "GET", path: path, query: query)
        XCTAssertEqual(status, 200, "\(path) [\(scenario)]")
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func todayMetric(_ scenario: FixtureMode.Scenario, _ key: String) -> Double {
        let metrics = json(scenario, "/api/today")["metrics"] as? [String: Any]
        let metric = metrics?[key] as? [String: Any]
        return (metric?["value"] as? Double) ?? .nan
    }

    private func latestBatchPoint(_ scenario: FixtureMode.Scenario, _ key: String) -> Double {
        let series = (json(scenario, "/api/trends", "metrics=\(key)&days=30")["series"] as? [String: Any])?[key] as? [String: Any]
        let points = series?["points"] as? [[String: Any]]
        return (points?.last?["value"] as? Double) ?? .nan
    }

    func test_expectedPerScenarioSleep() {
        XCTAssertEqual(todayMetric(.weightLoss, "sleep") * 60, 410, accuracy: 0.01)
        XCTAssertEqual(todayMetric(.muscle, "sleep") * 60, 460, accuracy: 0.01)
        XCTAssertEqual(todayMetric(.endurance, "sleep") * 60, 348, accuracy: 0.01)
    }

    func test_sleepIsOneValueAcrossTodayTrendsLogsAndAnalysis() {
        for scenario in scenarios {
            let todayMinutes = todayMetric(scenario, "sleep") * 60

            // Trends' latest point.
            XCTAssertEqual(latestBatchPoint(scenario, "sleep_minutes") * 60, todayMinutes, accuracy: 0.01, "\(scenario) trends")

            // Logs sleep row.
            let items = json(scenario, "/api/logs")["items"] as? [[String: Any]] ?? []
            let sleepRow = items.first { ($0["type"] as? String) == "sleep_session" }
            XCTAssertEqual(((sleepRow?["sleepMs"] as? Double) ?? .nan) / 60_000, todayMinutes, accuracy: 0.01, "\(scenario) logs")
            let total = Int(todayMinutes.rounded())
            XCTAssertEqual(sleepRow?["subtitle"] as? String, "\(total / 60)h \(total % 60)m last night", "\(scenario) logs subtitle")

            // Sleep analysis.
            let analysis = json(scenario, "/api/sleep-analyses/fixture-sleep-analysis")
            let minutes = (analysis["metrics"] as? [String: Any])?["minutes"] as? Double
            XCTAssertEqual(minutes ?? .nan, todayMinutes, accuracy: 0.01, "\(scenario) sleep analysis")
            let week = (analysis["context"] as? [String: Any])?["week"] as? [[String: Any]]
            XCTAssertEqual((week?.last?["minutes"] as? Double) ?? .nan, todayMinutes, accuracy: 0.01, "\(scenario) week strip")
        }
    }

    func test_routineWorkoutAnalysisGoingInSleepMatchesLastNight() {
        for scenario in [FixtureMode.Scenario.weightLoss, .muscle] {
            let analysis = json(scenario, "/api/workout-analyses/fixture-workout-analysis-routine")
            let goingIn = (analysis["context"] as? [String: Any])?["goingIn"] as? [String: Any]
            XCTAssertEqual((goingIn?["sleepMinutes"] as? Double) ?? .nan, todayMetric(scenario, "sleep") * 60, accuracy: 0.01)
        }
    }

    func test_hrvIsOneValueAndCoachReceiptMatchesDetailRange() {
        for scenario in scenarios {
            let hrv = todayMetric(scenario, "hrv")
            XCTAssertEqual(latestBatchPoint(scenario, "hrv_sdnn"), hrv, accuracy: 0.01, "\(scenario) trends latest")

            // HRV detail's "Normal (range)" = mean30 ± sd30, 0 decimals.
            let series = (json(scenario, "/api/trends", "metrics=hrv_sdnn&days=30")["series"] as? [String: Any])?["hrv_sdnn"] as? [String: Any]
            let baseline = series?["baseline"] as? [String: Any]
            let mean = (baseline?["mean30"] as? Double) ?? .nan
            let sd = (baseline?["sd30"] as? Double) ?? .nan
            let expected = "\(Int(hrv.rounded())) ms today · normal \(String(format: "%.0f", mean - sd))–\(String(format: "%.0f", mean + sd)) ms"

            let messages = json(scenario, "/api/coach")["messages"] as? [[String: Any]] ?? []
            let summaries = messages
                .compactMap { $0["activity"] as? [[String: Any]] }
                .flatMap { $0 }
                .filter { ($0["name"] as? String) == "get_baseline" }
                .compactMap { $0["summary"] as? String }
            XCTAssertEqual(summaries, [expected], "\(scenario) coach receipt")
        }
    }

    func test_enduranceLateRunMatchesSleepAnalysis() {
        let items = json(.endurance, "/api/logs")["items"] as? [[String: Any]] ?? []
        let run = items.first { ($0["type"] as? String) == "workout_completed" }
        let workout = json(.endurance, "/api/workout-analyses/fixture-workout-analysis")
        let startTime = ((workout["metrics"] as? [String: Any])?["startTime"] as? String) ?? ""
        XCTAssertEqual(run?["timestamp"] as? String, startTime, "Logs run row and workout analysis share a start")

        let sleep = json(.endurance, "/api/sleep-analyses/fixture-sleep-analysis")
        let endedAt = (((sleep["context"] as? [String: Any])?["beforeBed"] as? [String: Any])?["lastWorkoutEndedAt"] as? String) ?? ""
        let formatter = ISO8601DateFormatter()
        guard let start = formatter.date(from: startTime), let ended = formatter.date(from: endedAt) else {
            return XCTFail("unparseable run times \(startTime) / \(endedAt)")
        }
        let durationMin = ((workout["metrics"] as? [String: Any])?["durationMin"] as? Double) ?? 0
        XCTAssertEqual(start.addingTimeInterval(durationMin * 60).timeIntervalSince(ended), 0, accuracy: 120,
                       "the run ends when the sleep analysis says it did (9:40 PM)")
    }

    func test_goalProgressFixturesDecode() throws {
        let expectations: [(FixtureMode.Scenario, GoalVerdict)] = [
            (.weightLoss, .onTrack), (.muscle, .progressing), (.endurance, .building), (.newUser, .needsTarget),
        ]
        for (scenario, verdict) in expectations {
            let (status, data) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/goal/progress", query: "tz=UTC")
            XCTAssertEqual(status, 200)
            let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: data)
            XCTAssertEqual(progress.verdict, verdict, "\(scenario)")
        }
        let (status, _) = FixtureData.response(scenario: .serverError, method: "GET", path: "/api/goal/progress", query: "")
        XCTAssertEqual(status, 500)
    }

    func test_weightLossGoalProgressAgreesWithWeightFixture() throws {
        let (_, data) = FixtureData.response(scenario: .weightLoss, method: "GET", path: "/api/goal/progress", query: "")
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: data)
        XCTAssertEqual(progress.current.weightKg ?? .nan, 82, accuracy: 0.001)
        XCTAssertEqual(progress.target.weightKg, 76)
        XCTAssertEqual(progress.reasons.count, 3)
        XCTAssertNotNil(progress.eta)
    }
}
#endif
