import Foundation

/// Pure, stateless formatting + decision logic for the redesigned
/// `AnalysisView` (analysis-v2-contract.md §2). Every function here takes its
/// inputs explicitly (never reads a singleton) so it's trivially unit
/// tested — see `AnalysisLogicTests.swift`. No SwiftUI here; the view layer
/// only turns these strings/enums into styled rows.
enum AnalysisLogic {

    // MARK: - Tone

    /// Visual weight for a comparison chip/row. `good`/`watch` map to
    /// `Theme.Colors.positive`/`Theme.Colors.caution` in the view;
    /// `neutral` to a plain gray chip.
    enum Tone: Equatable {
        case good, watch, neutral
    }

    struct Chip: Equatable {
        let text: String
        let tone: Tone
    }

    /// A value within this fraction of `usual` reads as "usual" rather than
    /// a directional delta (analysis-v2-contract.md §2: "within ±3%").
    static let usualTolerancePct = 0.03

    private static func isWithinUsualTolerance(_ value: Double, _ usual: Double) -> Bool {
        guard usual != 0 else { return value == 0 }
        return abs(value - usual) / abs(usual) <= usualTolerancePct
    }

    // MARK: - Workout stat chips

    /// Distance has no inherent "good" direction — the chip is always
    /// neutral, just stating the delta (or "usual").
    static func distanceChip(distanceM: Double, usualDistanceM: Double, unit: UnitSystem) -> Chip {
        if isWithinUsualTolerance(distanceM, usualDistanceM) {
            return Chip(text: "usual", tone: .neutral)
        }
        let deltaKm = (distanceM - usualDistanceM) / 1000
        let sign = deltaKm >= 0 ? "+" : "\u{2212}"
        let magnitude = UnitFormat.distance(km: abs(deltaKm), unit, placeholder: "0")
        return Chip(text: "\(sign)\(magnitude) vs usual", tone: .neutral)
    }

    /// Pace is inverted — a LOWER minutes-per-km is faster. The chip reads
    /// "N s faster/slower" (seconds, since a full pace-unit delta is
    /// usually sub-minute) and is toned `good` when faster, `watch` when
    /// slower.
    static func paceChip(paceMinPerKm: Double, usualPaceMinPerKm: Double) -> Chip {
        if isWithinUsualTolerance(paceMinPerKm, usualPaceMinPerKm) {
            return Chip(text: "usual", tone: .neutral)
        }
        let deltaSeconds = Int(((usualPaceMinPerKm - paceMinPerKm) * 60).rounded())
        let faster = deltaSeconds > 0
        return Chip(text: "\(abs(deltaSeconds)) s \(faster ? "faster" : "slower")", tone: faster ? .good : .watch)
    }

    /// Average heart rate has no inherent "good" direction for a single
    /// workout (a harder session naturally runs higher) — neutral, like
    /// distance.
    static func avgHrChip(avgHr: Double, usualAvgHr: Double) -> Chip {
        if isWithinUsualTolerance(avgHr, usualAvgHr) {
            return Chip(text: "usual", tone: .neutral)
        }
        let delta = Int((avgHr - usualAvgHr).rounded())
        let sign = delta >= 0 ? "+" : "\u{2212}"
        return Chip(text: "\(sign)\(abs(delta)) bpm vs usual", tone: .neutral)
    }

    // MARK: - Pace history strip

    /// "Compared to your last N runs" caption, from `paceHistory.rank`
    /// (1 = fastest) among `previous.count + 1` total runs (the previous
    /// runs plus this one).
    static func paceRankPhrase(rank: Int, previousCount: Int) -> String {
        let total = previousCount + 1
        guard total > 0 else { return "" }
        if rank <= 1 {
            return "Quickest of your last \(total) runs."
        }
        if rank >= total {
            return "Slowest of your last \(total) runs."
        }
        return "\(ordinal(rank)) fastest of your last \(total) runs."
    }

    private static func ordinal(_ n: Int) -> String {
        let suffix: String
        switch (n % 100, n % 10) {
        case (11, _), (12, _), (13, _): suffix = "th"
        case (_, 1): suffix = "st"
        case (_, 2): suffix = "nd"
        case (_, 3): suffix = "rd"
        default: suffix = "th"
        }
        return "\(n)\(suffix)"
    }

    // MARK: - Effort zone

    /// Title-case label for `AnalysisContext.Effort.zone`'s raw string.
    static func effortZoneLabel(_ zone: String) -> String {
        switch zone {
        case "easy": return "Easy"
        case "steady": return "Steady"
        case "hard": return "Hard"
        case "max": return "Max"
        default: return zone.capitalized
        }
    }

    /// Fraction (0...1) of the resting→max heart-rate range a given value
    /// sits at, clamped so a value at or below resting reads 0 and at or
    /// above max reads 1. Used to place BOTH the avg-effort marker and this
    /// workout's own recorded max-HR marker on the same zone bar.
    static func heartRateRangeFraction(_ value: Double, restingHr: Double, maxHr: Double) -> Double {
        guard maxHr > restingHr else { return 0 }
        return min(max((value - restingHr) / (maxHr - restingHr), 0), 1)
    }

    /// The four zone-band boundaries as fractions of the full resting→max
    /// range: easy [0, 0.60), steady [0.60, 0.75), hard [0.75, 0.90), max
    /// [0.90, 1.0] — mirrors the effort classification the server already
    /// applied to produce `effort.zone`.
    static let effortZoneBoundaries: [Double] = [0.60, 0.75, 0.90]

    // MARK: - Recovery readings (HRV / resting HR)

    enum RecoveryMetric { case hrv, restingHr }

    /// "62 ms · above normal" / "58 bpm · below normal" / "64 ms · normal" /
    /// bare "62 ms" when the baseline isn't established (`vsNormal == nil`).
    /// Tone follows the metric's own better-direction: higher HRV is good,
    /// higher resting HR is a caution.
    static func recoveryChip(value: Double, unit: String, vsNormal: String?, metric: RecoveryMetric) -> Chip {
        let formattedValue = "\(Int(value.rounded())) \(unit)"
        guard let vsNormal else { return Chip(text: formattedValue, tone: .neutral) }
        switch vsNormal {
        case "above":
            return Chip(text: "\(formattedValue) · above normal", tone: metric == .hrv ? .good : .watch)
        case "below":
            return Chip(text: "\(formattedValue) · below normal", tone: metric == .hrv ? .watch : .good)
        default:
            return Chip(text: "\(formattedValue) · normal", tone: .neutral)
        }
    }

    // MARK: - Sleep hero

    /// Sleep total vs the 14-night usual — analogous to `distanceChip`, but
    /// worded "under"/"over" (contract example: "1h 32m under your usual").
    /// Toned `watch` when under (short sleep is the thing worth flagging),
    /// neutral otherwise.
    static func sleepUsualChip(minutes: Double, usualMinutes: Double) -> Chip {
        if isWithinUsualTolerance(minutes, usualMinutes) {
            return Chip(text: "usual", tone: .neutral)
        }
        let delta = minutes - usualMinutes
        let phrase = formatDuration(abs(delta))
        return delta < 0
            ? Chip(text: "\(phrase) under your usual", tone: .watch)
            : Chip(text: "\(phrase) over your usual", tone: .neutral)
    }

    // MARK: - Sleep stages

    /// "watch" when deep or REM fell under 75% of usual, or awake ran over
    /// 150% of usual (analysis-v2-contract.md §2). `stage` identifies which
    /// rule applies; core has no rule of its own and always reads neutral.
    enum SleepStageKind { case core, deep, rem, awake }

    static func sleepStageTone(_ stage: SleepStageKind, minutes: Double, usualMinutes: Double) -> Tone {
        guard usualMinutes > 0 else { return .neutral }
        let ratio = minutes / usualMinutes
        switch stage {
        case .deep, .rem:
            return ratio < 0.75 ? .watch : .neutral
        case .awake:
            return ratio > 1.5 ? .watch : .neutral
        case .core:
            return .neutral
        }
    }

    /// A stage bar's fill fraction (0...1) relative to the row's own scale —
    /// each row is scaled independently to `max(minutes, usualMinutes) * headroom`
    /// so a stage far below its usual doesn't render as a sliver next to an
    /// oversized usual tick, and vice versa.
    static func sleepStageBarFraction(minutes: Double, usualMinutes: Double, headroom: Double = 1.15) -> Double {
        let scale = max(minutes, usualMinutes, 1) * headroom
        return min(max(minutes / scale, 0), 1)
    }

    /// The usual-value tick's position (0...1) on that same per-row scale.
    static func sleepStageUsualTickFraction(minutes: Double, usualMinutes: Double, headroom: Double = 1.15) -> Double {
        let scale = max(minutes, usualMinutes, 1) * headroom
        return min(max(usualMinutes / scale, 0), 1)
    }

    // MARK: - Week strip

    struct WeekBar: Equatable {
        let dayLabel: String   // "M", "T", "W", …
        let heightFraction: Double // 0...1, relative to the strip's own scale
        let isToday: Bool
    }

    struct WeekStripLayout: Equatable {
        let bars: [WeekBar]
        /// The dashed goal line's position (0...1) on the same scale as `bars`.
        let goalLineFraction: Double
    }

    /// Scales the last-7-nights minutes (oldest → newest) and the goal line
    /// onto a shared 0...1 axis, with 10% headroom above the tallest of
    /// (max night, goal) so the goal line is never flush with the top edge.
    /// `nights` may be shorter than 7 — a night with no data is simply
    /// omitted by the caller before this is reached (contract: "missing
    /// nights omitted").
    static func weekStripLayout(nights: [(date: String, minutes: Double)], goalMinutes: Double, today: String) -> WeekStripLayout {
        let scale = max((nights.map(\.minutes).max() ?? 0), goalMinutes, 1) * 1.1
        let bars = nights.map { night -> WeekBar in
            WeekBar(
                dayLabel: weekdayLetter(night.date),
                heightFraction: min(max(night.minutes / scale, 0), 1),
                isToday: night.date == today
            )
        }
        return WeekStripLayout(bars: bars, goalLineFraction: min(max(goalMinutes / scale, 0), 1))
    }

    /// Single-letter weekday ("M", "T", "W", …) for a 'YYYY-MM-DD' day key,
    /// parsed as a calendar date at noon UTC (avoids any DST-boundary
    /// off-by-one from parsing at local midnight) so the same day key always
    /// yields the same letter regardless of device time zone.
    static func weekdayLetter(_ dayKey: String) -> String {
        guard let date = dayKeyFormatter.date(from: dayKey) else { return "" }
        return weekdayLetterFormatter.string(from: date).uppercased()
    }

    private static let dayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'12:00:00"
        return f
    }()

    private static let weekdayLetterFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEEEE" // single-letter weekday, locale-independent for en_US_POSIX
        return f
    }()

    // MARK: - Kickers

    /// Short, all-caps activity word for a workout kicker ("RUN", "RIDE", …)
    /// from the app's existing title-case workout type name
    /// (`HealthKitBackfill.workoutTypeName`, e.g. "Running").
    static func workoutKickerActivity(type: String) -> String {
        switch type {
        case "Running": return "RUN"
        case "Walking": return "WALK"
        case "Cycling": return "RIDE"
        case "Swimming": return "SWIM"
        case "Hiking": return "HIKE"
        case "Rowing": return "ROW"
        case "Strength Training": return "STRENGTH"
        default: return type.uppercased()
        }
    }

    /// "RUN · SAT 7:41 AM" — activity plus local weekday + time. `timeZone`
    /// defaults to the device's own so the view always renders in wall-clock
    /// local time; tests pass an explicit zone for determinism.
    static func workoutKicker(type: String, startTime: Date, timeZone: TimeZone = .current) -> String {
        let f = dateFormatter(pattern: "EEE h:mm a", timeZone: timeZone)
        return "\(workoutKickerActivity(type: type)) · \(f.string(from: startTime))"
    }

    /// "LAST NIGHT · SAT → SUN" — bed night's weekday through wake night's.
    static func sleepKicker(bedTime: Date, wakeTime: Date, timeZone: TimeZone = .current) -> String {
        let f = dateFormatter(pattern: "EEE", timeZone: timeZone)
        return "LAST NIGHT · \(f.string(from: bedTime)) \u{2192} \(f.string(from: wakeTime))"
    }

    /// "11:52 pm" — lowercase am/pm, no leading zero, matching the mockups.
    static func clockTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        dateFormatter(pattern: "h:mm a", timeZone: timeZone).string(from: date).lowercased()
    }

    /// Builds a fresh, fixed-locale (`en_US_POSIX`) `DateFormatter` for the
    /// given pattern/zone. A new instance per call (rather than a cached
    /// shared one) keeps every formatting function here free of mutable
    /// static state, so tests can pass an explicit `timeZone` without racing
    /// other callers of the same formatter.
    private static func dateFormatter(pattern: String, timeZone: TimeZone) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = pattern
        return f
    }

    // MARK: - Duration formatting

    /// 312 → "5h 12m"; 42 → "42m". Rounds to the nearest whole minute.
    static func formatDuration(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        let hours = total / 60
        let mins = total % 60
        return hours > 0 ? "\(hours)h \(mins)m" : "\(mins)m"
    }

    // MARK: - Before-bed proximity

    /// Whether `eventTime` falls within `windowHours` before `bedTime` —
    /// used to decide whether a "before bed" row is worth flagging (tone
    /// `.watch`) vs. shown neutrally. The contract's `beforeBed` fields are
    /// only ever populated by the server when they DO fall in that window
    /// (a workout within 4h, a meal within 3h), so in practice this is
    /// always true for data the view receives — exposed as a pure function
    /// here so that invariant itself is testable.
    static func isWithinWindow(eventTime: Date, bedTime: Date, windowHours: Double) -> Bool {
        let hours = bedTime.timeIntervalSince(eventTime) / 3600
        return hours >= 0 && hours <= windowHours
    }
}
