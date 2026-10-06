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

    static func label(for verdict: GoalVerdict) -> String {
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

    /// The prompt state: no target to measure against. Only the weight goal
    /// gets the "set a target weight" button — endurance/general need a weekly
    /// session goal instead, which has no editor yet, so they just show the
    /// server headline.
    static func needsWeightTarget(_ progress: GoalProgressDTO) -> Bool {
        progress.verdict == .needsTarget && progress.goal == "weight_loss"
    }

    /// "Need 3 weigh-ins · 1 of 3" — only for the weight goal (the only one
    /// whose insufficiency is measured in weigh-ins); `nil` otherwise so the
    /// caller falls back to the server headline.
    static func insufficientDataText(_ progress: GoalProgressDTO) -> String? {
        guard progress.verdict == .insufficientData, progress.goal == "weight_loss" else { return nil }
        let needed = max(progress.dataSufficiency.needed, 1)
        let have = min(max(progress.dataSufficiency.weighIns, 0), needed)
        return "Need \(needed) weigh-ins · \(have) of \(needed)"
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
        return "\(weightAmount(kg: doneKg, system)) of \(weightAmount(kg: totalKg, system)) \(system.weightUnit) \(verb)"
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

    /// "At this pace: around Dec 10" — only when the server supplied an ETA.
    static func etaLine(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let text = dateText(progress.eta, now: now, locale: locale) else { return nil }
        return "At this pace: around \(text)"
    }

    /// "Target date Jan 15 · on pace" / "· not on pace" / just the date.
    static func targetDateLine(_ progress: GoalProgressDTO, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let text = dateText(progress.target.date, now: now, locale: locale) else { return nil }
        switch progress.onPaceForTargetDate {
        case .some(true):  return "Target date \(text) · on pace"
        case .some(false): return "Target date \(text) · not on pace"
        case .none:        return "Target date \(text)"
        }
    }

    // MARK: - Primary lines

    /// The card's primary line. Weight goals compose from structured fields;
    /// everything else falls back to the server `headline`.
    static func primaryLine(_ progress: GoalProgressDTO, system: UnitSystem) -> String {
        if needsWeightTarget(progress) { return "Set a target weight to see your progress" }
        if let text = insufficientDataText(progress) { return text }
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

    /// The Today hero's short text beside the verdict chip: the ETA when there
    /// is one ("≈ Dec 10"), else the primary line.
    static func compactText(_ progress: GoalProgressDTO, system: UnitSystem, now: Date = Date(), locale: Locale = .current) -> String {
        if let eta = dateText(progress.eta, now: now, locale: locale),
           progress.verdict != .needsTarget, progress.verdict != .insufficientData {
            return "≈ \(eta)"
        }
        return primaryLine(progress, system: system)
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
    /// part (in the user's unit) only when the current weight is known.
    static func safeBandText(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let band = progress.safeBand else { return nil }
        var text = "Healthy pace: \(trimmedPercent(band.minPct))–\(trimmedPercent(band.maxPct))% of body weight per week"
        if let weightKg = progress.current.weightKg {
            let low = weightAmount(kg: weightKg * band.minPct / 100, system)
            let high = weightAmount(kg: weightKg * band.maxPct / 100, system)
            text += " ≈ \(low)–\(high) \(system.weightUnit)"
        }
        return text
    }

    /// "−0.6 kg/wk" (signed, user's unit) or `nil` without a measured rate.
    static func rateText(_ progress: GoalProgressDTO, system: UnitSystem) -> String? {
        guard let kg = progress.ratePerWeek.kg else { return nil }
        return UnitFormat.weightDelta(kgPerWeek: kg, system)
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
