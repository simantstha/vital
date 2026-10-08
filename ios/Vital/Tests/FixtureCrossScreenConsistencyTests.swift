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

    /// The weekly-review copy glues numbers to their units (and "a → b" pairs)
    /// with U+00A0, exactly like the server (lib/displayText.ts); compare it
    /// with plain spaces unless a test is about the glue itself.
    private func plain(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    func test_enduranceRestingHRAgreesAcrossTodayTrendsAndWeeklyReview() {
        let rhr = todayMetric(.endurance, "restingHr")
        XCTAssertEqual(rhr, 54, accuracy: 0.01)
        XCTAssertEqual(latestBatchPoint(.endurance, "resting_hr"), rhr, accuracy: 0.01)

        let review = json(.endurance, "/api/review/weekly")
        let stat = statValue(review, "Resting HR")
        XCTAssertEqual(plain(stat?["value"] as? String), "54 bpm")
        // Weekly review quotes the same gap-to-normal Trends shows (54 vs normal).
        let series = (json(.endurance, "/api/trends", "metrics=resting_hr&days=30")["series"] as? [String: Any])?["resting_hr"] as? [String: Any]
        let mean = ((series?["baseline"] as? [String: Any])?["mean30"] as? Double) ?? .nan
        let gap = Int((rhr - mean).rounded())
        XCTAssertGreaterThan(gap, 0, "RHR is above normal, never a green improvement")
        XCTAssertEqual(plain(stat?["comparison"] as? String), "+\(gap) bpm vs your normal")
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
        XCTAssertEqual(plain(review?["headline"] as? String), "3 of 4 sessions, Squat est. 1RM +10 kg over 4 wks")
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

    /// The muscle persona's two Today verdict surfaces no longer contradict
    /// each other: the goal line says WHY it is behind (structured adherence
    /// from the goal-progress fixture, matching its own reason text) and the
    /// weekly pill rates THAT week from the review's own stats.
    func test_muscleTodayGoalLineAndWeekPillAgree() throws {
        let (_, goalData) = FixtureData.response(scenario: .muscle, method: "GET", path: "/api/goal/progress", query: "tz=UTC")
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: goalData)
        let adherence = try XCTUnwrap(progress.adherence)
        XCTAssertEqual(adherence, GoalProgressDTO.Adherence(done: 9, planned: 16, weeklyTarget: 4, pct: 56))
        let reason = progress.reasons.first { $0.kind == "adherence" }?.text
        XCTAssertEqual(reason, "\(adherence.done) of \(adherence.planned) planned sessions in 4 weeks (\(adherence.pct ?? -1)%)")
        let line = GoalProgressLogic.compactText(progress, system: .metric)
        XCTAssertEqual(line.replacingOccurrences(of: "\u{00A0}", with: " "), "9 of 16 sessions in 4 wk · aim for 4 this week")

        let (_, reviewData) = FixtureData.response(scenario: .muscle, method: "GET", path: "/api/review/weekly", query: "tz=UTC")
        let review = try JSONDecoder().decode(WeeklyReviewResponse.self, from: reviewData).review
        // 3 of a 4-session target = target - 1 -> mixed, whatever the goal verdict says.
        let sessions = review.stats.first { $0.label == "Sessions" }
        XCTAssertEqual(sessions?.value, "3")
        XCTAssertEqual(sessions?.comparison, "target 4 for the week")
        XCTAssertEqual(review.weekRating, .mixed)
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(review), "Mixed week")
        XCTAssertTrue(review.headline.hasPrefix("3 of 4 sessions"), review.headline)
    }

    func test_everyScenarioWeeklyReviewCarriesAWeekRatingConsistentWithItsStats() throws {
        func review(_ scenario: FixtureMode.Scenario) throws -> WeeklyReviewDTO {
            let (_, data) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/review/weekly", query: "tz=UTC")
            return try JSONDecoder().decode(WeeklyReviewResponse.self, from: data).review
        }
        // 5 of 7 days in budget (>= 5/7) and weight down at a sane pace.
        let weightLoss = try review(.weightLoss)
        XCTAssertEqual(weightLoss.weekRating, .good)
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(weightLoss), "Good week")
        // 24.5 km against the 30 km weekly target = 82%: past 60%, short of 90%.
        let endurance = try review(.endurance)
        XCTAssertEqual(endurance.weekRating, .mixed)
        XCTAssertEqual(WeeklyReviewLogic.verdictLabel(endurance), "Mixed week")
        // Not enough data: the key is present as null, so no pill and no verdict fallback.
        let thin = try review(.newUser)
        XCTAssertNil(thin.weekRating)
        XCTAssertTrue(thin.hasWeekRating)
        XCTAssertNil(WeeklyReviewLogic.verdictLabel(thin))
    }

    /// The weekly review's pill, Slip and "Next week" tell ONE story
    /// (lib/weeklyReview.ts `weekGap`): a mixed / tough week's Slip names the
    /// gap and "Next week" closes it — never "Repeat this week" after a week
    /// that wasn't good — and the review carries the goal card's own verdict.
    func test_weeklyReviewPillSlipAndNextWeekTellOneStory() throws {
        func review(_ scenario: FixtureMode.Scenario) throws -> WeeklyReviewDTO {
            let (_, data) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/review/weekly", query: "tz=UTC")
            return try JSONDecoder().decode(WeeklyReviewResponse.self, from: data).review
        }
        func goalVerdict(_ scenario: FixtureMode.Scenario) throws -> GoalVerdict {
            let (_, data) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/goal/progress", query: "tz=UTC")
            return try JSONDecoder().decode(GoalProgressDTO.self, from: data).verdict
        }

        // Lifter: 3 of 4 sessions, and the goal card beside it says "Sessions behind".
        let muscle = try review(.muscle)
        let muscleGoalVerdict = try goalVerdict(.muscle)
        XCTAssertEqual(muscle.verdict, muscleGoalVerdict)
        XCTAssertEqual(muscle.verdict, .behind)
        XCTAssertEqual(muscle.weekRating, .mixed)
        XCTAssertEqual(muscle.slip, "3 of 4 sessions \u{2014} one short")
        XCTAssertEqual(muscle.nextWeek, "Book 4 sessions \u{2014} put the missed one on Saturday.")
        XCTAssertEqual(WeeklyReviewLogic.rows(muscle).map(\.kind), [.win, .slip, .next])

        // Runner: 24.5 of the 30 km target — the headline, Slip and Next week all say so.
        let endurance = try review(.endurance)
        let enduranceGoalVerdict = try goalVerdict(.endurance)
        XCTAssertEqual(enduranceGoalVerdict, endurance.verdict)
        XCTAssertEqual(endurance.weekRating, .mixed)
        XCTAssertEqual(plain(endurance.headline), "3 sessions, 24.5 of 30 km, +12% vs last week")
        XCTAssertEqual(plain(endurance.slip), "24.5 of 30 km target \u{2014} 5.5 km short")
        XCTAssertEqual(plain(endurance.nextWeek), "Aim for 30 km: add ~6 km to your long run or one easy run.")
        XCTAssertEqual(WeeklyReviewLogic.rows(endurance).map(\.kind), [.win, .slip, .next])

        // Whatever the scenario: a mixed / tough week has a Slip and never "Repeat this week".
        for scenario in scenarios {
            let r = try review(scenario)
            if r.weekRating == .mixed || r.weekRating == .tough {
                XCTAssertNotNil(r.slip, "\(scenario): a \(String(describing: r.weekRating)) week names its gap")
                XCTAssertFalse(r.nextWeek.contains("Repeat this week"), "\(scenario): \(r.nextWeek)")
            }
        }
    }

    /// Server copy glues a number to its unit (and the halves of "a → b") with
    /// U+00A0, so a narrow card never wraps mid-value; the fixtures mirror it.
    func test_weeklyReviewFixtureCopyNeverBreaksANumberFromItsUnit() throws {
        let breaking = #"\d (kg|lb|km|mi|kcal|bpm|wks)\b|\d → | → \d"#
        for scenario in scenarios {
            let (_, data) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/review/weekly", query: "tz=UTC")
            let review = try JSONDecoder().decode(WeeklyReviewResponse.self, from: data).review
            var strings: [String?] = [review.headline, review.win, review.slip, review.nextWeek]
            for stat in review.stats { strings += [stat.value, stat.comparison] }
            for text in strings.compactMap({ $0 }) {
                XCTAssertNil(text.range(of: breaking, options: .regularExpression), "\(scenario): \"\(text)\" can wrap mid-value")
            }
        }
        // ...and the glue really is U+00A0.
        let (_, data) = FixtureData.response(scenario: .muscle, method: "GET", path: "/api/review/weekly", query: "tz=UTC")
        let muscle = try JSONDecoder().decode(WeeklyReviewResponse.self, from: data).review
        XCTAssertEqual(muscle.headline, "3 of 4 sessions, Squat est. 1RM +10\u{00A0}kg over 4\u{00A0}wks")
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

    /// The endurance Today hero reads ms / bpm against the SAME 30-day normal
    /// the Trends pill states (never a percentage), and sleep as h/m.
    func test_enduranceHeroReasonLineIsAbsoluteAndAgreesWithTrends() {
        func normal(_ key: String) -> Double {
            let series = (json(.endurance, "/api/trends", "metrics=\(key)&days=30")["series"] as? [String: Any])?[key] as? [String: Any]
            return ((series?["baseline"] as? [String: Any])?["mean30"] as? Double) ?? .nan
        }
        let hrv = latestBatchPoint(.endurance, "hrv_sdnn")
        let rhr = latestBatchPoint(.endurance, "resting_hr")
        let sleepMinutes = Int((latestBatchPoint(.endurance, "sleep_minutes") * 60).rounded())
        let line = EnduranceHeroLogic.reasonLine(
            hrv: hrv, hrvNormal: normal("hrv_sdnn"), restingHR: rhr, restingHRNormal: normal("resting_hr"),
            sleepText: "\(sleepMinutes / 60)h \(sleepMinutes % 60)m"
        )
        XCTAssertEqual(line, "HRV \u{2212}6 ms \u{00B7} RHR +5 bpm \u{00B7} Sleep 5h 48m")

        // Same distance the HRV detail pill states ("6 ms below your normal (57 ms)").
        let hrvSpec = MetricCatalog.spec(for: "hrv_sdnn")!
        let mean = normal("hrv_sdnn")
        let pill = TrendsDeltaFormat.normalPillText(value: hrv, lower: mean - 3.4, upper: mean + 3.4, spec: hrvSpec, system: .metric)
        XCTAssertEqual(pill, "\u{2193} 6 ms below your normal (57 ms)")

        // ...and the Trends sleep tile / What-moved row spell the same night as h/m.
        let sleepSpec = MetricCatalog.spec(for: "sleep_minutes")!
        XCTAssertEqual(TrendsDeltaFormat.valueText(latestBatchPoint(.endurance, "sleep_minutes"), spec: sleepSpec), "5h 48m")
    }

    /// 2-week averages come from the weekly series and agree with the headline,
    /// the 4-week average and the coach opener; the weekly review's own
    /// week-over-week (+12%) is a different, labelled window.
    func test_enduranceVolumeWindowsAreCoherent() throws {
        let weeks = FixtureData.enduranceWeeklyKm
        XCTAssertEqual(weeks, [20.1, 23.7, 21.9, 24.5])
        let prior2 = (weeks[0] + weeks[1]) / 2
        let last2 = (weeks[2] + weeks[3]) / 2
        XCTAssertEqual(prior2, FixtureData.endurancePrior2WeeksAvgKm, accuracy: 0.001)
        XCTAssertEqual(last2, FixtureData.enduranceLast2WeeksAvgKm, accuracy: 0.001)
        XCTAssertEqual(Int(((last2 / prior2 - 1) * 100).rounded()), FixtureData.enduranceVolumeChangePct)
        XCTAssertEqual(weeks.reduce(0, +) / 4, FixtureData.enduranceFourWeekAvgKm, accuracy: 0.06)
        // Week over week (the review): 21.9 -> 24.5 = +12%.
        XCTAssertEqual(Int(((weeks[3] / weeks[2] - 1) * 100).rounded()), 12)

        let (_, data) = FixtureData.response(scenario: .endurance, method: "GET", path: "/api/goal/progress", query: "")
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: data)
        XCTAssertEqual(progress.headline, "Building \u{2014} distance up 6% (last 2 weeks vs the 2 before)")
        XCTAssertEqual(progress.distance?.avg4wKm ?? .nan, 22.6, accuracy: 0.001)
        XCTAssertFalse(progress.reasons.contains { $0.text.contains("12%") }, "the 2-week line must not reuse the week-over-week number")
        let opener = json(.endurance, "/api/coach/opener")["text"] as? String ?? ""
        XCTAssertTrue(opener.contains("distance up 6% (last 2 weeks vs the 2 before)"), opener)
    }

    /// Endurance goal card: race leads, then this week, then the long-run build;
    /// the detail row and the Profile Goal row carry the same race.
    func test_enduranceLongRunAndRaceShowOnGoalCardAndProfileRow() throws {
        let (_, data) = FixtureData.response(scenario: .endurance, method: "GET", path: "/api/goal/progress", query: "")
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: data)
        XCTAssertEqual(progress.longRun, GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 18))
        XCTAssertEqual(progress.reasons.map(\.kind), ["race", "week_distance", "long_run"])
        let longRun = progress.reasons[2].text
        XCTAssertTrue(longRun.hasPrefix("Long run 14 km \u{00B7} build to 18 km by "), longRun)
        XCTAssertEqual(RaceLogic.longRunRowText(progress.longRun!, .metric), "14 km \u{00B7} peak target 18 km")

        // The other scenarios never carry a long run.
        for scenario in [FixtureMode.Scenario.weightLoss, .muscle] {
            let (_, other) = FixtureData.response(scenario: scenario, method: "GET", path: "/api/goal/progress", query: "")
            XCTAssertNil(try JSONDecoder().decode(GoalProgressDTO.self, from: other).longRun, "\(scenario)")
        }

        let profile = json(.endurance, "/api/profile")
        let row = ProfileViewModel.goalRowLabel(
            goalLabel: "Endurance", goalId: "endurance", targetWeightKg: nil, weeklySessions: nil,
            weeklyDistanceKm: profile["weeklyDistanceKmTarget"] as? Double,
            raceDate: profile["raceDate"] as? String, raceDistanceKm: profile["raceDistanceKm"] as? Double,
            system: .metric
        )
        XCTAssertTrue(row.hasPrefix("Endurance \u{00B7} 30 km/week \u{00B7} Half marathon "), row)
    }

}
#endif
