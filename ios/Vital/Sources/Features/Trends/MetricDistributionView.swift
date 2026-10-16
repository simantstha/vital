import SwiftUI
import Charts

// MARK: - Pure histogram/percentile math

/// Pure distribution statistics for the detail view's histogram — no I/O, no
/// SwiftUI, so the bucket math and percentile rank are independently
/// testable. Always computed from the **raw** (non-downsampled) points in
/// the fixed 90-day distribution window (`MetricDetailViewModel.distributionSeries`
/// — deliberately NOT whatever range is currently selected), per the plan's
/// "band, stats, and distribution always compute from raw points" rule.
enum DistributionStats {
    struct Bucket: Equatable {
        let range: ClosedRange<Double>
        let count: Int
    }

    struct Result: Equatable {
        let buckets: [Bucket]
        let median: Double
        /// Index into `buckets` containing `latest` — `nil` only when
        /// `values` is empty (guarded before this type is constructed).
        let latestBucketIndex: Int
        /// Percentage of values at or below `latest`, 0–100.
        let percentileRank: Int
    }

    /// `bucketCount` mirrors the mockup's ~10-bar histogram. Returns `nil`
    /// for an empty `values` — callers gate on actual sample count before
    /// reaching here, so this is a defensive nil, not an expected path.
    static func compute(values: [Double], latest: Double, bucketCount: Int = 10) -> Result? {
        guard !values.isEmpty, bucketCount > 0 else { return nil }
        let sorted = values.sorted()
        let minValue = sorted.first!
        let maxValue = sorted.last!

        let median: Double
        let mid = sorted.count / 2
        if sorted.count % 2 == 0 {
            median = (sorted[mid - 1] + sorted[mid]) / 2
        } else {
            median = sorted[mid]
        }

        let countAtOrBelowLatest = sorted.filter { $0 <= latest }.count
        let percentileRank = Int((Double(countAtOrBelowLatest) / Double(sorted.count) * 100).rounded())

        // Degenerate spread (every value identical, e.g. a single day of
        // data or a smart scale's flat reading): one bucket holding
        // everything rather than dividing by a zero-width range.
        guard maxValue > minValue else {
            let bucket = Bucket(range: minValue...maxValue, count: sorted.count)
            return Result(buckets: [bucket], median: median, latestBucketIndex: 0, percentileRank: percentileRank)
        }

        let width = (maxValue - minValue) / Double(bucketCount)
        var counts = [Int](repeating: 0, count: bucketCount)
        for value in sorted {
            let idx = min(max(Int((value - minValue) / width), 0), bucketCount - 1)
            counts[idx] += 1
        }
        let buckets = (0..<bucketCount).map { i in
            Bucket(range: (minValue + Double(i) * width)...(minValue + Double(i + 1) * width), count: counts[i])
        }
        let latestIndex = min(max(Int((latest - minValue) / width), 0), bucketCount - 1)

        return Result(buckets: buckets, median: median, latestBucketIndex: latestIndex, percentileRank: percentileRank)
    }

    /// X-axis domain for the histogram: the data's min/max padded by 8% of
    /// the spread each side, so bars fill the plot width instead of Swift
    /// Charts auto-including zero (which squeezes every bar into the right
    /// edge for metrics like HRV at 40-60 ms). A zero-spread series gets a
    /// +/-1 unit window so the domain is never empty.
    static func xDomain(values: [Double], latest: Double) -> ClosedRange<Double> {
        let all = values + [latest]
        guard let lo = all.min(), let hi = all.max() else { return 0...1 }
        let spread = hi - lo
        guard spread > 0 else { return (lo - 1)...(hi + 1) }
        let pad = spread * 0.08
        return (lo - pad)...(hi + pad)
    }

    /// Days actually covered by the distribution window: first..last inclusive,
    /// capped at the fixed 90-day fetch. Used to label records/insight lines
    /// ("highest in the last 30 days") so they never claim a longer window
    /// than the data spans.
    static func windowDays(firstDate: Date, lastDate: Date, calendar: Calendar = .current) -> Int {
        let span = calendar.dateComponents([.day], from: calendar.startOfDay(for: firstDate), to: calendar.startOfDay(for: lastDate)).day ?? 0
        return min(max(span + 1, 1), 90)
    }

    /// True if `latest` is the maximum value in `values`.
    static func isMaximum(_ latest: Double, in values: [Double]) -> Bool {
        guard let maxValue = values.max() else { return false }
        return latest >= maxValue
    }

    /// True if `latest` is the minimum value in `values`.
    static func isMinimum(_ latest: Double, in values: [Double]) -> Bool {
        guard let minValue = values.min() else { return false }
        return latest <= minValue
    }

    /// "Your latest reading — 52 ms — is higher than 62% of your 90
    /// readings in the last 90 days." Moved out of `MetricDistributionView`
    /// (which now just calls this) so the sentence composition is
    /// independently testable without SwiftUI. When `latest` is the max or
    /// min, states that directly rather than a trivial percentile rank.
    static func caption(result: Result, latest: Double, values: [Double], spec: MetricSpec, unitSystem: UnitSystem) -> String {
        let sampleCount = values.count
        let formattedValue = spec.format(latest, unitSystem)

        if isMaximum(latest, in: values) {
            return "Your latest reading — \(formattedValue) — is the highest of your \(sampleCount) readings in the last 90 days."
        } else if isMinimum(latest, in: values) {
            return "Your latest reading — \(formattedValue) — is the lowest of your \(sampleCount) readings in the last 90 days."
        } else {
            return "Your latest reading — \(formattedValue) — is higher than \(result.percentileRank)% of your \(sampleCount) readings in the last 90 days."
        }
    }

    /// "Today is higher than 84% of your last 90 days" / "lower than" below
    /// the median — the detail view's required percentile sentence,
    /// distinct from `caption`'s "your latest reading — X —" phrasing (kept
    /// as-is for its own call sites/tests). Uses "lower than" whenever
    /// `latest` sits at or below the median, `"higher than"` otherwise, so
    /// the wording always agrees with which side of the distribution
    /// `latest` actually falls on. When `latest` is the window's max or min,
    /// a percentile against itself reads as a non-statement ("higher than
    /// 100% of your last 90 days") — say "highest"/"lowest" directly instead.
    ///
    /// `windowDays` is the real span of days the values cover (see
    /// `windowDays(firstDate:lastDate:)`) so this line and the records
    /// header always name the same window; defaults to the value count.
    static func todaySentence(result: Result, latest: Double, values: [Double], windowDays: Int? = nil) -> String {
        let sampleCount = windowDays ?? values.count
        if isMaximum(latest, in: values) {
            return "Today is your highest in the last \(sampleCount) days."
        } else if isMinimum(latest, in: values) {
            return "Today is your lowest in the last \(sampleCount) days."
        } else if latest <= result.median {
            let rank = 100 - result.percentileRank
            return "Today is lower than \(rank)% of your last \(sampleCount) days."
        } else {
            return "Today is higher than \(result.percentileRank)% of your last \(sampleCount) days."
        }
    }

    /// The distribution card's single combined VoiceOver label — leads with
    /// the median (the one stat the visual chart's median rule-mark conveys
    /// that `caption` alone doesn't), then the same caption sentence sighted
    /// users see.
    static func accessibilityLabel(result: Result, latest: Double, values: [Double], spec: MetricSpec, unitSystem: UnitSystem) -> String {
        let medianText = spec.format(result.median, unitSystem)
        return "Distribution chart. Median \(medianText). " + caption(result: result, latest: latest, values: values, spec: spec, unitSystem: unitSystem)
    }
}

// MARK: - View

/// Histogram over the fixed 90-day window's raw readings, with the median
/// marked and a percentile caption for the latest reading. Gated by the
/// caller on `dataDays >= 30` — below that, this section is omitted entirely
/// (no placeholder), per the plan.
struct MetricDistributionView: View {
    let values: [Double]
    let latest: Double
    let spec: MetricSpec
    let unitSystem: UnitSystem
    /// Days the values span (see `DistributionStats.windowDays`); `nil` falls back to the value count.
    var windowDays: Int? = nil

    private var result: DistributionStats.Result? {
        DistributionStats.compute(values: values, latest: latest)
    }

    var body: some View {
        if let result {
            GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Chart {
                        ForEach(Array(result.buckets.enumerated()), id: \.offset) { index, bucket in
                            BarMark(
                                xStart: .value("Lower", bucket.range.lowerBound),
                                xEnd: .value("Upper", bucket.range.upperBound),
                                y: .value("Count", bucket.count)
                            )
                            .foregroundStyle(index == result.latestBucketIndex ? Theme.Colors.accentContent : Theme.Colors.textSecondary.opacity(0.4))
                            .cornerRadius(2)
                        }
                        RuleMark(x: .value("Median", result.median))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .foregroundStyle(Theme.Colors.textSecondary.opacity(0.7))
                    }
                    .chartXScale(domain: DistributionStats.xDomain(values: values, latest: latest))
                    .chartXAxis(.hidden)
                    .chartYAxis(.hidden)
                    .frame(height: 84)

                    Text(DistributionStats.todaySentence(result: result, latest: latest, values: values, windowDays: windowDays))
                        .scaledFont(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            // Single combined VoiceOver stop for the whole card — otherwise
            // the histogram's bars and the caption `Text` read as separate
            // nodes, and the bars alone (unlabeled `BarMark`s) are noise.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(DistributionStats.accessibilityLabel(result: result, latest: latest, values: values, spec: spec, unitSystem: unitSystem))
        }
    }

}
