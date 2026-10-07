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
        XCTAssertEqual(RaceLogic.rowText(race(), calendar: utc), "Half marathon · Dec 30 · 12 wk")
        XCTAssertEqual(RaceLogic.rowText(race(weeks: 0, days: 5), calendar: utc), "Half marathon · Dec 30 · 5 d")
        XCTAssertEqual(RaceLogic.rowText(race(weeks: 0, days: 0), calendar: utc), "Half marathon · Dec 30 · today")
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
}
