import Foundation

/// Pure, network-free logic behind Trends' "Strength" card (roadmap v5 item B):
/// the top lifts' current estimated 1RM, an 8-week sparkline, a plain-English
/// progress chip, and the weekly volume line. Built from
/// `GET /api/workouts/summary` (`WorkoutSummaryResponse`). No SwiftUI import,
/// same convention as `TrendsMetricRowLogic`/`TrendsHeadline`, so every branch
/// is pinned exactly in `TrendsStrengthLogicTests`.
///
/// The server buckets sets into UTC Monday-start weeks and only returns weeks
/// that contain at least one working set, so this type first lays the weeks
/// out on a dense, oldest-first grid ending at the current week — a missed
/// week then reads as a gap (`nil`) in the sparkline rather than being
/// silently skipped.
enum TrendsStrengthLogic {

    // MARK: - Tunables

    /// Weeks shown in each lift's sparkline (and considered for ranking).
    static let windowWeeks = 8
    /// How many lifts the card shows.
    static let maxLifts = 3
    /// "Recent frequency" window used for ranking lifts.
    static let lookbackWeeks = 4
    /// THE one definition of lift progress — mirrors `lib/liftChange.ts`
    /// (`liftChange4w`), which the Trends goal card and the weekly review use,
    /// so one lift never shows two different numbers:
    ///   recent   = best e1RM across the current week and the week before
    ///   baseline = best e1RM across the two weeks ending 4 weeks before the
    ///              current week (current-4 and current-5)
    ///   change   = recent - baseline, rounded to 0.1 kg
    /// Offsets are in weeks back from the current (last) index of the dense
    /// weekly series. Both windows need data, else there is no change.
    static let recentWeekOffsets = [0, 1]
    static let baselineWeekOffsets = [4, 5]
    /// A change smaller than this (in kg, regardless of the display unit)
    /// reads as "no change" — below it, Epley noise from a different rep
    /// count dominates real progress.
    static let changeThresholdKg = 1.0
    /// A lift not trained for this many weeks gets a "Not logged in N wk"
    /// chip instead of a progress claim about old data.
    /// (Two, because the "recent" window is the current week plus the one
    /// before — a lift last logged 2+ weeks ago has no recent data.)
    static let staleWeeks = 2

    // MARK: - Types

    enum Tone: Equatable {
        case good
        case watch
        case neutral
    }

    struct Status: Equatable {
        let text: String
        let tone: Tone
    }

    struct Lift: Equatable, Identifiable {
        /// Canonical exercise key ("squat", "bench press").
        let key: String
        let name: String
        /// Latest weekly best e1RM, unit-formatted ("142.5 kg" / "314 lb").
        let currentText: String
        /// Weekly best e1RM (kg), oldest first, `windowWeeks` long; `nil`
        /// for a week with no loaded working set.
        let sparkline: [Double?]
        let status: Status
        /// The shared 4-week change in kg (`change(e1rm:)`), `nil` when either
        /// window has no data. Raw kg — unit formatting happens in `status`.
        let changeKg: Double?

        var id: String { key }

        var accessibilityLabel: String {
            "\(name), estimated one-rep max \(currentText), \(status.text)"
        }
    }

    struct VolumeLine: Equatable {
        /// "This week: 14 sets · 5.2 t lifted"
        let thisWeek: String
        /// "vs 12 sets · 4.8 t last week" — `nil` when last week had no sets.
        let comparison: String?
    }

    struct Card: Equatable {
        let lifts: [Lift]
        let volume: VolumeLine
    }

    // MARK: - Card

    /// `nil` (card hidden) when the summary has no logged exercises at all.
    /// Never fabricates zeros: a lift with only bodyweight sets has no e1RM
    /// and is skipped; if that leaves no lifts the card still shows the
    /// volume line (sets are real) but no lift rows.
    static func card(from summary: WorkoutSummaryResponse, system: UnitSystem, today: Date) -> Card? {
        let hasAnySets = summary.exercises.values.contains { stats in
            stats.contains { $0.totalSets > 0 }
        }
        guard hasAnySets else { return nil }

        let keys = weekKeys(endingAt: today, count: windowWeeks)
        let recentKeys = Set(keys.suffix(lookbackWeeks))

        struct Candidate {
            let key: String
            let recentSets: Int
            let totalSets: Int
            let series: [WorkoutWeeklyStatDTO?]
        }

        var candidates: [Candidate] = []
        for (key, stats) in summary.exercises {
            let series = weeklySeries(stats, keys: keys)
            let hasLoad = series.contains { $0?.bestEstimatedOneRepMaxKg != nil }
            guard hasLoad else { continue }
            var recentSets = 0
            var totalSets = 0
            for stat in series {
                guard let stat else { continue }
                totalSets += stat.totalSets
                if recentKeys.contains(stat.weekStart) { recentSets += stat.totalSets }
            }
            candidates.append(Candidate(key: key, recentSets: recentSets, totalSets: totalSets, series: series))
        }

        candidates.sort { lhs, rhs in
            if lhs.recentSets != rhs.recentSets { return lhs.recentSets > rhs.recentSets }
            if lhs.totalSets != rhs.totalSets { return lhs.totalSets > rhs.totalSets }
            return lhs.key < rhs.key
        }

        let lifts = candidates.prefix(maxLifts).compactMap { candidate -> Lift? in
            let e1rm: [Double?] = candidate.series.map { $0?.bestEstimatedOneRepMaxKg }
            guard let latest = e1rm.compactMap({ $0 }).last else { return nil }
            return Lift(
                key: candidate.key,
                name: displayName(for: candidate.key),
                currentText: UnitFormat.weight(kg: latest, system),
                sparkline: e1rm,
                status: status(e1rm: e1rm, system: system),
                changeKg: change(e1rm: e1rm)?.changeKg
            )
        }

        return Card(
            lifts: Array(lifts),
            volume: volumeLine(summary: summary, keys: keys, system: system)
        )
    }

    // MARK: - Status chip

    /// The shared lift-progress number (see `recentWeekOffsets`). `e1rm` is
    /// the dense oldest-first weekly series, so its last index is the current
    /// week. Parity-tested against `lib/liftChange.test.ts`.
    struct LiftChange: Equatable {
        let baselineKg: Double
        let recentKg: Double
        /// recent - baseline, rounded to 0.1 kg (half up, like JS `Math.round`).
        let changeKg: Double
    }

    static func change(e1rm: [Double?]) -> LiftChange? {
        func best(_ offsets: [Int]) -> Double? {
            var result: Double?
            for offset in offsets {
                let index = e1rm.count - 1 - offset
                guard index >= 0, let value = e1rm[index] else { continue }
                if result == nil || value > result! { result = value }
            }
            return result
        }
        guard let recent = best(recentWeekOffsets), let baseline = best(baselineWeekOffsets) else { return nil }
        let rounded = (recent - baseline) * 10
        return LiftChange(baselineKg: baseline, recentKg: recent, changeKg: (rounded + 0.5).rounded(.down) / 10)
    }

    /// "+2.5 kg vs 4 wk ago" (good) / "No change vs 4 wk ago" (watch) / "New"
    /// (neutral, fewer than two weeks with data or nothing 4 weeks back to
    /// compare with) / "Not logged in 3 wk" (watch, nothing in the current or
    /// previous week). The window is always named — it is the same
    /// "last 2 weeks vs 4 weeks ago" number the goal card shows.
    static func status(e1rm: [Double?], system: UnitSystem) -> Status {
        var lastIndex: Int?
        var pointCount = 0
        for (index, value) in e1rm.enumerated() where value != nil {
            pointCount += 1
            lastIndex = index
        }
        guard pointCount >= 2, let lastIndex else {
            return Status(text: "New", tone: .neutral)
        }

        let weeksSinceLast = (e1rm.count - 1) - lastIndex
        if weeksSinceLast >= staleWeeks {
            return Status(text: "Not logged in \(weeksSinceLast) wk", tone: .watch)
        }

        guard let change = change(e1rm: e1rm) else {
            return Status(text: "New", tone: .neutral)
        }
        let delta = change.changeKg
        if delta >= changeThresholdKg {
            return Status(text: "+\(magnitudeText(kg: delta, system: system)) vs 4 wk ago", tone: .good)
        }
        if delta <= -changeThresholdKg {
            return Status(text: "\u{2212}\(magnitudeText(kg: -delta, system: system)) vs 4 wk ago", tone: .watch)
        }
        return Status(text: "No change vs 4 wk ago", tone: .watch)
    }

    /// Unsigned weight magnitude with its unit — metric up to one decimal
    /// ("2.5 kg", "3 kg"), imperial whole pounds ("6 lb").
    static func magnitudeText(kg: Double, system: UnitSystem) -> String {
        let magnitude = abs(kg)
        switch system {
        case .metric:
            let rounded = (magnitude * 10).rounded() / 10
            let number = rounded.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(rounded))
                : String(format: "%.1f", rounded)
            return "\(number) \(system.weightUnit)"
        case .imperial:
            return "\(Int(UnitConvert.kgToLb(magnitude).rounded())) \(system.weightUnit)"
        }
    }

    // MARK: - Volume line

    /// Totals across every exercise (bodyweight sets count toward sets, not
    /// tonnage — mirrors the server's own aggregation rules).
    static func volumeLine(summary: WorkoutSummaryResponse, keys: [String], system: UnitSystem) -> VolumeLine {
        guard let thisKey = keys.last, keys.count >= 2 else {
            return VolumeLine(thisWeek: "This week: no sets yet", comparison: nil)
        }
        let lastKey = keys[keys.count - 2]
        let thisWeek = totals(summary: summary, weekStart: thisKey)
        let lastWeek = totals(summary: summary, weekStart: lastKey)

        let thisText: String
        if thisWeek.sets > 0 {
            thisText = "This week: \(summaryText(thisWeek, system: system, suffix: " lifted"))"
        } else {
            thisText = "This week: no sets yet"
        }
        let comparison: String? = lastWeek.sets > 0
            ? "vs \(summaryText(lastWeek, system: system, suffix: "")) last week"
            : nil
        return VolumeLine(thisWeek: thisText, comparison: comparison)
    }

    private static func totals(summary: WorkoutSummaryResponse, weekStart: String) -> (sets: Int, volumeKg: Double) {
        var sets = 0
        var volume = 0.0
        for stats in summary.exercises.values {
            for stat in stats where stat.weekStart == weekStart {
                sets += stat.totalSets
                volume += stat.volumeKg
            }
        }
        return (sets, volume)
    }

    /// "14 sets · 5.2 t lifted" (tonnage omitted when nothing was loaded).
    private static func summaryText(_ totals: (sets: Int, volumeKg: Double), system: UnitSystem, suffix: String) -> String {
        let setsText = "\(totals.sets) \(totals.sets == 1 ? "set" : "sets")"
        guard totals.volumeKg > 0 else { return setsText }
        return "\(setsText) · \(tonnageText(kg: totals.volumeKg, system: system))\(suffix)"
    }

    /// Metric: tonnes with one decimal ("5.2 t"). Imperial: thousands of lb
    /// ("11.5k lb") from 1,000 lb up, whole lb below.
    static func tonnageText(kg: Double, system: UnitSystem) -> String {
        switch system {
        case .metric:
            return String(format: "%.1f t", kg / 1000)
        case .imperial:
            let lb = UnitConvert.kgToLb(kg)
            if lb >= 1000 {
                return String(format: "%.1fk lb", lb / 1000)
            }
            return "\(Int(lb.rounded())) lb"
        }
    }

    // MARK: - Weeks

    /// "bench press" -> "Bench Press".
    static func displayName(for key: String) -> String {
        key.capitalized
    }

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        calendar.firstWeekday = 2 // Monday — matches lib/workoutRepository.ts's weekStartKey
        return calendar
    }()

    private static let keyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    /// `YYYY-MM-DD` (UTC) of the Monday that starts the week containing `date`.
    static func weekStartKey(for date: Date) -> String {
        let start = utcCalendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date
        return keyFormatter.string(from: start)
    }

    /// `count` consecutive week-start keys, oldest first, the last being the
    /// week containing `today`.
    static func weekKeys(endingAt today: Date, count: Int) -> [String] {
        let currentStart = utcCalendar.dateInterval(of: .weekOfYear, for: today)?.start ?? today
        var keys: [String] = []
        for offset in stride(from: count - 1, through: 0, by: -1) {
            let date = utcCalendar.date(byAdding: .weekOfYear, value: -offset, to: currentStart) ?? currentStart
            keys.append(keyFormatter.string(from: date))
        }
        return keys
    }

    /// Lays the server's sparse weeks onto the dense `keys` grid.
    static func weeklySeries(_ stats: [WorkoutWeeklyStatDTO], keys: [String]) -> [WorkoutWeeklyStatDTO?] {
        var byWeek: [String: WorkoutWeeklyStatDTO] = [:]
        for stat in stats { byWeek[stat.weekStart] = stat }
        return keys.map { byWeek[$0] }
    }
}
