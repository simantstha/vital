import XCTest
@testable import Vital

/// Pure-logic coverage for the goal-progress card / Today line
/// (`GoalProgressLogic`) and the tolerant `GoalProgressDTO` decoding.
final class GoalProgressLogicTests: XCTestCase {

    private let en = Locale(identifier: "en_US")

    /// The strings `GoalProgressLogic` builds join value+unit tokens ("4 kg",
    /// "4 wk") with U+00A0 so a narrow line only wraps BETWEEN tokens. Most
    /// assertions compare the plain-space spelling; the NBSP tests below pin
    /// the real characters.
    private func plain(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{2060}", with: "")
    }

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
                       "17.2 of 30\u{00A0}km this week")
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
        // The same line spelled with the server's non-breaking spaces is excluded too.
        XCTAssertEqual(GoalProgressLogic.distanceReasonText(
            endurance(headline: "Building — 17.2 of 30\u{00A0}km this week", reasons: reasons), system: .metric),
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

    func testBehindChipIsGoalAwareForMuscleOnly() {
        XCTAssertEqual(GoalProgressLogic.label(for: .behind, goal: "muscle"), "Sessions behind")
        XCTAssertEqual(GoalProgressLogic.label(for: .behind, goal: "weight_loss"), "Behind pace")
        XCTAssertEqual(GoalProgressLogic.label(for: .behind, goal: nil), "Behind pace")
        XCTAssertEqual(GoalProgressLogic.label(for: .progressing, goal: "muscle"), "Progressing")
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
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(weightLoss(), system: .metric)), "1.7 of 7.7 kg lost")
        // The unit is glued to its number with a non-breaking space.
        XCTAssertEqual(GoalProgressLogic.weightLine(weightLoss(), system: .metric), "1.7 of 7.7\u{00A0}kg lost")
    }

    func testWeightLineImperialNeverShowsKg() {
        let line = GoalProgressLogic.weightLine(weightLoss(), system: .imperial)
        XCTAssertEqual(plain(line), "3.7 of 17 lb lost")
        XCTAssertFalse(line?.contains("kg") ?? true)
    }

    func testWeightLineSaysGainedWhenTargetIsAboveStart() {
        let progress = GoalProgressDTO(
            goal: "muscle",
            target: .init(weightKg: 85),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 17),
            verdict: .progressing
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(progress, system: .metric)), "1 of 6 kg gained")
    }

    func testWeightLineNeverNegativeWhenRegressing() {
        let progress = GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76),
            current: .init(weightKg: 84.5, startWeightKg: 83.7, changeKg: 0.8, progressPct: 0),
            verdict: .behind
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(progress, system: .metric)), "0 of 7.7 kg lost")
    }

    func testWeightLineNilWithoutAllThreeWeights() {
        let progress = GoalProgressDTO(goal: "weight_loss", target: .init(weightKg: 76), verdict: .insufficientData)
        XCTAssertNil(GoalProgressLogic.weightLine(progress, system: .metric))
    }

    // MARK: - Primary / compact lines

    func testPrimaryLineIgnoresServerHeadlineForWeightGoals() {
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(weightLoss(), system: .imperial)), "3.7 of 17 lb lost")
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
        XCTAssertEqual(plain(GoalProgressLogic.compactText(weightLoss(), system: .metric, now: now, locale: en)), "5 wk ahead of Jan 15, 2027")
        XCTAssertEqual(GoalProgressLogic.compactText(weightLoss(), system: .metric, now: now, locale: en), "5\u{00A0}wk ahead of Jan 15, 2027")
        XCTAssertEqual(
            GoalProgressLogic.compactText(weightLoss(target: .init(weightKg: 76, date: nil, weeklySessions: nil)), system: .metric, now: now, locale: en),
            "76\u{00A0}kg by ~Dec 10"
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
            plain(GoalProgressLogic.compactText(weightLoss(eta: nil), system: .metric, now: now, locale: en)),
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
            plain(GoalProgressLogic.safeBandText(weightLoss(), system: .metric)),
            "Healthy pace: 0.25–1% of body weight per week ≈ 0.2–0.8 kg"
        )
    }

    func testSafeBandTextImperialUsesLb() {
        let text = plain(GoalProgressLogic.safeBandText(weightLoss(), system: .imperial))
        XCTAssertEqual(text, "Healthy pace: 0.25–1% of body weight per week ≈ 0.5–1.8 lb")
    }

    /// The sheet used to wrap as "≈ 0.2– / 0.8 kg": the "≈ value unit" tail is
    /// glued with U+00A0 and both ranges are bound with U+2060 around the dash
    /// (an en dash allows a break after it, even before a no-break space).
    func testSafeBandTextCannotWrapInsideARangeOrBeforeTheUnit() {
        XCTAssertEqual(
            GoalProgressLogic.safeBandText(weightLoss(), system: .metric),
            "Healthy pace: 0.25\u{2060}–\u{2060}1% of body weight per week ≈\u{00A0}0.2\u{2060}–\u{2060}0.8\u{00A0}kg"
        )
        XCTAssertEqual(
            GoalProgressLogic.safeBandText(weightLoss(), system: .imperial),
            "Healthy pace: 0.25\u{2060}–\u{2060}1% of body weight per week ≈\u{00A0}0.5\u{2060}–\u{2060}1.8\u{00A0}lb"
        )
    }

    func testRateTextUsesUserUnit() {
        XCTAssertEqual(GoalProgressLogic.rateText(weightLoss(), system: .metric), "\u{2212}0.6\u{00A0}kg/wk")
        XCTAssertEqual(GoalProgressLogic.rateText(weightLoss(), system: .imperial), "\u{2212}1.3\u{00A0}lb/wk")
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

    private func distanceProgress(thisWeek: Double? = 24.5, avg: Double? = 23.2, step: Double? = nil) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "endurance",
            target: .init(weeklyDistanceKm: 30),
            distance: .init(targetKm: 30, thisWeekKm: thisWeek, avg4wKm: avg, weekStart: "2026-10-05", stepTargetKm: step),
            verdict: .building,
            headline: "Building — distance up 12% (last 2 weeks vs the 2 before)"
        )
    }

    func testDistanceLineIsPrimaryAndUnitAware() {
        let p = distanceProgress()
        XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .metric), "24.5 of 30\u{00A0}km this week")
        XCTAssertEqual(GoalProgressLogic.primaryLine(p, system: .metric), "24.5 of 30\u{00A0}km this week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .imperial), "15.2 of 18.6\u{00A0}mi this week")
        XCTAssertEqual(GoalProgressLogic.distanceAverageLine(p, system: .metric), "4-week avg 23.2\u{00A0}km a week")
    }

    /// Every value+unit in the weekly-distance lines is glued with U+00A0, so a
    /// narrow card wraps between tokens ("22.7 of ~27 km" / "this week"), never
    /// "~27" / "km".
    func testDistanceLinesHaveNoPlainSpaceBetweenADigitAndAUnit() {
        for system in [UnitSystem.metric, .imperial] {
            for p in [distanceProgress(), distanceProgress(thisWeek: 22.7, step: 27)] {
                assertNoBreakableUnitSpace(GoalProgressLogic.distanceLine(p, system: system) ?? "")
                assertNoBreakableUnitSpace(GoalProgressLogic.primaryLine(p, system: system))
                assertNoBreakableUnitSpace(GoalProgressLogic.distanceAverageLine(p, system: system) ?? "")
            }
        }
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
        XCTAssertNil(p.distance?.stepTargetKm, "an older server omits the step")
    }

    // MARK: - This week's safe step (one target for the week)

    /// A step below the goal is the week's target: the line names both
    /// ("22.7 of ~27 km this week · goal 30 km") and the bar runs to the step.
    func testDistanceLineAndBarUseTheStepTargetWhenItIsBelowTheGoal() throws {
        let p = distanceProgress(thisWeek: 22.7, step: 27)
        XCTAssertEqual(GoalProgressLogic.stepTargetKm(p), 27)
        XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .metric), "22.7 of ~27\u{00A0}km this week · goal 30\u{00A0}km")
        XCTAssertEqual(GoalProgressLogic.primaryLine(p, system: .metric), "22.7 of ~27\u{00A0}km this week · goal 30\u{00A0}km")
        XCTAssertEqual(try XCTUnwrap(GoalProgressLogic.distanceFraction(p)), 22.7 / 27, accuracy: 0.0001)
        XCTAssertEqual(plain(GoalProgressLogic.distanceBarEndText(p, system: .metric)), "~27 km")
        // Past the step the bar is simply full.
        XCTAssertEqual(try XCTUnwrap(GoalProgressLogic.distanceFraction(distanceProgress(thisWeek: 28, step: 27))), 1, accuracy: 0.0001)
        // Nothing else about the average line changes.
        XCTAssertEqual(GoalProgressLogic.distanceAverageLine(p, system: .metric), "4-week avg 23.2\u{00A0}km a week")
    }

    func testDistanceStepIsUnitAware() {
        // The server sends the step in km (17 whole miles = 27.4 km); the goal 30 km = 18.6 mi.
        let p = distanceProgress(thisWeek: 22.7, step: 27.4)
        XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .imperial), "14.1 of ~17\u{00A0}mi this week · goal 18.6\u{00A0}mi")
        XCTAssertEqual(plain(GoalProgressLogic.distanceBarEndText(p, system: .imperial)), "~17 mi")
    }

    /// No step to speak of (the goal itself, absent on an older server, or
    /// nonsense) is exactly the previous behaviour: one goal target.
    func testDistanceLineFallsBackToTheGoalWithoutARealStep() throws {
        for step in [nil, 30, 31, 0, -4, Double.nan] as [Double?] {
            let p = distanceProgress(thisWeek: 24.5, step: step)
            XCTAssertNil(GoalProgressLogic.stepTargetKm(p), "step \(String(describing: step))")
            XCTAssertEqual(GoalProgressLogic.distanceLine(p, system: .metric), "24.5 of 30\u{00A0}km this week")
            XCTAssertEqual(try XCTUnwrap(GoalProgressLogic.distanceFraction(p)), 24.5 / 30, accuracy: 0.0001)
            XCTAssertEqual(plain(GoalProgressLogic.distanceBarEndText(p, system: .metric)), "30 km")
        }
        // Still nothing without a measured distance.
        XCTAssertNil(GoalProgressLogic.distanceLine(distanceProgress(thisWeek: nil, step: 27), system: .metric))
        XCTAssertNil(GoalProgressLogic.distanceFraction(distanceProgress(thisWeek: nil, step: 27)))
    }

    func testStepTargetDecodesTolerantly() throws {
        func decode(_ step: String) throws -> GoalProgressDTO {
            let json = """
            {"goal":"endurance","distance":{"targetKm":30,"thisWeekKm":22.7,"avg4wKm":22.6,"weekStart":"2026-10-05"\(step)},
             "verdict":"building","headline":"x","reasons":[]}
            """
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode(",\"stepTargetKm\":27").distance?.stepTargetKm, 27)
        XCTAssertEqual(try decode(",\"stepTargetKm\":27.4").distance?.stepTargetKm, 27.4)
        XCTAssertNil(try decode("").distance?.stepTargetKm)
        XCTAssertNil(try decode(",\"stepTargetKm\":null").distance?.stepTargetKm)
        XCTAssertNil(try decode(",\"stepTargetKm\":\"nope\"").distance?.stepTargetKm, "wrong type never hides the card")
        XCTAssertEqual(try decode(",\"stepTargetKm\":\"nope\"").distance?.thisWeekKm, 22.7)
        let withStep = try decode(",\"stepTargetKm\":27")
        XCTAssertEqual(GoalProgressLogic.distanceLine(withStep, system: .metric), "22.7 of ~27\u{00A0}km this week · goal 30\u{00A0}km")
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
        XCTAssertEqual(GoalProgressLogic.compactText(stale(1), system: .metric, now: now, locale: en), "76\u{00A0}kg by ~Dec 10")
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
        let lift = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg)", tone: .good)
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), eta: "2026-12-06", verdict: .progressing,
            reasons: [lift]
        )
        XCTAssertEqual(
            plain(GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en)),
            "1 of 4 kg gained · Squat +10 kg / 4 wk"
        )
        // Value+unit tokens never break mid-token: the only plain spaces sit between tokens.
        XCTAssertEqual(
            GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en),
            "1 of 4\u{00A0}kg gained · Squat +10\u{00A0}kg /\u{00A0}4\u{00A0}wk"
        )
        // Imperial: weights in lb; the lift short is the server's already-unit-correct text.
        let imperialLift = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM −44 lb vs 4 weeks ago (264 → 220 lb)", tone: .watch)
        let imperial = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), verdict: .progressing,
            reasons: [imperialLift]
        )
        XCTAssertEqual(
            plain(GoalProgressLogic.compactText(imperial, system: .imperial, now: now, locale: en)),
            "2.2 of 8.8 lb gained · Squat \u{2212}44 lb / 4 wk"
        )
        // No lift reason: the goal outcome alone.
        let noLift = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), verdict: .progressing
        )
        XCTAssertEqual(plain(GoalProgressLogic.compactText(noLift, system: .metric, now: now, locale: en)), "1 of 4 kg gained")
        // An "unchanged" lift has no signed change to quote.
        let flat = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM unchanged vs 4 weeks ago (120 → 120 kg)", tone: .neutral)
        XCTAssertNil(GoalProgressLogic.liftShortText(GoalProgressDTO(goal: "muscle", verdict: .progressing, reasons: [flat])))
        // The line fits two Today lines.
        XCTAssertLessThanOrEqual(GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en).count, 48)
    }

    func testMuscleCompactLinePrefersLiftReasonOverWeightEta() {
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 90), eta: "2026-12-06", verdict: .progressing,
            reasons: [GoalReasonDTO(kind: "lift", text: "Squat +10 kg vs 4 wk", tone: .good)]
        )
        XCTAssertEqual(GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en), "Squat +10 kg vs 4 wk")
        let noLift = GoalProgressDTO(goal: "muscle", target: .init(weightKg: 90), eta: "2026-12-06", verdict: .progressing)
        XCTAssertEqual(GoalProgressLogic.compactText(noLift, system: .metric, now: now, locale: en), "90\u{00A0}kg by ~Dec 6")
    }

    // MARK: - Muscle "sessions behind": cause + next step

    private func muscleBehind(
        adherence: GoalProgressDTO.Adherence? = .init(done: 9, planned: 16, weeklyTarget: 4, pct: 56),
        verdict: GoalVerdict = .behind
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83, weeklySessions: 4),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), eta: "2026-12-06", verdict: verdict,
            headline: "Lifts up, sessions behind — Squat +10 kg",
            reasons: [
                GoalReasonDTO(kind: "adherence", text: "9 of 16 planned sessions in 4 weeks (56%)", tone: .watch),
                GoalReasonDTO(kind: "lift", text: "Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg)", tone: .good),
            ],
            adherence: adherence
        )
    }

    /// The muscle `behind` Today line leads with the cause and the next step,
    /// from the payload's structured adherence (not parsed reason copy).
    func testMuscleBehindCompactLineLeadsWithCauseAndNextStep() {
        let line = GoalProgressLogic.compactText(muscleBehind(), system: .metric, now: now, locale: en)
        XCTAssertEqual(plain(line), "9 of 16 sessions in 4 wk · aim for 4 this week")
        XCTAssertEqual(line, "9 of 16 sessions in 4\u{00A0}wk · aim for 4 this week")
        XCTAssertEqual(GoalProgressLogic.sessionsBehindText(muscleBehind()), line)
        XCTAssertLessThanOrEqual(line.count, 48, "fits two Today lines")
        // Numbers come from the payload.
        let other = muscleBehind(adherence: .init(done: 5, planned: 12, weeklyTarget: 3, pct: 42))
        XCTAssertEqual(plain(GoalProgressLogic.compactText(other, system: .metric, now: now, locale: en)),
                       "5 of 12 sessions in 4 wk · aim for 3 this week")
        // The kg-gained / lift tail is not repeated next to the cause.
        XCTAssertFalse(line.contains("gained"))
        XCTAssertFalse(line.contains("Squat"))
    }

    /// Once Today knows this week's done count (the hero's "2 of 4 sessions this
    /// week") the next step is the concrete remainder, not a generic "aim for".
    func testMuscleBehindLineNamesTheRemainingSessionsWhenTheWeekCountIsKnown() {
        let line = GoalProgressLogic.compactText(muscleBehind(), system: .metric, sessionsDoneThisWeek: 2, now: now, locale: en)
        XCTAssertEqual(plain(line), "9 of 16 sessions in 4 wk · 2 more by Sun")
        // "2 more by Sun" is one unbreakable token: a narrow line wraps before it,
        // never as "· 2 / more by Sun".
        XCTAssertEqual(line, "9 of 16 sessions in 4\u{00A0}wk · 2\u{00A0}more\u{00A0}by\u{00A0}Sun")
        XCTAssertFalse(line.contains("2 more"), "no breaking space between the number and its noun")
        XCTAssertFalse(line.contains("more by"))
        XCTAssertEqual(GoalProgressLogic.sessionsBehindText(muscleBehind(), doneThisWeek: 2), line)
        XCTAssertLessThanOrEqual(line.count, 48, "fits two Today lines")
        XCTAssertEqual(plain(GoalProgressLogic.sessionsBehindText(muscleBehind(), doneThisWeek: 0)),
                       "9 of 16 sessions in 4 wk · 4 more by Sun")
        XCTAssertEqual(plain(GoalProgressLogic.sessionsBehindText(muscleBehind(), doneThisWeek: 3)),
                       "9 of 16 sessions in 4 wk · 1 more by Sun")
        // The weekly target comes from the payload.
        let other = muscleBehind(adherence: .init(done: 5, planned: 12, weeklyTarget: 3, pct: 42))
        XCTAssertEqual(plain(GoalProgressLogic.sessionsBehindText(other, doneThisWeek: 1)),
                       "5 of 12 sessions in 4 wk · 2 more by Sun")
    }

    func testMuscleBehindLineFallsBackToAimForWhenTheWeekCountIsUnknownOrTheTargetIsMet() {
        let aim = "9 of 16 sessions in 4 wk · aim for 4 this week"
        XCTAssertEqual(plain(GoalProgressLogic.sessionsBehindText(muscleBehind(), doneThisWeek: nil)), aim)
        XCTAssertEqual(plain(GoalProgressLogic.compactText(muscleBehind(), system: .metric, now: now, locale: en)), aim)
        // Target already hit (or beaten): never "0 more" / "-1 more".
        XCTAssertEqual(plain(GoalProgressLogic.sessionsBehindText(muscleBehind(), doneThisWeek: 4)), aim)
        XCTAssertEqual(plain(GoalProgressLogic.sessionsBehindText(muscleBehind(), doneThisWeek: 5)), aim)
        // The done count changes nothing for a muscle goal that is not behind.
        XCTAssertEqual(
            plain(GoalProgressLogic.compactText(muscleBehind(verdict: .progressing), system: .metric, sessionsDoneThisWeek: 2, now: now, locale: en)),
            "1 of 4 kg gained · Squat +10 kg / 4 wk"
        )
    }

    func testMuscleBehindLineOnlyWhenBehindMuscleWithAdherence() {
        // Not behind: the existing goal-outcome + lift line.
        let progressing = muscleBehind(verdict: .progressing)
        XCTAssertNil(GoalProgressLogic.sessionsBehindText(progressing))
        XCTAssertEqual(plain(GoalProgressLogic.compactText(progressing, system: .metric, now: now, locale: en)),
                       "1 of 4 kg gained · Squat +10 kg / 4 wk")
        // Older server (no adherence): behind keeps the previous line instead of guessing numbers.
        let legacy = muscleBehind(adherence: nil)
        XCTAssertNil(GoalProgressLogic.sessionsBehindText(legacy))
        XCTAssertEqual(plain(GoalProgressLogic.compactText(legacy, system: .metric, now: now, locale: en)),
                       "1 of 4 kg gained · Squat +10 kg / 4 wk")
        // Unusable counts never divide or print nonsense.
        XCTAssertNil(GoalProgressLogic.sessionsBehindText(muscleBehind(adherence: .init(done: 0, planned: 0, weeklyTarget: 0))))
        // Other goals' `behind` ("Behind pace") is untouched even if a payload carried adherence.
        let weightLossBehind = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 76, date: "2027-01-15"),
            current: .init(weightKg: 82.0, startWeightKg: 83.7), eta: "2026-12-10", verdict: .behind,
            adherence: .init(done: 9, planned: 16, weeklyTarget: 4)
        )
        XCTAssertNil(GoalProgressLogic.sessionsBehindText(weightLossBehind))
    }

    func testAdherenceDecodesTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = "{\"goal\":\"muscle\",\"verdict\":\"behind\",\"headline\":\"x\",\"reasons\":[]\(extra)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        let full = try decode(",\"adherence\":{\"done\":9,\"planned\":16,\"weeklyTarget\":4,\"pct\":56}")
        XCTAssertEqual(full.adherence, GoalProgressDTO.Adherence(done: 9, planned: 16, weeklyTarget: 4, pct: 56))
        XCTAssertEqual(GoalProgressLogic.sessionsBehindText(full), "9 of 16 sessions in 4\u{00A0}wk · aim for 4 this week")
        XCTAssertNil(try decode("").adherence, "older servers omit it")
        XCTAssertNil(try decode(",\"adherence\":null").adherence)
        XCTAssertNil(try decode(",\"adherence\":{\"done\":9}").adherence, "a partial block is dropped, never half-used")
        XCTAssertNil(try decode(",\"adherence\":\"nope\"").adherence)
        XCTAssertNil(try decode(",\"adherence\":{\"done\":9,\"planned\":16,\"weeklyTarget\":4}").adherence?.pct)
    }

    /// Wrapping may only happen between tokens: no plain space sits directly
    /// before a unit, and "/ 4 wk" is one token.
    func testValueUnitTokensDoNotBreakMidValue() {
        let lift = GoalReasonDTO(kind: "lift", text: "Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg)", tone: .good)
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 83),
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), eta: "2026-12-06", verdict: .progressing,
            reasons: [lift]
        )
        XCTAssertEqual(GoalProgressLogic.liftShortText(muscle), "Squat +10\u{00A0}kg /\u{00A0}4\u{00A0}wk")
        let strings = [
            GoalProgressLogic.compactText(muscle, system: .metric, now: now, locale: en),
            GoalProgressLogic.compactText(muscleBehind(), system: .metric, now: now, locale: en),
            GoalProgressLogic.weightLine(muscle, system: .metric) ?? "",
        ]
        for text in strings {
            for unit in [" kg", " lb", " wk", "/ 4"] {
                XCTAssertFalse(text.contains(unit), "\"\(text)\" has a breakable space before \"\(unit)\"")
            }
        }
    }

    // MARK: - nonBreaking(_:)

    /// Server copy (or copy composed with plain spaces) is shown through
    /// `nonBreaking` so a narrow line wraps BETWEEN value+unit tokens, never
    /// "+10 / kg" or "(153 → / 163 kg)".
    func testNonBreakingKeepsValuesUnitsAndArrowPairsWhole() {
        let nb = GoalProgressLogic.nbsp
        XCTAssertEqual(
            GoalProgressLogic.nonBreaking("Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg)"),
            "Squat est. 1RM +10\(nb)kg vs 4\(nb)weeks ago (153\(nb)→\(nb)163\(nb)kg)"
        )
        XCTAssertEqual(
            GoalProgressLogic.nonBreaking("3 of 4 sessions, Squat est. 1RM +10 kg over 4 wks"),
            "3 of 4 sessions, Squat est. 1RM +10\(nb)kg over 4\(nb)wks"
        )
        XCTAssertEqual(GoalProgressLogic.nonBreaking("Lifts up, sessions behind — Squat +10 kg"),
                       "Lifts up, sessions behind — Squat +10\(nb)kg")
        XCTAssertEqual(GoalProgressLogic.nonBreaking("-0.6 kg/wk, 8 mi, 150 bpm"), "-0.6\(nb)kg/wk, 8\(nb)mi, 150\(nb)bpm")
    }

    func testNonBreakingBindsNumericRangesAcrossTheDash() {
        let nb = GoalProgressLogic.nbsp
        let wj = GoalProgressLogic.wordJoiner
        XCTAssertEqual(GoalProgressLogic.nonBreaking("≈ 0.2–0.8 kg"), "≈ 0.2\(wj)–\(wj)0.8\(nb)kg")
        // A dash between words is a normal break opportunity.
        XCTAssertEqual(GoalProgressLogic.nonBreaking("Building — distance up"), "Building — distance up")
    }

    func testNonBreakingIsIdempotentAndLeavesOtherTextAlone() {
        let once = GoalProgressLogic.nonBreaking("Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg), 0.2–0.8 kg")
        XCTAssertEqual(GoalProgressLogic.nonBreaking(once), once)
        // Server copy that is already non-breaking passes through unchanged.
        let already = "Squat est. 1RM +10\u{00A0}kg over 4\u{00A0}wks"
        XCTAssertEqual(GoalProgressLogic.nonBreaking(already), already)
        // Words that merely begin with a unit are not units.
        XCTAssertEqual(GoalProgressLogic.nonBreaking("5 min, 3 weekly, 2 kgs"), "5 min, 3 weekly, 2 kgs")
        XCTAssertEqual(GoalProgressLogic.nonBreaking("Half marathon in 12 weeks (Dec 30)"),
                       "Half marathon in 12\u{00A0}weeks (Dec 30)")
        XCTAssertEqual(GoalProgressLogic.nonBreaking(""), "")
    }

    // MARK: - Detail sheet stats rows (weight rows only when they belong)

    /// A race-goal runner who also has a body weight on file (so "Now 61 kg"
    /// would be available) but no target weight.
    private func enduranceWithBodyWeight(targetWeightKg: Double? = nil) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "endurance",
            target: .init(weightKg: targetWeightKg, weeklyDistanceKm: 30),
            distance: .init(targetKm: 30, thisWeekKm: 24.5, avg4wKm: 22.6, weekStart: "2026-10-05"),
            race: .init(date: "2026-12-30", distanceKm: 21.1, label: "Half marathon", weeksToGo: 12, daysToGo: 85),
            longRun: .init(lastKm: 14, peakKm: 16, targetPeakKm: 18),
            current: .init(weightKg: 61, startWeightKg: 61.5, changeKg: -0.5),
            ratePerWeek: .init(kg: -0.1, pctBodyweight: -0.16),
            verdict: .building,
            dataSufficiency: .init(weighIns: 11, needed: 3, sessionsLast28d: 12)
        )
    }

    func testEnduranceStatRowsHideWeightRowsWithoutATargetWeight() {
        let progress = enduranceWithBodyWeight()
        XCTAssertFalse(GoalProgressLogic.showsWeightRows(progress))
        let rows = GoalProgressLogic.statRows(progress, system: .metric)
        XCTAssertEqual(
            rows.map(\.label),
            ["Race", "Long run", "Weekly distance goal", "This week", "4-week average", "Sessions, last 4 weeks"]
        )
        // The table opens with the race, never "Now 61 kg".
        XCTAssertEqual(rows.first?.label, "Race")
        XCTAssertEqual(rows.first { $0.label == "Weekly distance goal" }?.value, "30\u{00A0}km")
        XCTAssertEqual(rows.first { $0.label == "This week" }?.value, "24.5\u{00A0}km")
    }

    func testEnduranceStatRowsKeepWeightRowsWhenATargetWeightExists() {
        let progress = enduranceWithBodyWeight(targetWeightKg: 58)
        XCTAssertTrue(GoalProgressLogic.showsWeightRows(progress))
        let rows = GoalProgressLogic.statRows(progress, system: .metric)
        XCTAssertEqual(rows.prefix(4).map(\.label), ["Start", "Now", "Target", "Trend"])
        XCTAssertEqual(rows.prefix(4).map(\.value), [
            "61.5\u{00A0}kg", "61\u{00A0}kg", "58\u{00A0}kg", "\u{2212}0.1\u{00A0}kg/wk",
        ])
    }

    func testGeneralGoalStatRowsFollowTheSameTargetWeightRule() {
        let noTarget = GoalProgressDTO(
            goal: "general",
            current: .init(weightKg: 70, startWeightKg: 71, changeKg: -1),
            ratePerWeek: .init(kg: -0.2),
            verdict: .holding
        )
        XCTAssertFalse(GoalProgressLogic.showsWeightRows(noTarget))
        XCTAssertTrue(GoalProgressLogic.statRows(noTarget, system: .metric).isEmpty)

        let withTarget = GoalProgressDTO(
            goal: "general",
            target: .init(weightKg: 68),
            current: .init(weightKg: 70, startWeightKg: 71, changeKg: -1),
            ratePerWeek: .init(kg: -0.2),
            verdict: .holding
        )
        XCTAssertTrue(GoalProgressLogic.showsWeightRows(withTarget))
        XCTAssertEqual(GoalProgressLogic.statRows(withTarget, system: .metric).map(\.label), ["Start", "Now", "Target", "Trend"])
    }

    func testWeightLossAndMuscleGoalsAlwaysListTheirWeightRows() {
        let loss = weightLoss()
        XCTAssertTrue(GoalProgressLogic.showsWeightRows(loss))
        XCTAssertEqual(GoalProgressLogic.statRows(loss, system: .metric).map(\.label), ["Start", "Now", "Target", "Trend"])
        XCTAssertEqual(GoalProgressLogic.statRows(loss, system: .metric).map(\.value), [
            "83.7\u{00A0}kg", "82\u{00A0}kg", "76\u{00A0}kg", "\u{2212}0.6\u{00A0}kg/wk",
        ])
        // Muscle without a target weight still shows where the body weight started and is now.
        let muscle = GoalProgressDTO(
            goal: "muscle",
            current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1),
            verdict: .progressing
        )
        XCTAssertTrue(GoalProgressLogic.showsWeightRows(muscle))
        XCTAssertEqual(GoalProgressLogic.statRows(muscle, system: .metric).map(\.label), ["Start", "Now"])
    }

    func testCompactReasonShortensEnduranceVolumeCopy() {
        XCTAssertEqual(
            GoalProgressLogic.compactReason("weekly distance up 12% (last 2 weeks vs the 2 before)"),
            "distance up 12% · 2 wk vs prior 2"
        )
        XCTAssertEqual(GoalProgressLogic.compactReason("Resting heart rate down"), "Resting heart rate down")
    }
}
