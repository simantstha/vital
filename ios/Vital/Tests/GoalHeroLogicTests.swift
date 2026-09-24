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

    func testReadinessWordAllNormalIsGoodToTrain() {
        // Coaching review, 2026-09-23: nothing flagged means "train as
        // planned", not "hold back" — this is the common case.
        let word = EnduranceHeroLogic.readinessWord(hrv: .normal, sleep: .normal, restingHR: .normal)
        XCTAssertEqual(word, .goodToTrain)
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
        // HRV below normal (bad) and resting HR above normal (bad) → net -2,
        // a strong-enough combined negative on its own.
        let word = EnduranceHeroLogic.readinessWord(hrv: .below(z: -1.3), sleep: .normal, restingHR: .above(z: 1.5))
        XCTAssertEqual(word, .recoverToday)
    }

    func testReadinessWordSingleMildNegativeIsKeepItEasy() {
        // HRV below normal (bad, -1), everything else normal → net -1, a
        // mild negative — "Keep it easy", not the stronger "Recover today".
        let word = EnduranceHeroLogic.readinessWord(hrv: .below(z: -1.2), sleep: .normal, restingHR: .normal)
        XCTAssertEqual(word, .keepItEasy)
    }

    func testReadinessWordMixedSignalsCancelToGoodToTrain() {
        // HRV above (good, +1) and resting HR above (bad, -1) cancel out to
        // a net-0 score — same as all-normal, so "Good to train".
        let word = EnduranceHeroLogic.readinessWord(hrv: .above(z: 1.2), sleep: .normal, restingHR: .above(z: 1.2))
        XCTAssertEqual(word, .goodToTrain)
    }

    func testReadinessWordSingleStronglyBadMetricIsRecoverTodayEvenIfScoreCancels() {
        // HRV strongly below normal (z <= -2, bad) and resting HR mildly
        // above normal (bad too) both push negative here, but the point is
        // that a single |z| >= 2 metric forces "Recover today" regardless
        // of what the total score alone would say.
        let word = EnduranceHeroLogic.readinessWord(hrv: .below(z: -2.4), sleep: .normal, restingHR: .normal)
        XCTAssertEqual(word, .recoverToday)
    }

    func testReadinessWordStronglyBadRestingHRAloneIsRecoverToday() {
        // Resting HR strongly ABOVE normal (bad direction, z >= 2) alone
        // forces "Recover today" even though the raw sum is only -1.
        let word = EnduranceHeroLogic.readinessWord(hrv: .normal, sleep: .normal, restingHR: .above(z: 2.5))
        XCTAssertEqual(word, .recoverToday)
    }

    func testReadinessWordTreatsNoDataAsNeutralNeverBad() {
        // Missing readings must never read as "bad" — only real signal moves
        // the word away from the neutral default.
        let word = EnduranceHeroLogic.readinessWord(hrv: .noData, sleep: .noData, restingHR: .noData)
        XCTAssertEqual(word, .goodToTrain)
    }

    func testReadinessWordTreatsCalibratingAsNeutral() {
        let word = EnduranceHeroLogic.readinessWord(
            hrv: .calibrating(daysRemaining: 3), sleep: .normal, restingHR: .normal
        )
        XCTAssertEqual(word, .goodToTrain)
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
        XCTAssertNil(EnduranceHeroLogic.weeklyVolumeText(kmDone: nil, kmTarget: nil, system: .metric))
    }

    func testWeeklyVolumeTextFormatsDoneOnlyWhenNoTarget() {
        // `volume.target` is always null today (#202) — this is the common
        // real-world case.
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24.5, kmTarget: nil, system: .metric)
        XCTAssertEqual(text, "24.5 km this week")
    }

    func testWeeklyVolumeTextFormatsDoneOnlyWhenTargetIsZero() {
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: 0, system: .metric)
        XCTAssertEqual(text, "24 km this week")
    }

    func testWeeklyVolumeTextFormatsDoneOfTargetWhenTargetPresent() {
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: 40, system: .metric)
        XCTAssertEqual(text, "24 km of 40 km")
    }

    func testWeeklyVolumeTextRespectsImperialSystem() {
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: nil, system: .imperial)
        XCTAssertEqual(text, "\(UnitFormat.distance(km: 24, .imperial)) this week")
    }

    // MARK: - MuscleHeroLogic.sessionsThisWeekFallbackText

    func testSessionsThisWeekFallbackTextSingular() {
        XCTAssertEqual(MuscleHeroLogic.sessionsThisWeekFallbackText(completed: 1), "1 session this week")
    }

    func testSessionsThisWeekFallbackTextPlural() {
        XCTAssertEqual(MuscleHeroLogic.sessionsThisWeekFallbackText(completed: 3), "3 sessions this week")
    }

    func testSessionsThisWeekFallbackTextClampsNegative() {
        XCTAssertEqual(MuscleHeroLogic.sessionsThisWeekFallbackText(completed: -1), "0 sessions this week")
    }

    // MARK: - MuscleHeroLogic.lastLiftText (honesty rule — nil only on bad date)

    func testLastLiftTextWithWeight() {
        // 2026-09-21 is a Monday.
        let text = MuscleHeroLogic.lastLiftText(
            exercise: "Deadlift", date: "2026-09-21", sets: 2, reps: 5, weightKg: 150, system: .metric
        )
        XCTAssertEqual(text, "Last (Mon): Deadlift 2×5 @ 150 kg")
    }

    func testLastLiftTextBodyweightWhenWeightMissing() {
        let text = MuscleHeroLogic.lastLiftText(
            exercise: "Pull-up", date: "2026-09-21", sets: 3, reps: 8, weightKg: nil, system: .metric
        )
        XCTAssertEqual(text, "Last (Mon): Pull-up 3×8 bodyweight")
    }

    func testLastLiftTextRespectsImperialSystem() {
        let text = MuscleHeroLogic.lastLiftText(
            exercise: "Bench", date: "2026-09-21", sets: 3, reps: 5, weightKg: 84, system: .imperial
        )
        XCTAssertEqual(text, "Last (Mon): Bench 3×5 @ \(UnitFormat.weight(kg: 84, .imperial))")
    }

    func testLastLiftTextNilOnUnparseableDate() {
        XCTAssertNil(MuscleHeroLogic.lastLiftText(
            exercise: "Squat", date: "not-a-date", sets: 3, reps: 5, weightKg: 140, system: .metric
        ))
    }

    func testWeekdayShortLabelKnownDates() {
        XCTAssertEqual(MuscleHeroLogic.weekdayShortLabel(forDateString: "2026-09-24"), "Thu")
        XCTAssertEqual(MuscleHeroLogic.weekdayShortLabel(forDateString: "2026-09-21"), "Mon")
    }
}
