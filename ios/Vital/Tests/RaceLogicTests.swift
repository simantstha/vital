import XCTest
@testable import Vital

final class RaceLogicTests: XCTestCase {

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    private func race(
        date: String = "2026-12-30", km: Double? = 21.1, label: String? = "Half marathon",
        weeks: Int = 12, days: Int = 84
    ) -> GoalProgressDTO.Race {
        GoalProgressDTO.Race(date: date, distanceKm: km, label: label, weeksToGo: weeks, daysToGo: days)
    }

    func testLabelsMirrorServer() {
        XCTAssertEqual(RaceLogic.label(forKm: 21.1), "Half marathon")
        XCTAssertEqual(RaceLogic.label(forKm: 42.2), "Marathon")
        XCTAssertEqual(RaceLogic.label(forKm: 10), "10K")
        XCTAssertEqual(RaceLogic.label(forKm: 5), "5K")
        XCTAssertEqual(RaceLogic.label(forKm: 15), "15 km race")
        XCTAssertEqual(RaceLogic.label(forKm: 12.5), "12.5 km race")
        XCTAssertEqual(RaceLogic.label(forKm: nil), "Race")
    }

    func testPresetsAndMatching() {
        XCTAssertEqual(RaceLogic.presets.map(\.title), ["5K", "10K", "Half", "Marathon"])
        XCTAssertEqual(RaceLogic.preset(forKm: 21.1)?.title, "Half")
        XCTAssertNil(RaceLogic.preset(forKm: 15))
        XCTAssertNil(RaceLogic.preset(forKm: nil))
    }

    func testDistanceValidation() {
        XCTAssertEqual(RaceLogic.validDistanceKm(21.0975), 21.1)
        XCTAssertEqual(RaceLogic.validDistanceKm(1), 1)
        XCTAssertEqual(RaceLogic.validDistanceKm(250), 250)
        XCTAssertNil(RaceLogic.validDistanceKm(0.9))
        XCTAssertNil(RaceLogic.validDistanceKm(250.1))
        XCTAssertNil(RaceLogic.validDistanceKm(.nan))
        XCTAssertNil(RaceLogic.validDistanceKm(nil))
    }

    func testDateRangeIsTodayThroughTwoYears() {
        let now = ISO8601DateFormatter().date(from: "2026-10-06T12:00:00Z")!
        let range = RaceLogic.dateRange(from: now, calendar: utc)
        XCTAssertEqual(GoalTargetLogic.dayString(from: range.lowerBound, calendar: utc), "2026-10-06")
        XCTAssertEqual(GoalTargetLogic.dayString(from: range.upperBound, calendar: utc), "2028-10-06")
    }

    func testCountdownText() {
        XCTAssertEqual(RaceLogic.countdownText(weeksToGo: 12, daysToGo: 84), "12 weeks to go")
        XCTAssertEqual(RaceLogic.countdownText(weeksToGo: 1, daysToGo: 7), "1 week to go")
        XCTAssertEqual(RaceLogic.countdownText(weeksToGo: 0, daysToGo: 5), "5 days to go")
        XCTAssertEqual(RaceLogic.countdownText(weeksToGo: 0, daysToGo: 1), "1 day to go")
        XCTAssertEqual(RaceLogic.countdownText(weeksToGo: 0, daysToGo: 0), "Race day")
    }

    func testHeroLineAndRowText() {
        XCTAssertEqual(RaceLogic.heroLine(race()), "Half marathon · 12 weeks to go")
        XCTAssertEqual(RaceLogic.heroLine(race(), longRun: nil, system: .metric), "Half marathon · 12 weeks to go")
        XCTAssertEqual(RaceLogic.rowText(race(), calendar: utc), "Half marathon · Dec 30 · 12 wk")
        XCTAssertEqual(RaceLogic.rowText(race(weeks: 0, days: 5), calendar: utc), "Half marathon · Dec 30 · 5 d")
        XCTAssertEqual(RaceLogic.rowText(race(weeks: 0, days: 0), calendar: utc), "Half marathon · Dec 30 · today")
    }

    // MARK: - Hero line: long-run progress

    func testHeroLineAppendsTheLongRunProgressWhenThereIsATarget() {
        let longRun = GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 18)
        XCTAssertEqual(
            RaceLogic.heroLine(race(), longRun: longRun, system: .metric),
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 14/18 km"
        )
        // Race week reads in days; the long-run tail is unchanged.
        XCTAssertEqual(
            RaceLogic.heroLine(race(weeks: 0, days: 5), longRun: longRun, system: .metric),
            "Half marathon \u{00B7} 5 days to go \u{00B7} long run 14/18 km"
        )
        // Imperial users get miles for both numbers.
        XCTAssertEqual(
            RaceLogic.heroLine(race(), longRun: longRun, system: .imperial),
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 8.7/11.2 mi"
        )
        // No recent long run: the 28-day peak stands in.
        XCTAssertEqual(
            RaceLogic.heroLine(race(), longRun: GoalProgressDTO.LongRun(lastKm: nil, peakKm: 16, targetPeakKm: 18), system: .metric),
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 16/18 km"
        )
        XCTAssertEqual(RaceLogic.longRunProgressText(longRun, .metric), "long run 14/18 km")
    }

    func testHeroLineLeavesOutTheLongRunWithoutATarget() {
        // A race with no distance has no peak to build to: never invent a goal.
        let noTarget = GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: nil)
        XCTAssertEqual(RaceLogic.heroLine(race(), longRun: noTarget, system: .metric), "Half marathon \u{00B7} 12 weeks to go")
        XCTAssertNil(RaceLogic.longRunProgressText(noTarget, .metric))
        // A target with nothing logged is not progress either.
        let nothingLogged = GoalProgressDTO.LongRun(lastKm: nil, peakKm: nil, targetPeakKm: 18)
        XCTAssertNil(RaceLogic.longRunProgressText(nothingLogged, .metric))
        XCTAssertNil(RaceLogic.longRunProgressText(.init(lastKm: 14, peakKm: 16, targetPeakKm: 0), .metric))
    }

    func testMissingLabelFallsBackToDistance() {
        XCTAssertEqual(race(km: 42.2, label: nil).displayLabel, "Marathon")
        XCTAssertEqual(race(km: nil, label: "").displayLabel, "Race")
    }

    func testShowsRaceOnlyForEndurance() {
        XCTAssertTrue(RaceLogic.showsRace(goal: "endurance"))
        XCTAssertTrue(RaceLogic.showsRace(goal: "improve_endurance"))
        XCTAssertFalse(RaceLogic.showsRace(goal: "muscle"))
        XCTAssertFalse(RaceLogic.showsRace(goal: "weight_loss"))
    }

    func testGoalProgressDecodesRaceAndToleratesItsAbsence() throws {
        let withRace = """
        {"goal":"endurance","verdict":"building","headline":"h","reasons":[],
         "race":{"date":"2026-12-30","distanceKm":21.1,"label":"Half marathon","weeksToGo":12,"daysToGo":84}}
        """
        let a = try JSONDecoder().decode(GoalProgressDTO.self, from: Data(withRace.utf8))
        XCTAssertEqual(a.race?.label, "Half marathon")
        XCTAssertEqual(a.race?.weeksToGo, 12)
        XCTAssertEqual(a.race?.daysToGo, 84)

        let without = #"{"goal":"endurance","verdict":"building","headline":"h","reasons":[]}"#
        XCTAssertNil(try JSONDecoder().decode(GoalProgressDTO.self, from: Data(without.utf8)).race)

        let nullRace = #"{"goal":"endurance","verdict":"building","headline":"h","reasons":[],"race":null}"#
        XCTAssertNil(try JSONDecoder().decode(GoalProgressDTO.self, from: Data(nullRace.utf8)).race)

        let malformed = #"{"goal":"endurance","verdict":"building","headline":"h","reasons":[],"race":{"label":"x"}}"#
        XCTAssertNil(try JSONDecoder().decode(GoalProgressDTO.self, from: Data(malformed.utf8)).race)
    }

    // MARK: - Goal row suffix

    func testGoalRowSuffixNamesTheRaceAndDay() {
        let now = ISO8601DateFormatter().date(from: "2026-10-06T12:00:00Z")!
        XCTAssertEqual(RaceLogic.goalRowSuffix(raceDate: "2026-12-30", distanceKm: 21.1, now: now, calendar: utc), "Half marathon \u{00B7} Dec 30")
        XCTAssertEqual(RaceLogic.goalRowSuffix(raceDate: "2026-12-30", distanceKm: nil, now: now, calendar: utc), "Race \u{00B7} Dec 30")
        XCTAssertEqual(RaceLogic.goalRowSuffix(raceDate: "2026-10-06", distanceKm: 10, now: now, calendar: utc), "10K \u{00B7} Oct 6", "race day itself still counts")
        XCTAssertNil(RaceLogic.goalRowSuffix(raceDate: "2026-10-05", distanceKm: 10, now: now, calendar: utc), "a passed race is dropped")
        XCTAssertNil(RaceLogic.goalRowSuffix(raceDate: nil, distanceKm: 21.1, now: now, calendar: utc))
        XCTAssertNil(RaceLogic.goalRowSuffix(raceDate: "soon", distanceKm: 21.1, now: now, calendar: utc))
    }

    // MARK: - Long run

    func testGoalProgressDecodesLongRunTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = #"{"goal":"endurance","verdict":"building","headline":"h","reasons":[]\#(extra)}"#
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        XCTAssertEqual(
            try decode(#","longRun":{"lastKm":14,"peakKm":16,"targetPeakKm":18}"#).longRun,
            GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 18)
        )
        // No race distance -> no target, still decodes.
        XCTAssertEqual(
            try decode(#","longRun":{"lastKm":14,"peakKm":16,"targetPeakKm":null}"#).longRun,
            GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: nil)
        )
        // Older servers / null / malformed -> nil, never a decode failure.
        XCTAssertNil(try decode("").longRun)
        XCTAssertNil(try decode(#","longRun":null"#).longRun)
        XCTAssertNil(try decode(#","longRun":5"#).longRun)
        XCTAssertNil(try decode(#","longRun":{"lastKm":"x","peakKm":"y","targetPeakKm":18}"#).longRun)
        // Bad field types drop only that field.
        XCTAssertEqual(
            try decode(#","longRun":{"lastKm":"x","peakKm":16,"targetPeakKm":"18"}"#).longRun,
            GoalProgressDTO.LongRun(lastKm: nil, peakKm: 16, targetPeakKm: nil)
        )
        // The rest of the payload survives a bad longRun.
        XCTAssertEqual(try decode(#","longRun":"nope""#).headline, "h")
    }

    func testLongRunRowTextShowsTheLastLongRunThenThePeakTarget() {
        let full = GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 18)
        XCTAssertEqual(RaceLogic.longRunRowText(full, .metric), "14\u{00A0}km \u{00B7} peak target 18\u{00A0}km")
        XCTAssertEqual(RaceLogic.longRunRowText(full, .imperial), "8.7\u{00A0}mi \u{00B7} peak target 11.2\u{00A0}mi")
        XCTAssertEqual(RaceLogic.longRunRowText(.init(lastKm: 14.5, peakKm: 16, targetPeakKm: nil), .metric), "14.5\u{00A0}km")
        XCTAssertEqual(RaceLogic.longRunRowText(.init(lastKm: nil, peakKm: 16, targetPeakKm: 18), .metric), "peak 16\u{00A0}km \u{00B7} peak target 18\u{00A0}km")
        XCTAssertNil(RaceLogic.longRunRowText(.init(lastKm: nil, peakKm: nil, targetPeakKm: 18), .metric))
    }

}
