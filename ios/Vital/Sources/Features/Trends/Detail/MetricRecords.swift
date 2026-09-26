import Foundation

/// Pure "Your records" math for the detail view's 90-day records card:
/// highest/lowest readings (with date) and a one-line streak. Always
/// computed from the raw 90-day distribution window
/// (`MetricDetailViewModel.distributionSeries`), never whatever range is
/// currently selected — same rule as `DistributionStats`. No SwiftUI/I-O, so
/// independently unit-testable.
enum MetricRecords {
    struct Record: Equatable {
        let value: Double
        let date: Date
    }

    struct Result: Equatable {
        let highest: Record
        let lowest: Record
        /// "Climbing N days in a row" / "In normal N days" / nil when
        /// neither streak qualifies (e.g. no usable baseline and the series
        /// isn't currently rising).
        let streakText: String?
    }

    /// - Parameters:
    ///   - points: the raw 90-day window, any order — sorted internally.
    ///   - mean30/sd30: this metric's baseline, for the "in normal" streak.
    ///     `nil` skips that streak variant (never fabricated against a
    ///     missing/degenerate baseline).
    static func compute(points: [ChartPoint], mean30: Double?, sd30: Double?) -> Result? {
        guard !points.isEmpty else { return nil }
        let sorted = points.sorted { $0.date < $1.date }
        guard let highestPoint = sorted.max(by: { $0.value < $1.value }),
              let lowestPoint = sorted.min(by: { $0.value < $1.value }) else { return nil }

        let highest = Record(value: highestPoint.value, date: highestPoint.date)
        let lowest = Record(value: lowestPoint.value, date: lowestPoint.date)
        let streakText = streak(sorted, mean30: mean30, sd30: sd30)
        return Result(highest: highest, lowest: lowest, streakText: streakText)
    }

    /// Prefers a climbing streak (rising 3-day trailing mean, N≥3 days) over
    /// an "in normal" streak — a climbing trend is the more notable of the
    /// two when both happen to be true. Falls back to "in normal" when the
    /// series isn't currently climbing but a usable baseline exists. `nil`
    /// when neither qualifies.
    private static func streak(_ sorted: [ChartPoint], mean30: Double?, sd30: Double?) -> String? {
        if let climbing = climbingStreak(sorted) {
            return "Climbing \(climbing) days in a row"
        }
        if let normal = inNormalStreak(sorted, mean30: mean30, sd30: sd30) {
            return "In normal \(normal) days"
        }
        return nil
    }

    private static func trailingMean3(_ points: [ChartPoint], at index: Int) -> Double? {
        guard index >= 2 else { return nil }
        let window = points[(index - 2)...index]
        return window.reduce(0) { $0 + $1.value } / 3
    }

    private static func climbingStreak(_ points: [ChartPoint]) -> Int? {
        guard points.count >= 5 else { return nil }
        var streak = 0
        var i = points.count - 1
        while i > 0, let current = trailingMean3(points, at: i), let previous = trailingMean3(points, at: i - 1), current > previous {
            streak += 1
            i -= 1
        }
        return streak >= 3 ? streak : nil
    }

    private static func inNormalStreak(_ points: [ChartPoint], mean30: Double?, sd30: Double?) -> Int? {
        guard let mean30, let sd30, mean30.isFinite, sd30.isFinite, sd30 > 0 else { return nil }
        let lower = mean30 - sd30
        let upper = mean30 + sd30
        var streak = 0
        for point in points.reversed() {
            guard point.value >= lower, point.value <= upper else { break }
            streak += 1
        }
        return streak >= 3 ? streak : nil
    }
}
