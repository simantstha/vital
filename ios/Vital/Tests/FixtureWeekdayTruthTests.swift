import XCTest
@testable import Vital

/// Fixture copy that names a weekday for a RELATIVE date ("Monday's squat",
/// "Easy 30 minutes on Monday") used to hard-code the name while the date it
/// describes (`dayString(2)`, "last night") moved with the wall clock — so the
/// muscle persona's insight said "Monday's squat" beside "Last (Tue): Squat
/// 3×5 @ 140 kg". These tests derive the expected weekday from the SAME
/// relative date independently of `FixtureData.weekdayName`, and fail on any
/// weekday name in served fixture copy that is not verified here.
#if DEBUG
final class FixtureWeekdayTruthTests: XCTestCase {

    private let scenarios: [FixtureMode.Scenario] = [.newUser, .weightLoss, .muscle, .endurance]

    /// Every user-facing fixture endpoint that can carry prose. Deliberately
    /// NOT scanned: `/api/review/weekly` (it describes the last completed
    /// week, with its own copy and window) and `/api/memory` (routine facts such
    /// as "Lifts Monday, Wednesday, Friday" are timeless, not tied to a
    /// relative date).
    private let scannedPaths = [
        "/api/today", "/api/plan", "/api/training/summary", "/api/goal/progress",
        "/api/coach", "/api/coach/opener", "/api/logs",
        "/api/workouts/last", "/api/workouts/sessions", "/api/workouts/summary",
        "/api/workout-analyses/fixture-workout-analysis",
        "/api/workout-analyses/fixture-workout-analysis-routine",
        "/api/sleep-analyses/fixture-sleep-analysis",
        "/api/notifications", "/api/devices", "/api/profile", "/api/pending-facts",
    ]

    // MARK: - Helpers

    private func json(_ scenario: FixtureMode.Scenario, _ path: String) -> Any? {
        let (status, data) = FixtureData.response(scenario: scenario, method: "GET", path: path, query: "")
        guard status == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private func object(_ scenario: FixtureMode.Scenario, _ path: String) -> [String: Any] {
        json(scenario, path) as? [String: Any] ?? [:]
    }

    private func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = format
        return f
    }

    /// Full weekday name ("Tuesday") of a "YYYY-MM-DD" local day string.
    private func weekday(ofDay day: String) -> String? {
        formatter("yyyy-MM-dd").date(from: day).map { formatter("EEEE").string(from: $0) }
    }

    private func tomorrowsWeekday() -> String {
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        return formatter("EEEE").string(from: tomorrow)
    }

    private func strings(in value: Any) -> [String] {
        switch value {
        case let text as String: return [text]
        case let array as [Any]: return array.flatMap { strings(in: $0) }
        case let dictionary as [String: Any]: return dictionary.values.flatMap { strings(in: $0) }
        default: return []
        }
    }

    private static let weekdayPattern =
        #"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b"#

    private func weekdayMentions(in text: String) -> [String] {
        var found: [String] = []
        var searchRange = text.startIndex..<text.endIndex
        while let range = text.range(of: Self.weekdayPattern, options: .regularExpression, range: searchRange) {
            found.append(String(text[range]))
            searchRange = range.upperBound..<text.endIndex
        }
        return found
    }

    private var lastLiftDay: String? {
        (object(.muscle, "/api/training/summary")["lastLift"] as? [String: Any])?["date"] as? String
    }

    /// The muscle insight as it must read: the weekday of the last lift's date.
    private func expectedMuscleInsight() throws -> String {
        let day = try XCTUnwrap(lastLiftDay, "muscle fixture must carry a last lift")
        let name = try XCTUnwrap(weekday(ofDay: day), "unparseable last-lift day \(day)")
        return "Protein's on target four days running and \(name)'s squat was your best in 4 weeks \u{2014} stay the course."
    }

    private func expectedNextStep() -> String {
        "Easy 30 minutes on \(tomorrowsWeekday()). Keep it conversational \u{2014} this was a big one."
    }

    // MARK: - The pinned pairs

    /// "Monday's squat" beside "Last (Tue): Squat" was the bug.
    func test_muscleInsightNamesTheWeekdayOfTheLastLift() throws {
        let expected = try expectedMuscleInsight()
        let insight = object(.muscle, "/api/today")["insight"] as? String
        XCTAssertEqual(insight, expected)
    }

    /// The hero's "Last (Tue)" abbreviation, the insight's full name and the
    /// logger / session-menu history all describe one session on one day.
    func test_lastLiftLineInsightAndSessionHistoryAgreeOnTheDay() throws {
        let day = try XCTUnwrap(lastLiftDay)
        let full = try XCTUnwrap(weekday(ofDay: day))
        XCTAssertEqual(MuscleHeroLogic.weekdayShortLabel(forDateString: day), String(full.prefix(3)))

        let sessions = object(.muscle, "/api/workouts/sessions")["sessions"] as? [[String: Any]]
        XCTAssertEqual(sessions?.first?["localDay"] as? String, day, "newest session in the menu is the last lift")
        let sets = object(.muscle, "/api/workouts/last")["sets"] as? [[String: Any]]
        XCTAssertEqual(sets?.first?["localDay"] as? String, day, "the logger's last session is the last lift")
    }

    /// "Easy 30 minutes on Friday": the run was last night, so the easy day is
    /// tomorrow — never a fixed weekday.
    func test_workoutAnalysisNextStepNamesTomorrowsWeekday() {
        for scenario in scenarios.filter({ $0 != .newUser }) {
            let result = object(scenario, "/api/workout-analyses/fixture-workout-analysis")["result"] as? [String: Any]
            let steps = result?["nextSteps"] as? [String]
            XCTAssertEqual(steps, [expectedNextStep()], "\(scenario)")
        }
    }

    func test_weekdayNameHelperTracksTheRelativeDate() {
        let base = Date(timeIntervalSince1970: 1_790_000_000)
        for daysAgo in -3...9 {
            let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: base) ?? base
            XCTAssertEqual(FixtureData.weekdayName(daysAgo: daysAgo, now: base), formatter("EEEE").string(from: date), "daysAgo \(daysAgo)")
        }
    }

    // MARK: - The scan

    /// No other served fixture string may hard-code a weekday: a weekday that
    /// describes a relative date has to be derived from it (and pinned above),
    /// otherwise it drifts as soon as the fixture runs on another day.
    func test_noFixtureStringHardCodesAnUnverifiedWeekday() throws {
        let verified: Set<String> = [try expectedMuscleInsight(), expectedNextStep()]
        var offenders: [String] = []
        for scenario in scenarios {
            for path in scannedPaths {
                guard let payload = json(scenario, path) else { continue }
                for text in strings(in: payload) where !verified.contains(text) {
                    let mentions = weekdayMentions(in: text)
                    if !mentions.isEmpty {
                        offenders.append("[\(scenario)] \(path): \(mentions) in \"\(text)\"")
                    }
                }
            }
        }
        XCTAssertEqual(offenders, [], "derive the weekday from the relative date (FixtureData.weekdayName) and pin it in this file")
    }
}
#endif
