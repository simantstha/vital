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

    /// Driver tercile means must be averages of readings the records card
    /// also shows: never above the 90-day series max or below its min.
    func test_hrvDriverMeansStayInsideTheRecordsRange() {
        for scenario in scenarios {
            let series = (json(scenario, "/api/trends", "metrics=hrv_sdnn&days=90")["series"] as? [String: Any])?["hrv_sdnn"] as? [String: Any]
            let values = ((series?["points"] as? [[String: Any]]) ?? []).compactMap { $0["value"] as? Double }
            XCTAssertFalse(values.isEmpty, "\(scenario) hrv series")
            guard let lo = values.min(), let hi = values.max() else { continue }
            let drivers = json(scenario, "/api/trends/drivers", "metric=hrv_sdnn")["drivers"] as? [[String: Any]] ?? []
            XCTAssertFalse(drivers.isEmpty, "\(scenario) drivers")
            for driver in drivers {
                for side in ["high", "low"] {
                    let mean = ((driver[side] as? [String: Any])?["mean"] as? Double) ?? .nan
                    XCTAssertLessThanOrEqual(mean, hi, "\(scenario) \(driver["input"] ?? "") \(side) above series max")
                    XCTAssertGreaterThanOrEqual(mean, lo, "\(scenario) \(driver["input"] ?? "") \(side) below series min")
                }
            }
        }
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

    // MARK: - Endurance RHR / HRV / sleep agreement

    private func statValue(_ review: [String: Any], _ label: String) -> [String: Any]? {
        let stats = (review["review"] as? [String: Any])?["stats"] as? [[String: Any]]
        return stats?.first { ($0["label"] as? String) == label }
    }

    func test_enduranceRestingHRAgreesAcrossTodayTrendsAndWeeklyReview() {
        let rhr = todayMetric(.endurance, "restingHr")
        XCTAssertEqual(rhr, 54, accuracy: 0.01)
        XCTAssertEqual(latestBatchPoint(.endurance, "resting_hr"), rhr, accuracy: 0.01)

        let review = json(.endurance, "/api/review/weekly")
        let stat = statValue(review, "Resting HR")
        XCTAssertEqual(stat?["value"] as? String, "54 bpm")
        // Weekly review quotes the same gap-to-normal Trends shows (54 vs normal).
        let series = (json(.endurance, "/api/trends", "metrics=resting_hr&days=30")["series"] as? [String: Any])?["resting_hr"] as? [String: Any]
        let mean = ((series?["baseline"] as? [String: Any])?["mean30"] as? Double) ?? .nan
        let gap = Int((rhr - mean).rounded())
        XCTAssertGreaterThan(gap, 0, "RHR is above normal, never a green improvement")
        XCTAssertEqual(stat?["comparison"] as? String, "+\(gap) bpm vs your normal")
        XCTAssertEqual(stat?["tone"] as? String, "watch")
    }

    /// ONE HRV normal for endurance: 57 ms (band 54-60), today 51 -> -11% on
    /// Today, "6 ms below your normal (57 ms)" on the detail, and the detail's
    /// "Avg 30d" (the mean of the served points) is that same 57.
    func test_enduranceHRVNormalIsOneNumberAcrossTodayTrendsAndDetail() throws {
        let hrv = todayMetric(.endurance, "hrv")
        XCTAssertEqual(hrv, 51, accuracy: 0.01)
        XCTAssertEqual(latestBatchPoint(.endurance, "hrv_sdnn"), hrv, accuracy: 0.01)

        let todayMetrics = json(.endurance, "/api/today")["metrics"] as? [String: Any]
        let delta = (todayMetrics?["hrv"] as? [String: Any])?["deltaPct"] as? Int
        XCTAssertEqual(delta, -11, "Today tile: 51 vs 57 = -10.5% -> -11% vs normal")

        let series = (json(.endurance, "/api/trends", "metrics=hrv_sdnn&days=30")["series"] as? [String: Any])?["hrv_sdnn"] as? [String: Any]
        let baseline = series?["baseline"] as? [String: Any]
        let mean = (baseline?["mean30"] as? Double) ?? .nan
        let sd = (baseline?["sd30"] as? Double) ?? .nan
        XCTAssertEqual(mean, 57, accuracy: 0.0001)
        XCTAssertEqual(String(format: "%.0f\u{2013}%.0f", mean - sd, mean + sd), "54\u{2013}60")

        let values = (series?["points"] as? [[String: Any]] ?? []).compactMap { $0["value"] as? Double }
        XCTAssertEqual(values.count, 30)
        XCTAssertEqual(values.reduce(0, +) / Double(values.count), 57, accuracy: 0.0001, "detail Avg 30d is computed from the points")

        let spec = MetricCatalog.spec(for: "hrv_sdnn")!
        XCTAssertEqual(
            TrendsDeltaFormat.normalPillText(value: hrv, lower: mean - sd, upper: mean + sd, spec: spec, system: .metric),
            "\u{2193} 6 ms below your normal (57 ms)"
        )
    }

    /// The muscle goal-progress payload mirrors the current server copy:
    /// whole-kg lift reasons from rounded endpoints, Squat as the headline
    /// lift, and 9/16 = 56% adherence (< 70%) making the verdict `behind`.
    func test_muscleGoalProgressMirrorsServerCopy() throws {
        let (_, data) = FixtureData.response(scenario: .muscle, method: "GET", path: "/api/goal/progress", query: "")
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: data)
        XCTAssertEqual(progress.verdict, .behind)
        XCTAssertEqual(progress.headline, "Lifts up, sessions behind \u{2014} Squat +20 kg")
        let lifts = progress.reasons.filter { $0.kind == "lift" }.map(\.text)
        XCTAssertEqual(lifts, [
            "Squat est. 1RM +20 kg vs 4 weeks ago (143 \u{2192} 163 kg)",
            "Bench Press est. 1RM +9 kg vs 4 weeks ago (99 \u{2192} 108 kg)",
        ])
        XCTAssertEqual(GoalProgressLogic.label(for: progress.verdict, goal: progress.goal), "Sessions behind")
        let opener = json(.muscle, "/api/coach/opener")["text"] as? String ?? ""
        XCTAssertTrue(opener.contains("Lifts up, sessions behind \u{2014} Squat +20 kg"), opener)

        let review = json(.muscle, "/api/review/weekly")["review"] as? [String: Any]
        XCTAssertEqual(review?["headline"] as? String, "3 of 4 sessions, Squat est. 1RM +20 kg over 4 wks")
    }

    func test_enduranceSleepAgreesAcrossTrendsWeeklyReviewAndCoach() {
        let points = ((json(.endurance, "/api/trends", "metrics=sleep_minutes&days=7")["series"] as? [String: Any])?["sleep_minutes"] as? [String: Any])?["points"] as? [[String: Any]] ?? []
        let week = points.suffix(7).compactMap { ($0["value"] as? Double).map { $0 * 60 } }
        XCTAssertEqual(week.count, 7)
        let avg = Int((week.reduce(0, +) / 7).rounded())
        let under6 = week.filter { $0 < 360 }.count
        let avgText = "\(avg / 60)h \(avg % 60)m"

        let review = json(.endurance, "/api/review/weekly")
        let stat = statValue(review, "Avg sleep")
        XCTAssertEqual(stat?["value"] as? String, avgText)
        XCTAssertEqual(stat?["comparison"] as? String, "week avg · goal 8h 0m")

        let messages = json(.endurance, "/api/coach")["messages"] as? [[String: Any]] ?? []
        let answer = messages.compactMap { $0["content"] as? String }.first { $0.hasPrefix("Mostly sleep") } ?? ""
        XCTAssertTrue(answer.contains("averaged \(avgText) this week"), answer)
        XCTAssertTrue(answer.contains("\(under6) of the last 7 nights under 6 hours"), answer)
    }

    func test_coachOpenerIsScenarioAppropriate() {
        var openers: Set<String> = []
        for scenario in scenarios + [.newUser] {
            let text = json(scenario, "/api/coach/opener")["text"] as? String ?? ""
            XCTAssertFalse(text.isEmpty, "\(scenario)")
            openers.insert(text)
        }
        XCTAssertEqual(openers.count, 4, "each persona gets its own opener")
        let endurance = json(.endurance, "/api/coach/opener")["text"] as? String ?? ""
        XCTAssertFalse(endurance.contains("Nice work staying consistent"))
    }

    func test_coachOpenersLeadWithTheGoalStatus() {
        let weightLoss = json(.weightLoss, "/api/coach/opener")["text"] as? String ?? ""
        XCTAssertTrue(weightLoss.hasPrefix("You're 1.7 of 7.7 kg down and about 2 weeks ahead of your "), weightLoss)
        XCTAssertTrue(weightLoss.hasSuffix("What would you like to dig into?"), weightLoss)
        let newUser = json(.newUser, "/api/coach/opener")["text"] as? String ?? ""
        XCTAssertTrue(newUser.hasPrefix("Your goal is to lose weight."), newUser)
    }

    func test_weightLossTirednessAnswerAcknowledgesTheNightFeedsItCited() {
        let restore = json(.weightLoss, "/api/coach")
        let messages = restore["messages"] as? [[String: Any]] ?? []
        let answer = messages.compactMap { $0["content"] as? String }.first { $0.hasPrefix("Mostly short sleep") } ?? ""
        XCTAssertTrue(answer.contains("two night feeds"), answer)
        XCTAssertFalse(answer.contains("earlier night should settle it"), answer)
    }

    // MARK: - New user calibration counters

    func test_newUserCalibrationCountersShareOneDayCount() {
        let today = json(.newUser, "/api/today")
        let calMetrics = (today["calibration"] as? [String: Any])?["metrics"] as? [String: [String: Any]] ?? [:]
        let todayDays = ["hrv_sdnn", "resting_hr", "sleep_minutes"].compactMap { calMetrics[$0]?["dataDays"] as? Int }
        XCTAssertEqual(todayDays.count, 3)

        let batch = json(.newUser, "/api/trends", "metrics=sleep_minutes&days=30")
        let series = (batch["series"] as? [String: Any])?["sleep_minutes"] as? [String: Any]
        let trendsDays = series?["dataDays"] as? Int
        XCTAssertEqual(Set(todayDays), [trendsDays ?? -1], "Today card and Trends ring read the same day count")
        XCTAssertEqual((series?["points"] as? [[String: Any]])?.count, 0, "new_user has no Apple Health, so no sleep bars")
        XCTAssertEqual(json(.newUser, "/api/streak")["streakDays"] as? Int, 0, "nothing logged -> no streak chip")
    }

    // MARK: - Run analysis pace rank

    func test_paceRankAndStripShareSortDirection() {
        let previous = [5.60, 5.95, 5.70, 6.05, 5.80, 5.90, 5.65]
        // 5.85: four earlier runs were faster -> 5th fastest of 8.
        XCTAssertEqual(AnalysisLogic.paceRank(previous: previous, current: 5.85), 5)
        XCTAssertEqual(AnalysisLogic.paceRank(previous: previous, current: 5.0), 1)
        XCTAssertEqual(AnalysisLogic.paceRank(previous: previous, current: 7.0), 8)
        XCTAssertEqual(AnalysisLogic.paceRank(previous: [5.5, 5.5, 5.5], current: 5.5), 1, "ties share the better rank")

        // Rank 1 (fastest) is the right-most dot; rank = total is the left-most.
        let all = previous + [5.85]
        let lo = all.min()!, hi = all.max()!
        let fastest = AnalysisLogic.paceStripFraction(pace: lo, minPace: lo, maxPace: hi)
        let slowest = AnalysisLogic.paceStripFraction(pace: hi, minPace: lo, maxPace: hi)
        XCTAssertEqual(fastest, 1)
        XCTAssertEqual(slowest, 0)
        // More faster runs than slower ones in the fixture => dot sits left of centre... verify monotonic with rank.
        let mid = AnalysisLogic.paceStripFraction(pace: 5.85, minPace: lo, maxPace: hi)
        XCTAssertTrue(mid > slowest && mid < fastest)
    }

    func test_routineRunFixtureRankMatchesItsPaces() {
        let analysis = json(.weightLoss, "/api/workout-analyses/fixture-workout-analysis-routine")
        let pace = ((analysis["metrics"] as? [String: Any])?["paceMinPerKm"] as? Double) ?? .nan
        let history = (analysis["context"] as? [String: Any])?["paceHistory"] as? [String: Any]
        let previous = history?["previous"] as? [Double] ?? []
        XCTAssertEqual(history?["rank"] as? Int, AnalysisLogic.paceRank(previous: previous, current: pace))
        XCTAssertEqual(AnalysisLogic.paceRankPhrase(rank: history?["rank"] as? Int ?? 0, previousCount: previous.count),
                       "5th fastest of your last 8 runs.")
    }

    func test_weeklyReviewUnseenDotIsNeutralWithoutARealReview() {
        let thin = WeeklyReviewDTO(weekStart: "2026-09-28", weekEnd: "2026-10-04", verdict: .insufficientData, headline: "x", sufficient: false)
        let needs = WeeklyReviewDTO(weekStart: "2026-09-28", weekEnd: "2026-10-04", verdict: .needsTarget, headline: "x", sufficient: true)
        let real = WeeklyReviewDTO(weekStart: "2026-09-28", weekEnd: "2026-10-04", verdict: .onTrack, headline: "x", sufficient: true)
        XCTAssertTrue(WeeklyReviewRow.unseenDotIsNeutral(thin))
        XCTAssertTrue(WeeklyReviewRow.unseenDotIsNeutral(needs))
        XCTAssertFalse(WeeklyReviewRow.unseenDotIsNeutral(real))
    }

    func test_goalProgressFixturesDecode() throws {
        let expectations: [(FixtureMode.Scenario, GoalVerdict)] = [
            (.weightLoss, .onTrack), (.muscle, .behind), (.endurance, .building), (.newUser, .needsTarget),
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

    /// Endurance: Today's this-week totals (Monday-start local week) must agree
    /// with the goal card's distance line, and must differ from last week's
    /// review (3 sessions, 24.5 km).
    func test_enduranceThisWeekAgreesAcrossTodayAndGoalCardAndDiffersFromReview() throws {
        let week = FixtureData.enduranceWeek()
        XCTAssertEqual(week.days.count, 7)
        XCTAssertNotEqual(week.km, 24.5, "this week must not equal last week's review volume")

        let summary = json(.endurance, "/api/training/summary")
        let volume = summary["volume"] as? [String: Any]
        XCTAssertEqual(volume?["done"] as? Double ?? .nan, week.km, accuracy: 0.001)
        XCTAssertEqual((summary["week"] as? [String: Any])?["completedSessions"] as? Int, week.sessions)
        XCTAssertEqual((summary["week"] as? [String: Any])?["start"] as? String, week.start)

        let (_, data) = FixtureData.response(scenario: .endurance, method: "GET", path: "/api/goal/progress", query: "")
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: data)
        XCTAssertEqual(progress.target.weeklyDistanceKm, 30)
        XCTAssertEqual(progress.distance?.thisWeekKm ?? .nan, week.km, accuracy: 0.001)
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), GoalProgressLogic.distanceLine(progress, system: .metric))
        XCTAssertTrue(progress.headline.contains("last 2 weeks vs the 2 before"), progress.headline)
        XCTAssertFalse(progress.headline.contains("over 4 weeks"))

        let profile = json(.endurance, "/api/profile")
        XCTAssertEqual(profile["weeklyDistanceKmTarget"] as? Double, 30)

        // The race is the same on the profile and on the goal-progress payload.
        XCTAssertEqual(progress.race?.label, "Half marathon")
        XCTAssertEqual(progress.race?.weeksToGo, 12)
        XCTAssertEqual(progress.race?.date, profile["raceDate"] as? String)
        XCTAssertEqual(profile["raceDistanceKm"] as? Double, 21.1)

        let review = json(.endurance, "/api/review/weekly")
        XCTAssertEqual(statValue(review, "Volume")?["comparison"] as? String, "+12% vs last week")
    }
}
#endif
