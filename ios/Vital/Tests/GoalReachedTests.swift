import XCTest
@testable import Vital

/// The goal-reached state (server contract: verdict `"reached"`, `reachedAt`
/// ISO date or null, a reason of kind `next_step`), the capped weight line, the
/// stale-weigh-in nudge for any goal with a target weight, the two next-step
/// actions, and the colour-only tone words VoiceOver now speaks. Decoding stays
/// tolerant: an unknown verdict still reads as `insufficient_data`.
@MainActor
final class GoalReachedTests: XCTestCase {

    private let en = Locale(identifier: "en_US")

    /// 2026-10-06 12:00 UTC.
    private var now: Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: 12))!
    }

    private func plain(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{2060}", with: "")
    }

    /// A synthetic server payload in the "reached" shape: 90 -> 82 kg, now 81.6
    /// (0.4 kg past the target), reached Oct 3, last weigh-in 9 days ago.
    private let reachedJSON = """
    {
      "goal": "weight_loss",
      "target": { "weightKg": 82, "date": "2026-12-29", "weeklySessions": null },
      "current": { "weightKg": 81.6, "startWeightKg": 90, "changeKg": -8.4, "progressPct": 105 },
      "ratePerWeek": { "kg": -0.4, "pctBodyweight": -0.5 },
      "safeBand": { "minPct": 0.25, "maxPct": 1 },
      "eta": null,
      "onPaceForTargetDate": null,
      "verdict": "reached",
      "reachedAt": "2026-10-03",
      "headline": "Goal reached — 82 kg hit on Oct 3",
      "reasons": [
        { "kind": "next_step", "text": "Set a new target or switch to maintenance", "tone": "neutral" },
        { "kind": "rate", "text": "Lost 0.4 kg a week over the last month", "tone": "good" }
      ],
      "dataSufficiency": { "weighIns": 14, "needed": 3, "sessionsLast28d": 0 },
      "lastWeighInDaysAgo": 9
    }
    """

    private func decode(_ json: String) throws -> GoalProgressDTO {
        try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
    }

    private func reached() throws -> GoalProgressDTO { try decode(reachedJSON) }

    // MARK: - Contract decoding

    func testSyntheticReachedPayloadDecodes() throws {
        let progress = try reached()
        XCTAssertEqual(progress.verdict, .reached)
        XCTAssertEqual(progress.reachedAt, "2026-10-03")
        XCTAssertEqual(progress.reasons.map(\.kind), ["next_step", "rate"])
        XCTAssertEqual(progress.reasons.first?.tone, .neutral)
        XCTAssertTrue(GoalProgressLogic.isReached(progress))
    }

    func testUnknownVerdictsStillDecodeAsInsufficientData() throws {
        for wire in ["mastered", "REACHED", "goal_reached", ""] {
            let progress = try decode("{\"goal\":\"weight_loss\",\"verdict\":\"\(wire)\",\"headline\":\"x\",\"reasons\":[]}")
            XCTAssertEqual(progress.verdict, .insufficientData, "\(wire)")
        }
        XCTAssertEqual(GoalVerdict(wire: nil), .insufficientData)
        XCTAssertEqual(GoalVerdict(wire: "reached"), .reached)
        // The verdicts that existed before keep their wire names.
        XCTAssertEqual(GoalVerdict(wire: "on_track"), .onTrack)
        XCTAssertEqual(GoalVerdict(wire: "needs_target"), .needsTarget)
    }

    func testReachedAtDecodesTolerantly() throws {
        func progress(_ extra: String) throws -> GoalProgressDTO {
            try decode("{\"goal\":\"weight_loss\",\"verdict\":\"reached\",\"headline\":\"x\",\"reasons\":[]\(extra)}")
        }
        XCTAssertEqual(try progress(",\"reachedAt\":\"2026-10-03T14:22:00.000Z\"").reachedAt, "2026-10-03T14:22:00.000Z")
        XCTAssertNil(try progress(",\"reachedAt\":null").reachedAt)
        XCTAssertNil(try progress("").reachedAt)
        XCTAssertNil(try progress(",\"reachedAt\":20261003").reachedAt)
        // A payload from before the field existed is unaffected.
        let old = try decode("{\"goal\":\"weight_loss\",\"verdict\":\"on_track\",\"headline\":\"x\",\"reasons\":[]}")
        XCTAssertNil(old.reachedAt)
        XCTAssertEqual(old.verdict, .onTrack)
    }

    func testWeeklyReviewWithReachedVerdictDecodesAndReadsAsAGoodWeek() throws {
        let json = """
        { "weekStart": "2026-09-28", "weekEnd": "2026-10-04", "goal": "weight_loss", "verdict": "reached",
          "headline": "h", "stats": [], "nextWeek": "", "dataSufficiency": { "sufficient": true } }
        """
        let review = try JSONDecoder().decode(WeeklyReviewDTO.self, from: Data(json.utf8))
        XCTAssertEqual(review.verdict, .reached)
        XCTAssertEqual(WeeklyReviewLogic.weekLabel(for: .reached), "Good week")
        XCTAssertEqual(WeeklyReviewLogic.tone(for: review), .good)
    }

    // MARK: - Label, tone, fraction

    func testReachedLabelAndTone() {
        XCTAssertEqual(GoalProgressLogic.label(for: .reached), "Goal reached")
        XCTAssertEqual(GoalProgressLogic.label(for: .reached, goal: "muscle"), "Goal reached")
        XCTAssertEqual(GoalProgressLogic.tone(for: .reached), .good)
    }

    func testReachedProgressBarIsFullEvenWithoutAPercentage() throws {
        XCTAssertEqual(GoalProgressLogic.progressFraction(try reached()), 1)
        let noPct = GoalProgressDTO(goal: "weight_loss", current: .init(weightKg: 82, startWeightKg: 90, progressPct: nil), verdict: .reached)
        XCTAssertEqual(GoalProgressLogic.progressFraction(noPct), 1)
        let onTrack = GoalProgressDTO(goal: "weight_loss", current: .init(progressPct: 40), verdict: .onTrack)
        XCTAssertEqual(GoalProgressLogic.progressFraction(onTrack), 0.4)
    }

    // MARK: - The weight line never exceeds the target

    func testWeightLineIsCappedAtTheTargetForLoss() throws {
        let progress = try reached()   // 8.4 kg lost against an 8 kg goal
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(progress, system: .metric)), "8 of 8 kg lost")
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(progress, system: .metric)), "8 of 8 kg lost")
    }

    func testWeightLineIsCappedInPoundsAndForGain() {
        let loss = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 82),
            current: .init(weightKg: 81.6, startWeightKg: 90), verdict: .reached
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(loss, system: .imperial)), "17.6 of 17.6 lb lost")
        let gain = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 82),
            current: .init(weightKg: 82.6, startWeightKg: 78), verdict: .reached
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(gain, system: .metric)), "4 of 4 kg gained")
    }

    func testWeightLineCapAppliesToAnyVerdictAndKeepsNormalProgressUntouched() {
        // The server hasn't flagged "reached" yet, but the trend is already past the target.
        let overshoot = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 76),
            current: .init(weightKg: 75.2, startWeightKg: 83.7), verdict: .onTrack
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(overshoot, system: .metric)), "7.7 of 7.7 kg lost")
        let midway = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 76),
            current: .init(weightKg: 82, startWeightKg: 83.7), verdict: .onTrack
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(midway, system: .metric)), "1.7 of 7.7 kg lost")
    }

    func testCoachOpenerAlsoCapsTheDoneAmount() {
        let opener = CoachViewModel.goalStatusOpener(
            GoalProgressDTO(
                goal: "weight_loss", target: .init(weightKg: 76),
                current: .init(weightKg: 75.2, startWeightKg: 83.7), verdict: .onTrack
            ),
            system: .metric, now: now, locale: en
        )
        XCTAssertEqual(plain(opener)?.hasPrefix("You're 7.7 of 7.7 kg down"), true, opener ?? "nil")
    }

    // MARK: - Today line / card text

    func testCompactTextForReachedIsTheCappedOutcomeWhateverElseTheServerSends() throws {
        let progress = try reached()
        XCTAssertEqual(plain(GoalProgressLogic.compactText(progress, system: .metric, now: now, locale: en)), "8 of 8 kg lost")
        // Even with an ETA, a target date and a stale weigh-in, the line is the outcome.
        let busy = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 82, date: "2026-12-29"),
            current: .init(weightKg: 81.6, startWeightKg: 90), eta: "2026-12-10", onPaceForTargetDate: true,
            verdict: .reached, lastWeighInDaysAgo: 12
        )
        XCTAssertEqual(plain(GoalProgressLogic.compactText(busy, system: .metric, now: now, locale: en)), "8 of 8 kg lost")
    }

    func testReachedTextFallsBackToTheHeadlineMinusItsVerdictPrefix() {
        let noWeights = GoalProgressDTO(goal: "general", verdict: .reached, headline: "Goal reached — 82 kg hit on Oct 3")
        XCTAssertEqual(GoalProgressLogic.reachedText(noWeights, system: .metric), "82 kg hit on Oct 3")
        let bare = GoalProgressDTO(goal: "general", verdict: .reached, headline: "")
        XCTAssertEqual(GoalProgressLogic.reachedText(bare, system: .metric), "Goal reached")
    }

    func testReachedLineAndPaceLine() throws {
        let progress = try reached()
        XCTAssertEqual(GoalProgressLogic.reachedLine(progress, now: now, locale: en), "Reached Oct 3")
        // The pace line is the reached date, never "Target date Dec 29 · not on pace".
        XCTAssertEqual(GoalProgressLogic.paceLine(progress, now: now, locale: en), "Reached Oct 3")
        XCTAssertEqual(GoalProgressLogic.paceTone(progress), .good)

        let stamped = GoalProgressDTO(goal: "weight_loss", verdict: .reached, reachedAt: "2026-10-03T14:22:00.000Z")
        XCTAssertEqual(GoalProgressLogic.reachedLine(stamped, now: now, locale: en), "Reached Oct 3")

        let noDate = GoalProgressDTO(goal: "weight_loss", target: .init(date: "2026-12-29"), verdict: .reached)
        XCTAssertNil(GoalProgressLogic.reachedLine(noDate, now: now, locale: en))
        XCTAssertNil(GoalProgressLogic.paceLine(noDate, now: now, locale: en))
        let garbage = GoalProgressDTO(goal: "weight_loss", verdict: .reached, reachedAt: "yesterday-ish")
        XCTAssertNil(GoalProgressLogic.reachedLine(garbage, now: now, locale: en))
        // Only a reached goal says "Reached".
        let notReached = GoalProgressDTO(goal: "weight_loss", verdict: .onTrack, reachedAt: "2026-10-03")
        XCTAssertNil(GoalProgressLogic.reachedLine(notReached, now: now, locale: en))
    }

    func testHeadlinePrefixStrippingKnowsGoalReached() {
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Goal reached — 82 kg"), "82 kg")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Reached - 82 kg"), "82 kg")
    }

    // MARK: - Stale weigh-in for any goal with a weight target

    private func stale(goal: String, target: Double?, days: Int?, verdict: GoalVerdict = .progressing) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: goal, target: .init(weightKg: target),
            current: .init(weightKg: 80, startWeightKg: 78), verdict: verdict, lastWeighInDaysAgo: days
        )
    }

    func testStaleWeighInAppliesToAnyGoalWithAWeightTargetAtSevenDays() {
        let line = "Last weigh-in 7 days ago — step on the scale to update"
        for goal in ["muscle", "general", "endurance"] {
            XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(goal: goal, target: 82, days: 6)), goal)
            XCTAssertEqual(GoalProgressLogic.staleWeighInText(stale(goal: goal, target: 82, days: 7)), line, goal)
            XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(goal: goal, target: 82, days: nil)), goal)
            // No weight target -> nothing to be stale against.
            XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(goal: goal, target: nil, days: 30)), goal)
        }
    }

    func testStaleWeighInKeepsWeightLossAtFourDaysAndSilencesReached() {
        XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(goal: "weight_loss", target: 76, days: 3)))
        XCTAssertEqual(
            GoalProgressLogic.staleWeighInText(stale(goal: "weight_loss", target: 76, days: 4)),
            "Last weigh-in 4 days ago — step on the scale to update"
        )
        XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(goal: "weight_loss", target: 76, days: 20, verdict: .reached)))
    }

    func testMuscleCompactLineShowsTheStaleNudgeInsteadOfAnOutdatedWeightOutcome() {
        let progress = stale(goal: "muscle", target: 82, days: 9)
        XCTAssertEqual(
            GoalProgressLogic.compactText(progress, system: .metric, now: now, locale: en),
            "Last weigh-in 9 days ago — step on the scale to update"
        )
    }

    // MARK: - Next steps: set a new target / switch to maintenance

    private final class Recorder {
        var goals: [String] = []
        var posted: [Notification.Name] = []
    }

    private struct SwitchFailure: Error {}

    func testNextStepCopyAndMaintenanceGoalId() {
        XCTAssertEqual(GoalProgressLogic.setNewTargetTitle, "Set a new target")
        XCTAssertEqual(GoalProgressLogic.switchToMaintenanceTitle, "Switch to maintenance")
        // The id Profile -> Goal's "Maintain" radio row sends to PATCH /api/diet-goal.
        XCTAssertEqual(GoalProgressLogic.maintenanceGoal, "general")
        XCTAssertEqual(DietBudgetViewModel.goalLabels[GoalProgressLogic.maintenanceGoal], "Maintain")
    }

    func testSetNewTargetOpensTheGoalEditor() {
        let recorder = Recorder()
        let actions = GoalReachedActions(switchGoal: { _ in }, post: { recorder.posted.append($0) })
        actions.setNewTarget()
        XCTAssertEqual(recorder.posted, [.vitalOpenGoalEditor])
    }

    func testSwitchToMaintenanceSetsTheGeneralGoalThenAnnouncesTheChange() async {
        let recorder = Recorder()
        let actions = GoalReachedActions(
            switchGoal: { recorder.goals.append($0) },
            post: { recorder.posted.append($0) }
        )
        let ok = await actions.switchToMaintenance()
        XCTAssertTrue(ok)
        XCTAssertEqual(recorder.goals, ["general"])
        XCTAssertEqual(recorder.posted, [.vitalGoalKindChanged])
        XCTAssertFalse(actions.isSwitching)
        XCTAssertNil(actions.errorMessage)
    }

    func testFailedSwitchKeepsTheGoalAndShowsARetryableMessage() async {
        let recorder = Recorder()
        let actions = GoalReachedActions(
            switchGoal: { _ in throw SwitchFailure() },
            post: { recorder.posted.append($0) }
        )
        let ok = await actions.switchToMaintenance()
        XCTAssertFalse(ok)
        XCTAssertTrue(recorder.posted.isEmpty, "a failed switch announces nothing")
        XCTAssertEqual(actions.errorMessage, "Couldn't save — try again.")
        XCTAssertFalse(actions.isSwitching)
        // Retry clears the message once it works.
        let retry = GoalReachedActions(switchGoal: { _ in }, post: { _ in })
        let again = await retry.switchToMaintenance()
        XCTAssertTrue(again)
        XCTAssertNil(retry.errorMessage)
    }

    // MARK: - Server contract: weight-loss reached payload

    /// What the server sends for a reached weight-loss goal: day-only `reachedAt`
    /// and the "Goal reached — 86 kg (Sep 20)" headline, with the new reason kinds.
    private let serverReachedJSON = """
    {
      "goal": "weight_loss",
      "target": { "weightKg": 86, "date": null, "weeklySessions": null },
      "current": { "weightKg": 85.6, "startWeightKg": 94, "changeKg": -8.4, "progressPct": 105 },
      "ratePerWeek": { "kg": -0.3, "pctBodyweight": -0.35 },
      "eta": null,
      "onPaceForTargetDate": null,
      "verdict": "reached",
      "reachedAt": "2026-09-20",
      "headline": "Goal reached — 86 kg (Sep 20)",
      "reasons": [
        { "kind": "reached", "text": "Goal reached — 86 kg (Sep 20)", "tone": "good" },
        { "kind": "position", "text": "You're 0.4 kg past your target", "tone": "neutral" },
        { "kind": "weigh_in_age", "text": "Last weigh-in 9 days ago", "tone": "watch" },
        { "kind": "next_step", "text": "Set a new target or switch to maintenance", "tone": "neutral" },
        { "kind": "some_future_kind", "text": "Something this build has never seen", "tone": "sparkly" },
        { "text": "No kind and no tone" }
      ],
      "dataSufficiency": { "weighIns": 20, "needed": 3, "sessionsLast28d": 0 },
      "lastWeighInDaysAgo": 9,
      "lastSessionDaysAgo": null
    }
    """

    func testServerReachedPayloadReadsAsTheCappedOutcomeWithADay() throws {
        let progress = try decode(serverReachedJSON)
        XCTAssertEqual(progress.verdict, .reached)
        XCTAssertEqual(progress.reachedAt, "2026-09-20")
        XCTAssertEqual(plain(GoalProgressLogic.compactText(progress, system: .metric, now: now, locale: en)), "8 of 8 kg lost")
        XCTAssertEqual(GoalProgressLogic.paceLine(progress, now: now, locale: en), "Reached Sep 20")
        XCTAssertNil(GoalProgressLogic.staleWeighInText(progress), "a reached goal has no stale-weigh-in nudge even at 9 days")
    }

    func testServerHeadlineIsTheFallbackWithoutWeights() {
        let bare = GoalProgressDTO(
            goal: "weight_loss", verdict: .reached,
            headline: "Goal reached — 86 kg (Sep 20)", reachedAt: "2026-09-20"
        )
        XCTAssertEqual(GoalProgressLogic.reachedText(bare, system: .metric), "86 kg (Sep 20)")
        XCTAssertEqual(GoalProgressLogic.primaryLine(bare, system: .metric), "86 kg (Sep 20)")
        XCTAssertEqual(GoalProgressLogic.reachedLine(bare, now: now, locale: en), "Reached Sep 20")
    }

    func testNewReasonKindsDecodeAndRenderByTheirToneNeverCrash() throws {
        let progress = try decode(serverReachedJSON)
        XCTAssertEqual(
            progress.reasons.map(\.kind),
            ["reached", "position", "weigh_in_age", "next_step", "some_future_kind", ""]
        )
        // A tone this build doesn't know (and a missing one) reads as neutral.
        XCTAssertEqual(progress.reasons.map(\.tone), [.good, .neutral, .watch, .neutral, .neutral, .neutral])
        XCTAssertEqual(
            progress.reasons.map { GoalProgressLogic.tone(for: $0.tone) },
            [.good, .neutral, .watch, .neutral, .neutral, .neutral]
        )
        // 'reached' (good) leads and is what the compact card shows first.
        let visible = GoalProgressLogic.visibleReasons(progress)
        XCTAssertEqual(visible.map(\.kind), ["reached", "position", "weigh_in_age"])
        XCTAssertEqual(visible.first?.tone, .good)
        // VoiceOver hears the colour: good / watch, nothing for neutral.
        XCTAssertEqual(progress.reasons.map { GoalProgressLogic.accessibilityToneWord(for: $0.tone) },
                       ["good", nil, "watch", nil, nil, nil])
        // None of them is mistaken for a lift story.
        XCTAssertNil(GoalProgressLogic.liftReasonText(progress))
        XCTAssertNil(GoalProgressLogic.liftShortText(progress))
        // And they never change the verdict line.
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(progress, system: .metric)), "8 of 8 kg lost")
    }

    // MARK: - adherence.windowDays

    private func adherence(done: Int = 3, planned: Int = 6, window: Int? = nil) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "muscle", target: .init(weeklySessions: 4), verdict: .behind,
            adherence: .init(done: done, planned: planned, weeklyTarget: 4, pct: 50, windowDays: window ?? 28)
        )
    }

    func testSessionsBehindTextNamesTheAdherenceWindow() {
        XCTAssertEqual(
            plain(GoalProgressLogic.sessionsBehindText(adherence(done: 9, planned: 16, window: 28))),
            "9 of 16 sessions in 4 wk · aim for 4 this week"
        )
        // The default (no window given) is the original four weeks.
        XCTAssertEqual(
            plain(GoalProgressLogic.sessionsBehindText(adherence(done: 9, planned: 16))),
            "9 of 16 sessions in 4 wk · aim for 4 this week"
        )
        XCTAssertEqual(
            plain(GoalProgressLogic.sessionsBehindText(adherence(window: 10))),
            "3 of 6 sessions in 10 days · aim for 4 this week"
        )
        XCTAssertEqual(
            plain(GoalProgressLogic.sessionsBehindText(adherence(window: 7))),
            "3 of 6 sessions in 7 days · aim for 4 this week"
        )
        XCTAssertEqual(
            plain(GoalProgressLogic.sessionsBehindText(adherence(window: 1))),
            "3 of 6 sessions in 1 day · aim for 4 this week"
        )
        // With this week's count the next step is the concrete remainder.
        XCTAssertEqual(
            plain(GoalProgressLogic.sessionsBehindText(adherence(window: 10), doneThisWeek: 2)),
            "3 of 6 sessions in 10 days · 2 more by Sun"
        )
    }

    func testWindowTextKeepsValueAndUnitTogether() throws {
        let days = try XCTUnwrap(GoalProgressLogic.sessionsBehindText(adherence(window: 10)))
        XCTAssertTrue(days.contains("10\u{00A0}days"), days)
        XCTAssertFalse(days.contains("10 days"), "no breakable space between the value and its unit")
        let weeks = try XCTUnwrap(GoalProgressLogic.sessionsBehindText(adherence(window: 28)))
        XCTAssertTrue(weeks.contains("4\u{00A0}wk"), weeks)
    }

    func testTheTodayLineUsesTheShortWindowToo() {
        XCTAssertEqual(
            plain(GoalProgressLogic.compactText(adherence(window: 10), system: .metric, sessionsDoneThisWeek: 2, now: now, locale: en)),
            "3 of 6 sessions in 10 days · 2 more by Sun"
        )
    }

    func testWindowDaysDecodesTolerantlyAndDefaultsToTwentyEight() throws {
        func windowDays(_ extra: String) throws -> Int? {
            let json = "{\"goal\":\"muscle\",\"verdict\":\"behind\",\"headline\":\"x\",\"reasons\":[],"
                + "\"adherence\":{\"done\":3,\"planned\":6,\"weeklyTarget\":4,\"pct\":50\(extra)}}"
            return try decode(json).adherence?.windowDays
        }
        XCTAssertEqual(try windowDays(",\"windowDays\":10"), 10)
        XCTAssertEqual(try windowDays(",\"windowDays\":10.0"), 10)
        XCTAssertEqual(try windowDays(",\"windowDays\":7"), 7)
        XCTAssertEqual(try windowDays(",\"windowDays\":28"), 28)
        // Missing (older server), null, wrong type or out of range: the original window.
        XCTAssertEqual(try windowDays(""), 28)
        XCTAssertEqual(try windowDays(",\"windowDays\":null"), 28)
        XCTAssertEqual(try windowDays(",\"windowDays\":\"ten\""), 28)
        XCTAssertEqual(try windowDays(",\"windowDays\":0"), 28)
        XCTAssertEqual(try windowDays(",\"windowDays\":-3"), 28)
        XCTAssertEqual(try windowDays(",\"windowDays\":90"), 28)
        // The block is still dropped (not half-read) when a count is missing.
        let broken = try decode("{\"goal\":\"muscle\",\"verdict\":\"behind\",\"headline\":\"x\",\"reasons\":[],\"adherence\":{\"done\":3,\"windowDays\":10}}")
        XCTAssertNil(broken.adherence)
    }

    // MARK: - lastSessionDaysAgo

    func testLastSessionDaysAgoDecodesTolerantly() throws {
        func days(_ extra: String) throws -> Int? {
            try decode("{\"goal\":\"muscle\",\"verdict\":\"progressing\",\"headline\":\"x\",\"reasons\":[]\(extra)}").lastSessionDaysAgo
        }
        XCTAssertEqual(try days(",\"lastSessionDaysAgo\":12"), 12)
        XCTAssertEqual(try days(",\"lastSessionDaysAgo\":12.0"), 12)
        XCTAssertEqual(try days(",\"lastSessionDaysAgo\":0"), 0)
        XCTAssertNil(try days(",\"lastSessionDaysAgo\":null"))
        XCTAssertNil(try days(",\"lastSessionDaysAgo\":\"a while\""))
        XCTAssertNil(try days(""))
        // Independent of the weigh-in count beside it.
        let both = try decode("{\"goal\":\"muscle\",\"verdict\":\"progressing\",\"headline\":\"x\",\"reasons\":[],\"lastWeighInDaysAgo\":5,\"lastSessionDaysAgo\":2}")
        XCTAssertEqual(both.lastWeighInDaysAgo, 5)
        XCTAssertEqual(both.lastSessionDaysAgo, 2)
    }

    // MARK: - Spoken tone

    func testToneWordsAreSpokenOnlyForGoodAndWatch() {
        XCTAssertEqual(GoalProgressLogic.accessibilityToneWord(for: .good), "good")
        XCTAssertEqual(GoalProgressLogic.accessibilityToneWord(for: .watch), "watch")
        XCTAssertNil(GoalProgressLogic.accessibilityToneWord(for: .neutral))
        XCTAssertEqual(WeeklyReviewLogic.accessibilityToneWord(for: .good), "good")
        XCTAssertEqual(WeeklyReviewLogic.accessibilityToneWord(for: .watch), "watch")
        XCTAssertNil(WeeklyReviewLogic.accessibilityToneWord(for: .neutral))
        // The tile's spoken label itself is unchanged.
        XCTAssertEqual(
            WeeklyReviewLogic.accessibilityLabel(for: WeeklyReviewStatDTO(label: "Days in budget", value: "5/7", comparison: nil, tone: .good)),
            "Days in budget, 5 of 7"
        )
    }
}
