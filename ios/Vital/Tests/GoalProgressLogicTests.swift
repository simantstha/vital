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

    /// Wave 25s: the card's reason dates its baseline ("vs wk of Apr 6") when the number came from the week before the 4-weeks-ago week
    /// (`liftBaselineLabel` in lib/liftChange.ts). The Today line says that week too, not "/ 4 wk" (the card said +9 kg vs wk of Apr 6
    /// while the line said "Squat +9 kg / 4 wk"). Server wording quoted exactly; the spaces are non-breaking.
    func testTodayLiftLineNamesTheBaselineWeekWhenTheCardDoes() {
        func muscle(_ text: String) -> GoalProgressDTO {
            GoalProgressDTO(
                goal: "muscle", target: .init(weightKg: 83),
                current: .init(weightKg: 80, startWeightKg: 79, changeKg: 1, progressPct: 25), eta: "2026-12-06", verdict: .progressing,
                reasons: [GoalReasonDTO(kind: "lift", text: text, tone: .good)]
            )
        }
        let dated = muscle("Squat est. 1RM +9 kg vs wk of Apr 6 (139 → 148 kg)")
        XCTAssertEqual(GoalProgressLogic.liftShortText(dated), "Squat +9\u{00A0}kg vs\u{00A0}wk\u{00A0}of\u{00A0}Apr\u{00A0}6")
        // The server's own non-breaking spaces and a two-digit day read the same.
        let nb = muscle("Squat est. 1RM +9\u{00A0}kg vs wk of Aug 31 (139 → 148\u{00A0}kg)")
        XCTAssertEqual(GoalProgressLogic.liftShortText(nb), "Squat +9\u{00A0}kg vs\u{00A0}wk\u{00A0}of\u{00A0}Aug\u{00A0}31")
        // The 4-weeks-ago baseline keeps "/ 4 wk".
        let ago = muscle("Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg)")
        XCTAssertEqual(GoalProgressLogic.liftShortText(ago), "Squat +10\u{00A0}kg /\u{00A0}4\u{00A0}wk")
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

    // MARK: - Server weight read (wave 19: early / returning / plateau)

    private let earlyHeadline = "Early read — down 0.7 kg on the scale in 7 days"
    private let returningHeadline = "Welcome back — the scale is down 1.1 kg since May 10"
    private let plateauHeadline = "Plateau — weekly average ~89.4 kg for 3 weeks"

    /// A weight-loss payload shaped like the server's during a withheld-pace read:
    /// no rate and no ETA, while the smoothed trend is a hair under the start (so
    /// the trend-composed line would read "0.2 of 7.7 kg lost").
    private func readProgress(
        _ state: GoalProgressDTO.WeightRead.State?, headline: String, goal: String = "weight_loss",
        verdict: GoalVerdict = .progressing, eta: String? = nil, rateKg: Double? = nil
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: goal,
            target: .init(weightKg: 76, date: "2027-01-15"),
            current: .init(weightKg: 83.5, startWeightKg: 83.7, changeKg: -0.2, progressPct: 3),
            ratePerWeek: .init(kg: rateKg),
            eta: eta,
            verdict: verdict,
            headline: headline,
            weightRead: state.map { GoalProgressDTO.WeightRead(state: $0) }
        )
    }

    func testPrimaryLineIsTheServerReadDuringAnEarlyReturningOrPlateauRead() {
        let reads: [(GoalProgressDTO.WeightRead.State, String)] = [
            (.early, earlyHeadline), (.returning, returningHeadline), (.plateau, plateauHeadline),
        ]
        for (state, headline) in reads {
            let progress = readProgress(state, headline: headline)
            XCTAssertTrue(GoalProgressLogic.usesServerWeightRead(progress), "\(state)")
            XCTAssertEqual(GoalProgressLogic.serverWeightRead(progress), headline, "\(state)")
            XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), headline, "\(state)")
            // The server headline already speaks in the user's unit: no kg -> lb rewrite here.
            XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .imperial), headline, "\(state)")
            XCTAssertFalse(GoalProgressLogic.primaryLine(progress, system: .metric).contains("of 7.7"), "\(state)")
        }
    }

    func testServerReadDropsALeadingVerdictPhrase() {
        let progress = readProgress(.early, headline: "Progressing — down 0.7 kg on the scale in 7 days")
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), "down 0.7 kg on the scale in 7 days")
    }

    func testPrimaryLineKeepsTheTrendLineForPaceReachedAndAnOlderServer() {
        let composed = "0.2 of 7.7 kg lost"
        for state in [GoalProgressDTO.WeightRead.State.pace, .reached] {
            let progress = readProgress(state, headline: "On track — about 6 kg to go")
            XCTAssertFalse(GoalProgressLogic.usesServerWeightRead(progress), "\(state)")
            XCTAssertNil(GoalProgressLogic.serverWeightRead(progress), "\(state)")
            XCTAssertEqual(plain(GoalProgressLogic.primaryLine(progress, system: .metric)), composed, "\(state)")
        }
        // An older server sends no weightRead at all — even with an early-sounding headline.
        let older = readProgress(nil, headline: earlyHeadline)
        XCTAssertNil(older.weightRead)
        XCTAssertFalse(GoalProgressLogic.usesServerWeightRead(older))
        XCTAssertNil(GoalProgressLogic.serverWeightRead(older))
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(older, system: .metric)), composed)
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(older, system: .imperial)), "0.4 of 17 lb lost")
    }

    func testAnUnknownWeightReadStateBehavesLikeNoWeightRead() throws {
        let json = """
        {"goal":"weight_loss","verdict":"progressing","headline":"\(earlyHeadline)",
         "target":{"weightKg":76},"current":{"weightKg":83.5,"startWeightKg":83.7},
         "weightRead":{"state":"some_future_state","scaleKg":83.4}}
        """
        let progress = try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        XCTAssertNotNil(progress.weightRead)
        XCTAssertNil(progress.weightRead?.state)
        XCTAssertEqual(progress.weightRead?.scaleKg, 83.4)
        XCTAssertFalse(GoalProgressLogic.usesServerWeightRead(progress))
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(progress, system: .metric)), "0.2 of 7.7 kg lost")
    }

    /// The server read replaces the weight-loss line only; a muscle goal's weight
    /// story (and its lift-led headline) is untouched even though the server also
    /// sends `weightRead` for it.
    func testServerReadNeverReplacesAMuscleGoalLine() {
        let muscle = readProgress(.early, headline: "Progressing — Squat est. 1RM +10 kg", goal: "muscle")
        XCTAssertFalse(GoalProgressLogic.usesServerWeightRead(muscle))
        XCTAssertNil(GoalProgressLogic.serverWeightRead(muscle))
        let without = readProgress(nil, headline: "Progressing — Squat est. 1RM +10 kg", goal: "muscle")
        XCTAssertEqual(GoalProgressLogic.primaryLine(muscle, system: .metric), GoalProgressLogic.primaryLine(without, system: .metric))
    }

    func testServerReadIsNeverShownForAReachedGoalOrWithoutAHeadline() {
        XCTAssertNil(GoalProgressLogic.serverWeightRead(readProgress(.plateau, headline: plateauHeadline, verdict: .reached)))
        XCTAssertNil(GoalProgressLogic.serverWeightRead(readProgress(.early, headline: "  ")))
        // Without text the card falls back to the composed line rather than going blank.
        XCTAssertEqual(plain(GoalProgressLogic.primaryLine(readProgress(.early, headline: ""), system: .metric)), "0.2 of 7.7 kg lost")
    }

    /// Today's goal line: the read leads, and a projected date never contradicts
    /// it — even if one were sent alongside the read.
    func testCompactTextShowsTheServerReadAndNoEtaDuringAWithheldPace() {
        let early = readProgress(.early, headline: earlyHeadline, eta: "2026-12-10")
        XCTAssertEqual(GoalProgressLogic.compactText(early, system: .metric, now: now, locale: en), earlyHeadline)
        let plateau = readProgress(.plateau, headline: plateauHeadline)
        XCTAssertEqual(GoalProgressLogic.compactText(plateau, system: .metric, now: now, locale: en), plateauHeadline)
        // Pace and an older server keep the ETA-vs-target phrase.
        let pace = readProgress(.pace, headline: "On track", eta: "2026-12-10")
        XCTAssertEqual(plain(GoalProgressLogic.compactText(pace, system: .metric, now: now, locale: en)), "5 wk ahead of Jan 15, 2027")
        let older = readProgress(nil, headline: "On track", eta: "2026-12-10")
        XCTAssertEqual(plain(GoalProgressLogic.compactText(older, system: .metric, now: now, locale: en)), "5 wk ahead of Jan 15, 2027")
    }

    func testWeightReadDecodesTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = "{\"goal\":\"weight_loss\",\"verdict\":\"progressing\",\"headline\":\"x\",\"reasons\":[]\(extra)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        let full = try decode("""
        ,"weightRead":{"state":"returning","scaleKg":82.3,"scaleDay":"2026-10-05","weekMeanKg":82.5,"weeksVsTarget":-2,
         "returned":{"gapDays":12,"sinceDay":"2026-05-10","sinceKg":83.4,"weighInsSince":1},"reachedDaysAgo":null}
        """)
        XCTAssertEqual(full.weightRead, GoalProgressDTO.WeightRead(
            state: .returning, scaleKg: 82.3, scaleDay: "2026-10-05", weekMeanKg: 82.5, weeksVsTarget: -2,
            returned: .init(gapDays: 12, sinceDay: "2026-05-10", sinceKg: 83.4, weighInsSince: 1), reachedDaysAgo: nil
        ))

        // Every state the server sends.
        let states: [(String, GoalProgressDTO.WeightRead.State)] = [
            ("early", .early), ("returning", .returning), ("plateau", .plateau), ("pace", .pace), ("reached", .reached),
        ]
        for (wire, state) in states {
            XCTAssertEqual(try decode(",\"weightRead\":{\"state\":\"\(wire)\"}").weightRead?.state, state, wire)
        }
        // A null state (no usable weigh-in) is a read without a state.
        XCTAssertNotNil(try decode(",\"weightRead\":{\"state\":null,\"scaleKg\":null}").weightRead)
        XCTAssertNil(try decode(",\"weightRead\":{\"state\":null}").weightRead?.state)

        // Older payloads decode exactly as before.
        let older = try decode("")
        XCTAssertNil(older.weightRead)
        XCTAssertNil(older.liftReturn)
        XCTAssertEqual(older.verdict, .progressing)
        XCTAssertNil(try decode(",\"weightRead\":null").weightRead)
        XCTAssertNil(try decode(",\"weightRead\":\"nope\"").weightRead)

        // Unknown or wrong-typed pieces drop only themselves.
        let unknown = try decode(",\"weightRead\":{\"state\":\"mystery\",\"scaleKg\":82.3}")
        XCTAssertNil(unknown.weightRead?.state)
        XCTAssertEqual(unknown.weightRead?.scaleKg, 82.3)
        XCTAssertNil(try decode(",\"weightRead\":{\"state\":5}").weightRead?.state)
        XCTAssertEqual(try decode(",\"weightRead\":{\"weeksVsTarget\":2.0}").weightRead?.weeksVsTarget, 2)
        XCTAssertNil(try decode(",\"weightRead\":{\"weeksVsTarget\":\"soon\"}").weightRead?.weeksVsTarget)
        XCTAssertEqual(try decode(",\"weightRead\":{\"reachedDaysAgo\":3}").weightRead?.reachedDaysAgo, 3)
        let partial = try decode(",\"weightRead\":{\"state\":\"returning\",\"returned\":{\"gapDays\":12}}")
        XCTAssertEqual(partial.weightRead?.state, .returning)
        XCTAssertNil(partial.weightRead?.returned, "a partial return block is dropped, never half-used")
    }

    func testLiftReturnDecodesTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = "{\"goal\":\"muscle\",\"verdict\":\"building\",\"headline\":\"x\",\"reasons\":[]\(extra)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        let full = try decode("""
        ,"liftReturn":{"exercise":"squat","name":"Squat","breakDays":14,"endedOn":"2026-09-20",
         "preBreakKg":142,"recentKg":136.3,"pct":96,"regained":false}
        """)
        XCTAssertEqual(full.liftReturn, GoalProgressDTO.LiftReturn(
            exercise: "squat", name: "Squat", breakDays: 14, endedOn: "2026-09-20",
            preBreakKg: 142, recentKg: 136.3, pct: 96, regained: false
        ))
        XCTAssertNil(try decode("").liftReturn, "older servers omit it")
        XCTAssertNil(try decode(",\"liftReturn\":null").liftReturn)
        XCTAssertNil(try decode(",\"liftReturn\":\"nope\"").liftReturn)
        // The claim needs the lift, its pre-break best, the percentage and the flag.
        XCTAssertNil(try decode(",\"liftReturn\":{\"preBreakKg\":142,\"pct\":96,\"regained\":false}").liftReturn)
        XCTAssertNil(try decode(",\"liftReturn\":{\"exercise\":\"squat\",\"pct\":96,\"regained\":false}").liftReturn)
        XCTAssertNil(try decode(",\"liftReturn\":{\"exercise\":\"squat\",\"preBreakKg\":142,\"regained\":false}").liftReturn)
        XCTAssertNil(try decode(",\"liftReturn\":{\"exercise\":\"squat\",\"preBreakKg\":142,\"pct\":96}").liftReturn)
        // The rest is optional: the name falls back to the capitalised key, a fractional pct truncates.
        let sparse = try decode(",\"liftReturn\":{\"exercise\":\"bench press\",\"preBreakKg\":100,\"pct\":96.4,\"regained\":true}")
        XCTAssertEqual(sparse.liftReturn?.name, "Bench Press")
        XCTAssertEqual(sparse.liftReturn?.pct, 96)
        XCTAssertEqual(sparse.liftReturn?.regained, true)
        XCTAssertNil(sparse.liftReturn?.breakDays)
        XCTAssertNil(sparse.liftReturn?.recentKg)
    }

    /// Wave 21: `liftReturns` is the same break lift by lift, the headline lift first
    /// (identical to `liftReturn`). Absent, null or malformed reads as `nil`, so the card
    /// falls back to the single `liftReturn`.
    func testLiftReturnsDecodesTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = "{\"goal\":\"muscle\",\"verdict\":\"building\",\"headline\":\"x\",\"reasons\":[]\(extra)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        let full = try decode("""
        ,"liftReturn":{"exercise":"squat","name":"Squat","breakDays":14,"endedOn":"2026-09-20",
         "preBreakKg":142,"recentKg":145.2,"pct":102,"regained":true}
        ,"liftReturns":[
         {"exercise":"squat","name":"Squat","breakDays":14,"endedOn":"2026-09-20",
          "preBreakKg":142,"recentKg":145.2,"pct":102,"regained":true},
         {"exercise":"deadlift","name":"Deadlift","breakDays":14,"endedOn":"2026-09-20",
          "preBreakKg":158,"recentKg":155.1,"pct":98,"regained":false}]
        """)
        let squat = GoalProgressDTO.LiftReturn(
            exercise: "squat", name: "Squat", breakDays: 14, endedOn: "2026-09-20",
            preBreakKg: 142, recentKg: 145.2, pct: 102, regained: true
        )
        let deadlift = GoalProgressDTO.LiftReturn(
            exercise: "deadlift", name: "Deadlift", breakDays: 14, endedOn: "2026-09-20",
            preBreakKg: 158, recentKg: 155.1, pct: 98, regained: false
        )
        XCTAssertEqual(full.liftReturns, [squat, deadlift])
        XCTAssertEqual(full.liftReturns?.first, full.liftReturn, "the headline lift comes first and is identical to liftReturn")

        // Older servers, other goals and malformed values: nil, never a decode failure.
        XCTAssertNil(try decode("").liftReturns, "older servers omit it")
        XCTAssertNil(try decode(",\"liftReturns\":null").liftReturns)
        XCTAssertNil(try decode(",\"liftReturns\":\"nope\"").liftReturns)
        XCTAssertNil(try decode(",\"liftReturns\":{}").liftReturns)
        // An entry without the claim's essentials drops the whole list (a "building back" claim is never guessed);
        // the single liftReturn beside it still decodes.
        let broken = try decode("""
        ,"liftReturn":{"exercise":"squat","preBreakKg":142,"pct":96,"regained":false}
        ,"liftReturns":[{"exercise":"squat","preBreakKg":142,"pct":96,"regained":false},{"exercise":"deadlift","pct":98,"regained":false}]
        """)
        XCTAssertNil(broken.liftReturns)
        XCTAssertEqual(broken.liftReturn?.exercise, "squat")
        // The rest of an entry is optional, as for liftReturn.
        let sparse = try decode(",\"liftReturns\":[{\"exercise\":\"bench press\",\"preBreakKg\":100,\"pct\":96.4,\"regained\":true}]")
        XCTAssertEqual(sparse.liftReturns?.count, 1)
        XCTAssertEqual(sparse.liftReturns?.first?.name, "Bench Press")
        XCTAssertEqual(sparse.liftReturns?.first?.pct, 96)
        XCTAssertNil(sparse.liftReturns?.first?.recentKg)
        // The memberwise initialiser defaults it to nil, so older call sites are untouched.
        XCTAssertNil(GoalProgressDTO(goal: "muscle", verdict: .building).liftReturns)
        XCTAssertEqual(GoalProgressDTO(goal: "muscle", verdict: .building, liftReturns: [squat, deadlift]).liftReturns, [squat, deadlift])
    }

    /// Wave 22: `headlineLift` is the key of the server's sticky headline lift. Absent, null, empty or
    /// not a string reads as `nil`, never a decode failure, and the memberwise initialiser defaults it.
    func testHeadlineLiftDecodesTolerantly() throws {
        func decode(_ extra: String) throws -> GoalProgressDTO {
            let json = "{\"goal\":\"muscle\",\"verdict\":\"progressing\",\"headline\":\"x\",\"reasons\":[]\(extra)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode(",\"headlineLift\":\"squat\"").headlineLift, "squat")
        XCTAssertEqual(try decode(",\"headlineLift\":\"bench press\"").headlineLift, "bench press")
        XCTAssertNil(try decode("").headlineLift, "older servers and other goals omit it")
        XCTAssertNil(try decode(",\"headlineLift\":null").headlineLift)
        XCTAssertNil(try decode(",\"headlineLift\":\"\"").headlineLift)
        XCTAssertNil(try decode(",\"headlineLift\":7").headlineLift)
        XCTAssertNil(try decode(",\"headlineLift\":{}").headlineLift)
        XCTAssertNil(GoalProgressDTO(goal: "muscle", verdict: .building).headlineLift)
        XCTAssertEqual(GoalProgressDTO(goal: "muscle", verdict: .progressing, headlineLift: "squat").headlineLift, "squat")
    }

    // MARK: - Wave 21: weight (moving again, one displayed weight)

    private func decodeWeightLoss(_ extra: String, headline: String = "x") throws -> GoalProgressDTO {
        let json = "{\"goal\":\"weight_loss\",\"verdict\":\"progressing\",\"headline\":\"\(headline)\",\"reasons\":[]\(extra)}"
        return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
    }

    /// `moving_again` is a state of its own: the 14 days after a plateau, with no pace and no date. An unknown state
    /// still decodes to a nil state, never a throw.
    func testMovingAgainDecodesAndAnUnknownStateStillDecodesToNil() throws {
        let moving = try decodeWeightLoss("""
        ,"weightRead":{"state":"moving_again","scaleKg":88.7,"scaleDay":"2026-10-12","weekMeanKg":89.1,
         "weeksVsTarget":null,"returned":null,"reachedDaysAgo":null,
         "plan":{"weekStart":"2026-10-12","asOf":"2026-10-11","state":"moving_again","call":"none","verdict":"progressing",
                 "etaDate":null,"weeksVsTarget":null,"action":{"kind":"keep_what_worked","text":"Keep doing what restarted it"},
                 "plateauCause":null,"pace":null,"confirmed":false}}
        ,"ratePerWeek":{"kg":null,"pctBodyweight":null},"eta":null
        """, headline: "Moving again — weekly average down 0.5 kg from the plateau")
        XCTAssertEqual(moving.weightRead?.state, .movingAgain)
        XCTAssertEqual(moving.weightRead?.plan?.state, .movingAgain)
        XCTAssertEqual(moving.weightRead?.plan?.weekStart, "2026-10-12")
        XCTAssertEqual(moving.weightRead?.plan?.action?.kind, "keep_what_worked")
        XCTAssertEqual(moving.weightRead?.plan?.action?.text, "Keep doing what restarted it")
        // The server withholds a pace and a date in this state, so no surface may compute its own.
        XCTAssertNil(moving.ratePerWeek.kg)
        XCTAssertNil(moving.eta)
        XCTAssertTrue(GoalProgressLogic.usesServerWeightRead(moving))
        XCTAssertEqual(
            GoalProgressLogic.primaryLine(moving, system: .metric),
            "Moving again — weekly average down 0.5 kg from the plateau"
        )

        // An unknown state: a nil state (never a throw) and not a server read.
        let mystery = try decodeWeightLoss(",\"weightRead\":{\"state\":\"mystery\",\"plan\":{\"state\":\"mystery\"}}")
        XCTAssertNil(mystery.weightRead?.state)
        XCTAssertNotNil(mystery.weightRead?.plan, "an unknown plan state drops only itself")
        XCTAssertNil(mystery.weightRead?.plan?.state)
        XCTAssertFalse(GoalProgressLogic.usesServerWeightRead(mystery))
        // The plan's maintenance state is not a read state the app has: nil, the plan survives.
        let maintenance = try decodeWeightLoss(
            ",\"weightRead\":{\"state\":\"reached\",\"plan\":{\"state\":\"maintenance\",\"action\":{\"kind\":\"hold\",\"text\":\"Hold\"}}}"
        )
        XCTAssertEqual(maintenance.weightRead?.state, .reached)
        XCTAssertNil(maintenance.weightRead?.plan?.state)
        XCTAssertEqual(maintenance.weightRead?.plan?.action?.text, "Hold")
    }

    func testWeightReadPlanDecodesTolerantly() throws {
        // Older servers, other goals and malformed values: nil, never a decode failure.
        XCTAssertNil(try decodeWeightLoss(",\"weightRead\":{\"state\":\"pace\"}").weightRead?.plan, "older server")
        XCTAssertNil(try decodeWeightLoss(",\"weightRead\":{\"state\":\"pace\",\"plan\":null}").weightRead?.plan)
        XCTAssertNil(try decodeWeightLoss(",\"weightRead\":{\"state\":\"pace\",\"plan\":\"nope\"}").weightRead?.plan)
        // A pace read keeps working beside it.
        let pace = try decodeWeightLoss(
            ",\"weightRead\":{\"state\":\"pace\",\"plan\":{\"weekStart\":\"2026-10-12\",\"state\":\"pace\",\"action\":{\"kind\":\"keep_going\",\"text\":\"Keep your routine\"}}}"
        )
        XCTAssertEqual(pace.weightRead?.state, .pace)
        XCTAssertEqual(pace.weightRead?.plan?.state, .pace)
        XCTAssertFalse(GoalProgressLogic.usesServerWeightRead(pace))
        // Wrong-typed pieces drop only themselves; an action needs its text.
        let partial = try decodeWeightLoss(
            ",\"weightRead\":{\"state\":\"plateau\",\"plan\":{\"weekStart\":5,\"state\":7,\"action\":{\"kind\":\"plateau_water\"}}}"
        )
        XCTAssertEqual(partial.weightRead?.state, .plateau)
        XCTAssertNotNil(partial.weightRead?.plan)
        XCTAssertNil(partial.weightRead?.plan?.weekStart)
        XCTAssertNil(partial.weightRead?.plan?.state)
        XCTAssertNil(partial.weightRead?.plan?.action, "an action without text is no action")
        // The memberwise initialisers default the new parameters, so older call sites are untouched.
        XCTAssertNil(GoalProgressDTO.WeightRead(state: .pace).plan)
        XCTAssertNil(GoalProgressDTO.Current(weightKg: 82).trendKg)
    }

    /// Weight loss on a wave 21 server: `current.weightKg` is the weekly average and `trendKg` the smoothed trend.
    func testCurrentDecodesTheTrendSeparately() throws {
        let wave21 = try decodeWeightLoss(",\"current\":{\"weightKg\":82.3,\"startWeightKg\":83.7,\"changeKg\":-1.4,\"progressPct\":18,\"trendKg\":82}")
        XCTAssertEqual(wave21.current.weightKg, 82.3)
        XCTAssertEqual(wave21.current.trendKg, 82)
        let older = try decodeWeightLoss(",\"current\":{\"weightKg\":82,\"startWeightKg\":83.7,\"changeKg\":-1.7,\"progressPct\":22}")
        XCTAssertNil(older.current.trendKg)
        XCTAssertNil(try decodeWeightLoss(",\"current\":{\"weightKg\":82,\"trendKg\":null}").current.trendKg)
        XCTAssertNil(try decodeWeightLoss(",\"current\":{\"weightKg\":82,\"trendKg\":\"heavy\"}").current.trendKg)
        XCTAssertEqual(try decodeWeightLoss(",\"current\":{\"weightKg\":82,\"trendKg\":\"heavy\"}").current.weightKg, 82)
    }

    /// The goal sheet's stat row names the number it shows: "This week" for a weekly average of a recent weigh-in
    /// (a payload that carries `trendKg`), "Weekly avg" / "Latest" when it is not, "Now" for an older server's trend.
    /// Other goals keep "Now". (The label rules in full: `WeightHeroLogicTests`.)
    func testStatRowLabelsTheProgressWeightOnlyWhenTheServerSendsTheTrendSeparately() {
        func labels(goal: String, trendKg: Double?, weekMeanKg: Double? = 82.3, daysAgo: Int? = 0) -> [String] {
            GoalProgressLogic.statRows(
                GoalProgressDTO(
                    goal: goal, target: .init(weightKg: 76),
                    current: .init(weightKg: 82.3, startWeightKg: 83.7, trendKg: trendKg), verdict: .onTrack,
                    lastWeighInDaysAgo: daysAgo,
                    weightRead: GoalProgressDTO.WeightRead(state: .pace, weekMeanKg: weekMeanKg)
                ),
                system: .metric
            ).map(\.label)
        }
        XCTAssertEqual(labels(goal: "weight_loss", trendKg: 82), ["Start", "This week", "Target"])
        XCTAssertEqual(labels(goal: "weight_loss", trendKg: 82, daysAgo: 8), ["Start", "Weekly avg", "Target"])
        XCTAssertEqual(labels(goal: "weight_loss", trendKg: 82, weekMeanKg: nil), ["Start", "Latest", "Target"])
        XCTAssertEqual(labels(goal: "weight_loss", trendKg: nil), ["Start", "Now", "Target"], "an older server keeps Now")
        XCTAssertEqual(labels(goal: "muscle", trendKg: 82), ["Start", "Now", "Target"], "weight loss only")
        let weekly = GoalProgressDTO(
            goal: "weight_loss", current: .init(weightKg: 82.3, startWeightKg: 83.7, trendKg: 82), verdict: .onTrack,
            lastWeighInDaysAgo: 0, weightRead: GoalProgressDTO.WeightRead(state: .pace, weekMeanKg: 82.3)
        )
        XCTAssertEqual(GoalProgressLogic.statRows(weekly, system: .metric).first { $0.label == "This week" }?.value, "82.3\u{00A0}kg")
        XCTAssertTrue(GoalProgressLogic.usesProgressWeight(weekly))
        XCTAssertEqual(GoalProgressLogic.currentWeightLabel(weekly), "This week")
        XCTAssertEqual(GoalProgressLogic.currentWeightLabel(GoalProgressDTO(goal: "weight_loss", verdict: .onTrack)), "Now")
    }

    // MARK: - Wave 21: endurance (race eve, plan flags)

    private func decodeEndurance(_ json: String) throws -> GoalProgressDTO {
        try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8))
    }

    /// The race eve payload (`distance.thisWeekKm` null, `distance.text` "Race tomorrow", the advice in the headline).
    private let raceEveJSON = """
    {"goal":"endurance","verdict":"on_track",
     "headline":"Race tomorrow — rest or a 15-min shakeout; lay out your kit",
     "target":{"weightKg":null,"date":null,"weeklySessions":null,"weeklyDistanceKm":30},
     "distance":{"targetKm":30,"thisWeekKm":null,"avg4wKm":30,"weekStart":"2026-06-15","stepTargetKm":15,
                 "text":"Race tomorrow",
                 "plan":{"kind":"race_week","targetKm":15,"longRunKm":null,"purpose":"Race week","stepPct":null}},
     "race":{"date":"2026-06-21","distanceKm":21.1,"label":"Half marathon","weeksToGo":0,"daysToGo":1,"phase":"race_week"},
     "longRun":{"lastKm":18,"peakKm":18,"targetPeakKm":15},
     "reasons":[{"kind":"race","text":"Half marathon in 1 day (Jun 21)","tone":"neutral"}]}
    """

    /// Race eve: no km bar, no "0 of 15 km", no "This week" row, no empty line; the server's headline is the card.
    func testRaceEveShowsTheServersHeadlineAndNoDistanceBar() throws {
        let eve = try decodeEndurance(raceEveJSON)
        XCTAssertNil(eve.distance?.thisWeekKm)
        XCTAssertEqual(eve.distance?.text, "Race tomorrow")
        XCTAssertTrue(GoalProgressLogic.isRaceEve(eve))

        let headline = "Race tomorrow — rest or a 15-min shakeout; lay out your kit"
        XCTAssertNil(GoalProgressLogic.distanceFraction(eve), "no bar")
        XCTAssertNil(GoalProgressLogic.distanceLine(eve, system: .metric), "no \"0 of 15 km\" line")
        XCTAssertEqual(GoalProgressLogic.primaryLine(eve, system: .metric), headline)
        XCTAssertEqual(GoalProgressLogic.compactText(eve, system: .metric), headline)
        // Even when the Today hero would have shown the distance line (it cannot: it has none).
        XCTAssertEqual(GoalProgressLogic.compactText(eve, system: .metric, heroShowsDistance: true), headline)
        XCTAssertFalse(GoalProgressLogic.primaryLine(eve, system: .metric).contains(" of "))
        XCTAssertNil(GoalProgressLogic.paceLine(eve))

        let rows = GoalProgressLogic.statRows(eve, system: .metric)
        XCTAssertNil(rows.first { $0.label == "This week" }, "the week's km are not shown the day before")
        XCTAssertEqual(rows.first { $0.label == "Weekly distance goal" }?.value, "30\u{00A0}km")
        XCTAssertFalse(rows.contains { $0.value.isEmpty }, "no empty row")
        XCTAssertEqual(GoalProgressLogic.visibleReasons(eve).map(\.kind), ["race"])
    }

    func testRaceEveIsOnlyTheDayBeforeTheRaceFromAServerThatSendsNoKm() throws {
        // The day before the race: eve. Two days out, with km: not.
        XCTAssertTrue(GoalProgressLogic.isRaceEve(try decodeEndurance(raceEveJSON)))
        let twoDays = raceEveJSON
            .replacingOccurrences(of: "\"daysToGo\":1", with: "\"daysToGo\":2")
            .replacingOccurrences(of: "\"thisWeekKm\":null", with: "\"thisWeekKm\":12.5")
        XCTAssertFalse(GoalProgressLogic.isRaceEve(try decodeEndurance(twoDays)))
        // km present on the eve (an older server that still sends them): not an eve, the distance line stays.
        let withKm = raceEveJSON.replacingOccurrences(of: "\"thisWeekKm\":null", with: "\"thisWeekKm\":12.5")
        XCTAssertFalse(GoalProgressLogic.isRaceEve(try decodeEndurance(withKm)))
        // Race day and recovery are not the eve.
        let raceDay = raceEveJSON.replacingOccurrences(of: "\"daysToGo\":1", with: "\"daysToGo\":0")
        XCTAssertFalse(GoalProgressLogic.isRaceEve(try decodeEndurance(raceDay)))
        let recovery = raceEveJSON.replacingOccurrences(of: "\"phase\":\"race_week\"", with: "\"phase\":\"recovery\"")
        XCTAssertFalse(GoalProgressLogic.isRaceEve(try decodeEndurance(recovery)))
        // No phase (a server that predates the race lifecycle) and no race at all.
        let noPhase = raceEveJSON.replacingOccurrences(of: ",\"phase\":\"race_week\"", with: "")
        XCTAssertFalse(GoalProgressLogic.isRaceEve(try decodeEndurance(noPhase)))
        XCTAssertFalse(GoalProgressLogic.isRaceEve(GoalProgressDTO(goal: "endurance", verdict: .onTrack)))
        // Other goals never.
        XCTAssertFalse(GoalProgressLogic.isRaceEve(GoalProgressDTO(goal: "weight_loss", verdict: .onTrack)))
    }

    /// The same day as the eve, but with the km: the usual distance line and bar are untouched.
    func testADayWithKmStillShowsTheDistanceLineAndBar() throws {
        let withKm = try decodeEndurance(
            raceEveJSON
                .replacingOccurrences(of: "\"thisWeekKm\":null", with: "\"thisWeekKm\":6.5")
                .replacingOccurrences(of: "\"text\":\"Race tomorrow\"", with: "\"text\":\"6.5 of 15 km running this week\"")
        )
        XCTAssertEqual(GoalProgressLogic.distanceFraction(withKm) ?? .nan, 6.5 / 15, accuracy: 0.001)
        XCTAssertNotNil(GoalProgressLogic.distanceLine(withKm, system: .metric))
    }

    /// Wave 21e flags, each only present when true; an older server sends none.
    func testWeekPlanAndLongRunFlagsDecodeTolerantly() throws {
        let flagged = try decodeEndurance("""
        {"goal":"endurance","verdict":"holding","headline":"x","reasons":[],
         "distance":{"targetKm":30,"thisWeekKm":8,"text":"8 of ~18 km running this week · goal 30 km",
          "plan":{"kind":"build","targetKm":18,"longRunKm":9,"purpose":"p","cutback":true,"lightWeek":true,"strides":true,
                  "longRunHeld":true,"upTo":true}},
         "longRun":{"lastKm":14,"peakKm":16,"targetPeakKm":15,"capNoteDue":true,"oversized":true}}
        """)
        let plan = try XCTUnwrap(flagged.distance?.plan)
        XCTAssertEqual(plan.cutback, true)
        XCTAssertEqual(plan.lightWeek, true)
        XCTAssertEqual(plan.strides, true)
        XCTAssertEqual(plan.longRunHeld, true)
        XCTAssertEqual(plan.upTo, true)
        XCTAssertEqual(flagged.longRun?.capNoteDue, true)
        XCTAssertEqual(flagged.longRun?.oversized, true)

        // Absent (older server, or false-by-omission) and wrong-typed: nil, the rest of the plan intact.
        let unflagged = try decodeEndurance("""
        {"goal":"endurance","verdict":"building","headline":"x","reasons":[],
         "distance":{"targetKm":30,"thisWeekKm":8,"plan":{"kind":"build","targetKm":18,"cutback":"yes","lightWeek":null}},
         "longRun":{"lastKm":14,"peakKm":16,"capNoteDue":1}}
        """)
        let basic = try XCTUnwrap(unflagged.distance?.plan)
        XCTAssertEqual(basic.kind, "build")
        XCTAssertEqual(basic.targetKm, 18)
        XCTAssertNil(basic.cutback)
        XCTAssertNil(basic.lightWeek)
        XCTAssertNil(basic.strides)
        XCTAssertNil(basic.longRunHeld)
        XCTAssertNil(basic.upTo)
        XCTAssertNil(unflagged.longRun?.capNoteDue)
        XCTAssertNil(unflagged.longRun?.oversized)
        XCTAssertEqual(unflagged.longRun?.lastKm, 14)
        // The memberwise initialisers default the flags.
        XCTAssertNil(GoalProgressDTO.Distance.Plan(kind: "build").lightWeek)
        XCTAssertNil(GoalProgressDTO.LongRun(lastKm: 14).oversized)
    }

    // MARK: - Week plan (distance.plan: baseline / build / hold / restart / taper / recovery ...)

    /// An endurance payload with a week plan: 30 km goal, `done` km run so far.
    /// `step` stands for the payload's `stepTargetKm` (the server sets it to the
    /// plan's target, or to the goal when the plan has none).
    private func planned(
        kind: String?, planTarget: Double?, step: Double? = 30, done: Double? = 15, text: String? = nil
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "endurance",
            target: .init(weeklyDistanceKm: 30),
            distance: .init(
                targetKm: 30, thisWeekKm: done, avg4wKm: nil, weekStart: "2026-10-05", stepTargetKm: step,
                text: text, plan: kind.map { GoalProgressDTO.Distance.Plan(kind: $0, targetKm: planTarget) }
            ),
            verdict: .building,
            headline: "Baseline week — 15 km so far"
        )
    }

    /// The first week of running: the server's step equals the goal, which used to
    /// print "15 of 30 km this week" beside "Baseline week — 15 km so far…".
    func testBaselineWeekHasNoTargetToMeasureAgainst() {
        let baseline = planned(kind: "baseline", planTarget: nil)
        XCTAssertTrue(GoalProgressLogic.isBaselineWeek(baseline))
        XCTAssertNil(GoalProgressLogic.stepTargetKm(baseline))
        XCTAssertEqual(GoalProgressLogic.distanceLine(baseline, system: .metric), "15\u{00A0}km so far this week")
        XCTAssertEqual(GoalProgressLogic.primaryLine(baseline, system: .metric), "15\u{00A0}km so far this week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(baseline, system: .imperial), "9.3\u{00A0}mi so far this week")
        assertNoBreakableUnitSpace(GoalProgressLogic.distanceLine(baseline, system: .imperial) ?? "")
    }

    func testServerDistanceTextIsPreferredWhenItComesWithAPlan() {
        let served = planned(kind: "baseline", planTarget: nil, text: "15\u{00A0}km so far · baseline week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(served, system: .metric), "15\u{00A0}km so far · baseline week")
        let build = planned(kind: "build", planTarget: 27, step: 27, done: 22.7,
                            text: "22.7 of ~27\u{00A0}km running this week · goal 30\u{00A0}km")
        XCTAssertEqual(GoalProgressLogic.distanceLine(build, system: .metric), "22.7 of ~27\u{00A0}km running this week · goal 30\u{00A0}km")

        // No plan (an older server): the composed wording, text or not.
        let older = planned(kind: nil, planTarget: nil, text: "15\u{00A0}km so far · baseline week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(older, system: .metric), "15 of 30\u{00A0}km this week")
    }

    /// The server words its text in the unit it has on file: a km line never reaches a miles user.
    func testServerDistanceTextIsNeverShownInTheWrongUnit() {
        let kmText = planned(kind: "baseline", planTarget: nil, text: "15\u{00A0}km so far · baseline week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(kmText, system: .imperial), "9.3\u{00A0}mi so far this week")
        let miText = planned(kind: "baseline", planTarget: nil, text: "9.3\u{00A0}mi so far · baseline week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(miText, system: .imperial), "9.3\u{00A0}mi so far · baseline week")
        XCTAssertEqual(GoalProgressLogic.distanceLine(miText, system: .metric), "15\u{00A0}km so far this week")
    }

    func testThePlansTargetIsThisWeeksNumberForEveryKindBesidesBaseline() {
        for kind in ["build", "hold", "restart", "taper", "race_week", "rebuild"] {
            // `stepTargetKm` absent: the plan's own target still names the week.
            let progress = planned(kind: kind, planTarget: 24, step: nil, done: 10.2)
            XCTAssertEqual(GoalProgressLogic.stepTargetKm(progress), 24, kind)
            XCTAssertEqual(GoalProgressLogic.distanceLine(progress, system: .metric),
                           "10.2 of ~24\u{00A0}km this week · goal 30\u{00A0}km", kind)
            XCTAssertEqual(GoalProgressLogic.distanceFraction(progress) ?? .nan, 10.2 / 24, accuracy: 0.0001, kind)
            XCTAssertEqual(plain(GoalProgressLogic.distanceBarEndText(progress, system: .metric)), "~24 km", kind)
        }
        // A plan that asks for the goal itself (maintain at the weekly goal) is just "of 30".
        let maintain = planned(kind: "maintain", planTarget: 30, done: 10.2)
        XCTAssertNil(GoalProgressLogic.stepTargetKm(maintain))
        XCTAssertEqual(GoalProgressLogic.distanceLine(maintain, system: .metric), "10.2 of 30\u{00A0}km this week")
    }

    func testRecoveryWeekNumberIsACeiling() {
        let recovery = planned(kind: "recovery", planTarget: 12, step: 12, done: 4.2)
        XCTAssertEqual(GoalProgressLogic.distanceLine(recovery, system: .metric), "4.2 of up to 12\u{00A0}km this week (recovery)")
        XCTAssertEqual(GoalProgressLogic.distanceLine(recovery, system: .imperial), "2.6 of up to 7.5\u{00A0}mi this week (recovery)")
    }

    func testWithoutAPlanTheDistanceLineIsExactlyAsBefore() {
        XCTAssertEqual(GoalProgressLogic.distanceLine(distanceProgress(thisWeek: 22.7, step: 27), system: .metric),
                       "22.7 of ~27\u{00A0}km this week · goal 30\u{00A0}km")
        XCTAssertEqual(GoalProgressLogic.distanceLine(distanceProgress(), system: .metric), "24.5 of 30\u{00A0}km this week")
        XCTAssertFalse(GoalProgressLogic.isBaselineWeek(distanceProgress()))
    }

    func testDistancePlanDecodesTolerantly() throws {
        func decode(_ distance: String) throws -> GoalProgressDTO.Distance? {
            let json = "{\"goal\":\"endurance\",\"verdict\":\"building\",\"headline\":\"x\",\"distance\":\(distance)}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8)).distance
        }
        let full = try decode("""
        {"targetKm":30,"thisWeekKm":15,"avg4wKm":null,"weekStart":"2026-10-05","stepTargetKm":30,
         "text":"15 km so far · baseline week",
         "plan":{"kind":"baseline","targetKm":null,"longRunKm":null,"purpose":"Baseline week: run as you normally would"}}
        """)
        XCTAssertEqual(full?.text, "15 km so far · baseline week")
        XCTAssertEqual(full?.plan, GoalProgressDTO.Distance.Plan(kind: "baseline", targetKm: nil, longRunKm: nil, purpose: "Baseline week: run as you normally would"))

        // Older payloads decode exactly as before.
        let older = try decode(#"{"targetKm":30,"thisWeekKm":15,"stepTargetKm":27}"#)
        XCTAssertNil(older?.text)
        XCTAssertNil(older?.plan)
        XCTAssertEqual(older?.stepTargetKm, 27)
        XCTAssertNil(try decode(#"{"targetKm":30,"plan":null}"#)?.plan)
        XCTAssertNil(try decode(#"{"targetKm":30,"plan":"nope"}"#)?.plan)
        // A plan without a kind is dropped; an unknown kind survives as a string; odd pieces drop alone.
        XCTAssertNil(try decode(#"{"targetKm":30,"plan":{"targetKm":24}}"#)?.plan)
        XCTAssertEqual(try decode(#"{"targetKm":30,"plan":{"kind":"future_kind","targetKm":24}}"#)?.plan?.kind, "future_kind")
        let odd = try decode(#"{"targetKm":30,"text":5,"plan":{"kind":"build","targetKm":"soon","longRunKm":16}}"#)
        XCTAssertNil(odd?.text)
        XCTAssertEqual(odd?.plan?.kind, "build")
        XCTAssertNil(odd?.plan?.targetKm)
        XCTAssertEqual(odd?.plan?.longRunKm, 16)
    }

    // MARK: - Wave 20: one weight basis for the line and the bar

    /// A weight-loss payload as the server sends it from wave 20: `changeKg` / `progressPct` are measured
    /// from the 7-day mean of the scale (82.3), while `weightKg` is still the smoothed trend (82.0) that lags it.
    private func weeklyMeanProgress(changeKg: Double? = -1.4, progressPct: Double? = 18) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: "weight_loss",
            target: .init(weightKg: 76),
            current: .init(weightKg: 82.0, startWeightKg: 83.7, changeKg: changeKg, progressPct: progressPct),
            ratePerWeek: .init(kg: -0.6),
            verdict: .onTrack,
            headline: "On track for Jan 15 \u{2014} about 6.3 kg to go",
            weightRead: .init(state: .pace, scaleKg: 82.0, weekMeanKg: 82.3)
        )
    }

    /// "X of Y kg lost" is built from `current.changeKg`, the weight the bar's `progressPct` (and the
    /// server's "to go", opener and coach) use — not from the trend, which would say 1.7 beside an 18% bar.
    func testWeightLossLineIsBuiltFromTheSameWeightAsTheBar() throws {
        let progress = weeklyMeanProgress()
        XCTAssertEqual(GoalProgressLogic.weightLine(progress, system: .metric), "1.4 of 7.7\u{00A0}kg lost")
        XCTAssertEqual(GoalProgressLogic.primaryLine(progress, system: .metric), "1.4 of 7.7\u{00A0}kg lost")
        XCTAssertEqual(plain(GoalProgressLogic.compactText(progress, system: .metric, now: now, locale: en)), "1.4 of 7.7 kg lost")
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(progress, system: .imperial)), "3.1 of 17 lb lost")
        // Text and bar agree: 18% of the way is 1.4 of 7.7 kg.
        let fraction = try XCTUnwrap(GoalProgressLogic.progressFraction(progress))
        XCTAssertEqual(fraction, 1.4 / 7.7, accuracy: 0.005)
    }

    /// Without a usable `changeKg` the line is the trend against the start, exactly as before.
    func testWeightLossLineFallsBackToTheTrendWithoutChangeKg() {
        for change in [nil, Double.nan, Double.infinity] as [Double?] {
            let progress = weeklyMeanProgress(changeKg: change, progressPct: nil)
            XCTAssertEqual(plain(GoalProgressLogic.weightLine(progress, system: .metric)), "1.7 of 7.7 kg lost", "\(String(describing: change))")
            XCTAssertEqual(plain(GoalProgressLogic.weightLine(progress, system: .imperial)), "3.7 of 17 lb lost", "\(String(describing: change))")
        }
    }

    func testWeightLineKeepsItsCapAndFloorOnTheServersChange() {
        // Past the target: capped at the total, never "9 of 7.7".
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(weeklyMeanProgress(changeKg: -9, progressPct: 100), system: .metric)), "7.7 of 7.7 kg lost")
        // The scale going the wrong way reads 0, never negative.
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(weeklyMeanProgress(changeKg: 0.6, progressPct: 0), system: .metric)), "0 of 7.7 kg lost")
        // Nothing moved yet.
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(weeklyMeanProgress(changeKg: 0, progressPct: 0), system: .metric)), "0 of 7.7 kg lost")
    }

    /// Only a weight-loss goal changed basis: a muscle goal's `changeKg` is still the trend's, so its
    /// line stays the trend against the start whatever `changeKg` says.
    func testOnlyWeightLossReadsTheServersChangeForItsLine() {
        let muscle = GoalProgressDTO(
            goal: "muscle", target: .init(weightKg: 82),
            current: .init(weightKg: 80, startWeightKg: 78, changeKg: 5, progressPct: 50), verdict: .progressing
        )
        XCTAssertEqual(plain(GoalProgressLogic.weightLine(muscle, system: .metric)), "2 of 4 kg gained")
        XCTAssertEqual(GoalProgressLogic.weightMovedKg(muscle, startKg: 78, currentKg: 80), 2)
        XCTAssertEqual(GoalProgressLogic.weightMovedKg(weeklyMeanProgress(), startKg: 83.7, currentKg: 82.0), -1.4)
        XCTAssertEqual(GoalProgressLogic.weightMovedKg(weeklyMeanProgress(changeKg: nil), startKg: 83.7, currentKg: 82.0), 82.0 - 83.7, accuracy: 1e-9)
    }

    /// The goal reached card/line still caps at the target whatever the basis.
    func testReachedTextStillCapsOnTheServersChange() {
        let reached = GoalProgressDTO(
            goal: "weight_loss", target: .init(weightKg: 76),
            current: .init(weightKg: 75.9, startWeightKg: 83.7, changeKg: -8.2, progressPct: 100), verdict: .reached,
            weightRead: .init(state: .reached, scaleKg: 75.5, weekMeanKg: 75.5)
        )
        XCTAssertEqual(plain(GoalProgressLogic.reachedText(reached, system: .metric)), "7.7 of 7.7 kg lost")
    }

    // MARK: - Wave 20: headlines the server now writes

    /// The new fat-loss headlines (lib/goalProgress.ts `fatLossOutcome`). A phrase the verdict chip already says
    /// is stripped — only as a whole phrase directly followed by its dash. "On track for Jul 6" is not the
    /// "On track" verdict: stripping two words would leave "for Jul 6 — about 6.5 kg to go".
    func testHeadlineWithoutVerdictHandlesTheWave20FatLossHeadlines() {
        // On track for a date: the date belongs to the phrase, so the headline stays whole.
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("On track for Jul 6 \u{2014} about 6.5 kg to go"),
            "On track for Jul 6 \u{2014} about 6.5 kg to go"
        )
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("On track for Jul 6, 2027 \u{2014} about 6.5 kg to go"),
            "On track for Jul 6, 2027 \u{2014} about 6.5 kg to go"
        )
        // ...and without a date it is the plain verdict again.
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("On track \u{2014} about 6.5 kg to go"), "about 6.5 kg to go")
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("On track \u{2014} about 6.5 kg to go, any day now"), "about 6.5 kg to go, any day now")
        // "Still losing fast" is the too-fast verdict, held between 0.9% and 1% a week: stripped like "Losing too fast".
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("Still losing fast \u{2014} 1.1% of bodyweight a week"),
            "1.1% of bodyweight a week"
        )
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("Losing too fast \u{2014} 1.2% of bodyweight a week"),
            "1.2% of bodyweight a week"
        )
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("still losing fast - 1.1% of bodyweight a week"), "1.1% of bodyweight a week")
        // "Nearly there" is no verdict (no chip says it) and its sentence is the news: left in the text.
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("Nearly there \u{2014} start easing calories toward maintenance"),
            "Nearly there \u{2014} start easing calories toward maintenance"
        )
        // Behind pace: the verdict is stripped, the date after the numbers stays.
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("Behind pace \u{2014} about 4.7 kg to go, around Jul 26"),
            "about 4.7 kg to go, around Jul 26"
        )
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("Behind \u{2014} 4.7 kg to go, pace is under the 0.25% a week floor"),
            "4.7 kg to go, pace is under the 0.25% a week floor"
        )
        // A verdict word inside a longer phrase, or mid-sentence, is never cut.
        XCTAssertEqual(GoalProgressLogic.headlineWithoutVerdict("Still losing, slowly \u{2014} 0.4 kg a week"), "Still losing, slowly \u{2014} 0.4 kg a week")
        XCTAssertEqual(
            GoalProgressLogic.headlineWithoutVerdict("On track for the half marathon \u{2014} long run 14 of 15 km"),
            "On track for the half marathon \u{2014} long run 14 of 15 km"
        )
    }

    /// The same headlines as they reach the card's primary line when no weight line is composed
    /// (a general goal with the weight verdicts, the fallback `primaryLine` ends in).
    func testPrimaryLineShowsTheWave20HeadlinesWithoutADanglingFragment() {
        func line(_ verdict: GoalVerdict, _ headline: String) -> String {
            GoalProgressLogic.primaryLine(GoalProgressDTO(goal: "general", verdict: verdict, headline: headline), system: .metric)
        }
        XCTAssertEqual(line(.onTrack, "On track for Jul 6 \u{2014} about 6.5 kg to go"), "On track for Jul 6 \u{2014} about 6.5 kg to go")
        XCTAssertEqual(line(.tooFast, "Still losing fast \u{2014} 1.1% of bodyweight a week"), "1.1% of bodyweight a week")
        XCTAssertEqual(line(.progressing, "Nearly there \u{2014} start easing calories toward maintenance"), "Nearly there \u{2014} start easing calories toward maintenance")
        XCTAssertEqual(line(.behind, "Behind pace \u{2014} about 4.7 kg to go, around Jul 26"), "about 4.7 kg to go, around Jul 26")
        XCTAssertFalse(line(.onTrack, "On track for Jul 6 \u{2014} about 6.5 kg to go").hasPrefix("for "))
    }

    // MARK: - Wave 20: weightRead.goalAgeDays

    func testWeightReadGoalAgeDaysDecodesTolerantly() throws {
        func read(_ extra: String) throws -> GoalProgressDTO.WeightRead? {
            let json = "{\"goal\":\"weight_loss\",\"verdict\":\"progressing\",\"headline\":\"x\",\"reasons\":[],\"weightRead\":{\"state\":\"early\"\(extra)}}"
            return try JSONDecoder().decode(GoalProgressDTO.self, from: Data(json.utf8)).weightRead
        }
        XCTAssertEqual(try read(",\"goalAgeDays\":24")?.goalAgeDays, 24)
        XCTAssertEqual(try read(",\"goalAgeDays\":24.0")?.goalAgeDays, 24)
        // Absent (an older server), null, or the wrong type: no age, and the rest of the read survives.
        XCTAssertNil(try read("")?.goalAgeDays)
        XCTAssertNil(try read(",\"goalAgeDays\":null")?.goalAgeDays)
        XCTAssertNil(try read(",\"goalAgeDays\":\"old\"")?.goalAgeDays)
        XCTAssertEqual(try read(",\"goalAgeDays\":\"old\"")?.state, .early)
        // A full wave-20 read still equals the one built from its parts.
        let full = try read(",\"scaleKg\":82.3,\"weekMeanKg\":82.5,\"goalAgeDays\":30,\"paceWindowDays\":21,\"intake\":null")
        XCTAssertEqual(full, GoalProgressDTO.WeightRead(state: .early, scaleKg: 82.3, weekMeanKg: 82.5, goalAgeDays: 30))
    }

    // MARK: - Wave 20: endurance fields the app does not read

    /// `distance.plan.{stepPct, comebackKm, goalReachedBefore}` and `longRun.raceTargetKm` are additive and
    /// no screen needs them: a payload carrying them decodes to exactly what the older payload did, and
    /// the capped `targetPeakKm` is just the peak target, in every text built from it.
    func testWave20EnduranceFieldsDoNotChangeWhatIsDecodedOrShown() throws {
        let planFields = #""kind":"build","targetKm":27,"longRunKm":14,"purpose":"~27 km this week: long run 14 km, the rest easy runs""#
        let withNew = try decode("""
        {"goal":"endurance","verdict":"building","headline":"x",
         "distance":{"targetKm":30,"thisWeekKm":10.2,"stepTargetKm":27,
                     "plan":{\(planFields),"stepPct":10,"comebackKm":null,"goalReachedBefore":false}},
         "longRun":{"lastKm":14,"peakKm":16,"targetPeakKm":15,"raceTargetKm":18}}
        """)
        let older = try decode("""
        {"goal":"endurance","verdict":"building","headline":"x",
         "distance":{"targetKm":30,"thisWeekKm":10.2,"stepTargetKm":27,"plan":{\(planFields)}},
         "longRun":{"lastKm":14,"peakKm":16,"targetPeakKm":15}}
        """)
        XCTAssertEqual(withNew.distance, older.distance)
        XCTAssertEqual(withNew.longRun, older.longRun)
        XCTAssertEqual(withNew.longRun, GoalProgressDTO.LongRun(lastKm: 14, peakKm: 16, targetPeakKm: 15))
        XCTAssertEqual(withNew.distance?.plan?.longRunKm, 14)
        // The capped peak reads right where it is shown: the goal sheet's row and the Today hero's race tail.
        let longRun = try XCTUnwrap(withNew.longRun)
        XCTAssertEqual(RaceLogic.longRunRowText(longRun, .metric), "14\u{00A0}km \u{00B7} peak target 15\u{00A0}km")
        XCTAssertEqual(RaceLogic.longRunProgressText(longRun, .metric), "long run 14/15\u{00A0}km")
        XCTAssertEqual(RaceLogic.longRunRowText(longRun, .imperial), "8.7\u{00A0}mi \u{00B7} peak target 9.3\u{00A0}mi")
        XCTAssertEqual(
            GoalProgressLogic.statRows(withNew, system: .metric).first { $0.label == "Long run" }?.value,
            "14\u{00A0}km \u{00B7} peak target 15\u{00A0}km"
        )
    }

    /// The server's cap explanation arrives as an ordinary long-run reason: the card lists it as sent
    /// (units glued), so no iOS text needs to know about the cap.
    func testTheCapExplanationReasonIsListedAsSent() {
        let note = "Long run peak 16 km \u{2014} on target. Your 30 km weeks fit a 15 km long run; for an 18 km peak, raise the goal to ~36 km"
        let progress = GoalProgressDTO(
            goal: "endurance", verdict: .building, headline: "x",
            reasons: [
                GoalReasonDTO(kind: "race", text: "Half marathon in 12 weeks (Dec 30)"),
                GoalReasonDTO(kind: "plan", text: "~27 km this week: long run 14 km, the rest easy runs"),
                GoalReasonDTO(kind: "long_run", text: note, tone: .good),
            ]
        )
        let shown = GoalProgressLogic.visibleReasons(progress)
        XCTAssertEqual(shown.map(\.kind), ["race", "plan", "long_run"])
        XCTAssertEqual(shown.last?.text, note)
        XCTAssertEqual(GoalProgressLogic.displayReasons(progress).last?.text, note)
        let wrapped = GoalProgressLogic.nonBreaking(note)
        XCTAssertEqual(plain(wrapped), note)
        assertNoBreakableUnitSpace(wrapped)
    }

    // MARK: - Wave 22w: the flat fortnight, the pace range, a stale week

    /// `GoalProgressDTO.WeightRead.Plan.Pace`, the way the tests below spell it.
    private func pace(_ kgPerWeek: Double) -> GoalProgressDTO.WeightRead.Plan.Pace {
        GoalProgressDTO.WeightRead.Plan.Pace(kgPerWeek: kgPerWeek)
    }

    /// An on-pace weight-loss payload: the plan's pace now (-0.59) and, when `earlier` is given, the pace a week
    /// earlier (what the server sends when the two land either side of the target date). `ratePerWeek.kg` is the
    /// plan's pace, as `lib/goalProgress.ts` sends it.
    private func onPace(
        earlier: Double? = -0.37, now: Double? = -0.59, rateKg: Double? = -0.59,
        state: GoalProgressDTO.WeightRead.State? = .pace, verdict: GoalVerdict = .onTrack,
        goal: String = "weight_loss", lastWeighInDaysAgo: Int? = 0, staleSince: String? = nil
    ) -> GoalProgressDTO {
        let plan = GoalProgressDTO.WeightRead.Plan(
            weekStart: "2026-10-19", state: .pace,
            action: .init(kind: "keep_going", text: "Keep your routine — it is working"),
            pace: now.map(pace), earlierPace: earlier.map(pace), staleSince: staleSince
        )
        return GoalProgressDTO(
            goal: goal, target: .init(weightKg: 76, date: "2027-01-15"),
            current: .init(weightKg: 82.3, startWeightKg: 83.7, changeKg: -1.4, progressPct: 18, trendKg: 82),
            ratePerWeek: .init(kg: rateKg), verdict: verdict,
            headline: "On track for Jan 15 — about 6.3 kg to go", lastWeighInDaysAgo: lastWeighInDaysAgo,
            weightRead: state.map { GoalProgressDTO.WeightRead(state: $0, weekMeanKg: 82.3, plan: plan) }
        )
    }

    private let rangeDash = "\u{2060}\u{2013}\u{2060}"

    /// The server's own payloads (`JSON.stringify` of `WeightWeekPlan`): a flat fortnight, a plateau, an on-pace
    /// week with two paces and a stale week. Each new field decodes to what the server sent.
    func testWeekPlanWave22FieldsDecodeFromTheServersPayloads() throws {
        let fortnight = try decodeWeightLoss("""
        ,"weightRead":{"state":"plateau","scaleKg":89.4,"scaleDay":"2026-10-18","weekMeanKg":89.4,"weeksVsTarget":null,
         "returned":null,"reachedDaysAgo":null,
         "plan":{"weekStart":"2026-10-19","asOf":"2026-10-18","state":"plateau","call":"none","verdict":"holding","etaDate":null,
                 "weeksVsTarget":null,"action":{"kind":"plateau_water","text":"Keep 1,900 kcal; we'll look again next Monday","kcalTarget":1900},
                 "plateauCause":{"kind":"water","namedAt":"2026-10-18","loggedDays":0,"spanDays":14,"avgKcal":null,"targetKcal":1900},
                 "pace":null,"earlierPace":null,"confirmed":false,"young":false,"onPace":null,"tooFast":false,"nearlyThere":false,
                 "slow":false,"away":false,"farBehind":false,"projectedEta":null,"plateauMeanKg":89.4,"flatWeeks":2,"heldKg":null,
                 "firstPaceWeek":false,"updated":null,"staleSince":null}}
        ,"ratePerWeek":{"kg":null,"pctBodyweight":null},"eta":null
        """, headline: "Two flat weeks — common; your plan holds")
        XCTAssertEqual(fortnight.weightRead?.state, .plateau)
        XCTAssertEqual(fortnight.weightRead?.plan?.flatWeeks, 2)
        XCTAssertEqual(fortnight.weightRead?.plan?.action?.text, "Keep 1,900 kcal; we'll look again next Monday")
        XCTAssertNil(fortnight.weightRead?.plan?.pace)
        XCTAssertNil(fortnight.weightRead?.plan?.earlierPace)
        XCTAssertNil(fortnight.weightRead?.plan?.staleSince)
        XCTAssertTrue(GoalProgressLogic.usesServerWeightRead(fortnight))
        XCTAssertEqual(GoalProgressLogic.primaryLine(fortnight, system: .metric), "Two flat weeks — common; your plan holds")
        XCTAssertNil(GoalProgressLogic.paceRange(fortnight))

        let plateau = try decodeWeightLoss("""
        ,"weightRead":{"state":"plateau","plan":{"weekStart":"2026-10-19","state":"plateau","action":{"kind":"plateau_water","text":"Hold"},
         "pace":{"kgPerWeek":-0.04,"pctPerWeek":-0.05,"windowDays":21},"earlierPace":null,"flatWeeks":3,"staleSince":null}}
        """, headline: "Plateau — weekly average ~89.4 kg for 3 weeks")
        XCTAssertEqual(plateau.weightRead?.plan?.flatWeeks, 3)
        XCTAssertEqual(plateau.weightRead?.plan?.pace, pace(-0.04))

        let onPaceRange = try decodeWeightLoss("""
        ,"weightRead":{"state":"pace","weekMeanKg":88.3,"plan":{"weekStart":"2026-10-19","state":"pace","call":"on_pace",
         "action":{"kind":"keep_going","text":"Keep your routine — it is working"},
         "pace":{"kgPerWeek":-0.59,"pctPerWeek":-0.65,"windowDays":21},
         "earlierPace":{"kgPerWeek":-0.37,"pctPerWeek":-0.41,"windowDays":21},
         "confirmed":true,"flatWeeks":null,"staleSince":null}}
        ,"ratePerWeek":{"kg":-0.59,"pctBodyweight":-0.65}
        """)
        XCTAssertNil(onPaceRange.weightRead?.plan?.flatWeeks)
        XCTAssertEqual(onPaceRange.weightRead?.plan?.pace, pace(-0.59))
        XCTAssertEqual(onPaceRange.weightRead?.plan?.earlierPace, pace(-0.37))
        XCTAssertEqual(
            GoalProgressLogic.paceRange(onPaceRange),
            GoalProgressLogic.PaceRange(slowKgPerWeek: 0.37, fastKgPerWeek: 0.59)
        )

        let stale = try decodeWeightLoss("""
        ,"weightRead":{"state":"pace","plan":{"weekStart":"2026-10-19","state":"pace","call":"on_pace",
         "action":{"kind":"keep_weighing","text":"No weigh-in since Oct 11 — step on the scale when you can; your plan picks up from there"},
         "pace":{"kgPerWeek":-0.5,"pctPerWeek":-0.6,"windowDays":21},"earlierPace":null,"staleSince":"2026-10-11"}}
        ,"lastWeighInDaysAgo":8
        """)
        XCTAssertEqual(stale.weightRead?.plan?.staleSince, "2026-10-11")
        XCTAssertEqual(stale.lastWeighInDaysAgo, 8)
        XCTAssertTrue(stale.weightRead?.plan?.action?.text.hasPrefix("No weigh-in since Oct 11") ?? false)
    }

    /// An older server sends none of the four: they read as nil and the plan decodes as it did.
    func testWeekPlanWave22FieldsAreNilFromAnOlderServer() throws {
        let older = try decodeWeightLoss("""
        ,"weightRead":{"state":"pace","plan":{"weekStart":"2026-10-12","state":"pace","action":{"kind":"keep_going","text":"Keep your routine"}}}
        """)
        let plan = try XCTUnwrap(older.weightRead?.plan)
        XCTAssertEqual(plan.weekStart, "2026-10-12")
        XCTAssertEqual(plan.state, .pace)
        XCTAssertEqual(plan.action?.text, "Keep your routine")
        XCTAssertNil(plan.flatWeeks)
        XCTAssertNil(plan.pace)
        XCTAssertNil(plan.earlierPace)
        XCTAssertNil(plan.staleSince)
        // The memberwise initialiser defaults them too, so every older call site is untouched.
        let bare = GoalProgressDTO.WeightRead.Plan(weekStart: "2026-10-12", state: .pace)
        XCTAssertNil(bare.flatWeeks)
        XCTAssertNil(bare.pace)
        XCTAssertNil(bare.earlierPace)
        XCTAssertNil(bare.staleSince)
        XCTAssertNil(GoalProgressLogic.paceRange(older))
    }

    /// Malformed values drop only themselves: never a throw, never the rest of the plan or the read.
    func testWeekPlanWave22FieldsDecodeTolerantly() throws {
        func plan(_ fields: String) throws -> GoalProgressDTO.WeightRead.Plan? {
            try decodeWeightLoss(",\"weightRead\":{\"state\":\"pace\",\"plan\":{\"weekStart\":\"2026-10-19\",\(fields)}}").weightRead?.plan
        }
        // flatWeeks: a whole number, sent as 2 or 2.0; anything else is nil.
        XCTAssertEqual(try plan("\"flatWeeks\":2")?.flatWeeks, 2)
        XCTAssertEqual(try plan("\"flatWeeks\":3")?.flatWeeks, 3)
        XCTAssertEqual(try plan("\"flatWeeks\":2.0")?.flatWeeks, 2)
        XCTAssertNil(try plan("\"flatWeeks\":null")?.flatWeeks)
        XCTAssertNil(try plan("\"flatWeeks\":\"two\"")?.flatWeeks)
        XCTAssertNil(try plan("\"flatWeeks\":true")?.flatWeeks)
        XCTAssertNil(try plan("\"flatWeeks\":[2]")?.flatWeeks)
        // pace / earlierPace: an object with a numeric rate; anything else is nil (a range is never half-built).
        XCTAssertEqual(try plan("\"earlierPace\":{\"kgPerWeek\":-0.37}")?.earlierPace, pace(-0.37))
        XCTAssertEqual(try plan("\"earlierPace\":{\"kgPerWeek\":-0.37,\"pctPerWeek\":\"x\",\"windowDays\":null}")?.earlierPace, pace(-0.37))
        XCTAssertNil(try plan("\"earlierPace\":null")?.earlierPace)
        XCTAssertNil(try plan("\"earlierPace\":\"fast\"")?.earlierPace)
        XCTAssertNil(try plan("\"earlierPace\":-0.37")?.earlierPace)
        XCTAssertNil(try plan("\"earlierPace\":{}")?.earlierPace)
        XCTAssertNil(try plan("\"earlierPace\":{\"kgPerWeek\":\"-0.37\"}")?.earlierPace)
        XCTAssertNil(try plan("\"earlierPace\":{\"kgPerWeek\":null}")?.earlierPace)
        XCTAssertNil(try plan("\"pace\":{\"kgPerWeek\":[]}")?.pace)
        XCTAssertEqual(try plan("\"pace\":{\"kgPerWeek\":-0.59}")?.pace, pace(-0.59))
        // staleSince: a day string; a blank, null or wrong-typed one is nil.
        XCTAssertEqual(try plan("\"staleSince\":\"2026-10-11\"")?.staleSince, "2026-10-11")
        XCTAssertNil(try plan("\"staleSince\":\"\"")?.staleSince)
        XCTAssertNil(try plan("\"staleSince\":null")?.staleSince)
        XCTAssertNil(try plan("\"staleSince\":20261011")?.staleSince)
        XCTAssertNil(try plan("\"staleSince\":{}")?.staleSince)
        // All four malformed at once: the plan, its state and its week survive, and so does the read.
        let broken = try decodeWeightLoss("""
        ,"weightRead":{"state":"plateau","scaleKg":89.4,"plan":{"weekStart":"2026-10-19","state":"plateau",
         "action":{"kind":"plateau_water","text":"Hold"},"flatWeeks":"two","pace":"fast","earlierPace":[1],"staleSince":7}}
        """)
        XCTAssertEqual(broken.weightRead?.state, .plateau)
        XCTAssertEqual(broken.weightRead?.scaleKg, 89.4)
        XCTAssertEqual(broken.weightRead?.plan?.weekStart, "2026-10-19")
        XCTAssertEqual(broken.weightRead?.plan?.state, .plateau)
        XCTAssertEqual(broken.weightRead?.plan?.action?.text, "Hold")
        XCTAssertNil(broken.weightRead?.plan?.flatWeeks)
        XCTAssertNil(broken.weightRead?.plan?.pace)
        XCTAssertNil(broken.weightRead?.plan?.earlierPace)
        XCTAssertNil(broken.weightRead?.plan?.staleSince)
        // A plateau without flatWeeks is the plateau it always was.
        XCTAssertTrue(GoalProgressLogic.usesServerWeightRead(broken))
    }

    // MARK: Pace range

    func testPaceRangeIsThePaceNowAndThePaceAWeekEarlierSlowerFirst() {
        let range = GoalProgressLogic.PaceRange(slowKgPerWeek: 0.37, fastKgPerWeek: 0.59)
        XCTAssertEqual(GoalProgressLogic.paceRange(onPace()), range)
        // Whichever of the two is the faster one.
        XCTAssertEqual(GoalProgressLogic.paceRange(onPace(earlier: -0.59, now: -0.37, rateKg: -0.37)), range)
        // Without the plan's own pace the payload's rate is the pace now (it is the same number, rounded).
        XCTAssertEqual(GoalProgressLogic.paceRange(onPace(now: nil)), range)
    }

    /// An older server has no `earlierPace`, so nothing changes; neither does anything that is not a loss on pace.
    func testPaceRangeIsNilUnlessBothPacesAreALossOnAnOnPaceWeightLossWeek() {
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(earlier: nil)), "older server")
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(earlier: 0.1)), "the earlier pace is a gain")
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(earlier: 0)), "the earlier pace is flat")
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(now: 0.2, rateKg: 0.2)), "the pace now is a gain")
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(now: nil, rateKg: nil)), "no pace now at all")
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(earlier: Double.nan)))
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(earlier: Double.infinity)))
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(state: nil)), "a read with no state (a stale week past 14 days)")
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(state: .plateau)))
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(state: .movingAgain)))
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(state: .reached)))
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(verdict: .reached)))
        XCTAssertNil(GoalProgressLogic.paceRange(onPace(goal: "muscle")))
        XCTAssertNil(GoalProgressLogic.paceRange(GoalProgressDTO(goal: "weight_loss", verdict: .onTrack)), "no weightRead at all")
    }

    /// The same figures and format as the server's card ("Down 0.37–0.58 kg/wk": two decimals, trailing zeros dropped).
    func testPaceRangeTextIsTheServersFormatInTheUsersUnit() {
        let range = GoalProgressLogic.PaceRange(slowKgPerWeek: 0.37, fastKgPerWeek: 0.59)
        XCTAssertEqual(GoalProgressLogic.paceRangeText(range, system: .metric), "Down 0.37\(rangeDash)0.59\u{00A0}kg/wk")
        XCTAssertEqual(GoalProgressLogic.paceRangeValueText(range, system: .metric), "0.37\(rangeDash)0.59\u{00A0}kg/wk")
        // 0.37 kg = 0.82 lb, 0.59 kg = 1.30 lb -> "1.3".
        XCTAssertEqual(GoalProgressLogic.paceRangeText(range, system: .imperial), "Down 0.82\(rangeDash)1.3\u{00A0}lb/wk")
        let round = GoalProgressLogic.PaceRange(slowKgPerWeek: 0.5, fastKgPerWeek: 0.6)
        XCTAssertEqual(GoalProgressLogic.paceRangeText(round, system: .metric), "Down 0.5\(rangeDash)0.6\u{00A0}kg/wk")
        let whole = GoalProgressLogic.PaceRange(slowKgPerWeek: 0.75, fastKgPerWeek: 1)
        XCTAssertEqual(GoalProgressLogic.paceRangeText(whole, system: .metric), "Down 0.75\(rangeDash)1\u{00A0}kg/wk")
        // The unit stays glued to its number and the dash to its numbers.
        for system in [UnitSystem.metric, .imperial] {
            let text = GoalProgressLogic.paceRangeText(range, system: system)
            assertNoBreakableUnitSpace(text)
        }
    }

    /// The goal sheet's "Trend" row says the range the card says; without it, the single rate exactly as before.
    func testTheTrendRowIsTheRangeWhenTheServerSendsTwoPaces() {
        func trendRow(_ progress: GoalProgressDTO, _ system: UnitSystem = .metric) -> String? {
            GoalProgressLogic.statRows(progress, system: system).first { $0.label == "Trend" }?.value
        }
        XCTAssertEqual(trendRow(onPace()), "Down 0.37\(rangeDash)0.59\u{00A0}kg/wk")
        XCTAssertEqual(GoalProgressLogic.rateText(onPace(), system: .metric), "Down 0.37\(rangeDash)0.59\u{00A0}kg/wk")
        XCTAssertEqual(trendRow(onPace(), .imperial), "Down 0.82\(rangeDash)1.3\u{00A0}lb/wk")
        // An older server (no earlierPace): the single rate, exactly as before.
        XCTAssertEqual(trendRow(onPace(earlier: nil)), "\u{2212}0.6\u{00A0}kg/wk")
        XCTAssertEqual(trendRow(onPace(earlier: nil), .imperial), "\u{2212}1.3\u{00A0}lb/wk")
        // So is a payload with no weightRead at all.
        XCTAssertEqual(trendRow(onPace(state: nil)), "\u{2212}0.6\u{00A0}kg/wk")
        // A muscle goal never reads a range.
        XCTAssertEqual(trendRow(onPace(goal: "muscle")), "\u{2212}0.6\u{00A0}kg/wk")
    }

    // MARK: An aging weigh-in

    /// The server calls a weigh-in aging from 7 days (`WEIGH_IN_AGING_DAYS`), and a week that began that old keeps
    /// the previous plan with `staleSince` set — either one means a rate is not this week's.
    func testAnAgingWeighInIsSevenDaysOrMoreOrAPlanThatSaysSo() {
        XCTAssertFalse(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: 0)))
        XCTAssertFalse(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: 6)))
        XCTAssertTrue(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: 7)))
        XCTAssertTrue(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: 14)))
        XCTAssertTrue(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: 40)))
        XCTAssertEqual(GoalProgressLogic.agingWeighInDays, 7)
        // The days are unknown (an older server omits them): only the plan can say so.
        XCTAssertFalse(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: nil)))
        XCTAssertTrue(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: nil, staleSince: "2026-10-11")))
        XCTAssertTrue(GoalProgressLogic.hasAgingWeighIn(onPace(lastWeighInDaysAgo: 8, staleSince: "2026-10-11")))
        // An older server's payload has no plan, only the days.
        XCTAssertTrue(GoalProgressLogic.hasAgingWeighIn(onPace(state: nil, lastWeighInDaysAgo: 9)))
        XCTAssertFalse(GoalProgressLogic.hasAgingWeighIn(onPace(state: nil, lastWeighInDaysAgo: 2)))
        // A reached goal and every other goal are not held to it.
        XCTAssertFalse(GoalProgressLogic.hasAgingWeighIn(onPace(verdict: .reached, lastWeighInDaysAgo: 20)))
        XCTAssertFalse(GoalProgressLogic.hasAgingWeighIn(onPace(goal: "muscle", lastWeighInDaysAgo: 20)))
    }

    /// The hero withholds a rate for a server read (as before) and for an aging weigh-in; a pace on a recent one is shown.
    func testTheWeeklyRateIsWithheldForAServerReadOrAnAgingWeighIn() {
        XCTAssertFalse(GoalProgressLogic.withholdsWeeklyRate(onPace(lastWeighInDaysAgo: 3)))
        XCTAssertFalse(GoalProgressLogic.withholdsWeeklyRate(onPace(lastWeighInDaysAgo: 6)))
        XCTAssertTrue(GoalProgressLogic.withholdsWeeklyRate(onPace(lastWeighInDaysAgo: 7)))
        XCTAssertTrue(GoalProgressLogic.withholdsWeeklyRate(onPace(lastWeighInDaysAgo: 2, staleSince: "2026-10-11")))
        for state in [GoalProgressDTO.WeightRead.State.early, .returning, .plateau, .movingAgain] {
            XCTAssertTrue(GoalProgressLogic.withholdsWeeklyRate(onPace(state: state, lastWeighInDaysAgo: 0)), "\(state)")
        }
        XCTAssertFalse(GoalProgressLogic.withholdsWeeklyRate(onPace(state: .reached, verdict: .reached, lastWeighInDaysAgo: 30)))
        XCTAssertFalse(GoalProgressLogic.withholdsWeeklyRate(onPace(state: nil, lastWeighInDaysAgo: 1)), "older server, recent weigh-in")
    }
}
