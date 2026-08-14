import Foundation

// MARK: - Chart data point

/// One point in a metric's time series. `id` is derived from `date` rather
/// than a fresh `UUID()` per construction — the previous `let id = UUID()`
/// regenerated on every rebuild of the array, so Swift Charts treated every
/// render as 100% new marks and diffed nothing. Dates are unique within a
/// single metric's series (one point per day), so this is a safe identity.
struct ChartPoint: Identifiable {
    var id: Date { date }
    let date: Date
    let value: Double
}

// MARK: - Metric series

/// One metric's fully-loaded series for the Trends grid/detail: the points
/// in the requested window plus the baseline stats needed to gate a verdict
/// (`TrendsVerdict`), bundled so the two can never drift apart in a view.
///
/// Both `points[].value` and every field of `baseline` are expected to
/// already be in the user's display unit system by the time a `MetricSeries`
/// is constructed — conversion happens exactly once, at decode
/// (`MetricSpec.displayScale(_:)`), never in a computed property read
/// multiple times per render. See the Trends revamp plan's "Where each unit
/// conversion happens — exactly once".
struct MetricSeries: Equatable {
    /// Raw `daily_metrics.metric` name — the same vocabulary as
    /// `MetricCatalog`, `baselines.metric`, and the batch response's
    /// `series` keys. Never a legacy alias like `hrv`.
    let key: String
    let points: [ChartPoint]
    let baseline: TrendsBaselineDTO?
    /// Fresh count of distinct days with data in the last 90 days — mirrors
    /// the server's `dataDays`, recomputed rather than trusting a stale
    /// snapshot (see `TrendsBaselineDTO`'s doc comment).
    let dataDays: Int
    let established: Bool
    /// Most recent date this metric has ever synced, independent of whether
    /// that date falls inside the requested window — drives the "dimmed"
    /// tile's "Last synced …" copy for a metric with history but no recent
    /// points.
    let lastDate: Date?

    static func == (lhs: MetricSeries, rhs: MetricSeries) -> Bool {
        lhs.key == rhs.key
            && lhs.dataDays == rhs.dataDays
            && lhs.established == rhs.established
            && lhs.lastDate == rhs.lastDate
            && lhs.baseline == rhs.baseline
            && lhs.points.map(\.date) == rhs.points.map(\.date)
            && lhs.points.map(\.value) == rhs.points.map(\.value)
    }
}
