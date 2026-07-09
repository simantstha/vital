import Foundation
import SwiftUI

// MARK: - Metric option

enum TrendMetric: String, CaseIterable, Identifiable {
    case hrv    = "hrv"
    case sleep  = "sleep"
    case weight = "weight"
    case steps  = "steps"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .hrv:    return "HRV"
        case .sleep:  return "Sleep"
        case .weight: return "Weight"
        case .steps:  return "Steps"
        }
    }

    var unit: String {
        switch self {
        case .hrv:    return "ms"
        case .sleep:  return "h"
        case .weight: return "kg"
        case .steps:  return "steps"
        }
    }
}

// MARK: - Chart data point

struct ChartPoint: Identifiable {
    let id = UUID()
    let date: Date
    let value: Double
}

// MARK: - ViewModel

@MainActor
final class TrendsViewModel: ObservableObject {

    @Published var selectedMetric: TrendMetric = .hrv
    @Published var selectedDays: Int = 14
    @Published var points: [ChartPoint] = []
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    private let apiClient = APIClient.shared

    // MARK: - Computed stats

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

    // MARK: - Load

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

    // MARK: - Helpers

    private func formatValue(_ v: Double) -> String {
        switch selectedMetric {
        case .hrv, .steps:
            return "\(Int(v.rounded()))"
        case .sleep:
            return String(format: "%.1f", v)
        case .weight:
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
