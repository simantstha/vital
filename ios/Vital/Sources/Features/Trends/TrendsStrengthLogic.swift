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

    // MARK: - Non-breaking

    /// U+00A0 (`UnitFormat.nbsp`). Joins a value to its unit ("142 kg", "4 wk",
    /// "5.2 t") in every string built here, so a narrow row (the strength
    /// chip, the volume line) can wrap BETWEEN tokens but never strand a unit
    /// on its own line.
    private static let nbsp = UnitFormat.nbsp

    // MARK: - Tunables

    /// Weeks shown in each lift's sparkline (and considered for ranking).
    static let windowWeeks = 8
    /// How many lifts the card shows.
    static let maxLifts = 3
    /// "Recent frequency" window used for ranking lifts when the server sends no
    /// per-week session counts (an older server). With counts, the server's own
    /// rule ranks them instead (`rankedLiftKeys`).
    static let lookbackWeeks = 4
    /// THE one definition of lift progress — mirrors `lib/liftChange.ts`
    /// (`liftChange4w`), which the Trends goal card and the weekly review use,
    /// so one lift never shows two different numbers:
    ///   end      = the newest week with an e1RM among the current week and the
    ///              two before it (an empty current week — e.g. Monday before
    ///              training — is skipped, not read as a regression)
    ///   recent   = best e1RM across `end` and the week before it
    ///   baseline = best e1RM across the two weeks ending 4 weeks before `end`
    ///              (end-4 and end-5)
    ///   change   = recent - baseline, rounded to 0.1 kg
    /// Offsets are in weeks back from `end` (recent/baseline) or from the
    /// current (last) index of the dense weekly series (`endSearchOffsets`).
    /// Both windows need data, else there is no change.
    static let endSearchOffsets = [0, 1, 2]
    static let recentWeekOffsets = [0, 1]
    static let baselineWeekOffsets = [4, 5]
    /// A change of at least this fraction of the baseline counts as progress
    /// (mirrors `LIFT_PROGRESS_MIN_FRACTION` in `lib/liftChange.ts`); anything
    /// smaller is a stall. Scales with the lift, so 1 kg on a 40 kg press is
    /// real progress while 1 kg on a 200 kg deadlift is Epley noise.
    static let progressMinFraction = 0.01
    /// A lift whose newest e1RM is this many weeks back (or more) gets a
    /// "Not logged in N wk" chip instead of a progress claim about old data.
    /// Three = the width of the end-week search (`endSearchOffsets`: the
    /// current week plus the two before it), so a lift the server can still
    /// anchor a change on is never shown as "Not logged".
    static let staleWeeks = endSearchOffsets.count

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
        /// window has no data — and for the lift being rebuilt after a break
        /// (`buildingBackStatus`), whose dip is not a decline to count.
        /// Raw kg — unit formatting happens in `status`.
        let changeKg: Double?
        /// The baseline e1RM (kg) that `changeKg` is measured against; `nil`
        /// exactly when `changeKg` is. The progress bar is 1% of this.
        let baselineKg: Double?

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
    ///
    /// Order: when the weekly stats carry the server's `sessions` counts the
    /// lifts follow the server's headline-lift rule exactly (`headlineLift` leads,
    /// then `rankedLiftKeys`), so the first row is the lift the goal card names;
    /// without them (older server) the original recent-sets order is kept.
    ///
    /// `liftReturn` (`GoalProgressDTO.liftReturn`): the lift the server says the
    /// user is rebuilding after a break reads a neutral "Building back" status
    /// instead of a decline (`buildingBackStatus`) and is left out of the
    /// header's lifts-up / lifts-down counts.
    static func card(
        from summary: WorkoutSummaryResponse, system: UnitSystem, today: Date,
        liftReturn: GoalProgressDTO.LiftReturn? = nil
    ) -> Card? {
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

        if carriesSessionCounts(summary) {
            // The server's rule: the headline lift first, then the rest as ranked.
            var order = rankedLiftKeys(in: summary, today: today)
            if let headline = headlineLift(in: summary, today: today),
               let index = order.firstIndex(of: headline) {
                order.remove(at: index)
                order.insert(headline, at: 0)
            }
            var position: [String: Int] = [:]
            for (index, key) in order.enumerated() { position[key] = index }
            candidates.sort { lhs, rhs in
                let lhsPosition = position[lhs.key] ?? Int.max
                let rhsPosition = position[rhs.key] ?? Int.max
                if lhsPosition != rhsPosition { return lhsPosition < rhsPosition }
                return lhs.key < rhs.key
            }
        } else {
            candidates.sort { lhs, rhs in
                if lhs.recentSets != rhs.recentSets { return lhs.recentSets > rhs.recentSets }
                if lhs.totalSets != rhs.totalSets { return lhs.totalSets > rhs.totalSets }
                return lhs.key < rhs.key
            }
        }

        let lifts = candidates.prefix(maxLifts).compactMap { candidate -> Lift? in
            let e1rm: [Double?] = candidate.series.map { $0?.bestEstimatedOneRepMaxKg }
            guard let latest = e1rm.compactMap({ $0 }).last else { return nil }
            let building = buildingBackStatus(liftReturn: liftReturn, forLift: candidate.key, system: system)
            let liftChange = building == nil ? change(e1rm: e1rm) : nil
            return Lift(
                key: candidate.key,
                name: displayName(for: candidate.key),
                currentText: wholeWeightText(kg: latest, system: system),
                sparkline: e1rm,
                status: building ?? status(e1rm: e1rm, system: system),
                changeKg: liftChange?.changeKg,
                baselineKg: liftChange?.baselineKg
            )
        }

        return Card(
            lifts: Array(lifts),
            volume: volumeLine(summary: summary, keys: keys, system: system)
        )
    }

    // MARK: - Headline lift (the server's rule)

    /// Completed weeks the "most-trained lift" ranking looks back over
    /// (`LIFT_RANK_WINDOW_WEEKS` in `lib/liftChange.ts`).
    static let rankWindowWeeks = 8
    /// Tie-break order for equally-trained lifts; any other lift follows, A-Z
    /// (`MAIN_LIFT_ORDER` in `lib/liftChange.ts`).
    static let mainLiftOrder = ["squat", "bench press", "deadlift", "overhead press"]

    /// `"Bench-Press"` / `"bench_press"` -> `"bench press"` (`normalizeLiftKey`).
    static func normalizedLiftKey(_ key: String) -> String {
        key.lowercased()
            .replacingOccurrences(of: "[-_]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func mainLiftRank(_ key: String) -> Int {
        mainLiftOrder.firstIndex(of: normalizedLiftKey(key)) ?? mainLiftOrder.count
    }

    /// True when the summary carries the server's per-week `sessions` counts.
    /// Only then does the card use the server's ranking (`rankedLiftKeys`); an
    /// older server keeps the card's own recent-sets order.
    static func carriesSessionCounts(_ summary: WorkoutSummaryResponse) -> Bool {
        summary.exercises.values.contains { stats in
            stats.contains { $0.sessions != nil }
        }
    }

    /// Sessions that week (days with a working set of the lift); a week without
    /// a count counts 1 when anything was trained (`weekSessions` in the server rule).
    private static func weekSessions(_ stat: WorkoutWeeklyStatDTO) -> Int {
        if let sessions = stat.sessions { return sessions }
        return (stat.totalSets > 0 || stat.bestEstimatedOneRepMaxKg != nil) ? 1 : 0
    }

    /// Lifts in rotation (an e1RM in the last 8 weeks including the current one),
    /// most-trained first. Mirrors `rankLifts` in `lib/liftChange.ts`: sessions
    /// containing the lift over the 8 COMPLETED weeks before the current week,
    /// ties by the fixed order (squat, bench press, deadlift, overhead press,
    /// then A-Z). Before any week has completed (a brand-new lifter) the
    /// current week counts.
    static func rankedLiftKeys(in summary: WorkoutSummaryResponse, today: Date) -> [String] {
        // keys[0...7] are the 8 completed weeks before the current one (the
        // server's anchor); keys[8] is the anchor itself.
        let keys = weekKeys(endingAt: today, count: rankWindowWeeks + 1)
        guard keys.count == rankWindowWeeks + 1, let anchor = keys.last else { return [] }
        let oldestCompleted = keys[0]
        let newestCompleted = keys[rankWindowWeeks - 1]
        let oldestWithAnchor = keys[1]

        var inRotation: [(key: String, stats: [WorkoutWeeklyStatDTO])] = []
        for (key, stats) in summary.exercises {
            let hasRecentLoad = stats.contains {
                $0.bestEstimatedOneRepMaxKg != nil && $0.weekStart >= oldestWithAnchor && $0.weekStart <= anchor
            }
            if hasRecentLoad { inRotation.append((key: key, stats: stats)) }
        }

        func sessions(_ stats: [WorkoutWeeklyStatDTO], from oldest: String, through newest: String) -> Int {
            var total = 0
            for stat in stats where stat.weekStart >= oldest && stat.weekStart <= newest {
                total += weekSessions(stat)
            }
            return total
        }

        var scored: [(key: String, sessions: Int)] = inRotation.map {
            (key: $0.key, sessions: sessions($0.stats, from: oldestCompleted, through: newestCompleted))
        }
        if scored.allSatisfy({ $0.sessions == 0 }) {
            scored = inRotation.map {
                (key: $0.key, sessions: sessions($0.stats, from: oldestWithAnchor, through: anchor))
            }
        }
        scored.sort { lhs, rhs in
            if lhs.sessions != rhs.sessions { return lhs.sessions > rhs.sessions }
            let lhsRank = mainLiftRank(lhs.key)
            let rhsRank = mainLiftRank(rhs.key)
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            return lhs.key < rhs.key
        }
        return scored.map { $0.key }
    }

    /// THE headline lift, as the server picks it (`pickHeadlineLift` in
    /// `lib/liftChange.ts`, the lift the goal card and Today line name): the
    /// first lift of `rankedLiftKeys` that has a 4-week change. Never the lift
    /// that moved the most. `nil` when no lift has a comparable change.
    static func headlineLift(in summary: WorkoutSummaryResponse, today: Date) -> String? {
        let keys = weekKeys(endingAt: today, count: windowWeeks)
        for key in rankedLiftKeys(in: summary, today: today) {
            let e1rm: [Double?] = weeklySeries(summary.exercises[key] ?? [], keys: keys).map { $0?.bestEstimatedOneRepMaxKg }
            if change(e1rm: e1rm) != nil { return key }
        }
        return nil
    }

    // MARK: - Building back after a break

    /// "Building back — 96% of pre-break 142 kg" (neutral): the server's
    /// `liftReturn` says the user is rebuilding this lift after a break of 10+
    /// days and has not yet regained its pre-break best, so a negative change
    /// against 4 weeks ago is expected, not a decline. `nil` for any other lift,
    /// once the pre-break best is regained, and without a `liftReturn`.
    static func buildingBackStatus(
        liftReturn: GoalProgressDTO.LiftReturn?, forLift key: String, system: UnitSystem
    ) -> Status? {
        guard let liftReturn, !liftReturn.regained,
              normalizedLiftKey(liftReturn.exercise) == normalizedLiftKey(key) else { return nil }
        let preBreak = wholeWeightText(kg: liftReturn.preBreakKg, system: system)
        return Status(text: "Building back — \(liftReturn.pct)% of pre-break \(preBreak)", tone: .neutral)
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
        guard let endIndex = endSearchOffsets
            .map({ e1rm.count - 1 - $0 })
            .first(where: { $0 >= 0 && e1rm[$0] != nil })
        else { return nil }
        func best(_ offsets: [Int]) -> Double? {
            var result: Double?
            for offset in offsets {
                let index = endIndex - offset
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
    /// compare with) / "Not logged in 3 wk" (watch, nothing in the current week or the
    /// two weeks before it). The window is always named — it is the same
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
            return Status(text: "Not logged in \(weeksSinceLast)\(nbsp)wk", tone: .watch)
        }

        guard let change = change(e1rm: e1rm) else {
            return Status(text: "New", tone: .neutral)
        }
        let delta = change.changeKg
        // Whole kg/lb, computed from the ROUNDED endpoints (mirrors
        // `liftDisplayChange` in lib/liftChange.ts) so "+6 kg" always matches
        // the "102 -> 108" the goal card shows. A change too small to survive
        // rounding reads as "No change" rather than "+0 kg".
        let shown = displayChange(change, system: system)
        if isProgressing(changeKg: delta, baselineKg: change.baselineKg), shown.change > 0 {
            return Status(text: "+\(shown.change)\(nbsp)\(system.weightUnit) vs 4\(nbsp)wk ago", tone: .good)
        }
        if isDeclining(changeKg: delta, baselineKg: change.baselineKg), shown.change < 0 {
            return Status(text: "\u{2212}\(-shown.change)\(nbsp)\(system.weightUnit) vs 4\(nbsp)wk ago", tone: .watch)
        }
        return Status(text: "No change vs 4\(nbsp)wk ago", tone: .watch)
    }

    /// Whole-unit endpoints and the change between the ROUNDED endpoints —
    /// the single user-facing e1RM number format (an estimated 1RM to 0.1 kg
    /// is false precision). Mirrors `liftDisplayChange` in `lib/liftChange.ts`
    /// (JS `Math.round` and `.rounded()` agree for positive e1RMs).
    struct DisplayChange: Equatable {
        let baseline: Int
        let recent: Int
        let change: Int
    }

    static func displayChange(_ change: LiftChange, system: UnitSystem) -> DisplayChange {
        func whole(_ kg: Double) -> Int {
            Int((system == .metric ? kg : UnitConvert.kgToLb(kg)).rounded())
        }
        let baseline = whole(change.baselineKg)
        let recent = whole(change.recentKg)
        return DisplayChange(baseline: baseline, recent: recent, change: recent - baseline)
    }

    /// A lift's e1RM as a whole-unit string ("142 kg" / "314 lb").
    static func wholeWeightText(kg: Double, system: UnitSystem) -> String {
        let value = system == .metric ? kg : UnitConvert.kgToLb(kg)
        return "\(Int(value.rounded()))\(nbsp)\(system.weightUnit)"
    }

    /// Mirrors `isLiftProgressing`: a real gain is >= +1% of the baseline.
    static func isProgressing(changeKg: Double, baselineKg: Double) -> Bool {
        changeKg > 0 && changeKg >= baselineKg * progressMinFraction - 1e-9
    }

    /// The mirror image: a real drop is >= 1% of the baseline.
    static func isDeclining(changeKg: Double, baselineKg: Double) -> Bool {
        changeKg < 0 && -changeKg >= baselineKg * progressMinFraction - 1e-9
    }

    /// Unsigned weight magnitude with its unit, whole kg / whole lb
    /// ("3 kg", "6 lb").
    static func magnitudeText(kg: Double, system: UnitSystem) -> String {
        wholeWeightText(kg: abs(kg), system: system)
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
            return String(format: "%.1f\(nbsp)t", kg / 1000)
        case .imperial:
            let lb = UnitConvert.kgToLb(kg)
            if lb >= 1000 {
                return String(format: "%.1fk\(nbsp)lb", lb / 1000)
            }
            return "\(Int(lb.rounded()))\(nbsp)lb"
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
