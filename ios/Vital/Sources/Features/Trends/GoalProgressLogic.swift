import SwiftUI

/// Pure copy + decision logic behind the "Am I on track?" card (Trends) and
/// the one-line verdict in each Today hero (v5 Wave 2, docs/roadmap-v5-goal-progress.md).
///
/// Everything user-visible about weight is composed HERE from the response's
/// structured fields (`target`/`current`/`ratePerWeek`) and the user's
/// `UnitSystem` — never from the server `headline`, which is always in kg.
/// `headline` is only the fallback for goals/states that have no weight
/// numbers to compose from (muscle lifts, endurance sessions, general habits).
enum GoalProgressLogic {

    // MARK: - Non-breaking text

    /// U+00A0. Joins a value to its unit ("+20 kg", "4 wk") inside the strings
    /// built here so a narrow line can wrap BETWEEN tokens but never in the
    /// middle of one ("Squat +20 / kg / 4 wk" -> "Squat +20 kg / 4 wk").
    static let nbsp = "\u{00A0}"

    /// U+2060. Glued to both sides of an en dash inside a numeric range
    /// ("0.2–0.8") so the line cannot break after the dash — a no-break space
    /// does not help there (an en dash allows a break after it, even before a
    /// non-breaking space).
    static let wordJoiner = "\u{2060}"

    /// Makes copy that arrives (or is composed) with plain spaces safe to wrap:
    /// a value stays with its unit ("+10 kg", "4 wks"), an arrow pair stays
    /// whole ("153 → 163 kg") and a numeric range cannot split ("0.2–0.8").
    /// Wrapping can then only happen BETWEEN these tokens. Idempotent, and a
    /// no-op for text that is already non-breaking (the server emits U+00A0
    /// itself), so it is safe to run over any displayed server string. Applied
    /// where such strings are shown verbatim (goal reasons, the Trends review
    /// row, the strength chip).
    static func nonBreaking(_ text: String) -> String {
        var out = text.replacingOccurrences(of: " \u{2192} ", with: "\(nbsp)\u{2192}\(nbsp)")
        out = out.replacingOccurrences(
            of: "(\\d) (kg|lb|km|mi|wks|wk|weeks|week|bpm)\\b", with: "$1\(nbsp)$2", options: .regularExpression
        )
        out = out.replacingOccurrences(
            of: "(\\d)\u{2013}(\\d)", with: "$1\(wordJoiner)\u{2013}\(wordJoiner)$2", options: .regularExpression
        )
        return out
    }

    // MARK: - Tone

    enum Tone: Equatable {
        case good
        case watch
        case neutral
    }

    /// Same colors the Trends rows use for "moved the right/wrong way"
    /// (`TrendsMetricRowView` / `WhatMovedRowView`): positive green, caution
    /// amber (never the red `alert` — a slow week isn't a failure), and
    /// secondary text gray for neutral.
    static func color(for tone: Tone) -> Color {
        switch tone {
        case .good:    return Theme.Colors.positive
        case .watch:   return Theme.Colors.caution
        case .neutral: return Theme.Colors.textSecondary
        }
    }

    static func tone(for verdict: GoalVerdict) -> Tone {
        switch verdict {
        case .onTrack, .ahead, .progressing, .building:
            return .good
        case .tooFast, .behind, .stalled:
            return .watch
        case .holding, .needsTarget, .insufficientData:
            return .neutral
        }
    }

    static func tone(for reasonTone: GoalReasonTone) -> Tone {
        switch reasonTone {
        case .good:    return .good
        case .watch:   return .watch
        case .neutral: return .neutral
        }
    }

    // MARK: - Verdict label

    /// `goal` ("muscle" ...) makes the chip goal-aware: for a muscle goal the
    /// server's `behind` verdict means the lifts are up but the planned
    /// sessions are not happening ("Lifts up, sessions behind"), so a generic
    /// "Behind pace" chip beside it would read as a contradiction. Every other
    /// goal (and `nil`) keeps the generic label.
    static func label(for verdict: GoalVerdict, goal: String? = nil) -> String {
        if verdict == .behind, goal == "muscle" { return "Sessions behind" }
        switch verdict {
        case .onTrack:          return "On track"
        case .ahead:            return "Ahead of pace"
        case .tooFast:          return "Losing too fast"
        case .behind:           return "Behind pace"
        case .stalled:          return "Stalled"
        case .progressing:      return "Progressing"
        case .building:         return "Building"
        case .holding:          return "Holding steady"
        case .needsTarget:      return "Set a target"
        case .insufficientData: return "Getting started"
        }
    }

    // MARK: - Progress fraction

    /// 0...1 from the server's `progressPct` (0...100, clamped again here
    /// defensively), or `nil` when the server couldn't compute one.
    static func progressFraction(_ progress: GoalProgressDTO) -> Double? {
        guard let pct = progress.current.progressPct, pct.isFinite else { return nil }
        return min(1, max(0, pct / 100))
    }

    // MARK: - State helpers

    /// True when start, current and target weights are all known — the only
    /// case a weight line / progress bar can be composed from structured
    /// fields (a muscle-goal user with a target weight qualifies too).
    static func hasWeightProgress(_ progress: GoalProgressDTO) -> Bool {
        progress.target.weightKg != nil
            && progress.current.startWeightKg != nil
            && progress.current.weightKg != nil
    }

    /// The weight-loss prompt state: no target weight to measure against.
    static func needsWeightTarget(_ progress: GoalProgressDTO) -> Bool {
        progress.verdict == .needsTarget && progress.goal == "weight_loss"
    }

    /// Endurance (needs a weekly distance or session goal) and a muscle goal
    /// with neither target (needs a weekly session goal) instead of a weight.
    static func needsSessionTarget(_ progress: GoalProgressDTO) -> Bool {
        progress.verdict == .needsTarget && (progress.goal == "endurance" || progress.goal == "muscle")
    }

    /// Any goal whose needs-target state offers a "Set target" button — it
    /// opens Profile's goal editor (`.vitalOpenGoalEditor`), which shows the
    /// target weight field for weight/muscle goals, the weekly distance field
    /// for endurance, and the "workouts per week" stepper for muscle/endurance.
    static func needsTargetPrompt(_ progress: GoalProgressDTO) -> Bool {
        needsWeightTarget(progress) || needsSessionTarget(progress)
    }

    /// True once the weigh-in COUNT is met. The server can still say
    /// insufficient_data then (it also needs the readings to span ~7 days), so
    /// "3 of 3" must never be shown as if something were missing.
    static func weighInCountMet(_ progress: GoalProgressDTO) -> Bool {
        progress.dataSufficiency.weighIns >= max(progress.dataSufficiency.needed, 1)
    }

    /// "Need 3 weigh-ins · 1 of 3" — only for the weight goal (the only one
    /// whose insufficiency is measured in weigh-ins); `nil` otherwise so the
    /// caller falls back to the server headline. Once the count is met but the
    /// server still lacks a trend (needs a 7-day span), shows the server
    /// headline instead, or a generic "keep weighing in" line.
    static func insufficientDataText(_ progress: GoalProgressDTO) -> String? {
        guard progress.verdict == .insufficientData, progress.goal == "weight_loss" else { return nil }
        if weighInCountMet(progress) {
            return headlineWithoutVerdict(progress.headline)
                ?? "Keep weighing in — your trend needs about a week of weigh-ins"
        }
        let needed = max(progress.dataSufficiency.needed, 1)
        let have = min(max(progress.dataSufficiency.weighIns, 0), needed)
        return "Need \(needed) weigh-ins · \(have) of \(needed)"
    }

    /// The weigh-in count bar is only meaningful while weigh-ins are missing.
    static func showsWeighInProgressBar(_ progress: GoalProgressDTO) -> Bool {
        progress.verdict == .insufficientData && progress.goal == "weight_loss" && !weighInCountMet(progress)
    }

    /// Days without a weigh-in at which the card nudges the user.
    static let staleWeighInDays = 4

    /// "Last weigh-in 6 days ago — step on the scale to update" for a weight
    /// goal whose newest weigh-in is >= 4 days old; `nil` otherwise (including
    /// when the server doesn't send `lastWeighInDaysAgo`).
    static func staleWeighInText(_ progress: GoalProgressDTO) -> String? {
        guard progress.goal == "weight_loss",
              let days = progress.lastWeighInDaysAgo, days >= staleWeighInDays else { return nil }
        return "Last weigh-in \(days) days ago — step on the scale to update"
    }

    /// Fraction of weigh-ins collected, for the insufficient-data mini bar.
    static func insufficientDataFraction(_ progress: GoalProgressDTO) -> Double {
        let needed = max(progress.dataSufficiency.needed, 1)
        return min(1, max(0, Double(progress.dataSufficiency.weighIns) / Double(needed)))
    }

    // MARK: - Weight formatting

    /// "1.7", "8" — one decimal, trailing ".0" dropped.
    static func trimmedNumber(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        if rounded.truncatingRemainder(dividingBy: 1) == 0 {
            return String(Int(rounded))
        }
        return String(format: "%.1f", rounded)
    }

    /// A weight difference (never an absolute weight) in the user's unit, one
    /// decimal, no sign: `(1.7, .metric)` -> "1.7", `.imperial` -> "3.7".
    static func weightAmount(kg: Double, _ system: UnitSystem) -> String {
        let value = system == .metric ? kg : UnitConvert.kgToLb(kg)
        return trimmedNumber(abs(value))
    }

    /// "1.7 of 8 kg lost" / "3.7 of 17.6 lb lost" / "…gained". Direction comes
    /// from target vs start. Progress is never negative (regressing reads as
    /// "0 of 8 kg lost" — the verdict chip carries the bad news).
    static func weightLine(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let target = progress.target.weightKg,
              let start = progress.current.startWeightKg,
              let current = progress.current.weightKg else { return nil }
        let losing = target < start
        let totalKg = abs(start - target)
        let doneKg = max(0, losing ? start - current : current - start)
        guard totalKg > 0 else { return nil }
        let verb = losing ? "lost" : "gained"
        return "\(weightAmount(kg: doneKg, system)) of \(weightAmount(kg: totalKg, system))\(nbsp)\(system.weightUnit) \(verb)"
    }

    // MARK: - Weekly distance (endurance)

    /// This week's safe step toward the weekly goal (km), from last week's
    /// running (the same ~10% rule as the weekly review's "Next week"), when the
    /// server sent one that is genuinely below the goal; `nil` otherwise (absent
    /// on an older server, equal to the goal, or nonsense) — the goal is then
    /// the one target, exactly as before.
    static func stepTargetKm(_ progress: GoalProgressDTO) -> Double? {
        guard let d = progress.distance, d.targetKm > 0,
              let step = d.stepTargetKm, step.isFinite, step > 0, step < d.targetKm else { return nil }
        return step
    }

    /// 0...1 of this local week's distance against THIS WEEK'S target
    /// (clamped): the safe step when there is one ("of ~27 km"), else the weekly
    /// goal. `nil` without a distance target / without any measured distance.
    static func distanceFraction(_ progress: GoalProgressDTO) -> Double? {
        guard let d = progress.distance, d.targetKm > 0,
              let done = d.thisWeekKm, done.isFinite else { return nil }
        let target = stepTargetKm(progress) ?? d.targetKm
        return min(1, max(0, done / target))
    }

    /// A km value as a bare number in the user's unit, one decimal, trailing
    /// ".0" dropped: `(30, .metric)` -> "30", `(30, .imperial)` -> "18.6".
    static func distanceAmount(km: Double, _ system: UnitSystem) -> String {
        trimmedNumber(system == .metric ? km : UnitConvert.kmToMiles(km))
    }

    /// "24.5 of 30 km this week" (imperial: "15.2 of 18.6 mi this week") — the
    /// endurance primary progress. Calendar week (Monday–today, user-local).
    /// When last week caps this week's safe step below the goal the line says
    /// both, so there is ONE target for the week with the goal beside it:
    /// "22.7 of ~27 km this week · goal 30 km". `nil` without a distance target
    /// or a measured distance.
    static func distanceLine(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let d = progress.distance, d.targetKm > 0, let done = d.thisWeekKm else { return nil }
        let unit = system.distanceUnit
        let doneText = distanceAmount(km: done, system)
        let goalText = distanceAmount(km: d.targetKm, system)
        if let step = stepTargetKm(progress) {
            return "\(doneText) of ~\(distanceAmount(km: step, system)) \(unit) this week · goal \(goalText) \(unit)"
        }
        return "\(doneText) of \(goalText) \(unit) this week"
    }

    /// The label at the far end of the distance bar: the km the bar runs to
    /// ("~27 km" with a step, else the weekly goal "30 km"). `nil` without a
    /// distance target.
    static func distanceBarEndText(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let d = progress.distance, d.targetKm > 0 else { return nil }
        if let step = stepTargetKm(progress) { return "~\(UnitFormat.distance(km: step, system))" }
        return UnitFormat.distance(km: d.targetKm, system)
    }

    /// "4-week avg 23.2 km a week" — explicitly labelled so it is never
    /// confused with this week's total. `nil` without distance data.
    static func distanceAverageLine(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let d = progress.distance, let avg = d.avg4wKm else { return nil }
        return "4-week avg \(distanceAmount(km: avg, system)) \(system.distanceUnit) a week"
    }

    // MARK: - Dates

    private static func utcCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }

    /// "Dec 10" ("Dec 10, 2027" when not in `now`'s year) from a
    /// "YYYY-MM-DD" string, or `nil` if it doesn't parse. Parsed and
    /// formatted in UTC so the calendar day never shifts with the device zone.
    static func dateText(_ ymd: String?, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let ymd else { return nil }
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: ymd) else { return nil }

        let calendar = utcCalendar()
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "MMMdy")
        return formatter.string(from: date)
    }

    /// "At this pace: ~Dec 10" — only when the server supplied an ETA.
    static func etaLine(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let text = dateText(progress.eta, now: now, locale: locale) else { return nil }
        return "At this pace: ~\(text)"
    }

    /// "Target date Jan 15 · on pace" / "· not on pace" / just the date. Used
    /// only when there is NO ETA to relate the target date to (see `paceLine`).
    static func targetDateLine(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let text = dateText(progress.target.date, now: now, locale: locale) else { return nil }
        switch progress.onPaceForTargetDate {
        case .some(true):  return "Target date \(text) · on pace"
        case .some(false): return "Target date \(text) · not on pace"
        case .none:        return "Target date \(text)"
        }
    }

    /// ETA within this many days of the target date reads as "on pace".
    static let onPaceToleranceDays = 7

    /// Whole days from `from` to `to` ("YYYY-MM-DD" both), positive when `to`
    /// is later; `nil` if either fails to parse. UTC so the zone never shifts it.
    static func daysBetween(_ from: String?, _ to: String?) -> Int? {
        guard let from, let to else { return nil }
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let a = parser.date(from: from), let b = parser.date(from: to) else { return nil }
        return utcCalendar().dateComponents([.day], from: a, to: b).day
    }

    enum PaceRelation: Equatable {
        case onPace
        /// Weeks (rounded, >= 1) the ETA beats the target date by.
        case ahead(weeks: Int)
        case behind(weeks: Int)
    }

    /// ETA vs target date; `nil` unless both exist. Within ±7 days = on pace.
    static func paceRelation(_ progress: GoalProgressDTO) -> PaceRelation? {
        guard let days = daysBetween(progress.eta, progress.target.date) else { return nil }
        if abs(days) <= onPaceToleranceDays { return .onPace }
        let weeks = max(1, Int((Double(abs(days)) / 7).rounded()))
        return days > 0 ? .ahead(weeks: weeks) : .behind(weeks: weeks)
    }

    /// One line relating the projection to the user's target date:
    /// "About 2 weeks ahead of your Dec 29 target" / "About 3 weeks behind
    /// your Dec 29 target" / "Right on pace for Dec 29". `nil` without both an
    /// ETA and a target date.
    static func paceVsTargetLine(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let relation = paceRelation(progress),
              let target = dateText(progress.target.date, now: now, locale: locale) else { return nil }
        switch relation {
        case .onPace:
            return "Right on pace for \(target)"
        case .ahead(let weeks):
            return "About \(weeks) \(weeks == 1 ? "week" : "weeks") ahead of your \(target) target"
        case .behind(let weeks):
            return "About \(weeks) \(weeks == 1 ? "week" : "weeks") behind your \(target) target"
        }
    }

    /// Short form for the Today line: "2 wk ahead of Dec 29" / "On pace for Dec 29".
    static func compactPaceVsTarget(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let relation = paceRelation(progress),
              let target = dateText(progress.target.date, now: now, locale: locale) else { return nil }
        switch relation {
        case .onPace:              return "On pace for \(target)"
        case .ahead(let weeks):    return "\(weeks)\(nbsp)wk ahead of \(target)"
        case .behind(let weeks):   return "\(weeks)\(nbsp)wk behind \(target)"
        }
    }

    /// The single pace line for the detail sheet: the ETA-vs-target relation
    /// when both dates exist, else the bare ETA, else the target date alone
    /// (e.g. no projection yet).
    static func paceLine(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        if let line = paceVsTargetLine(progress, now: now, locale: locale) { return line }
        if let eta = etaLine(progress, now: now, locale: locale) { return eta }
        return targetDateLine(progress, now: now, locale: locale)
    }

    /// Tone of `paceLine`: on pace / ahead good, behind caution, else neutral.
    static func paceTone(_ progress: GoalProgressDTO) -> Tone {
        switch paceRelation(progress) {
        case .some(.onPace), .some(.ahead): return .good
        case .some(.behind):                return .watch
        case .none:
            switch progress.onPaceForTargetDate {
            case .some(true):  return .good
            case .some(false): return .watch
            case .none:        return .neutral
            }
        }
    }

    // MARK: - Primary lines

    /// The card's primary line. Weight goals compose from structured fields;
    /// everything else falls back to the server `headline`.
    static func primaryLine(_ progress: GoalProgressDTO, system: UnitSystem) -> String {
        if needsWeightTarget(progress) { return "Set a target weight to see your progress" }
        if needsSessionTarget(progress) {
            return progress.goal == "endurance"
                ? "Set a weekly distance or session goal to see your progress"
                : "Set a weekly session goal to see your progress"
        }
        if let text = insufficientDataText(progress) { return text }
        if let line = distanceLine(progress, system: system) { return line }
        switch progress.verdict {
        case .needsTarget, .insufficientData:
            return headlineWithoutVerdict(progress.headline) ?? label(for: progress.verdict)
        default:
            break
        }
        if let line = weightLine(progress, system: system) { return line }
        return headlineWithoutVerdict(progress.headline) ?? label(for: progress.verdict)
    }

    /// Verdict phrases the server prefixes its headlines with ("Building — weekly
    /// distance up 12%"). Surfaces that already show the verdict chip must not
    /// repeat it.
    private static let leadingVerdictPhrases: [String] = [
        "On track", "Ahead of pace", "Ahead", "Losing too fast", "Behind pace", "Behind",
        "Stalled", "Progressing", "Building", "Holding steady", "Holding",
        "Set a target", "Getting started",
    ]

    /// `headline` with a leading verdict phrase + dash ("Building — ", "On track - ",
    /// "Progressing – ") removed (case-insensitive). Returns the trimmed headline
    /// unchanged when there is no such prefix, and keeps it whole if stripping
    /// would leave nothing. `nil` for an empty headline.
    static func headlineWithoutVerdict(_ headline: String) -> String? {
        guard let text = nonEmpty(headline) else { return nil }
        for phrase in leadingVerdictPhrases {
            guard text.range(of: phrase, options: [.caseInsensitive, .anchored]) != nil else { continue }
            var rest = text.dropFirst(phrase.count)
            // Must be followed by optional spaces then a dash (em, en or hyphen).
            rest = rest.drop(while: { $0 == " " })
            guard let dash = rest.first, "—–-".contains(dash) else { continue }
            rest = rest.drop(while: { "—–- ".contains($0) })
            if let stripped = nonEmpty(String(rest)) { return stripped }
        }
        return text
    }

    /// The Today hero's short text beside the verdict chip: the ETA-vs-target
    /// relation ("2 wk ahead of Dec 29") when there is a target date, else
    /// the target weight + ETA ("82 kg by ~Dec 10") when a target weight
    /// exists, else the bare ETA ("≈ Dec 10"), else the primary line.
    ///
    /// `heroShowsDistance`: the endurance hero already shows "17.2 of 30 km
    /// this week" with a bar, so repeating that distance line here would be
    /// redundant — show the verdict's reason instead (`distanceReasonText`).
    ///
    /// A muscle goal whose verdict is `behind` (planned sessions not
    /// happening) leads with the cause and the next step instead
    /// (`sessionsBehindText`): "9 of 16 sessions in 4 wk · 2 more by Sun" once
    /// Today knows this week's done count (`sessionsDoneThisWeek`, the same
    /// number the hero's "2 of 4 sessions this week" shows), else "... · aim for
    /// 4 this week".
    ///
    /// Value+unit tokens use non-breaking spaces (`nbsp`); compare in tests
    /// after replacing them with plain spaces.
    static func compactText(
        _ progress: GoalProgressDTO, system: UnitSystem, heroShowsDistance: Bool = false,
        sessionsDoneThisWeek: Int? = nil,
        now: Date = Date(), locale: Locale = .current
    ) -> String {
        // Only when there is a distance line the hero could be duplicating —
        // weight/muscle goals have no distance block and must be unaffected.
        if let stale = staleWeighInText(progress), progress.verdict != .needsTarget { return stale }
        if heroShowsDistance, distanceLine(progress, system: system) != nil,
           let reason = distanceReasonText(progress, system: system) { return compactReason(reason) }
        // A muscle goal's Today line leads with the user's own goal outcome
        // ("1 of 4 kg gained") and appends the headline lift short
        // ("· Squat +10 kg / 4 wk"). With no weight target it is the lift story
        // alone; with neither it falls through to the weight ETA.
        if progress.goal == "muscle", progress.verdict != .needsTarget, progress.verdict != .insufficientData {
            if let cause = sessionsBehindText(progress, doneThisWeek: sessionsDoneThisWeek) { return cause }
            if let outcome = weightLine(progress, system: system) {
                if let short = liftShortText(progress) { return "\(outcome) · \(short)" }
                return outcome
            }
            if let lift = liftReasonText(progress) { return compactReason(lift) }
        }
        if let eta = dateText(progress.eta, now: now, locale: locale),
           progress.verdict != .needsTarget, progress.verdict != .insufficientData {
            if let relation = compactPaceVsTarget(progress, now: now, locale: locale) { return relation }
            // Say what the date is for: "82 kg by ~Dec 6" (the verdict chip
            // beside it already says "Progressing" etc.).
            if let targetKg = progress.target.weightKg {
                return "\(UnitFormat.weight(kg: targetKg, system)) by ~\(eta)"
            }
            return "≈ \(eta)"
        }
        return primaryLine(progress, system: system)
    }

    /// Shortens server reason copy for the one-line Today strip:
    /// "weekly distance up 12% (last 2 weeks vs the 2 before)" ->
    /// "distance up 12% · 2 wk vs prior 2".
    static func compactReason(_ text: String) -> String {
        var out = text.replacingOccurrences(of: "weekly distance", with: "distance", options: .caseInsensitive)
        if let range = out.range(of: #"\s*\(last (\d+) weeks? vs the (\d+) before\)"#, options: .regularExpression) {
            let match = String(out[range])
            let numbers = match.split(whereSeparator: { !$0.isNumber }).map(String.init)
            if numbers.count == 2 {
                out.replaceSubrange(range, with: " · \(numbers[0]) wk vs prior \(numbers[1])")
            }
        }
        return out
    }

    /// The lift-related story for a muscle goal ("Squat +10 kg vs 4 wk"):
    /// the first reason of kind "lift", else the server headline when it
    /// mentions a lift/1RM, minus its verdict prefix. `nil` when absent.
    static func liftReasonText(_ progress: GoalProgressDTO) -> String? {
        if let reason = progress.reasons.first(where: { $0.kind.lowercased().contains("lift") }),
           let text = nonEmpty(reason.text) { return text }
        if let headline = headlineWithoutVerdict(progress.headline),
           headline.range(of: "1RM", options: .caseInsensitive) != nil
            || headline.range(of: #"\b(squat|bench|deadlift|overhead press|row|lift)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return headline
        }
        return nil
    }

    /// The headline lift as a short tail for the Today line: the server's lift
    /// reason ("Squat est. 1RM +10 kg vs 4 weeks ago (153 → 163 kg)", always the
    /// shared headline lift, first) becomes "Squat +10 kg / 4 wk". `nil` when
    /// there is no lift reason, or it carries no signed change ("unchanged").
    static func liftShortText(_ progress: GoalProgressDTO) -> String? {
        guard let reason = progress.reasons.first(where: { $0.kind.lowercased().contains("lift") }),
              let nameEnd = reason.text.range(of: " est. 1RM"),
              let delta = reason.text.range(of: #"[+−-]\d+(?:\.\d+)?\s?(?:kg|lb)"#, options: .regularExpression)
        else { return nil }
        let name = reason.text[..<nameEnd.lowerBound].trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        // Keep "+10 kg" and "/ 4 wk" whole: wrapping happens between them.
        let change = String(reason.text[delta]).replacingOccurrences(of: " ", with: nbsp)
        return "\(name) \(change) /\(nbsp)4\(nbsp)wk"
    }

    /// The muscle `behind` verdict means lifts are up but the planned sessions
    /// are not happening, so say that with the numbers and the next step:
    /// "9 of 16 sessions in 4 wk · 2 more by Sun". From the payload's
    /// structured `adherence`; `nil` unless this is a muscle goal with a
    /// `behind` verdict and usable counts (older servers omit `adherence`, and
    /// the caller then keeps the weight/lift line).
    ///
    /// `doneThisWeek` is the number of sessions already done this week as Today
    /// shows it (the hero's "2 of 4 sessions this week"); the next step is then
    /// the concrete remainder of the weekly target ("2 more by Sun", the week
    /// ends Sunday). Unknown, or the target already met, falls back to the
    /// generic "aim for 4 this week" - never "0 more".
    static func sessionsBehindText(_ progress: GoalProgressDTO, doneThisWeek: Int? = nil) -> String? {
        guard progress.goal == "muscle", progress.verdict == .behind,
              let adherence = progress.adherence,
              adherence.planned > 0, adherence.weeklyTarget > 0 else { return nil }
        let nextStep: String
        if let doneThisWeek, adherence.weeklyTarget - max(doneThisWeek, 0) > 0 {
            // One unbreakable token: a narrow Today line wraps BEFORE "2 more by
            // Sun", never as "… · 2 / more by Sun" or "… 2 more by / Sun".
            nextStep = "\(adherence.weeklyTarget - max(doneThisWeek, 0))\(nbsp)more\(nbsp)by\(nbsp)Sun"
        } else {
            nextStep = "aim for \(adherence.weeklyTarget) this week"
        }
        return "\(adherence.done) of \(adherence.planned) sessions in 4\(nbsp)wk · \(nextStep)"
    }

    /// Why the verdict is what it is, in one short phrase, for a surface that
    /// already shows this week's distance progress ("distance up 12% (last 2
    /// weeks vs the 2 before)"): the server headline minus its verdict prefix,
    /// else the first reason. Never the "X of Y km this week" line itself.
    /// `nil` when nothing other than that line is available.
    static func distanceReasonText(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        let progressLine = distanceLine(progress, system: system)
        let candidates = [headlineWithoutVerdict(progress.headline)]
            + progress.reasons.map { nonEmpty($0.text) }
        return candidates.compactMap { $0 }.first { $0 != progressLine }
    }

    // MARK: - Detail sheet copy

    /// Percentage with up to 2 decimals, trailing zeros dropped: 0.25 -> "0.25", 1.0 -> "1".
    static func trimmedPercent(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded.truncatingRemainder(dividingBy: 1) == 0 { return String(Int(rounded)) }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    /// "Healthy pace: 0.25–1% of body weight per week ≈ 0.2–0.8 kg" — the kg
    /// part (in the user's unit) only when the current weight is known. Both
    /// ranges and the "≈ value unit" tail are non-breaking (`nonBreaking`), so
    /// a narrow sheet wraps between words, never as "≈ 0.2– / 0.8 kg".
    static func safeBandText(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let band = progress.safeBand else { return nil }
        var text = "Healthy pace: \(trimmedPercent(band.minPct))–\(trimmedPercent(band.maxPct))% of body weight per week"
        if let weightKg = progress.current.weightKg {
            let low = weightAmount(kg: weightKg * band.minPct / 100, system)
            let high = weightAmount(kg: weightKg * band.maxPct / 100, system)
            text += " ≈\(nbsp)\(low)–\(high)\(nbsp)\(system.weightUnit)"
        }
        return nonBreaking(text)
    }

    /// "−0.6 kg/wk" (signed, user's unit) or `nil` without a measured rate.
    static func rateText(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let kg = progress.ratePerWeek.kg else { return nil }
        return UnitFormat.weightDelta(kgPerWeek: kg, system)
    }

    // MARK: - Detail sheet stats table

    /// One label/value row of the detail sheet's stats card.
    struct StatRow: Equatable {
        let label: String
        let value: String
    }

    /// Whether the stats table lists body-weight rows (Start / Now / Target
    /// weight and the weight "Trend" rate). Weight-loss and muscle goals are
    /// about body weight, so they always do; an endurance or general goal gets
    /// them only when the user actually set a target weight — otherwise a race
    /// goal opened with "Now 61 kg" as its first row reads as the wrong story.
    /// Any future goal id follows the same target-weight rule.
    static func showsWeightRows(_ progress: GoalProgressDTO) -> Bool {
        switch progress.goal {
        case "weight_loss", "muscle": return true
        default:                      return progress.target.weightKg != nil
        }
    }

    /// Label/value rows for whatever the response has — a row is simply
    /// omitted when its value is unknown (never "--" placeholders or zeros),
    /// and the weight rows are omitted entirely per `showsWeightRows`.
    static func statRows(_ progress: GoalProgressDTO, system: UnitSystem) -> [StatRow] {
        var rows: [StatRow] = []
        if showsWeightRows(progress) {
            if let start = progress.current.startWeightKg {
                rows.append(StatRow(label: "Start", value: UnitFormat.weight(kg: start, system)))
            }
            if let current = progress.current.weightKg {
                rows.append(StatRow(label: "Now", value: UnitFormat.weight(kg: current, system)))
            }
            if let target = progress.target.weightKg {
                rows.append(StatRow(label: "Target", value: UnitFormat.weight(kg: target, system)))
            }
            if let rate = rateText(progress, system: system) {
                rows.append(StatRow(label: "Trend", value: rate))
            }
        }
        if let race = progress.race {
            rows.append(StatRow(label: "Race", value: RaceLogic.rowText(race)))
        }
        if let longRun = progress.longRun, let text = RaceLogic.longRunRowText(longRun, system) {
            rows.append(StatRow(label: "Long run", value: text))
        }
        if let distance = progress.distance {
            rows.append(StatRow(label: "Weekly distance goal", value: UnitFormat.distance(km: distance.targetKm, system)))
            if let done = distance.thisWeekKm {
                rows.append(StatRow(label: "This week", value: UnitFormat.distance(km: done, system)))
            }
            if let avg = distance.avg4wKm {
                rows.append(StatRow(label: "4-week average", value: "\(UnitFormat.distance(km: avg, system))/week"))
            }
        }
        if let sessions = progress.target.weeklySessions {
            rows.append(StatRow(label: "Weekly sessions goal", value: "\(sessions)"))
        }
        if progress.goal != "weight_loss", progress.dataSufficiency.sessionsLast28d > 0 {
            rows.append(StatRow(label: "Sessions, last 4 weeks", value: "\(progress.dataSufficiency.sessionsLast28d)"))
        }
        return rows
    }

    /// Up to `limit` reasons for the compact card.
    static func visibleReasons(_ progress: GoalProgressDTO, limit: Int = 3) -> [GoalReasonDTO] {
        Array(progress.reasons.prefix(limit))
    }

    private static func nonEmpty(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
