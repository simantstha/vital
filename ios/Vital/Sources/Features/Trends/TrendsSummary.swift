import Foundation

// MARK: - Weekly summary — pure helpers

/// Pure, network-free logic behind the "Last 7 days" summary cards (Sleep,
/// HRV, Resting HR) on the Trends screen: mapping day-keyed API points onto a
/// fixed 7-slot window, and the data-driven footnote copy under each chart.
/// Kept static/pure (with an injected `today`) so `TrendsSummaryTests` can
/// exercise it without any network or view-model plumbing.
enum TrendsSummary {

    /// A 7-day window of values (oldest → newest), aligned 1:1 with
    /// single-letter weekday labels (e.g. "F S S M T W T" ending today).
    struct WeekWindow: Equatable {
        let values: [Double?]
        let dayLabels: [String]

        static let empty = WeekWindow(
            values: Array(repeating: nil, count: 7),
            dayLabels: Array(repeating: "", count: 7)
        )
    }

    /// A two-tone footnote: `prefix` + an optional bold `bold` span +
    /// `suffix`. `bold` is nil when the whole footnote renders in one weight.
    struct Footnote: Equatable {
        let prefix: String
        let bold: String?
        let suffix: String

        static func plain(_ text: String) -> Footnote {
            Footnote(prefix: text, bold: nil, suffix: "")
        }
    }

    private static let dateKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let weekdayLetterFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEEE" // narrow weekday initial, e.g. "F", "S", "M"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    /// Maps day-keyed points onto the 7 local calendar days ending `today`
    /// (oldest → newest). Points outside the window are ignored; days
    /// without a matching point are `nil`.
    static func weekWindow(
        from points: [TrendPoint],
        today: Date,
        calendar: Calendar = .current
    ) -> WeekWindow {
        var cal = calendar
        cal.timeZone = TimeZone.current
        let startOfToday = cal.startOfDay(for: today)

        var byDate: [String: Double] = [:]
        for p in points { byDate[p.date] = p.value }

        var values: [Double?] = []
        var dayLabels: [String] = []
        for offset in -6...0 {
            guard let day = cal.date(byAdding: .day, value: offset, to: startOfToday) else { continue }
            let key = dateKeyFormatter.string(from: day)
            values.append(byDate[key])
            dayLabels.append(weekdayLetterFormatter.string(from: day))
        }
        return WeekWindow(values: values, dayLabels: dayLabels)
    }

    // MARK: Sleep

    /// "8" for 8.0, "7.5" for 7.5 — the bare number; callers append "h".
    /// Matches `ProfileViewModel.sleepGoalSummary`'s formatting.
    static func hoursLabel(_ hours: Double) -> String {
        hours.truncatingRemainder(dividingBy: 1) == 0
            ? "\(Int(hours))"
            : String(format: "%.1f", hours)
    }

    /// The "short night" cutoff for a given sleep goal: 75% of the goal,
    /// snapped to the nearest half hour so the threshold speaks the same
    /// half-hour vocabulary as the goal picker (7.5h / 8h / 8.5h) rather than
    /// surfacing a derived decimal like "5.6h". 7.5h → 5.5h, 8h → 6h, 8.5h → 6.5h.
    ///
    /// Single source of truth: `sleepFootnote`'s copy and `TrendBarChart`'s bar
    /// shading both call this, so the gray bars always match the sentence.
    static func shortSleepThreshold(for goalHours: Double) -> Double {
        ((goalHours * 0.75) * 2).rounded() / 2
    }

    /// Average of the available (non-nil) nights, formatted "6h 54m"; nil
    /// when no nights are available.
    static func sleepAverageText(_ values: [Double?]) -> String? {
        let available = values.compactMap { $0 }
        guard !available.isEmpty else { return nil }
        let avgHours = available.reduce(0, +) / Double(available.count)
        let totalMinutes = Int((avgHours * 60).rounded())
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        return "\(hours)h \(String(format: "%02d", minutes))m"
    }

    /// Never overclaims across missing nights: with fewer than 7 of 7 synced,
    /// the copy states how many nights actually synced before saying
    /// anything about them, and never uses an absolute word like "Every" —
    /// only the full 7-of-7 case gets that copy. Missing nights are neither
    /// counted as short nor silently folded into a full-week claim.
    static func sleepFootnote(
        _ values: [Double?],
        goalHours: Double = 8.0
    ) -> Footnote {
        let available = values.compactMap { $0 }
        guard !available.isEmpty else { return .plain("No sleep synced yet.") }

        let shortThresholdHours = shortSleepThreshold(for: goalHours)
        let shortCount = available.filter { $0 < shortThresholdHours }.count
        let syncedCount = available.count
        let totalSlots = values.count
        let fullWeekSynced = syncedCount == totalSlots

        if shortCount == 0 {
            guard fullWeekSynced else {
                let claim: String
                switch syncedCount {
                case 1: claim = "it's near your \(hoursLabel(goalHours))h goal."
                case 2: claim = "both near your \(hoursLabel(goalHours))h goal."
                default: claim = "all near your \(hoursLabel(goalHours))h goal."
                }
                return Footnote(
                    prefix: "Only ",
                    bold: "\(syncedCount) of \(totalSlots) nights",
                    suffix: " synced — \(claim)"
                )
            }
            return .plain("Every night near your \(hoursLabel(goalHours))h goal this week.")
        }

        let bold = fullWeekSynced
            ? "\(shortCount) of \(totalSlots) nights"
            : "\(shortCount) of \(syncedCount) synced nights"
        return Footnote(
            prefix: "Under \(hoursLabel(shortThresholdHours))h on ",
            bold: bold,
            suffix: ". Gray bars are short nights."
        )
    }

    // MARK: HRV / Resting HR (continuous vitals)

    /// "syncing" when any of the 7 slots is missing data, else "7-day".
    static func vitalsNote(_ values: [Double?]) -> String {
        values.contains(where: { $0 == nil }) ? "syncing" : "7-day"
    }

    /// The most recent non-nil reading in a 7-slot window, or nil.
    static func latestAvailable(_ values: [Double?]) -> Double? {
        for v in values.reversed() where v != nil { return v }
        return nil
    }

    static func lineFootnote(_ values: [Double?]) -> Footnote {
        let available = values.compactMap { $0 }
        guard !available.isEmpty else { return .plain("No readings yet.") }
        guard available.count >= 7 else {
            let noun = available.count == 1 ? "reading" : "readings"
            return .plain("Only \(available.count) \(noun) this week — dashed dots haven't synced.")
        }
        let first = available.first!
        let last = available.last!
        guard first != 0 else { return .plain("Steady this week.") }
        let pct = Int(((last - first) / first * 100).rounded())
        if abs(pct) <= 2 {
            return .plain("Steady this week.")
        } else if pct > 2 {
            return .plain("Drifting up (+\(pct)%) this week.")
        } else {
            return .plain("Trending down (−\(abs(pct))%) this week.")
        }
    }
}
