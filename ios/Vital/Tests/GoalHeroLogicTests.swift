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
        XCTAssertEqual(MuscleHeroLogic.sessionsThisWeekText(done: 2, total: 4), "2 of 4 sessions this week")
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
        XCTAssertEqual(EnduranceHeroLogic.calibratingText(daysCollected: 5), "Getting to know your normal · day 5 of 14")
    }

    func testCalibratingTextClampsToZeroAndFourteen() {
        XCTAssertEqual(EnduranceHeroLogic.calibratingText(daysCollected: -2), "Getting to know your normal · day 0 of 14")
        XCTAssertEqual(EnduranceHeroLogic.calibratingText(daysCollected: 30), "Getting to know your normal · day 14 of 14")
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
        XCTAssertEqual(text, "24.5\u{00A0}km this week")
    }

    func testWeeklyVolumeTextFormatsDoneOnlyWhenTargetIsZero() {
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: 0, system: .metric)
        XCTAssertEqual(text, "24\u{00A0}km this week")
    }

    func testWeeklyVolumeTextFormatsDoneOfTargetWhenTargetPresent() {
        let text = EnduranceHeroLogic.weeklyVolumeText(kmDone: 24, kmTarget: 40, system: .metric)
        XCTAssertEqual(text, "24\u{00A0}km of 40\u{00A0}km")
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
        XCTAssertEqual(text, "Last (Mon): Deadlift 2×5 @ 150\u{00A0}kg")
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

    // MARK: - EnduranceHeroLogic.weeklySessionsAndVolumeText (combined line)

    func testWeeklySessionsAndVolumeTextBothPresent() {
        // Fixture endurance scenario: 3 sessions, 24.5 km
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: 3, kmDone: 24.5, system: .metric
        )
        XCTAssertEqual(text, "3 sessions · 24.5\u{00A0}km this week")
    }

    func testWeeklySessionsAndVolumeTextSingleSession() {
        // Singular form when only 1 session
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: 1, kmDone: 12.0, system: .metric
        )
        XCTAssertEqual(text, "1 session · 12\u{00A0}km this week")
    }

    func testWeeklySessionsAndVolumeTextOnlySessionsNoVolume() {
        // Only sessions available
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: 3, kmDone: nil, system: .metric
        )
        XCTAssertEqual(text, "3 sessions this week")
    }

    func testWeeklySessionsAndVolumeTextOnlyVolumeNoSessions() {
        // Only volume available
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: nil, kmDone: 24.5, system: .metric
        )
        XCTAssertEqual(text, "24.5\u{00A0}km this week")
    }

    func testWeeklySessionsAndVolumeTextNeitherPresent() {
        // Neither available
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: nil, kmDone: nil, system: .metric
        )
        XCTAssertNil(text)
    }

    func testWeeklySessionsAndVolumeTextRespectsImperialSystem() {
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: 2, kmDone: 24.0, system: .imperial
        )
        XCTAssertEqual(
            text,
            "2 sessions · \(UnitFormat.distance(km: 24.0, .imperial)) this week"
        )
    }

    func testWeeklySessionsAndVolumeTextClampsNegativeSessions() {
        // Negative sessions should be clamped to 0 (honesty rule)
        let text = EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: -1, kmDone: 10.0, system: .metric
        )
        XCTAssertEqual(text, "0 sessions · 10\u{00A0}km this week")
    }

    // MARK: - EnduranceHeroLogic readiness vs planned session

    private func session(_ title: String, subtitle: String = "", status: PlanItem.Status = .later, kind: PlanItem.Kind = .move) -> PlanItem {
        PlanItem(id: "s", timeMinutes: 420, title: title, subtitle: subtitle,
                 sfSymbol: "figure.run", status: status, source: .coach, kind: kind)
    }

    func testIsHardSessionRecognisesHardWorkoutsAndSparesEasyOnes() {
        for title in ["10km tempo run", "6 x 800m intervals", "Long run", "Threshold session", "Hill repeats", "Race day", "VO2max set"] {
            XCTAssertTrue(EnduranceHeroLogic.isHardSession(session(title)), title)
        }
        for title in ["Easy 5km", "Recovery jog", "Easy long walk", "Yoga", "Strength"] {
            XCTAssertFalse(EnduranceHeroLogic.isHardSession(session(title)), title)
        }
        XCTAssertTrue(EnduranceHeroLogic.isHardSession(session("Run", subtitle: "RPE 8")))
        XCTAssertFalse(EnduranceHeroLogic.isHardSession(session("Run", subtitle: "RPE 4")))
        XCTAssertFalse(EnduranceHeroLogic.isHardSession(session("Tempo run", kind: .meal)))
    }

    func testReconciliationShowsWhenReadinessSaysRecoverAndSessionIsHard() {
        let tempo = session("10km tempo run")
        XCTAssertEqual(
            EnduranceHeroLogic.reconciliationText(readinessWord: .recoverToday, isCalibrating: false, session: tempo),
            "Your body says recover \u{2014} swap to an easy 30 min or rest?"
        )
        XCTAssertEqual(
            EnduranceHeroLogic.reconciliationText(readinessWord: .keepItEasy, isCalibrating: false, session: tempo),
            "Your body says take it easy \u{2014} swap to an easy 30 min or rest?"
        )
    }

    func testReconciliationHiddenWhenNotApplicable() {
        let tempo = session("10km tempo run")
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: .goodToTrain, isCalibrating: false, session: tempo))
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: .readyToPush, isCalibrating: false, session: tempo))
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: .recoverToday, isCalibrating: true, session: tempo))
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: .recoverToday, isCalibrating: false, session: nil))
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: .recoverToday, isCalibrating: false, session: session("Easy 5km")))
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: .recoverToday, isCalibrating: false, session: session("10km tempo run", status: .done)))
        XCTAssertNil(EnduranceHeroLogic.reconciliationText(readinessWord: nil, isCalibrating: false, session: tempo))
    }

    func testReconciliationCoachPromptNamesSessionAndReadiness() {
        let prompt = EnduranceHeroLogic.reconciliationCoachPrompt(
            readinessWord: .recoverToday, reasonLine: "HRV -12 %", session: session("10km tempo run")
        )
        XCTAssertTrue(prompt.contains("recover today"))
        XCTAssertTrue(prompt.contains("HRV -12 %"))
        XCTAssertTrue(prompt.contains("10km tempo run"))
    }

    // MARK: - WeightHeroLogic sparkline target

    func testSparklineTargetDrawnOnlyWhenNearEnoughNotToFlattenTheTrend() {
        let values = [82.0, 82.4, 83.0, 83.7]   // span 1.7
        XCTAssertTrue(WeightHeroLogic.sparklineTargetVisible(values: values, minSpan: 1, target: 80))
        XCTAssertFalse(WeightHeroLogic.sparklineTargetVisible(values: values, minSpan: 1, target: 76), "6 kg away > 3 spans")
        XCTAssertTrue(WeightHeroLogic.sparklineTargetVisible(values: values, minSpan: 1, target: 82.5), "inside the range")
        XCTAssertFalse(WeightHeroLogic.sparklineTargetVisible(values: values, minSpan: 1, target: nil))
        let near = WeightHeroLogic.sparklineDomain(values: values, minSpan: 1, target: 80)!
        XCTAssertLessThanOrEqual(near.lowerBound, 80)
    }

    func testFarTargetIsCompressedBelowTheTrendNotOmitted() {
        let values = [82.0, 82.4, 83.0, 83.7]
        let base = WeightHeroLogic.sparklineDomain(values: values, minSpan: 1)!
        let layout = WeightHeroLogic.sparklineLayout(values: values, minSpan: 1, target: 76)!
        XCTAssertTrue(layout.targetCompressed)
        let line = layout.targetLine!
        // Trend keeps its own range in the upper part; the line sits below it, inside the domain.
        XCTAssertEqual(layout.domain.upperBound, base.upperBound, accuracy: 1e-9)
        XCTAssertLessThan(layout.domain.lowerBound, base.lowerBound)
        XCTAssertLessThan(line, base.lowerBound)
        XCTAssertGreaterThan(line, layout.domain.lowerBound)
        // Not to scale: nowhere near the real 76.
        XCTAssertGreaterThan(line, 76)
        XCTAssertEqual(WeightHeroLogic.sparklineDomain(values: values, minSpan: 1, target: 76), layout.domain)
    }

    func testFarTargetAboveTheTrendCompressesUpward() {
        let values = [60.0, 60.4, 61.0]
        let base = WeightHeroLogic.sparklineDomain(values: values, minSpan: 1)!
        let layout = WeightHeroLogic.sparklineLayout(values: values, minSpan: 1, target: 80)!
        XCTAssertTrue(layout.targetCompressed)
        XCTAssertGreaterThan(layout.targetLine!, base.upperBound)
        XCTAssertLessThan(layout.targetLine!, layout.domain.upperBound)
    }

    func testNearOrAbsentTargetIsNotCompressed() {
        let values = [82.0, 82.4, 83.0, 83.7]
        let near = WeightHeroLogic.sparklineLayout(values: values, minSpan: 1, target: 80)!
        XCTAssertFalse(near.targetCompressed)
        XCTAssertEqual(near.targetLine, 80)
        let none = WeightHeroLogic.sparklineLayout(values: values, minSpan: 1, target: nil)!
        XCTAssertNil(none.targetLine)
        XCTAssertNil(WeightHeroLogic.sparklineLayout(values: [], minSpan: 1, target: 76))
    }

    func testTargetArrowPointsDownForCompressedLossGoal() {
        let values = [82.0, 83.7]
        let far = WeightHeroLogic.sparklineLayout(values: values, minSpan: 1, target: 70)
        XCTAssertEqual(WeightHeroLogic.sparklineTargetArrow(layout: far, targetKg: 70, lastKg: 83.7), "↓")
        let near = WeightHeroLogic.sparklineLayout(values: values, minSpan: 1, target: 81)
        XCTAssertEqual(WeightHeroLogic.sparklineTargetArrow(layout: near, targetKg: 81, lastKg: 83.7), "→")
        XCTAssertEqual(WeightHeroLogic.sparklineTargetArrow(layout: nil, targetKg: nil, lastKg: nil), "→")
    }

    func testSparklineCaptionsAreUnitAware() {
        let metric = WeightHeroLogic.sparklineCaptions(firstKg: 83.7, lastKg: 82, targetKg: 76, system: .metric)
        XCTAssertEqual(metric?.start, "Start 83.7\u{00A0}kg")
        XCTAssertEqual(metric?.now, "Now 82\u{00A0}kg")
        XCTAssertEqual(metric?.target, "Goal 76\u{00A0}kg")
        let imperial = WeightHeroLogic.sparklineCaptions(firstKg: 83.7, lastKg: 82, targetKg: nil, system: .imperial)
        XCTAssertEqual(imperial?.start, "Start 185\u{00A0}lb")
        XCTAssertNil(imperial?.target)
        XCTAssertNil(WeightHeroLogic.sparklineCaptions(firstKg: nil, lastKg: 82, targetKg: 76, system: .metric))
    }

    // MARK: - Profile goal row

    func testGoalRowLabelShowsTheTarget() {
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Lose weight", goalId: "weight_loss", targetWeightKg: 76, weeklySessions: nil, system: .metric), "Lose weight \u{00B7} 76\u{00A0}kg")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Build muscle", goalId: "muscle", targetWeightKg: 82, weeklySessions: 4, system: .metric), "Build muscle \u{00B7} 4\u{00D7}/week")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Build muscle", goalId: "muscle", targetWeightKg: 82, weeklySessions: nil, system: .metric), "Build muscle \u{00B7} 82\u{00A0}kg")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Endurance", goalId: "endurance", targetWeightKg: nil, weeklySessions: 3, system: .metric), "Endurance \u{00B7} 3\u{00D7}/week")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Endurance", goalId: "endurance", targetWeightKg: nil, weeklySessions: 3, weeklyDistanceKm: 30, system: .metric), "Endurance \u{00B7} 30\u{00A0}km/week")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Endurance", goalId: "endurance", targetWeightKg: nil, weeklySessions: nil, weeklyDistanceKm: 32.2, system: .imperial), "Endurance \u{00B7} 20\u{00A0}mi/week")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Lose weight", goalId: "weight_loss", targetWeightKg: nil, weeklySessions: nil, system: .metric), "Lose weight")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "Maintain", goalId: "general", targetWeightKg: 70, weeklySessions: 3, system: .metric), "Maintain")
        XCTAssertEqual(ProfileViewModel.goalRowLabel(goalLabel: "", goalId: "", targetWeightKg: nil, weeklySessions: nil, system: .metric), "")
    }

    // MARK: - Voice FAB scroll behaviour

    func testFabShrinksOnDownwardScrollAndRestoresOnUpwardOrEdges() {
        // Scrolling down mid-page -> compact.
        XCTAssertTrue(VoiceFABScroll.isCompact(current: false, oldOffset: 100, newOffset: 140, maxOffset: 1000))
        // Scrolling up -> restored.
        XCTAssertFalse(VoiceFABScroll.isCompact(current: true, oldOffset: 300, newOffset: 260, maxOffset: 1000))
        // Tiny jitter keeps the current state.
        XCTAssertTrue(VoiceFABScroll.isCompact(current: true, oldOffset: 300, newOffset: 302, maxOffset: 1000))
        XCTAssertFalse(VoiceFABScroll.isCompact(current: false, oldOffset: 300, newOffset: 298, maxOffset: 1000))
        // Top (incl. pull-to-refresh rubber band) and bottom always restore.
        XCTAssertFalse(VoiceFABScroll.isCompact(current: true, oldOffset: 60, newOffset: 10, maxOffset: 1000))
        XCTAssertFalse(VoiceFABScroll.isCompact(current: true, oldOffset: 0, newOffset: -40, maxOffset: 1000))
        XCTAssertFalse(VoiceFABScroll.isCompact(current: false, oldOffset: 960, newOffset: 990, maxOffset: 1000))
    }

    // MARK: - Profile goal row with a race

    func testGoalRowLabelAppendsTheEnduranceRace() {
        let now = ISO8601DateFormatter().date(from: "2026-10-06T12:00:00Z")!
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        func label(_ goalId: String, sessions: Int? = nil, km: Double? = nil, race: String? = "2026-12-30", raceKm: Double? = 21.1, system: UnitSystem = .metric) -> String {
            ProfileViewModel.goalRowLabel(
                goalLabel: goalId == "endurance" ? "Endurance" : "Build muscle", goalId: goalId, targetWeightKg: nil,
                weeklySessions: sessions, weeklyDistanceKm: km, raceDate: race, raceDistanceKm: raceKm,
                now: now, calendar: utc, system: system
            )
        }
        // The race leads (and replaces the generic "Endurance"), so what survives
        // a narrow row is the race, not the goal word.
        XCTAssertEqual(label("endurance", km: 30), "Half marathon \u{00B7} Dec 30 \u{00B7} 30\u{00A0}km/wk")
        XCTAssertEqual(label("endurance", km: 32.2, system: .imperial), "Half marathon \u{00B7} Dec 30 \u{00B7} 20\u{00A0}mi/wk")
        XCTAssertEqual(label("endurance", sessions: 3), "Half marathon \u{00B7} Dec 30 \u{00B7} 3\u{00D7}/wk")
        XCTAssertEqual(label("endurance"), "Half marathon \u{00B7} Dec 30", "race alone is still worth showing")
        XCTAssertEqual(label("endurance", km: 30, raceKm: nil), "Race \u{00B7} Dec 30 \u{00B7} 30\u{00A0}km/wk")
        XCTAssertFalse(label("endurance", km: 30).contains("Endurance"))
        // The number never separates from its unit on a wrapped row ("30" / "km/wk").
        XCTAssertTrue(label("endurance", km: 30).hasSuffix("30\u{00A0}km/wk"))
        XCTAssertFalse(label("endurance", km: 30).contains("30 km"))
        // A passed race / no race leaves the old label; other goals never show a race.
        XCTAssertEqual(label("endurance", km: 30, race: "2026-10-01"), "Endurance \u{00B7} 30\u{00A0}km/week")
        XCTAssertEqual(label("endurance", km: 30, race: nil), "Endurance \u{00B7} 30\u{00A0}km/week")
        XCTAssertEqual(label("muscle", sessions: 4), "Build muscle \u{00B7} 4\u{00D7}/week")
        XCTAssertEqual(label("endurance", race: nil), "Endurance")
    }

    // MARK: - Endurance readiness reason line (absolute units)

    func testRecoveryClauseIsAbsoluteAgainstTheNormal() {
        XCTAssertEqual(EnduranceHeroLogic.recoveryClause(label: "HRV", value: 51, normal: 57, unit: "ms"), "HRV \u{2212}6 ms")
        XCTAssertEqual(EnduranceHeroLogic.recoveryClause(label: "RHR", value: 54, normal: 48.74, unit: "bpm"), "RHR +5 bpm")
        XCTAssertEqual(EnduranceHeroLogic.recoveryClause(label: "HRV", value: 57.2, normal: 57, unit: "ms"), "HRV at your normal")
        // Same half-to-even rounding as Trends' NumberFormatter: -6.5 -> -6.
        XCTAssertEqual(EnduranceHeroLogic.recoveryClause(label: "HRV", value: 51, normal: 57.5, unit: "ms"), "HRV \u{2212}6 ms")
        // Baseline not loaded yet: the bare reading, never a percentage.
        XCTAssertEqual(EnduranceHeroLogic.recoveryClause(label: "HRV", value: 51, normal: nil, unit: "ms"), "HRV 51 ms")
        XCTAssertNil(EnduranceHeroLogic.recoveryClause(label: "HRV", value: nil, normal: 57, unit: "ms"))
    }

    func testReasonLineReadsHrvThenRhrThenSleepInAbsoluteUnits() {
        let line = EnduranceHeroLogic.reasonLine(hrv: 51, hrvNormal: 57, restingHR: 54, restingHRNormal: 48.74, sleepText: "5h 48m")
        XCTAssertEqual(line, "HRV \u{2212}6 ms \u{00B7} RHR +5 bpm \u{00B7} Sleep 5h 48m")
        XCTAssertFalse(line?.contains("%") ?? true, "no percentages on the hero")
        // Metrics without a value drop out; nothing at all is nil.
        XCTAssertEqual(
            EnduranceHeroLogic.reasonLine(hrv: nil, hrvNormal: nil, restingHR: nil, restingHRNormal: nil, sleepText: "7h 10m"),
            "Sleep 7h 10m"
        )
        XCTAssertEqual(
            EnduranceHeroLogic.reasonLine(hrv: 62, hrvNormal: 57, restingHR: nil, restingHRNormal: nil, sleepText: nil),
            "HRV +5 ms"
        )
        XCTAssertNil(EnduranceHeroLogic.reasonLine(hrv: nil, hrvNormal: 57, restingHR: nil, restingHRNormal: nil, sleepText: nil))
        XCTAssertNil(EnduranceHeroLogic.reasonLine(hrv: nil, hrvNormal: nil, restingHR: nil, restingHRNormal: nil, sleepText: ""))
    }

}
