import Foundation

/// The Trends grid index's period switch — 7 / 30 / 90 days. Drives
/// `TrendsViewModel.load()`'s `fetchTrendsBatch(days:)` request; the backend
/// already clamps the requested value to 1...365, so every case here is
/// already a safe literal. Default is `.thirtyDays` (unchanged from the
/// previous fixed 30-day window).
enum TrendsPeriod: Int, CaseIterable, Identifiable, Equatable {
    case sevenDays = 7
    case thirtyDays = 30
    case ninetyDays = 90

    var id: Int { rawValue }
    var days: Int { rawValue }

    /// Segmented-control label.
    var label: String {
        switch self {
        case .sevenDays:   return "7D"
        case .thirtyDays:  return "30D"
        case .ninetyDays:  return "90D"
        }
    }

    /// The period phrase `TrendsHeadline` appends to its "N things moved"
    /// sentence — deliberately simple prose rather than "in the last 7
    /// days" for every case, matching the mock's copy.
    var headlineWord: String {
        switch self {
        case .sevenDays:   return "this week"
        case .thirtyDays:  return "this month"
        case .ninetyDays:  return "in the last 3 months"
        }
    }
}
