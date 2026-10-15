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
        XCTAssertEqual(RaceLogic.label(forKm: 15), "15\u{00A0}km race")
        XCTAssertEqual(RaceLogic.label(forKm: 12.5), "12.5\u{00A0}km race")
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
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 14/18\u{00A0}km"
        )
        // Race week reads in days; the long-run tail is unchanged.
        XCTAssertEqual(
            RaceLogic.heroLine(race(weeks: 0, days: 5), longRun: longRun, system: .metric),
            "Half marathon \u{00B7} 5 days to go \u{00B7} long run 14/18\u{00A0}km"
        )
        // Imperial users get miles for both numbers.
        XCTAssertEqual(
            RaceLogic.heroLine(race(), longRun: longRun, system: .imperial),
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 8.7/11.2\u{00A0}mi"
        )
        // No recent long run: the 28-day peak stands in.
        XCTAssertEqual(
            RaceLogic.heroLine(race(), longRun: GoalProgressDTO.LongRun(lastKm: nil, peakKm: 16, targetPeakKm: 18), system: .metric),
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 16/18\u{00A0}km"
        )
        XCTAssertEqual(RaceLogic.longRunProgressText(longRun, .metric), "long run 14/18\u{00A0}km")
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

    /// A custom-distance label and the long-run tail glue every number to its
    /// unit with U+00A0, so a narrow hero line never strands "km" / "mi".
    func testNoPlainSpaceBetweenADigitAndAUnit() throws {
        assertNoBreakableUnitSpace(RaceLogic.label(forKm: 15))
        assertNoBreakableUnitSpace(RaceLogic.label(forKm: 12.5))
        let longRun = GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 18)
        for system in [UnitSystem.metric, .imperial] {
            assertNoBreakableUnitSpace(try XCTUnwrap(RaceLogic.longRunProgressText(longRun, system)))
            assertNoBreakableUnitSpace(race(km: 15, label: nil).displayLabel)
            assertNoBreakableUnitSpace(try XCTUnwrap(RaceLogic.longRunRowText(longRun, system)))
        }
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
        XCTAssertEqual(RaceLogic.goalRowSuffix(raceDate: "2026-12-30", distanceKm: 21.1, now: now, calendar: utc), "Half marathon \u{00B7}\u{00A0}Dec 30")
        XCTAssertEqual(RaceLogic.goalRowSuffix(raceDate: "2026-12-30", distanceKm: nil, now: now, calendar: utc), "Race \u{00B7}\u{00A0}Dec 30")
        XCTAssertEqual(RaceLogic.goalRowSuffix(raceDate: "2026-10-06", distanceKm: 10, now: now, calendar: utc), "10K \u{00B7}\u{00A0}Oct 6", "race day itself still counts")
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

    // MARK: - Race lifecycle (taper / race week / recovery)

    private func lifecycle(
        date: String = "2026-12-30", weeks: Int, days: Int,
        phase: GoalProgressDTO.Race.Phase?, daysSince: Int? = nil
    ) -> GoalProgressDTO.Race {
        GoalProgressDTO.Race(
            date: date, distanceKm: 21.1, label: "Half marathon", weeksToGo: weeks, daysToGo: days,
            phase: phase, daysSince: daysSince
        )
    }

    func testRecoveryWeekBoundariesMirrorTheServer() {
        XCTAssertEqual(RaceLogic.recoveryWeek(daysSince: 1), 1)
        XCTAssertEqual(RaceLogic.recoveryWeek(daysSince: 7), 1)
        XCTAssertEqual(RaceLogic.recoveryWeek(daysSince: 8), 2)
        XCTAssertEqual(RaceLogic.recoveryWeek(daysSince: 14), 2)
        // A server that sends no day count reads as the first recovery week.
        XCTAssertEqual(RaceLogic.recoveryWeek(daysSince: nil), 1)
    }

    func testHeroLineFollowsThePhase() {
        // Build keeps the plain countdown (and its long-run tail).
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(weeks: 12, days: 84, phase: .build), calendar: utc), "Half marathon · 12 weeks to go")
        let longRun = GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 18)
        XCTAssertEqual(
            RaceLogic.heroLine(lifecycle(weeks: 12, days: 84, phase: .build), longRun: longRun, system: .metric, calendar: utc),
            "Half marathon \u{00B7} 12 weeks to go \u{00B7} long run 14/18\u{00A0}km"
        )
        // Taper: the phase, the countdown, no long-run tail (the build-up is over).
        XCTAssertEqual(
            RaceLogic.heroLine(lifecycle(weeks: 2, days: 14, phase: .taper), longRun: longRun, system: .metric, calendar: utc),
            "Half marathon \u{00B7} taper \u{00B7} 2 weeks to go"
        )
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(weeks: 3, days: 21, phase: .taper), calendar: utc), "Half marathon · taper · 3 weeks to go")
        // Race week: the day, not a countdown.
        XCTAssertEqual(
            RaceLogic.heroLine(lifecycle(date: "2026-12-31", weeks: 0, days: 5, phase: .raceWeek), longRun: longRun, calendar: utc),
            "Race week · Dec 31"
        )
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(date: "2026-12-31", weeks: 1, days: 7, phase: .raceWeek), calendar: utc), "Race week · Dec 31")
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(date: "2026-12-31", weeks: 0, days: 0, phase: .raceWeek), calendar: utc), "Race day · Dec 31")
        // Recovery: done, with the recovery week.
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 3), calendar: utc), "Race done · recovery week 1")
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 9), calendar: utc), "Race done · recovery week 2")
        XCTAssertEqual(RaceLogic.heroLine(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: nil), calendar: utc), "Race done · recovery week 1")
        // An older server (no phase) is exactly the old countdown.
        XCTAssertEqual(RaceLogic.heroLine(race(), calendar: utc), "Half marathon · 12 weeks to go")
    }

    func testRowTextCarriesThePhase() {
        XCTAssertEqual(RaceLogic.rowText(lifecycle(weeks: 12, days: 84, phase: .build), calendar: utc), "Half marathon · Dec 30 · 12 wk")
        XCTAssertEqual(RaceLogic.rowText(lifecycle(weeks: 2, days: 14, phase: .taper), calendar: utc), "Half marathon · Dec 30 · taper · 2 wk")
        XCTAssertEqual(RaceLogic.rowText(lifecycle(weeks: 0, days: 5, phase: .raceWeek), calendar: utc), "Half marathon · Dec 30 · race week · 5 d")
        XCTAssertEqual(RaceLogic.rowText(lifecycle(weeks: 0, days: 0, phase: .raceWeek), calendar: utc), "Half marathon · Dec 30 · race week · today")
        XCTAssertEqual(
            RaceLogic.rowText(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 3), calendar: utc),
            "Half marathon · Dec 30 · recovery week 1"
        )
        XCTAssertEqual(
            RaceLogic.rowText(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 12), calendar: utc),
            "Half marathon · Dec 30 · recovery week 2"
        )
    }

    func testRecoveryTextAndCallToActionCopy() {
        XCTAssertEqual(RaceLogic.recoveryText(daysSince: 2), "Race done · recovery week 1")
        XCTAssertEqual(RaceLogic.nextGoalTitle, "Set your next goal")
        XCTAssertTrue(RaceLogic.isRecovery(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 1)))
        XCTAssertFalse(RaceLogic.isRecovery(lifecycle(weeks: 2, days: 14, phase: .taper)))
        XCTAssertFalse(RaceLogic.isRecovery(race()))
        XCTAssertFalse(RaceLogic.isRecovery(nil))
    }

    func testGoalProgressDecodesTaperAndRecoveryPayloads() throws {
        func decode(_ race: String) throws -> GoalProgressDTO {
            let json = #"{"goal":"endurance","verdict":"holding","headline":"h","reasons":[],"race":\#(race)}"#
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        let taper = try decode(#"{"date":"2026-12-30","distanceKm":21.1,"label":"Half marathon","weeksToGo":2,"daysToGo":14,"phase":"taper"}"#)
        XCTAssertEqual(taper.race?.phase, .taper)
        XCTAssertNil(taper.race?.daysSince)
        XCTAssertEqual(taper.race?.daysToGo, 14)

        let raceWeek = try decode(#"{"date":"2026-12-30","weeksToGo":0,"daysToGo":4,"phase":"race_week"}"#)
        XCTAssertEqual(raceWeek.race?.phase, .raceWeek)

        let recovery = try decode(#"{"date":"2026-12-30","distanceKm":21.1,"label":"Half marathon","weeksToGo":0,"daysToGo":0,"phase":"recovery","daysSince":3}"#)
        XCTAssertEqual(recovery.race?.phase, .recovery)
        XCTAssertEqual(recovery.race?.daysSince, 3)
        XCTAssertEqual(recovery.race?.daysToGo, 0)
        XCTAssertTrue(GoalProgressLogic.showsNextGoalPrompt(recovery))

        let build = try decode(#"{"date":"2026-12-30","weeksToGo":12,"daysToGo":84,"phase":"build"}"#)
        XCTAssertEqual(build.race?.phase, .build)
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(build))
    }

    func testRacePhaseDecodingIsTolerant() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO.Race? {
            let json = #"{"goal":"endurance","verdict":"holding","headline":"h","reasons":[],"race":{"date":"2026-12-30","weeksToGo":12,"daysToGo":84\#(extra)}}"#
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8)).race
        }
        // Older server: no phase, still a plain race.
        XCTAssertNil(try decode("")?.phase)
        XCTAssertEqual(try decode("")?.daysToGo, 84)
        // An unknown phase from a newer server, or a wrong type, drops only the phase.
        XCTAssertNil(try decode(#","phase":"carb_load""#)?.phase)
        XCTAssertEqual(try decode(#","phase":"carb_load""#)?.weeksToGo, 12)
        XCTAssertNil(try decode(#","phase":5"#)?.phase)
        XCTAssertNil(try decode(#","phase":null"#)?.phase)
        // A bad daysSince drops only that field.
        XCTAssertNil(try decode(#","phase":"recovery","daysSince":"three""#)?.daysSince)
        XCTAssertEqual(try decode(#","phase":"recovery","daysSince":"three""#)?.phase, .recovery)
    }

    func testRecoveryLeadsWithTheRaceDoneHeadlineAndOffersTheNextGoal() {
        let recovery = GoalProgressDTO(
            goal: "endurance",
            distance: GoalProgressDTO.Distance(targetKm: 50, thisWeekKm: 4, stepTargetKm: 16),
            race: lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 3),
            verdict: .holding,
            headline: "Race done — Dec 30 · recovery week 1"
        )
        XCTAssertTrue(GoalProgressLogic.showsNextGoalPrompt(recovery))
        XCTAssertEqual(GoalProgressLogic.primaryLine(recovery, system: .metric), "Race done — Dec 30 · recovery week 1")
        // The goal sheet's race row names the recovery week.
        let rows = GoalProgressLogic.statRows(recovery, system: .metric)
        XCTAssertEqual(rows.first(where: { $0.label == "Race" })?.value, RaceLogic.rowText(recovery.race!))

        // Taper / no race: no call to action, and the distance line still leads.
        let taper = GoalProgressDTO(
            goal: "endurance",
            distance: GoalProgressDTO.Distance(targetKm: 50, thisWeekKm: 4, stepTargetKm: 30),
            race: lifecycle(weeks: 2, days: 14, phase: .taper),
            verdict: .holding,
            headline: "Holding steady — averaging 40 of 50 km a week (4-week avg)"
        )
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(taper))
        XCTAssertTrue(GoalProgressLogic.primaryLine(taper, system: .metric).contains("this week"))
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(GoalProgressDTO(goal: "endurance", verdict: .holding)))
    }

    @MainActor
    func testSetYourNextGoalOpensTheGoalEditor() {
        final class Recorder { var posted: [Notification.Name] = [] }
        let recorder = Recorder()
        let actions = GoalReachedActions(switchGoal: { _ in }, post: { recorder.posted.append($0) })
        actions.setNewTarget()
        XCTAssertEqual(recorder.posted, [.vitalOpenGoalEditor])
    }

    /// The server reads recovery in CALENDAR weeks once the goal has a week plan:
    /// the days from race day to THIS WEEK'S Monday pick the week ("Recovery week 1
    /// — day 9 after your half"), so after a mid-week race a day-count rule says
    /// week 2 where the server's headline still says week 1, and `daysSince` runs
    /// to ~20 before recovery ends. Without a plan the server counts from today.
    func testRecoveryWeekFollowsTheCalendarWeekWithAWeekPlan() {
        func week(_ daysSince: Int?, date: String, planned: Bool = true) -> Int {
            RaceLogic.recoveryWeek(
                lifecycle(date: date, weeks: 0, days: 0, phase: .recovery, daysSince: daysSince), weekPlanned: planned
            )
        }
        // Race on a Wednesday (2026-12-30): Thu 12-31 ... Sun 01-03 are the race week's own recovery days.
        XCTAssertEqual((1...4).map { week($0, date: "2026-12-30") }, [1, 1, 1, 1])
        // Next Monday (day 5) to its Sunday (day 11): still week 1 — the day-count rule says 2 from day 8.
        XCTAssertEqual((5...11).map { week($0, date: "2026-12-30") }, [1, 1, 1, 1, 1, 1, 1])
        XCTAssertEqual((5...11).map { RaceLogic.recoveryWeek(daysSince: $0) }, [1, 1, 1, 2, 2, 2, 2])
        // Monday 01-11 (day 12) to the end of recovery, Sunday 01-17 (day 18): week 2.
        XCTAssertEqual((12...18).map { week($0, date: "2026-12-30") }, [2, 2, 2, 2, 2, 2, 2])

        // Race on a Monday (2026-12-28): week 1 through the following Sunday+6, week 2 up to day 20.
        XCTAssertEqual((1...13).map { week($0, date: "2026-12-28") }, Array(repeating: 1, count: 13))
        XCTAssertEqual((14...20).map { week($0, date: "2026-12-28") }, Array(repeating: 2, count: 7))

        // Race on a Sunday (2026-12-27): the same as the plain day count.
        XCTAssertEqual((1...7).map { week($0, date: "2026-12-27") }, Array(repeating: 1, count: 7))
        XCTAssertEqual((8...14).map { week($0, date: "2026-12-27") }, Array(repeating: 2, count: 7))

        // Without a week plan the server counts days from today, and a missing count reads as week 1.
        XCTAssertEqual((8...11).map { week($0, date: "2026-12-30", planned: false) }, [2, 2, 2, 2])
        XCTAssertEqual(week(nil, date: "2026-12-30"), 1)
        XCTAssertEqual(week(nil, date: "2026-12-30", planned: false), 1)
        // An unreadable race date falls back to the day count rather than guessing a weekday.
        XCTAssertEqual(week(9, date: "soon"), 2)
    }

    func testRecoveryLabelsUseTheServersWeekWhenThereIsAPlan() {
        let midWeek = lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 9) // race Wed 12-30, today Fri 01-08
        XCTAssertEqual(RaceLogic.heroLine(midWeek, calendar: utc, weekPlanned: true), "Race done · recovery week 1")
        XCTAssertEqual(RaceLogic.heroLine(midWeek, calendar: utc), "Race done · recovery week 2")
        XCTAssertEqual(RaceLogic.recoveryText(midWeek, weekPlanned: true), "Race done · recovery week 1")
        XCTAssertEqual(RaceLogic.rowText(midWeek, calendar: utc, weekPlanned: true), "Half marathon · Dec 30 · recovery week 1")
        XCTAssertEqual(RaceLogic.rowText(midWeek, calendar: utc), "Half marathon · Dec 30 · recovery week 2")
        // The goal sheet's Race row reads the plan off the payload.
        let progress = GoalProgressDTO(
            goal: "endurance",
            target: .init(weeklyDistanceKm: 30),
            distance: GoalProgressDTO.Distance(
                targetKm: 30, thisWeekKm: 4, stepTargetKm: 12, plan: .init(kind: "recovery", targetKm: 12)
            ),
            race: midWeek,
            verdict: .building
        )
        let row = GoalProgressLogic.statRows(progress, system: .metric).first { $0.label == "Race" }?.value
        XCTAssertEqual(row, RaceLogic.rowText(midWeek, weekPlanned: true))
        XCTAssertTrue(row?.hasSuffix("recovery week 1") ?? false, row ?? "nil")
    }

    // MARK: - "Set your next goal": recovery week 1 only (wave 20)

    /// A recovery payload `daysSince` days after the race, with the headline the server writes for it.
    private func recoveryProgress(daysSince: Int?, phase: GoalProgressDTO.Race.Phase? = .recovery) -> GoalProgressDTO {
        let week = (daysSince ?? 1) <= 7 ? 1 : 2
        return GoalProgressDTO(
            goal: "endurance",
            distance: GoalProgressDTO.Distance(targetKm: 50, thisWeekKm: 4, stepTargetKm: 16),
            race: lifecycle(weeks: 0, days: 0, phase: phase, daysSince: daysSince),
            verdict: .holding,
            headline: "Race done \u{2014} Dec 30 \u{00B7} recovery week \(week)"
        )
    }

    /// The server shows its "Set your next goal" reason in recovery week 1 only (`nextGoalReason`, days 1-7);
    /// a month of it is nagging. The button follows the sentence, on the card and in the sheet alike
    /// (both gate on `showsNextGoalPrompt`).
    func testTheNextGoalButtonIsForRecoveryWeekOneOnly() {
        for day in 1...7 {
            XCTAssertTrue(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: day)), "day \(day)")
            XCTAssertTrue(RaceLogic.offersNextGoal(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: day)), "day \(day)")
        }
        for day in 8...14 {
            XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: day)), "day \(day)")
            XCTAssertFalse(RaceLogic.offersNextGoal(lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: day)), "day \(day)")
        }
        // A server that sends no day count reads as week 1: the button, exactly as before.
        XCTAssertTrue(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: nil)))
        // Outside recovery there is never a button, whatever the day count.
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: 3, phase: .taper)))
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: 3, phase: .raceWeek)))
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: 3, phase: .build)))
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(recoveryProgress(daysSince: 3, phase: nil)))
        XCTAssertFalse(RaceLogic.offersNextGoal(nil))
        XCTAssertFalse(RaceLogic.offersNextGoal(race()))
    }

    /// The recovery headline keeps leading for the whole 14 days — only the button goes after week 1.
    func testTheRecoveryHeadlineLeadsForAllFourteenDays() {
        for day in 1...14 {
            let progress = recoveryProgress(daysSince: day)
            XCTAssertTrue(RaceLogic.isRecovery(progress.race), "day \(day)")
            XCTAssertEqual(
                GoalProgressLogic.primaryLine(progress, system: .metric),
                "Race done \u{2014} Dec 30 \u{00B7} recovery week \(day <= 7 ? 1 : 2)", "day \(day)"
            )
        }
        // With the week plan the server writes "Recovery week 2 — day 9 after your half": still the lead, still no button.
        let planned = GoalProgressDTO(
            goal: "endurance",
            distance: GoalProgressDTO.Distance(
                targetKm: 50, thisWeekKm: 4, stepTargetKm: 16, plan: GoalProgressDTO.Distance.Plan(kind: "recovery", targetKm: 16)
            ),
            race: lifecycle(weeks: 0, days: 0, phase: .recovery, daysSince: 9),
            verdict: .holding,
            headline: "Recovery week 2 \u{2014} day 9 after your half"
        )
        XCTAssertEqual(GoalProgressLogic.primaryLine(planned, system: .metric), "Recovery week 2 \u{2014} day 9 after your half")
        XCTAssertFalse(GoalProgressLogic.showsNextGoalPrompt(planned))
    }
}
