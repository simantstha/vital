import Foundation

/// Pure display logic for Today's endurance recovery strip (HRV / Resting HR
/// / Sleep): value, a range bar placed on the user's own 30-day normal, and a
/// one-line delta. Kept free of SwiftUI/APIClient so the honesty rules are
/// cheap to unit test.
///
/// Honesty rules (mirrors `TrendsVerdict`):
/// - A band, marker and delta exist ONLY for a gated `.normal` / `.above` /
///   `.below` verdict. `.noData` / `.calibrating` show the value alone — never
///   a fabricated range.
/// - σ never reaches copy: deltas are absolute (ms / bpm / minutes vs the
///   30-day mean).
enum RecoveryStripLogic {

    enum Kind: String, CaseIterable, Equatable {
        case hrv, restingHR, sleep

        var label: String {
            switch self {
            case .hrv: return "HRV"
            case .restingHR: return "Resting HR"
            case .sleep: return "Sleep"
            }
        }

        /// Key into `MetricExplainer` for the "What is this?" button.
        var explanationKey: String {
            switch self {
            case .hrv: return "hrv_sdnn"
            case .restingHR: return "resting_hr"
            case .sleep: return "sleep_minutes"
            }
        }

        /// Same good/bad direction as `MetricSpec.polarity` for these keys.
        var polarity: EnduranceHeroLogic.Polarity {
            self == .restingHR ? .lowerIsBetter : .higherIsBetter
        }
    }

    /// How an outlier reads: a good-side outlier is positive, a bad-side one
    /// is caution, everything else (in range, no verdict) is neutral.
    enum Tone: Equatable {
        case positive, caution, neutral
    }

    /// Positions on the bar, as fractions (0...1) of the bar's width. The
    /// domain is `mean ± 3·sd`; the band is `mean ± sd`; `marker` is the
    /// current value clamped into the domain so an extreme reading pins to
    /// the end instead of leaving the bar.
    struct Range: Equatable {
        let bandStart: Double
        let bandEnd: Double
        let marker: Double
    }

    struct Input: Equatable {
        let kind: Kind
        /// Numeric value in the metric's native unit (ms, bpm, HOURS for sleep).
        let value: Double?
        let valueText: String
        let unit: String
        let verdict: Verdict
        let mean30: Double?
        let sd30: Double?
    }

    struct Item: Equatable, Identifiable {
        let kind: Kind
        let valueText: String
        let unit: String
        /// `nil` unless the verdict is `.normal` / `.above` / `.below`.
        let range: Range?
        /// `nil` whenever `range` is.
        let deltaText: String?
        let tone: Tone

        var id: Kind { kind }
        var label: String { kind.label }
        var explanationKey: String { kind.explanationKey }
    }

    static let inRangeText = "In range"

    // MARK: - Items

    /// One item per metric that has a value, in HRV / Resting HR / Sleep
    /// order (the order the inputs arrive in). Empty when none has a value.
    static func items(_ inputs: [Input]) -> [Item] {
        inputs.compactMap(item)
    }

    static func item(_ input: Input) -> Item? {
        guard let value = input.value, value.isFinite else { return nil }

        // Only a judged verdict earns a band; it also needs a usable
        // baseline to draw one against (the verdict gates already guarantee
        // this, but a bar is geometry — so check, don't assume).
        guard isJudged(input.verdict),
              let mean = input.mean30, let sd = input.sd30,
              mean.isFinite, sd.isFinite, sd > 0 else {
            return Item(kind: input.kind, valueText: input.valueText, unit: input.unit,
                        range: nil, deltaText: nil, tone: .neutral)
        }

        return Item(
            kind: input.kind,
            valueText: input.valueText,
            unit: input.unit,
            range: range(value: value, mean: mean, sd: sd),
            deltaText: deltaText(kind: input.kind, verdict: input.verdict, value: value, mean: mean),
            tone: tone(verdict: input.verdict, polarity: input.kind.polarity)
        )
    }

    // MARK: - Pieces

    static func isJudged(_ verdict: Verdict) -> Bool {
        switch verdict {
        case .normal, .above, .below: return true
        case .noData, .calibrating: return false
        }
    }

    /// Band = mean ± sd on a mean ± 3·sd domain; marker clamped into it.
    static func range(value: Double, mean: Double, sd: Double) -> Range? {
        guard sd > 0, value.isFinite, mean.isFinite else { return nil }
        let low = mean - 3 * sd
        let span = 6 * sd
        func fraction(_ x: Double) -> Double { min(1, max(0, (x - low) / span)) }
        return Range(
            bandStart: fraction(mean - sd),
            bandEnd: fraction(mean + sd),
            marker: fraction(value)
        )
    }

    static func tone(verdict: Verdict, polarity: EnduranceHeroLogic.Polarity) -> Tone {
        switch EnduranceHeroLogic.score(verdict, polarity: polarity) {
        case 1: return .positive
        case -1: return .caution
        default: return .neutral
        }
    }

    /// "In range" for `.normal`; otherwise "+6 vs normal" (HRV / RHR) or
    /// "30 min short" / "30 min over" (sleep, minutes vs the 30-day mean).
    /// The sign / direction comes from the verdict, the magnitude from
    /// `|value − mean|`. `nil` for an unjudged verdict.
    static func deltaText(kind: Kind, verdict: Verdict, value: Double, mean: Double) -> String? {
        let isAbove: Bool
        switch verdict {
        case .noData, .calibrating: return nil
        case .normal: return inRangeText
        case .above: isAbove = true
        case .below: isAbove = false
        }
        switch kind {
        case .hrv, .restingHR:
            let magnitude = Int(abs(value - mean).rounded())
            return "\(isAbove ? "+" : "\u{2212}")\(magnitude) vs normal"
        case .sleep:
            let minutes = Int((abs(value - mean) * 60).rounded())
            return "\(minutes) min \(isAbove ? "over" : "short")"
        }
    }
}

/// Pure copy for Today's header (title + one-line meta). Separate from the
/// view so the "never show the verdict word before loaded" rule is testable.
enum TodayHeaderLogic {

    /// `dateSubtitle · streakChipText`; the streak is omitted when `nil`.
    static func metaLine(dateSubtitle: String, streakText: String?) -> String {
        guard let streakText, !streakText.isEmpty else { return dateSubtitle }
        return "\(dateSubtitle) · \(streakText)"
    }

    /// The page title. For the endurance goal it is the readiness word —
    /// but only once Today has loaded and the user is past calibration
    /// (`calibratingText == nil`); in every other case the time-of-day greeting.
    static func title(
        greeting: String,
        isEnduranceGoal: Bool,
        isLoaded: Bool,
        calibratingText: String?,
        readinessWord: EnduranceHeroLogic.ReadinessWord
    ) -> String {
        guard isEnduranceGoal, isLoaded, calibratingText == nil else { return greeting }
        return readinessWord.rawValue
    }
}
