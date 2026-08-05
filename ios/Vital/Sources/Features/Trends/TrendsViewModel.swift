import Foundation
import SwiftUI

// MARK: - Metric option

enum TrendMetric: String, CaseIterable, Identifiable {
    case hrv      = "hrv"
    case sleep    = "sleep"
    case weight   = "weight"
    case steps    = "steps"
    case vo2      = "vo2"
    case distance = "distance"
    case rhr      = "rhr"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .hrv:      return "HRV"
        case .sleep:    return "Sleep"
        case .weight:   return "Weight"
        case .steps:    return "Steps"
        case .vo2:      return "VO₂ Max"
        case .distance: return "Distance"
        case .rhr:      return "Resting HR"
        }
    }

    /// Server values are always metric (kg/km) — actual value conversion
    /// happens in `TrendsViewModel.points` and friends via `UnitConvert`.
    /// Unit-neutral metrics (ms, h, steps, bpm, ml/kg·min) are unaffected by
    /// the unit system.
    func unitLabel(_ system: UnitSystem) -> String {
        switch self {
        case .hrv:      return "ms"
        case .sleep:    return "h"
        case .weight:   return system.weightUnit
        case .steps:    return "steps"
        case .vo2:      return "ml/kg·min"
        case .distance: return system.distanceUnit
        case .rhr:      return "bpm"
        }
    }
}

// MARK: - Chart data point

struct ChartPoint: Identifiable {
    let id = UUID()
    let date: Date
    let value: Double
}

/// A fully-loaded explorer series: the metric/range it was fetched for,
/// bundled with its points so the two can never drift apart in the view.
/// Replaces a bare `points` array, which let a stale metric's numbers render
/// under a just-tapped metric's label mid-load.
struct LoadedSeries: Equatable {
    let metric: TrendMetric
    let days: Int
    let points: [ChartPoint]

    static func == (lhs: LoadedSeries, rhs: LoadedSeries) -> Bool {
        lhs.metric == rhs.metric
            && lhs.days == rhs.days
            && lhs.points.map(\.value) == rhs.points.map(\.value)
            && lhs.points.map(\.date) == rhs.points.map(\.date)
    }
}

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

    static func sleepFootnote(
        _ values: [Double?],
        goalHours: Double = 8.0
    ) -> Footnote {
        let available = values.compactMap { $0 }
        guard !available.isEmpty else { return .plain("No sleep synced yet.") }
        let shortThresholdHours = shortSleepThreshold(for: goalHours)
        let shortCount = available.filter { $0 < shortThresholdHours }.count
        guard shortCount > 0 else {
            return .plain("Every night near your \(hoursLabel(goalHours))h goal this week.")
        }
        return Footnote(
            prefix: "Under \(hoursLabel(shortThresholdHours))h on ",
            bold: "\(shortCount) of 7 nights",
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

// MARK: - ViewModel

@MainActor
final class TrendsViewModel: ObservableObject {

    // MARK: Explorer state (existing)

    @Published var selectedMetric: TrendMetric = .hrv
    @Published var selectedDays: Int = 14
    /// The metric/range a completed `load()` actually produced, bundled with
    /// its points. Never set from a response whose metric/days no longer
    /// match what was requested at call time (see `load()`), so the chart and
    /// header can't show one metric's numbers under another's label.
    @Published private(set) var loaded: LoadedSeries? = nil
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    /// Derived from `loaded`, converted into the user's current unit system
    /// for weight/distance (the server always returns kg/km) — the chart,
    /// the hero number, and the Latest/Average badges all read from this one
    /// converted source so they can never drift apart from each other.
    var points: [ChartPoint] {
        guard let loaded else { return [] }
        let system = UnitPreference.shared.current
        return loaded.points.map {
            ChartPoint(date: $0.date, value: Self.displayValue($0.value, metric: loaded.metric, system: system))
        }
    }

    private static func displayValue(_ value: Double, metric: TrendMetric, system: UnitSystem) -> Double {
        switch metric {
        case .weight:   return system == .metric ? value : UnitConvert.kgToLb(value)
        case .distance: return system == .metric ? value : UnitConvert.kmToMiles(value)
        default:        return value
        }
    }

    // MARK: Summary state (Last 7 days)

    @Published var sleepWindow: TrendsSummary.WeekWindow = .empty
    @Published var hrvWindow: TrendsSummary.WeekWindow = .empty
    @Published var rhrWindow: TrendsSummary.WeekWindow = .empty
    @Published var calibration: CalibrationStatus? = nil
    @Published var sleepGoalMinutes: Int = 480 // 8h default
    @Published var isLoadingSummary = false
    @Published var summaryErrorMessage: String? = nil

    private let apiClient: TrendsAPIProviding
    /// `loadSummary()` also needs `fetchProfile()`, which is outside the
    /// minimal `TrendsAPIProviding` seam (that protocol exists solely to let
    /// tests inject a fake for `load()`/`fetchTrends`). Kept as a direct
    /// `APIClient.shared` reference rather than widening the protocol.
    private let profileClient = APIClient.shared

    /// Bumped at the top of every `load()` call; a response is only applied
    /// if its generation is still the newest one in flight. Guards against a
    /// slow first response (e.g. metric A) landing after a faster second one
    /// (metric B) and overwriting it with stale data.
    private var loadGeneration = 0

    init(apiClient: TrendsAPIProviding = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Computed stats (explorer)

    var currentValue: String {
        guard let last = points.last else { return "--" }
        return formatValue(last.value)
    }

    var rangeLabel: String {
        guard points.count > 1 else { return "" }
        let vals = points.map(\.value)
        let lo = vals.min()!
        let hi = vals.max()!
        return "\(formatValue(lo)) – \(formatValue(hi))"
    }

    /// Mean over the visible window (the analysis the Trends screen was missing).
    var averageValue: String {
        guard !points.isEmpty else { return "--" }
        let mean = points.map(\.value).reduce(0, +) / Double(points.count)
        return formatValue(mean)
    }

    /// First → last change across the visible window, as a signed percentage.
    /// nil when there aren't enough points (or the baseline is zero).
    var trendDeltaPct: Int? {
        guard let first = points.first?.value,
              let last = points.last?.value,
              points.count > 1, first != 0 else { return nil }
        return Int((((last - first) / first) * 100).rounded())
    }

    // MARK: - Computed stats (Last 7 days summary)

    var sleepValueText: String { TrendsSummary.sleepAverageText(sleepWindow.values) ?? "--" }
    var sleepFootnote: TrendsSummary.Footnote { TrendsSummary.sleepFootnote(sleepWindow.values, goalHours: Double(sleepGoalMinutes) / 60.0) }

    var hrvValueText: String {
        TrendsSummary.latestAvailable(hrvWindow.values).map { "\(Int($0.rounded()))" } ?? "--"
    }
    var hrvNote: String { TrendsSummary.vitalsNote(hrvWindow.values) }
    var hrvFootnote: TrendsSummary.Footnote { TrendsSummary.lineFootnote(hrvWindow.values) }

    var rhrValueText: String {
        TrendsSummary.latestAvailable(rhrWindow.values).map { "\(Int($0.rounded()))" } ?? "--"
    }
    var rhrNote: String { TrendsSummary.vitalsNote(rhrWindow.values) }
    var rhrFootnote: TrendsSummary.Footnote { TrendsSummary.lineFootnote(rhrWindow.values) }

    // MARK: - Load (explorer — unchanged apart from the .rhr case flowing through)

    func load() async {
        loadGeneration += 1
        let generation = loadGeneration

        // Capture the tapped metric/range before the `await` below — if the
        // user taps again before this call returns, `selectedMetric`/
        // `selectedDays` will have already moved on, and the response must
        // still be labeled with what was actually requested here.
        let requestedMetric = selectedMetric
        let requestedDays = selectedDays

        withAnimation(Theme.Motion.appear) { isLoading = true }
        errorMessage = nil
        do {
            let response = try await apiClient.fetchTrends(
                metric: requestedMetric.rawValue,
                days: requestedDays
            )
            guard generation == loadGeneration else { return } // superseded by a newer tap
            let points = response.points.compactMap { pt -> ChartPoint? in
                guard let date = Self.dateFormatter.date(from: pt.date) else { return nil }
                return ChartPoint(date: date, value: pt.value)
            }
            let newSeries = LoadedSeries(metric: requestedMetric, days: requestedDays, points: points)
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { loaded = newSeries }
        } catch {
            guard generation == loadGeneration else { return } // superseded by a newer tap
            errorMessage = error.localizedDescription
            loaded = nil
        }
        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    // MARK: - Load (Last 7 days summary)

    func loadSummary() async {
        isLoadingSummary = true
        summaryErrorMessage = nil

        // The sleep goal only drives label copy ("goal 7.5h"), so it rides
        // alongside the trend requests but is deliberately fail-soft — a
        // profile error must never blank all three charts. Falls back to the
        // 480min/8h default.
        async let profileResp = try? await profileClient.fetchProfile()

        do {
            async let sleepResp = apiClient.fetchTrends(metric: "sleep", days: 7)
            async let hrvResp   = apiClient.fetchTrends(metric: "hrv", days: 7)
            async let rhrResp   = apiClient.fetchTrends(metric: "rhr", days: 7)
            let (sleep, hrv, rhr) = try await (sleepResp, hrvResp, rhrResp)

            let today = Date()
            sleepWindow = TrendsSummary.weekWindow(from: sleep.points, today: today)
            hrvWindow   = TrendsSummary.weekWindow(from: hrv.points, today: today)
            rhrWindow   = TrendsSummary.weekWindow(from: rhr.points, today: today)
            calibration = sleep.calibration ?? hrv.calibration ?? rhr.calibration
        } catch {
            summaryErrorMessage = error.localizedDescription
        }

        let profile = await profileResp
        sleepGoalMinutes = profile?.sleepGoalMinutes ?? 480
        UnitPreference.shared.applyServerValue(profile?.unitSystem)
        isLoadingSummary = false
    }

    // MARK: - Helpers

    private func formatValue(_ v: Double) -> String {
        // Format against the metric `points` actually belongs to (not
        // necessarily `selectedMetric`, which may have already moved on to
        // the user's next tap while this load is still in flight) — the view
        // additionally gates display of these strings on `loaded` matching
        // the current selection, but this keeps the value's own formatting
        // honest about which metric it is.
        switch loaded?.metric ?? selectedMetric {
        case .hrv, .steps, .rhr:
            return "\(Int(v.rounded()))"
        case .sleep, .weight, .vo2, .distance:
            return String(format: "%.1f", v)
        }
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
