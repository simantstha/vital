import XCTest
@testable import Vital

/// Pure-logic coverage for the goal-progress card / Today line
/// (`GoalProgressLogic`) and the tolerant `GoalProgressDTO` decoding.
final class GoalProgressLogicTests: XCTestCase {

    private let en = Locale(identifier: "en_US")

    private var now: Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: 12))!
    }

    private func weightLoss(
        verdict: GoalVerdict = .onTrack,
        eta: String? = "2026-12-10",
        headline: String = "On track — about 6 kg to go, around Dec 10",
        target: GoalProgressDTO.Target = .init(weightKg: 76, date: "2027-01-15", weeklySessions: nil)
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "weight_loss",
            target: target,
            current: .init(weightKg: 82.0, startWeightKg: 83.7, changeKg: -1.7, progressPct: 22),
            ratePerWeek: .init(kg: -0.6, pctBodyweight: -0.73),
            safeBand: .init(minPct: 0.25, maxPct: 1),
            eta: eta,
            onPaceForTargetDate: true,
            verdict: verdict,
            headline: headline,
            reasons: [GoalReasonDTO(kind: "rate", text: "Losing 0.6 kg a week", tone: .good)],
            dataSufficiency: .init(weighIns: 11, needed: 3, sessionsLast28d: 0)
        )
    }

    private func endurance(headline: String, reasons: [GoalReasonDTO] = []) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "endurance",
            target: .init(weeklyDistanceKm: 30),
            distance: .init(targetKm: 30, thisWeekKm: 17.2, avg4wKm: 23.2, weekStart: "2026-10-05"),
            verdict: .building,
            headline: headline,
            reasons: reasons
        )
    }

    // MARK: - Hero already shows distance

    func testCompactTextRepeatsDistanceOnlyWhenHeroDoesNotShowIt() {
        let progress = endurance(headline: "Building — distance up 12% (last 2 wk vs 2 before)")
        XCTAssertEqual(GoalProgressLogic.compactText(progress, system: .metric, now: now, locale: en),
                       "17.2 of 30 km this week")
        XCTAssertEqual(GoalProgressLogic.compactText(progress, system: .metric, heroShowsDistance: true, now: now, locale: en),
                       "distance up 12% (last 2 wk vs 2 before)")
    }

    func testDistanceReasonFallsBackToFirstReasonAndNeverTheDistanceLine() {
        let reasons = [GoalReasonDTO(kind: "volume", text: "Distance up 12%", tone: .good)]
        XCTAssertEqual(GoalProgressLogic.distanceReasonText(endurance(headline: "", reasons: reasons), system: .metric),
                       "Distance up 12%")
        XCTAssertEqual(GoalProgressLogic.distanceReasonText(
            endurance(headline: "Building — 17.2 of 30 km this week", reasons: reasons), system: .metric),
                       "Distance up 12%")
        XCTAssertNil(GoalProgressLogic.distanceReasonText(endurance(headline: ""), system: .metric))
    }

    func testWeightLossCompactTextIgnoresHeroDistanceFlag() {
        // No distance block: weight loss keeps "5 wk ahead of ..." either way.
        let flagged = GoalProgressLogic.compactText(weightLoss(), system: .metric, heroShowsDistance: true, now: now, locale: en)
        XCTAssertEqual(flagged, GoalProgressLogic.compactText(weightLoss(), system: .metric, now: now, locale: en))
    }

    // MARK: - Labels + tone

    func testEveryVerdictHasTheSpecifiedLabel() {
        let expected: [GoalVerdict: String] = [
            .onTrack: "On track", .ahead: "Ahead of pace", .tooFast: "Losing too fast",
            .behind: "Behind pace", .stalled: "Stalled", .progressing: "Progressing",
            .building: "Building", .holding: "Holding steady", .needsTarget: "Set a target",
            .insufficientData: "Getting started",
        ]
        for (verdict, label) in expected {
            XCTAssertEqual(GoalProgressLogic.label(for: verdict), label)
        }
    }

    func testVerdictTones() {
        XCTAssertEqual(GoalProgressLogic.tone(for: .onTrack), .good)
        XCTAssertEqual(GoalProgressLogic.tone(for: .ahead), .good)
        XCTAssertEqual(GoalProgressLogic.tone(for: .progressing), .good)
        XCTAssertEqual(GoalProgressLogic.tone(for: .building), .good)
        XCTAssertEqual(GoalProgressLogic.tone(for: .tooFast), .watch)
        XCTAssertEqual(GoalProgressLogic.tone(for: .behind), .watch)
        XCTAssertEqual(GoalProgressLogic.tone(for: .stalled), .watch)
        XCTAssertEqual(GoalProgressLogic.tone(for: .holding), .neutral)
        XCTAssertEqual(GoalProgressLogic.tone(for: .needsTarget), .neutral)
        XCTAssertEqual(GoalProgressLogic.tone(for: .insufficientData), .neutral)
    }

    // MARK: - Weight lines (unit aware)

    func testWeightLineMetric() {
        XCTAssertEqual(GoalProgressLogic.weightLine(weightLoss(), system: .metric), "1.7 of 7.7 kg lost")
    }

    func testWeightLineImperialNeverShowsKg() {
        let line = GoalProgressLogic.weightLine(weightLoss(), system: .imperial)
        XCTAssertEqual(line, "3.7 of 17 lb lost")
        XCTAssertFalse(line?.contains("kg") ?? true)
    }

    func testWeightLineSaysGainedWhenTargetIsAboveStart() {
        let progress = GoalProgressDTO(
            goal: "muscle",
            target: .init(weightKg: 85),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 17),
            verdict: .progressing
        )
        XCTAssertEqual(GoalProgressLogic.weightLine(progress, system: .metric), "1 of 6 kg gained")
    }

    func testWeightLineNeverNegativeWhenRegressing() {
        let progress = GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76),
            current: .init(weightKg: 84.5, startWeightKg: 83.7, changeKg: 0.8, progressPct: 0),
            verdict: .behind
        )
        XCTAssertEqual(GoalProgressLogic.weightLine(progress, system: .metric), "0 of 7.7 kg lost")
    }

    func testWeightLineNilWithoutAllThreeWeights() {
        let progress = GoalProgressDTO(goal: "weight_loss", target: .init(weightKg: 76), verdict: .insufficientData)
        XCTAssertNil(GoalProgressLogic.weightLine(progress, system: .metric))
    }

    // MARK: - Primary / compact lines

    func testPrimaryLineIgnoresServerHeadlineForWeightGoals() {
        XCTAssertEqual(GoalProgressLogic.primaryLine(weightLoss(), system: .imperial), "3.7 of 17 lb lost")
    }

    func testPrimaryLineFallsBackToHeadlineForNonWeightGoals() {
        let progress = GoalProgressDTO(
            goal: "muscle", verdict: .progressing,
            headline: "Progressing — Squat estimated 1RM up 8.3 kg"
        )
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .imperial), "Squat estimated 1RM up 8.3 kg")
    }

    func testHeadlineWithoutVerdictStripsLeadingVerdictAndDash() {
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Building — weekly distance up 12% over 4 weeks"), "weekly distance up 12% over 4 weeks")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("On track — about 6 kg to go"), "about 6 kg to go")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("progressing – Squat up"), "Squat up")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Building - Squat up"), "Squat up")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Ahead of pace — 2 kg to go"), "2 kg to go")
    }

    func testHeadlineWithoutVerdictLeavesOtherTextAlone() {
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Building muscle takes time"), "Building muscle takes time")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Set a weekly session goal to track your training"), "Set a weekly session goal to track your training")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Stalled —"), "Stalled —")
        XCTAssertNil(GoalProgressLogic.headlineWithoutVerdict("   "))
    }

    func testNeedsTargetPromptForWeightGoal() {
        let progress = GoalProgressDTO(goal: "weight_loss", verdict: .needsTarget, headline: "Set a target weight to track your fat-loss progress")
        XCTAssertTrue(GoalProgressLogic.needsWeightTarget(progress))
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), "Set a target weight to see your progress")
    }

    func testNeedsTargetForEnduranceUsesServerHeadlineAndNoWeightPrompt() {
        let progress = GoalProgressDTO(goal: "endurance", verdict: .needsTarget, headline: "Set a weekly session goal to track your training")
        XCTAssertFalse(GoalProgressLogic.needsWeightTarget(progress))
        XCTAssertTrue(GoalProgressLogic.needsSessionTarget(progress))
        XCTAssertTrue(GoalProgressLogic.needsTargetPrompt(progress), "endurance gets a Set target button too")
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), "Set a weekly distance or session goal to see your progress")
        let muscle = GoalProgressDTO(goal: "muscle", verdict: .needsTarget)
        XCTAssertEqual(GoalProgressLogic.primaryLine(muscle, system: .metric), "Set a weekly session goal to see your progress")
        let general = GoalProgressDTO(goal: "general", verdict: .needsTarget)
        XCTAssertFalse(GoalProgressLogic.needsTargetPrompt(general))
    }

    func testInsufficientDataShowsWeighInProgressNeverAnEta() {
        let progress = GoalProgressDTO(
            goal: "weight_loss", eta: nil, verdict: .insufficientData,
            dataSufficiency: .init(weighIns: 1, needed: 3, sessionsLast28d: 0)
        )
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), "Need 3 weigh-ins · 1 of 3")
        XCTAssertEqual(GoalProgressLogic.insufficientDataFraction(progress), 1.0 / 3.0, accuracy: 0.0001)
        XCTAssertNil(GoalProgressLogic.etaLine(progress, now: now, locale: en))
    }

    func testCompactTextPrefersEtaOtherwisePrimaryLine() {
        XCTAssertEqual(GoalProgressLogic.compactText(weightLoss(), system: .metric, now: now, locale: en), "5 wk ahead of Jan 15, 2027")
        XCTAssertEqual(
            GoalProgressLogic.compactText(weightLoss(target: .init(weightKg: 76, date: nil, weeklySessions: nil)), system: .metric, now: now, locale: en),
            "76 kg by ~Dec 10"
        )
        XCTAssertEqual(
            GoalProgressLogic.compactText(weightLoss(target: .init(weightKg: 76, date: nil, weeklySessions: nil)), system: .imperial, now: now, locale: en),
            "\(UnitFormat.weight(kg: 76, .imperial)) by ~Dec 10"
        )
        XCTAssertEqual(
            GoalProgressLogic.compactText(weightLoss(target: .init(weightKg: nil, date: nil, weeklySessions: nil)), system: .metric, now: now, locale: en),
            "≈ Dec 10"
        )
        XCTAssertEqual(
            GoalProgressLogic.compactText(weightLoss(eta: nil), system: .metric, now: now, locale: en),
            "1.7 of 7.7 kg lost"
        )
    }

    // MARK: - Dates

    func testDateTextOmitsYearInCurrentYearAndShowsItOtherwise() {
        XCTAssertEqual(GoalProgressLogic.dateText("2026-12-10", now: now, locale: en), "Dec 10")
        XCTAssertEqual(GoalProgressLogic.dateText("2027-01-15", now: now, locale: en), "Jan 15, 2027")
        XCTAssertNil(GoalProgressLogic.dateText("garbage", now: now, locale: en))
        XCTAssertNil(GoalProgressLogic.dateText(nil, now: now, locale: en))
    }

    func testEtaLineOnlyWhenEtaPresent() {
        XCTAssertEqual(GoalProgressLogic.etaLine(weightLoss(), now: now, locale: en), "At this pace: ~Dec 10")
        XCTAssertNil(GoalProgressLogic.etaLine(weightLoss(eta: nil), now: now, locale: en))
    }

    func testPaceVsTargetLineRelatesEtaToTargetDate() {
        func line(eta: String?, target: String?) -> String? {
            let p = weightLoss(eta: eta, target: .init(weightKg: 76, date: target, weeklySessions: nil))
            return GoalProgressLogic.paceVsTargetLine(p, now: now, locale: en)
        }
        XCTAssertEqual(line(eta: "2026-12-15", target: "2026-12-29"), "About 2 weeks ahead of your Dec 29 target")
        XCTAssertEqual(line(eta: "2027-01-19", target: "2026-12-29"), "About 3 weeks behind your Dec 29 target")
        XCTAssertEqual(line(eta: "2026-12-22", target: "2026-12-29"), "Right on pace for Dec 29", "exactly 7 days is on pace")
        XCTAssertEqual(line(eta: "2027-01-05", target: "2026-12-29"), "Right on pace for Dec 29", "7 days late is on pace")
        XCTAssertEqual(line(eta: "2026-12-20", target: "2026-12-29"), "About 1 week ahead of your Dec 29 target")
        XCTAssertNil(line(eta: nil, target: "2026-12-29"))
        XCTAssertNil(line(eta: "2026-12-15", target: nil))
    }

    func testPaceLineFallsBackToEtaThenTargetDate() {
        let noTarget = weightLoss(target: .init(weightKg: 76, date: nil, weeklySessions: nil))
        XCTAssertEqual(GoalProgressLogic.paceLine(noTarget, now: now, locale: en), "At this pace: ~Dec 10")
        let noEta = weightLoss(eta: nil)
        XCTAssertEqual(GoalProgressLogic.paceLine(noEta, now: now, locale: en), "Target date Jan 15, 2027 · on pace")
        XCTAssertEqual(GoalProgressLogic.paceTone(weightLoss(eta: "2027-03-01")), .watch)
        XCTAssertEqual(GoalProgressLogic.paceTone(weightLoss()), .good)
    }

    func testMuscleEtaShowsAtThisPace() {
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 82, date: nil, weeklySessions: 4),
            eta: "2026-11-24", verdict: .progressing
        )
        XCTAssertEqual(GoalProgressLogic.etaLine(muscle, now: now, locale: en), "At this pace: ~Nov 24")
    }

    func testTargetDateLineReflectsOnPace() {
        XCTAssertEqual(GoalProgressLogic.targetDateLine(weightLoss(), now: now, locale: en), "Target date Jan 15, 2027 · on pace")
    }

    // MARK: - Safe band / rate

    func testSafeBandTextMetric() {
        XCTAssertEqual(
            GoalProgressLogic.safeBandText(weightLoss(), system: .metric),
            "Healthy pace: 0.25–1% of body weight per week ≈ 0.2–0.8 kg"
        )
    }

    func testSafeBandTextImperialUsesLb() {
        let text = GoalProgressLogic.safeBandText(weightLoss(), system: .imperial)
        XCTAssertEqual(text, "Healthy pace: 0.25–1% of body weight per week ≈ 0.5–1.8 lb")
    }

    func testRateTextUsesUserUnit() {
        XCTAssertEqual(GoalProgressLogic.rateText(weightLoss(), system: .metric), "\u{2212}0.6 kg/wk")
        XCTAssertEqual(GoalProgressLogic.rateText(weightLoss(), system: .imperial), "\u{2212}1.3 lb/wk")
    }

    // MARK: - Fraction + reasons

    func testProgressFractionClampsAndHandlesNil() {
        XCTAssertEqual(GoalProgressLogic.progressFraction(weightLoss()) ?? -1, 0.22, accuracy: 0.0001)
        let over = GoalProgressDTO(goal: "weight_loss", current: .init(progressPct: 140), verdict: .ahead)
        XCTAssertEqual(GoalProgressLogic.progressFraction(over), 1)
        let none = GoalProgressDTO(goal: "weight_loss", verdict: .insufficientData)
        XCTAssertNil(GoalProgressLogic.progressFraction(none))
    }

    func testVisibleReasonsCapsAtThree() {
        let reasons = (0..<5).map { GoalReasonDTO(text: "r\($0)") }
        let progress = GoalProgressDTO(goal: "general", verdict: .holding, reasons: reasons)
        XCTAssertEqual(GoalProgressLogic.visibleReasons(progress).count, 3)
    }

    // MARK: - Tolerant decoding

    private func decode(_ json: String) throws -> GoalProgressDTO {
        try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
    }

    func testDecodesFullPayload() throws {
        let progress = try decode("""
        {"goal":"weight_loss","target":{"weightKg":76,"date":null,"weeklySessions":null},
         "current":{"weightKg":82,"startWeightKg":83.7,"changeKg":-1.7,"progressPct":22},
         "ratePerWeek":{"kg":-0.6,"pctBodyweight":-0.73},"safeBand":{"minPct":0.25,"maxPct":1},
         "eta":"2026-12-10","onPaceForTargetDate":null,"verdict":"on_track","headline":"On track",
         "reasons":[{"kind":"rate","text":"Good rate","tone":"good"}],
         "dataSufficiency":{"weighIns":11,"needed":3,"sessionsLast28d":0}}
        """)
        XCTAssertEqual(progress.verdict, .onTrack)
        XCTAssertEqual(progress.target.weightKg, 76)
        XCTAssertNil(progress.target.date)
        XCTAssertNil(progress.onPaceForTargetDate)
        XCTAssertEqual(progress.reasons.first?.tone, .good)
        XCTAssertEqual(progress.safeBand?.maxPct, 1)
    }

    func testUnknownVerdictIsInsufficientDataAndReasonsDefaultEmpty() throws {
        let progress = try decode(#"{"goal":"general","verdict":"some_future_verdict","headline":"x"}"#)
        XCTAssertEqual(progress.verdict, .insufficientData)
        XCTAssertEqual(progress.reasons, [])
        XCTAssertNil(progress.eta)
        XCTAssertNil(progress.target.weightKg)
    }

    func testUnknownReasonToneIsNeutral() throws {
        let progress = try decode(#"{"goal":"general","verdict":"holding","reasons":[{"kind":"k","text":"t","tone":"mystery"}]}"#)
        XCTAssertEqual(progress.reasons.first?.tone, .neutral)
    }

    func testWrongTypedFieldsDoNotFailDecoding() throws {
        let progress = try decode(#"{"goal":"weight_loss","verdict":"on_track","eta":5,"target":"nope","reasons":"nope"}"#)
        XCTAssertNil(progress.eta)
        XCTAssertEqual(progress.reasons, [])
        XCTAssertEqual(progress.verdict, .onTrack)
    }

    // MARK: - Endurance weekly distance

    private func distanceProgress(thisWeek: Double? = 24.5, avg: Double? = 23.2) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "endurance",
            target: .init(weeklyDistanceKm: 30),
            distance: .init(targetKm: 30, thisWeekKm: thisWeek, avg4wKm: avg, weekStart: "2026-10-05"),
            verdict: .building,
            headline: "Building — distance up 12% (last 2 weeks vs the 2 before)"
        )
    }

    func testDistanceLineIsPrimaryAndUnitAware() {
        let p = distanceProgress()
        XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .metric), "24.5 of 30 km this week")
        XCTAssertEqual(GoalProgressLogic.primaryLine(p, system: .metric), "24.5 of 30 km this week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .imperial), "15.2 of 18.6 mi this week")
        XCTAssertEqual(GoalProgressLogic.distanceAverageLine(p, system: .metric), "4-week avg 23.2 km a week")
    }

    func testDistanceFractionClampedAndNilWithoutData() throws {
        XCTAssertEqual(try XCTUnwrap(GoalProgressLogic.distanceFraction(distanceProgress(thisWeek: 15))), 0.5, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(GoalProgressLogic.distanceFraction(distanceProgress(thisWeek: 45))), 1, accuracy: 0.001)
        XCTAssertNil(GoalProgressLogic.distanceFraction(distanceProgress(thisWeek: nil)))
        XCTAssertNil(GoalProgressLogic.distanceLine(distanceProgress(thisWeek: nil), system: .metric))
    }

    func testProgressDTODecodesDistanceBlock() throws {
        let json = """
        {"goal":"endurance","target":{"weightKg":null,"date":null,"weeklySessions":null,"weeklyDistanceKm":30},
         "distance":{"targetKm":30,"thisWeekKm":8.5,"avg4wKm":null,"weekStart":"2026-10-05","text":"8.5 of 30 km this week"},
         "verdict":"building","headline":"x","reasons":[]}
        """
        let p = try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        XCTAssertEqual(p.target.weeklyDistanceKm, 30)
        XCTAssertEqual(p.distance?.thisWeekKm, 8.5)
        XCTAssertNil(p.distance?.avg4wKm)
    }

    // MARK: - Day-1 honesty, stale weigh-ins, compact Today line

    func testInsufficientDataWithCountMetShowsServerHeadlineNotNeedThree() {
        let progress = GoalProgressDTO(
            goal: "weight_loss", eta: nil, verdict: .insufficientData,
            headline: "Getting started — two weeks of weigh-ins will show whether you are plateauing",
            dataSufficiency: .init(weighIns: 3, needed: 3, sessionsLast28d: 0)
        )
        XCTAssertTrue(GoalProgressLogic.weighInCountMet(progress))
        XCTAssertFalse(GoalProgressLogic.showsWeighInProgressBar(progress))
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric),
                       "two weeks of weigh-ins will show whether you are plateauing")
        let noHeadline = GoalProgressDTO(
            goal: "weight_loss", verdict: .insufficientData,
            dataSufficiency: .init(weighIns: 4, needed: 3, sessionsLast28d: 0)
        )
        XCTAssertTrue(GoalProgressLogic.primaryLine(noHeadline, system: .metric).hasPrefix("Keep weighing in"))
    }

    func testInsufficientDataBelowCountStillShowsCounterAndBar() {
        let progress = GoalProgressDTO(
            goal: "weight_loss", verdict: .insufficientData,
            dataSufficiency: .init(weighIns: 1, needed: 3, sessionsLast28d: 0)
        )
        XCTAssertTrue(GoalProgressLogic.showsWeighInProgressBar(progress))
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), "Need 3 weigh-ins · 1 of 3")
    }

    func testStaleWeighInTextThresholdAndCompactLine() {
        func stale(_ days: Int?) -> GoalProgressDTO {
            GoalProgressDTO(
                goal: "weight_loss", target: .init(weightKg: 76), eta: "2026-12-10", verdict: .onTrack,
                lastWeighInDaysAgo: days
            )
        }
        XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(nil)))
        XCTAssertNil(GoalProgressLogic.staleWeighInText(stale(3)))
        XCTAssertEqual(GoalProgressLogic.staleWeighInText(stale(4)), "Last weigh-in 4 days ago — step on the scale to update")
        XCTAssertEqual(GoalProgressLogic.compactText(stale(6), system: .metric, now: now, locale: en),
                       "Last weigh-in 6 days ago — step on the scale to update")
        XCTAssertEqual(GoalProgressLogic.compactText(stale(1), system: .metric, now: now, locale: en), "76 kg by ~Dec 10")
    }

    func testLastWeighInDaysAgoDecodesTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = "{\"goal\":\"weight_loss\",\"verdict\":\"on_track\",\"headline\":\"x\",\"reasons\":[]\(extra)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode(",\"lastWeighInDaysAgo\":5").lastWeighInDaysAgo, 5)
        XCTAssertEqual(try decode(",\"lastWeighInDaysAgo\":5.0").lastWeighInDaysAgo, 5)
        XCTAssertNil(try decode(",\"lastWeighInDaysAgo\":\"soon\"").lastWeighInDaysAgo)
        XCTAssertNil(try decode("").lastWeighInDaysAgo)
    }

    /// The Today line leads with the user's goal outcome and appends the
    /// headline lift short; the lift alone only when there is no weight line.
    func testMuscleCompactLineLeadsWithGoalOutcomeThenHeadlineLift() {
        let lift = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM +20 kg vs 4 weeks ago (120 → 140 kg)", tone: .good)
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), eta: "2026-12-06", verdict: .progressing,
            reasons: [lift]
        )
        XCTAssertEqual(
            GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en),
            "1 of 4 kg gained · Squat +20 kg / 4 wk"
        )
        // Imperial: weights in lb; the lift short is the server's already-unit-correct text.
        let imperialLift = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM −44 lb vs 4 weeks ago (264 → 220 lb)", tone: .watch)
        let imperial = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), verdict: .progressing,
            reasons: [imperialLift]
        )
        XCTAssertEqual(
            GoalProgressLogic.compactText(imperial, system: .imperial, now: now, locale: en),
            "2.2 of 8.8 lb gained · Squat \u{2212}44 lb / 4 wk"
        )
        // No lift reason: the goal outcome alone.
        let noLift = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), verdict: .progressing
        )
        XCTAssertEqual(GoalProgressLogic.compactText(noLift, system: .metric, now: now, locale: en), "1 of 4 kg gained")
        // An "unchanged" lift has no signed change to quote.
        let flat = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM unchanged vs 4 weeks ago (120 → 120 kg)", tone: .neutral)
        XCTAssertNil(GoalProgressLogic.liftShortText(GoalProgressDTO(goal: "muscle", verdict: .progressing, reasons: [flat])))
        // The line fits two Today lines.
        XCTAssertLessThanOrEqual(GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en).count, 48)
    }

    func testMuscleCompactLinePrefersLiftReasonOverWeightEta() {
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 90), eta: "2026-12-06", verdict: .progressing,
            reasons: [GoalReasonDTO(kind: "lift", text: "Squat +20.4 kg vs 4 wk", tone: .good)]
        )
        XCTAssertEqual(GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en), "Squat +20.4 kg vs 4 wk")
        let noLift = GoalProgressDTO(goal: "muscle", target: .init(weightKg: 90), eta: "2026-12-06", verdict: .progressing)
        XCTAssertEqual(GoalProgressLogic.compactText(noLift, system: .metric, now: now, locale: en), "90 kg by ~Dec 6")
    }

    func testCompactReasonShortensEnduranceVolumeCopy() {
        XCTAssertEqual(
            GoalProgressLogic.compactReason("weekly distance up 12% (last 2 weeks vs the 2 before)"),
            "distance up 12% · 2 wk vs prior 2"
        )
        XCTAssertEqual(GoalProgressLogic.compactReason("Resting heart rate down"), "Resting heart rate down")
    }
}
