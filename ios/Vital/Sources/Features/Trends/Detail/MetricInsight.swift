import Foundation

/// One on-device, pure "most notable true statement" about a metric's loaded
/// series — rendered as the single insight line under `MetricDetailView`'s
/// hero. Never invents: every branch requires the data it cites to actually
/// be present, and `compute` returns `nil` (hiding the line entirely) when
/// nothing qualifies. No SwiftUI/Foundation-date-formatting-locale surprises
/// beyond `DateFormatter`, so this is independently unit-testable.
enum MetricInsight {
    /// Evaluated in this priority order — the first statement that qualifies
    /// wins, since only one line is shown:
    /// 1. Climbing for N days (N≥5 consecutive rises of the 3-day trailing mean)
    /// 2. Highest 7-day average since <Month> (a new high vs. every earlier
    ///    7-day window in the loaded series)
    /// 3. Lowest since <date> (today's raw value is below every earlier point)
    /// 4. Steady — within your normal for N days (requires a usable baseline)
    static func compute(
        points: [ChartPoint],
        mean30: Double?,
        sd30: Double?
    ) -> String? {
        let sorted = points.sorted { $0.date < $1.date }
        guard sorted.count >= 4 else { return nil }

        if let climbing = climbingStreak(sorted) { return climbing }
        if let highest = highest7DayAverage(sorted) { return highest }
        if let lowest = lowestSinceEver(sorted) { return lowest }
        if let steady = steadyStreak(sorted, mean30: mean30, sd30: sd30) { return steady }
        return nil
    }

    // MARK: - Climbing

    /// The 3-day trailing mean at index `i` (nil until there are 3 points
    /// behind it, inclusive).
    private static func trailingMean3(_ points: [ChartPoint], at index: Int) -> Double? {
        guard index >= 2 else { return nil }
        let window = points[(index - 2)...index]
        return window.reduce(0) { $0 + $1.value } / 3
    }

    /// Walks backward from the last point counting a run of strict
    /// increases in the 3-day trailing mean. A "day" of climbing means that
    /// day's 3-day mean is greater than the previous day's — the run length
    /// is the number of qualifying transitions, so N≥5 needs at least 6
    /// points with valid trailing means.
    private static func climbingStreak(_ points: [ChartPoint]) -> String? {
        guard points.count >= 7 else { return nil }
        var means: [Double?] = (0..<points.count).map { trailingMean3(points, at: $0) }
        var streak = 0
        var i = means.count - 1
        while i > 0, let current = means[i], let previous = means[i - 1], current > previous {
            streak += 1
            i -= 1
        }
        guard streak >= 5 else { return nil }
        return "Climbing for \(streak) days"
    }

    // MARK: - Highest 7-day average

    private static func trailing7DayAverages(_ points: [ChartPoint]) -> [(date: Date, avg: Double)] {
        guard points.count >= 7 else { return [] }
        var result: [(Date, Double)] = []
        for i in 6..<points.count {
            let window = points[(i - 6)...i]
            let avg = window.reduce(0) { $0 + $1.value } / 7
            result.append((points[i].date, avg))
        }
        return result
    }

    /// True new high: the latest 7-day average strictly exceeds every
    /// earlier 7-day average in the loaded series. Cites the month the
    /// previous-best window ended, so the claim is always traceable to real
    /// data already on screen.
    private static func highest7DayAverage(_ points: [ChartPoint]) -> String? {
        let averages = trailing7DayAverages(points)
        guard averages.count >= 2 else { return nil }
        let latest = averages.last!
        let earlier = averages.dropLast()
        guard let previousBest = earlier.max(by: { $0.avg < $1.avg }) else { return nil }
        guard latest.avg > previousBest.avg else { return nil }
        return "Your highest 7-day average since \(monthFormatter.string(from: previousBest.date))"
    }

    // MARK: - Lowest since

    /// True new low for the latest raw reading vs. every earlier point in
    /// the loaded series. Cites the date of the previous low.
    private static func lowestSinceEver(_ points: [ChartPoint]) -> String? {
        guard let latest = points.last else { return nil }
        let earlier = points.dropLast()
        guard let previousLow = earlier.min(by: { $0.value < $1.value }) else { return nil }
        guard latest.value < previousLow.value else { return nil }
        return "Lowest since \(dayFormatter.string(from: previousLow.date))"
    }

    // MARK: - Steady

    /// N most-recent consecutive days whose raw value falls within
    /// `mean30 ± sd30`. Requires a finite, positive `sd30` — otherwise there
    /// is no "normal" to be steady within, so this is silently skipped
    /// (never fabricated from a degenerate/missing baseline).
    private static func steadyStreak(_ points: [ChartPoint], mean30: Double?, sd30: Double?) -> String? {
        guard let mean30, let sd30, mean30.isFinite, sd30.isFinite, sd30 > 0 else { return nil }
        let lower = mean30 - sd30
        let upper = mean30 + sd30
        var streak = 0
        for point in points.reversed() {
            guard point.value >= lower, point.value <= upper else { break }
            streak += 1
        }
        guard streak >= 5 else { return nil }
        return "Steady — within your normal for \(streak) days"
    }

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMMM"
        return f
    }()

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()
}
