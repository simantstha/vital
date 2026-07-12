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

    var unit: String {
        switch self {
        case .hrv:      return "ms"
        case .sleep:    return "h"
        case .weight:   return "kg"
        case .steps:    return "steps"
        case .vo2:      return "ml/kg·min"
        case .distance: return "km"
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

    static let sleepGoalHours: Double = 8.0
    /// 360min = 75% of the 480min/8h goal.
    static let sleepShortThresholdHours: Double = 6.0

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
        shortThresholdHours: Double = sleepShortThresholdHours
    ) -> Footnote {
        let available = values.compactMap { $0 }
        guard !available.isEmpty else { return .plain("No sleep synced yet.") }
        let shortCount = available.filter { $0 < shortThresholdHours }.count
        guard shortCount > 0 else { return .plain("Every night near your 8h goal this week.") }
        return Footnote(
            prefix: "Under 6h on ",
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
    @Published var points: [ChartPoint] = []
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    // MARK: Summary state (Last 7 days)

    @Published var sleepWindow: TrendsSummary.WeekWindow = .empty
    @Published var hrvWindow: TrendsSummary.WeekWindow = .empty
    @Published var rhrWindow: TrendsSummary.WeekWindow = .empty
    @Published var calibration: CalibrationStatus? = nil
    @Published var isLoadingSummary = false
    @Published var summaryErrorMessage: String? = nil

    private let apiClient = APIClient.shared

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
    var sleepFootnote: TrendsSummary.Footnote { TrendsSummary.sleepFootnote(sleepWindow.values) }

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
        isLoading = true
        errorMessage = nil
        do {
            let response = try await apiClient.fetchTrends(
                metric: selectedMetric.rawValue,
                days: selectedDays
            )
            points = response.points.compactMap { pt in
                guard let date = Self.dateFormatter.date(from: pt.date) else { return nil }
                return ChartPoint(date: date, value: pt.value)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Load (Last 7 days summary)

    func loadSummary() async {
        isLoadingSummary = true
        summaryErrorMessage = nil
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
        isLoadingSummary = false
    }

    // MARK: - Helpers

    private func formatValue(_ v: Double) -> String {
        switch selectedMetric {
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
