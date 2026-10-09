import XCTest
@testable import Vital

final class GoalTargetLogicTests: XCTestCase {

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    /// 2026-10-06 12:00 UTC.
    private var now: Date {
        ISO8601DateFormatter().date(from: "2026-10-06T12:00:00Z")!
    }

    // MARK: - Which fields a goal shows

    func testTargetWeightShownForLossAndMuscleOnly() {
        XCTAssertTrue(GoalTargetLogic.showsTargetWeight(goal: "lose_fat"))
        XCTAssertTrue(GoalTargetLogic.showsTargetWeight(goal: "weight_loss"))
        XCTAssertTrue(GoalTargetLogic.showsTargetWeight(goal: "build_muscle"))
        XCTAssertTrue(GoalTargetLogic.showsTargetWeight(goal: "muscle"))
        XCTAssertFalse(GoalTargetLogic.showsTargetWeight(goal: "improve_endurance"))
        XCTAssertFalse(GoalTargetLogic.showsTargetWeight(goal: "general_health"))
        XCTAssertFalse(GoalTargetLogic.showsTargetWeight(goal: ""))
    }

    func testWeeklySessionsShownForMuscleAndEnduranceOnly() {
        XCTAssertTrue(GoalTargetLogic.showsWeeklySessions(goal: "build_muscle"))
        XCTAssertTrue(GoalTargetLogic.showsWeeklySessions(goal: "improve_endurance"))
        XCTAssertTrue(GoalTargetLogic.showsWeeklySessions(goal: "endurance"))
        XCTAssertFalse(GoalTargetLogic.showsWeeklySessions(goal: "lose_fat"))
        XCTAssertFalse(GoalTargetLogic.showsWeeklySessions(goal: "general"))
    }

    func testDefaultWeeklySessions() {
        XCTAssertEqual(GoalTargetLogic.defaultWeeklySessions(goal: "build_muscle"), 4)
        XCTAssertEqual(GoalTargetLogic.defaultWeeklySessions(goal: "improve_endurance"), 3)
    }

    // MARK: - Validation / unit conversion

    func testValidTargetKgRangeAndRounding() {
        XCTAssertEqual(GoalTargetLogic.validTargetKg(76.04), 76.0)
        XCTAssertEqual(GoalTargetLogic.validTargetKg(30), 30)
        XCTAssertEqual(GoalTargetLogic.validTargetKg(300), 300)
        XCTAssertNil(GoalTargetLogic.validTargetKg(29.9))
        XCTAssertNil(GoalTargetLogic.validTargetKg(300.1))
        XCTAssertNil(GoalTargetLogic.validTargetKg(nil))
        XCTAssertNil(GoalTargetLogic.validTargetKg(.nan))
    }

    func testImperialEntryConvertsToKg() throws {
        let kg = try XCTUnwrap(UnitFormat.kg(fromEntry: "168", .imperial))
        XCTAssertEqual(kg, 76.2, accuracy: 0.05)
        XCTAssertEqual(GoalTargetLogic.validTargetKg(kg), 76.2)
        XCTAssertEqual(UnitFormat.kg(fromEntry: "76,5", .metric), 76.5)
    }

    func testClampSessions() {
        XCTAssertEqual(GoalTargetLogic.clampSessions(0), 1)
        XCTAssertEqual(GoalTargetLogic.clampSessions(4), 4)
        XCTAssertEqual(GoalTargetLogic.clampSessions(30), 14)
    }

    // MARK: - Pace

    func testPaceEstimateDateAtHalfKgPerWeek() throws {
        // 6 kg at 0.5 kg/wk = 12 weeks = 84 days → 2026-12-29.
        let date = try XCTUnwrap(GoalTargetLogic.paceEstimateDate(
            currentKg: 82, targetKg: 76, from: now, calendar: utc
        ))
        XCTAssertEqual(GoalTargetLogic.dayString(from: date, calendar: utc), "2026-12-29")
    }

    func testPaceEstimateNilWhenTargetNotBelowCurrent() {
        XCTAssertNil(GoalTargetLogic.paceEstimateDate(currentKg: 76, targetKg: 76, from: now, calendar: utc))
        XCTAssertNil(GoalTargetLogic.paceEstimateDate(currentKg: 76, targetKg: 80, from: now, calendar: utc))
    }

    func testPaceHintMetricAndImperial() {
        XCTAssertEqual(
            GoalTargetLogic.paceHint(currentKg: 82, targetKg: 76, units: .metric, from: now, calendar: utc),
            "At ~0.5\u{00A0}kg/week that's around Dec 29"
        )
        XCTAssertEqual(
            GoalTargetLogic.paceHint(currentKg: 82, targetKg: 76, units: .imperial, from: now, calendar: utc),
            "At ~1\u{00A0}lb/week that's around Dec 29"
        )
    }

    /// The pace hint and the aggressive-date warning glue each value to its unit
    /// with U+00A0, so a narrow goal sheet wraps between words, never "0.5" / "kg/week".
    func testNoPlainSpaceBetweenADigitAndAUnit() throws {
        let in28Days = now.addingTimeInterval(28 * 86_400)
        for units in [UnitSystem.metric, .imperial] {
            let hint = try XCTUnwrap(
                GoalTargetLogic.paceHint(currentKg: 82, targetKg: 76, units: units, from: now, calendar: utc)
            )
            assertNoBreakableUnitSpace(hint)
            XCTAssertTrue(hint.contains("\u{00A0}\(units.weightUnit)/week"), hint)
            let warning = try XCTUnwrap(GoalTargetLogic.sanityWarning(
                goal: "weight_loss", currentKg: 82, targetKg: 76, targetDate: in28Days, units: units, from: now
            ))
            assertNoBreakableUnitSpace(warning)
            XCTAssertTrue(warning.contains("\u{00A0}\(units.weightUnit)/week"), warning)
        }
    }

    func testPaceHintNilForMissingOrInvalidInputs() {
        XCTAssertNil(GoalTargetLogic.paceHint(currentKg: nil, targetKg: 76, units: .metric, from: now, calendar: utc))
        XCTAssertNil(GoalTargetLogic.paceHint(currentKg: 82, targetKg: nil, units: .metric, from: now, calendar: utc))
        XCTAssertNil(GoalTargetLogic.paceHint(currentKg: 82, targetKg: 10, units: .metric, from: now, calendar: utc))
        XCTAssertNil(GoalTargetLogic.paceHint(currentKg: 82, targetKg: 90, units: .metric, from: now, calendar: utc))
    }

    func testImpliedKgPerWeek() throws {
        let in28Days = now.addingTimeInterval(28 * 86_400)
        let rate = try XCTUnwrap(GoalTargetLogic.impliedKgPerWeek(currentKg: 82, targetKg: 76, by: in28Days, from: now))
        XCTAssertEqual(rate, 1.5, accuracy: 0.001)
        XCTAssertNil(GoalTargetLogic.impliedKgPerWeek(currentKg: 82, targetKg: 76, by: now.addingTimeInterval(-1), from: now))
        XCTAssertNil(GoalTargetLogic.impliedKgPerWeek(currentKg: 76, targetKg: 82, by: in28Days, from: now))
    }

    // MARK: - Sanity warnings

    func testSanityWarningLoss() {
        XCTAssertEqual(
            GoalTargetLogic.sanityWarning(goal: "lose_fat", currentKg: 82, targetKg: 85, targetDate: nil, units: .metric, from: now),
            "Your target should be below your current weight."
        )
        XCTAssertEqual(
            GoalTargetLogic.sanityWarning(goal: "lose_fat", currentKg: 82, targetKg: 55, targetDate: nil, units: .metric, from: now),
            "That's a big change. Consider a closer first target."
        )
        XCTAssertNil(
            GoalTargetLogic.sanityWarning(goal: "lose_fat", currentKg: 82, targetKg: 76, targetDate: nil, units: .metric, from: now)
        )
    }

    func testSanityWarningAggressiveDate() {
        let in28Days = now.addingTimeInterval(28 * 86_400)
        XCTAssertEqual(
            GoalTargetLogic.sanityWarning(goal: "weight_loss", currentKg: 82, targetKg: 76, targetDate: in28Days, units: .metric, from: now),
            "That date needs about 1.5\u{00A0}kg/week, faster than a healthy pace."
        )
        let in120Days = now.addingTimeInterval(120 * 86_400)
        XCTAssertNil(
            GoalTargetLogic.sanityWarning(goal: "weight_loss", currentKg: 82, targetKg: 76, targetDate: in120Days, units: .metric, from: now)
        )
    }

    func testSanityWarningMuscleTargetMustBeAbove() {
        XCTAssertEqual(
            GoalTargetLogic.sanityWarning(goal: "build_muscle", currentKg: 80, targetKg: 78, targetDate: nil, units: .metric, from: now),
            "Your target should be above your current weight."
        )
        XCTAssertNil(
            GoalTargetLogic.sanityWarning(goal: "build_muscle", currentKg: 80, targetKg: 85, targetDate: nil, units: .metric, from: now)
        )
    }

    // MARK: - Dates

    func testDayStringRoundTrip() throws {
        XCTAssertEqual(GoalTargetLogic.dayString(from: now, calendar: utc), "2026-10-06")
        let parsed = try XCTUnwrap(GoalTargetLogic.date(fromDay: "2026-12-29", calendar: utc))
        XCTAssertEqual(GoalTargetLogic.dayString(from: parsed, calendar: utc), "2026-12-29")
        XCTAssertNil(GoalTargetLogic.date(fromDay: "soon", calendar: utc))
    }

    func testTargetDateRangeIsTomorrowToThreeYears() {
        let range = GoalTargetLogic.targetDateRange(from: now, calendar: utc)
        XCTAssertEqual(GoalTargetLogic.dayString(from: range.lowerBound, calendar: utc), "2026-10-07")
        XCTAssertEqual(GoalTargetLogic.dayString(from: range.upperBound, calendar: utc), "2029-10-06")
    }

    func testStartedLine() {
        XCTAssertEqual(
            GoalTargetLogic.startedLine(weightKg: 82, startedAtISO: "2026-09-15T10:00:00Z", units: .metric, calendar: utc),
            "Started at 82\u{00A0}kg on Sep 15"
        )
        XCTAssertEqual(
            GoalTargetLogic.startedLine(weightKg: 82, startedAtISO: "2026-09-15T10:00:00.123Z", units: .imperial, calendar: utc),
            "Started at 181\u{00A0}lb on Sep 15"
        )
        XCTAssertEqual(
            GoalTargetLogic.startedLine(weightKg: nil, startedAtISO: "2026-09-15T10:00:00Z", units: .metric, calendar: utc),
            "Started Sep 15"
        )
        XCTAssertEqual(
            GoalTargetLogic.startedLine(weightKg: 82, startedAtISO: nil, units: .metric, calendar: utc),
            "Started at 82\u{00A0}kg"
        )
        XCTAssertNil(GoalTargetLogic.startedLine(weightKg: nil, startedAtISO: nil, units: .metric, calendar: utc))
    }

    // MARK: - Profile decoding

    func testProfileResponseDecodesGoalTargets() throws {
        let json = """
        {
          "name": "Alex", "integrations": [],
          "stats": {"loggedDays": 1, "mealsLogged": 1, "avgHrv": null, "workouts": 0},
          "profile": {"age": 30, "biologicalSex": "male", "heightCm": 180, "weightKg": 82},
          "targetWeightKg": 76, "targetDate": "2026-12-15", "weeklySessionsTarget": 4,
          "goalStartWeightKg": 82, "goalStartedAt": "2026-09-15T10:00:00.000Z"
        }
        """
        let r = try JSONDecoder().decode(ProfileResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.targetWeightKg, 76)
        XCTAssertEqual(r.targetDate, "2026-12-15")
        XCTAssertEqual(r.weeklySessionsTarget, 4)
        XCTAssertEqual(r.goalStartWeightKg, 82)
        XCTAssertEqual(r.goalStartedAt, "2026-09-15T10:00:00.000Z")
    }

    // MARK: - Weekly distance

    func testWeeklyDistanceShownForEnduranceOnly() {
        XCTAssertTrue(GoalTargetLogic.showsWeeklyDistance(goal: "improve_endurance"))
        XCTAssertTrue(GoalTargetLogic.showsWeeklyDistance(goal: "endurance"))
        XCTAssertFalse(GoalTargetLogic.showsWeeklyDistance(goal: "muscle"))
        XCTAssertFalse(GoalTargetLogic.showsWeeklyDistance(goal: "weight_loss"))
    }

    func testValidWeeklyDistanceKmRangeAndRounding() {
        XCTAssertNil(GoalTargetLogic.validWeeklyDistanceKm(0.5))
        XCTAssertNil(GoalTargetLogic.validWeeklyDistanceKm(301))
        XCTAssertNil(GoalTargetLogic.validWeeklyDistanceKm(nil))
        XCTAssertEqual(GoalTargetLogic.validWeeklyDistanceKm(30.04), 30.0)
    }

    func testDistanceEntryRoundTripsInBothUnits() throws {
        XCTAssertEqual(UnitFormat.distanceEntryText(km: 30, .metric), "30")
        XCTAssertEqual(UnitFormat.distanceEntryText(km: 32.2, .imperial), "20")
        XCTAssertEqual(try XCTUnwrap(UnitFormat.km(fromDistanceEntry: "20", .imperial)), 32.18688, accuracy: 0.001)
        XCTAssertEqual(UnitFormat.km(fromDistanceEntry: "12,5", .metric), 12.5)
        XCTAssertNil(UnitFormat.km(fromDistanceEntry: "abc", .metric))
    }

    func testMissingTargetNudgeOnlyForLossGoalWithoutTarget() {
        XCTAssertEqual(GoalTargetLogic.missingTargetNudge(goal: "lose_fat", targetKg: nil), "Add a target to see how far you have to go")
        XCTAssertEqual(GoalTargetLogic.missingTargetNudge(goal: "weight_loss", targetKg: nil), "Add a target to see how far you have to go")
        XCTAssertNil(GoalTargetLogic.missingTargetNudge(goal: "lose_fat", targetKg: 76))
        XCTAssertNil(GoalTargetLogic.missingTargetNudge(goal: "general_health", targetKg: nil))
        XCTAssertNil(GoalTargetLogic.missingTargetNudge(goal: "build_muscle", targetKg: nil))
    }

    func testOnboardingImportSummaryUsesRealCount() {
        XCTAssertEqual(OnboardingCopy.importSummary(daysUploaded: 212), "Imported 212 days of health history.")
        XCTAssertEqual(OnboardingCopy.importSummary(daysUploaded: 1), "Imported 1 day of health history.")
        XCTAssertEqual(OnboardingCopy.importSummary(daysUploaded: 0), "Your health history is up to date.")
        XCTAssertFalse(OnboardingCopy.importSummary(daysUploaded: 30).contains("365"))
    }

    func testProfileResponseDecodesWeeklyDistanceTarget() throws {
        let json = """
        {
          "name": "Alex", "integrations": [],
          "stats": {"loggedDays": 1, "mealsLogged": 1, "avgHrv": null, "workouts": 0},
          "profile": {"age": 30, "biologicalSex": "male", "heightCm": 180, "weightKg": 82},
          "weeklyDistanceKmTarget": 30
        }
        """
        let r = try JSONDecoder().decode(ProfileResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.weeklyDistanceKmTarget, 30)
        XCTAssertTrue(TodayViewModel.profileHasGoalTarget(r))
    }
}
