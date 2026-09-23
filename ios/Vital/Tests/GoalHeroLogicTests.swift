import XCTest
@testable import Vital

/// Unit tests for the pure decision logic backing the muscle and endurance
/// Today heroes (docs/ux-spec-v4.md §4.1) — see `GoalHeroLogic.swift`.
final class GoalHeroLogicTests: XCTestCase {

    // MARK: - MuscleHeroLogic.todaySession / rest day

    private func planItem(id: String, kind: PlanItem.Kind, status: PlanItem.Status, title: String = "Session") -> PlanItem {
        PlanItem(
            id: id, timeMinutes: 600, title: title, subtitle: "",
            sfSymbol: "circle", status: status, source: .coach, kind: kind
        )
    }

    func testMuscleTodaySessionPicksTheMoveKindItem() {
        let items = [
            planItem(id: "meal", kind: .meal, status: .later),
            planItem(id: "lift", kind: .move, status: .later, title: "Lower-body strength"),
        ]
        XCTAssertEqual(MuscleHeroLogic.todaySession(from: items)?.id, "lift")
    }

    func testMuscleTodaySessionIgnoresSkippedMoveItem() {
        let items = [planItem(id: "lift", kind: .move, status: .skipped)]
        XCTAssertNil(MuscleHeroLogic.todaySession(from: items))
    }

    func testMuscleTodaySessionStillCountsWhenDone() {
        // A completed session keeps showing what was trained rather than
        // flipping to the rest-day copy the moment it's logged.
        let items = [planItem(id: "lift", kind: .move, status: .done)]
        XCTAssertEqual(MuscleHeroLogic.todaySession(from: items)?.id, "lift")
    }

    func testMuscleTodaySessionNilWithNoMoveItem() {
        let items = [planItem(id: "meal", kind: .meal, status: .later)]
        XCTAssertNil(MuscleHeroLogic.todaySession(from: items))
    }

    func testMuscleRestDayCopyIsExact() {
        XCTAssertEqual(MuscleHeroLogic.restDayText, "Rest day. Protein still counts.")
    }

    func testEnduranceRestDayCopyIsExact() {
        XCTAssertEqual(EnduranceHeroLogic.restDayText, "No session planned today.")
    }

    func testEnduranceTodaySessionSameRuleAsMuscle() {
        let items = [planItem(id: "run", kind: .move, status: .later, title: "10km tempo run")]
        XCTAssertEqual(EnduranceHeroLogic.todaySession(from: items)?.id, "run")
    }

    // MARK: - MuscleHeroLogic.sessionsThisWeek

    func testSessionsThisWeekCountsOnlyPlannedDays() {
        let records = [
            MuscleHeroLogic.WeeklySessionRecord(planned: true, completed: true),
            MuscleHeroLogic.WeeklySessionRecord(planned: true, completed: true),
            MuscleHeroLogic.WeeklySessionRecord(planned: true, completed: false),
            MuscleHeroLogic.WeeklySessionRecord(planned: true, completed: false),
            MuscleHeroLogic.WeeklySessionRecord(planned: false, completed: false),
            MuscleHeroLogic.WeeklySessionRecord(planned: false, completed: true), // ignored — not planned
        ]
        let result = MuscleHeroLogic.sessionsThisWeek(records)
        XCTAssertEqual(result.done, 2)
        XCTAssertEqual(result.total, 4)
    }

    func testSessionsThisWeekAllDone() {
        let records = [
            MuscleHeroLogic.WeeklySessionRecord(planned: true, completed: true),
            MuscleHeroLogic.WeeklySessionRecord(planned: true, completed: true),
        ]
        let result = MuscleHeroLogic.sessionsThisWeek(records)
        XCTAssertEqual(result.done, 2)
        XCTAssertEqual(result.total, 2)
    }

    func testSessionsThisWeekEmptyIsZeroOfZero() {
        let result = MuscleHeroLogic.sessionsThisWeek([])
        XCTAssertEqual(result.done, 0)
        XCTAssertEqual(result.total, 0)
    }

    func testSessionDotsFormatsFilledThenEmpty() {
        XCTAssertEqual(MuscleHeroLogic.sessionDots(done: 2, total: 4), "● ● ○ ○")
    }

    func testSessionDotsNilWhenNothingPlanned() {
        XCTAssertNil(MuscleHeroLogic.sessionDots(done: 0, total: 0))
    }

    func testSessionsThisWeekTextNilWhenNothingPlanned() {
        XCTAssertNil(MuscleHeroLogic.sessionsThisWeekText(done: 0, total: 0))
    }

    func testSessionsThisWeekTextFormatsDoneOfTotal() {
        XCTAssertEqual(MuscleHeroLogic.sessionsThisWeekText(done: 2, total: 4), "2 of 4 sessions")
    }

    // MARK: - EnduranceHeroLogic.readinessWord

    func testReadinessWordAllNormalIsKeepItEasy() {
        let word = EnduranceHeroLogic.readinessWord(hrv: .normal, sleep: .normal, restingHR: .normal)
        XCTAssertEqual(word, .keepItEasy)
    }

    func testReadinessWordHrvAboveAndSleepAboveIsReadyToPush() {
        // HRV above normal (good) and sleep above normal (good) → net +2.
        let word = EnduranceHeroLogic.readinessWord(hrv: .above(z: 1.4), sleep: .above(z: 1.2), restingHR: .normal)
        XCTAssertEqual(word, .readyToPush)
    }

    func testReadinessWordLowRestingHRAloneIsReadyToPush() {
        // Resting HR below normal is GOOD (lower is better) → net +1.
        let word = EnduranceHeroLogic.readinessWord(hrv: .normal, sleep: .normal, restingHR: .below(z: -1.1))
        XCTAssertEqual(word, .readyToPush)
    }

    func testReadinessWordHrvBelowAndRestingHRAboveIsRecoverToday() {
        // HRV below normal (bad) and resting HR above normal (bad) → net -2.
        let word = EnduranceHeroLogic.readinessWord(hrv: .below(z: -1.3), sleep: .normal, restingHR: .above(z: 1.5))
        XCTAssertEqual(word, .recoverToday)
    }

    func testReadinessWordMixedSignalsCancelToKeepItEasy() {
        // HRV above (good, +1) and resting HR above (bad, -1) cancel out.
        let word = EnduranceHeroLogic.readinessWord(hrv: .above(z: 1.2), sleep: .normal, restingHR: .above(z: 1.2))
        XCTAssertEqual(word, .keepItEasy)
    }

    func testReadinessWordTreatsNoDataAsNeutralNeverBad() {
        // Missing readings must never read as "bad" — only real signal moves
        // the word away from the neutral default.
        let word = EnduranceHeroLogic.readinessWord(hrv: .noData, sleep: .noData, restingHR: .noData)
        XCTAssertEqual(word, .keepItEasy)
    }

    func testReadinessWordTreatsCalibratingAsNeutral() {
        let word = EnduranceHeroLogic.readinessWord(
            hrv: .calibrating(daysRemaining: 3), sleep: .normal, restingHR: .normal
        )
        XCTAssertEqual(word, .keepItEasy)
    }

    // MARK: - EnduranceHeroLogic.calibratingText

    func testCalibratingTextFormatsDayOf14() {
        XCTAssertEqual(EnduranceHeroLogic.calibratingText(daysCollected: 5), "Calibrating · day 5 of 14")
    }

    func testCalibratingTextClampsToZeroAndFourteen() {
        XCTAssertEqual(EnduranceHeroLogic.calibratingText(daysCollected: -2), "Calibrating · day 0 of 14")
        XCTAssertEqual(EnduranceHeroLogic.calibratingText(daysCollected: 30), "Calibrating · day 14 of 14")
    }

    // MARK: - EnduranceHeroLogic.weeklyVolumeText (honesty rule — omitted when missing)

    func testWeeklyVolumeTextNilWhenDoneMissing() {
        XCTAssertNil(EnduranceHeroLogic.weeklyVolumeText(kmDone: nil, kmTarget: 40, system: .metric))
    }

    func testWeeklyVolumeTextNilWhenTargetMissing() {
        XCTAssertNil(EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: nil, system: .metric))
    }

    func testWeeklyVolumeTextNilWhenTargetIsZero() {
        XCTAssertNil(EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: 0, system: .metric))
    }

    func testWeeklyVolumeTextFormatsWhenBothPresent() {
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: 40, system: .metric)
        XCTAssertEqual(text, "Week 24 km of 40 km")
    }
}
