import Foundation
import SwiftUI

/// Fixed range choices for the detail view's range pills.
enum TrendsDetailRange: Int, CaseIterable, Identifiable {
    case fourteenDays = 14
    case thirtyDays = 30
    case threeMonths = 90
    case oneYear = 365

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .fourteenDays: return "14d"
        case .thirtyDays:   return "30d"
        case .threeMonths:  return "3M"
        case .oneYear:      return "1Y"
        }
    }

    /// Full-word range description for VoiceOver — `label` is a compact
    /// pill caption ("30d", "3M"), too terse to read aloud unambiguously.
    var accessibilityLabel: String {
        switch self {
        case .fourteenDays: return "14 days"
        case .thirtyDays:   return "30 days"
        case .threeMonths:  return "3 months"
        case .oneYear:      return "1 year"
        }
    }
}

/// Loads one metric's series at a selected range for `MetricDetailView`.
/// Goes through `fetchTrendsBatch` with a single-key `metrics` array —
/// deliberately reusing the batch decoder rather than `fetchTrends` (the
/// legacy single-metric path used only by `ProfileViewModel`), because the
/// batch response is the only one carrying `baseline` (mean30/sd30/
/// percentiles), which the band, verdict, and stats row all depend on. See
/// the plan's "one decoder, and it's the only path that carries the
/// baseline" rule.
@MainActor
final class MetricDetailViewModel: ObservableObject {
    let metricKey: String

    @Published private(set) var series: MetricSeries? = nil
    @Published var range: TrendsDetailRange = .thirtyDays
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    /// The distribution section's own fixed 90-day raw window — deliberately
    /// decoupled from `range`/`series`. The range pills go from 14 days to a
    /// year; reusing whichever window happens to be selected would silently
    /// disagree with `showDistribution`'s `dataDays >= 30` gate (a passing
    /// gate backed by, say, a 15-sample histogram) and with the section's own
    /// "of your last 90 days" caption. Fetched once per view, independent of
    /// range-pill taps.
    @Published private(set) var distributionSeries: MetricSeries? = nil
    private var distributionLoadStarted = false

    /// The date the user is currently scrubbing, if any — `nil` when not
    /// touching the chart. Lives here rather than local `@State` in the view
    /// so a range-pill switch or a fresh load can clear stale scrub state in
    /// one place.
    @Published var scrubbedDate: Date? = nil

    var spec: MetricSpec? { MetricCatalog.spec(for: metricKey) }

    private let apiClient: TrendsAPIProviding

    /// Bumped at the top of every `load()` call; a response is only applied
    /// if its generation is still the newest one in flight. Guards against a
    /// slow response (e.g. a 1Y range fetch) landing after a faster later one
    /// (e.g. the user already flipped back to 30d) and overwriting it with
    /// stale data — the same hazard `TrendsViewModel.load()` guards against.
    private var loadGeneration = 0

    init(metricKey: String, apiClient: TrendsAPIProviding = APIClient.shared) {
        self.metricKey = metricKey
        self.apiClient = apiClient
    }

    /// Haptics never fire from this path — not on the initial load, a range
    /// change's fetch, or a failure. Only the range-pill tap that *triggers*
    /// this call and a scrub snap are user-committed actions allowed to buzz
    /// (see `Theme.Haptics`'s doc comment and `TrendsViewModel.load()`'s
    /// identical note); data arriving in the background is state the user
    /// merely observes.
    func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        do {
            let response = try await apiClient.fetchTrendsBatch(metrics: [metricKey], days: range.rawValue)
            guard generation == loadGeneration else { return } // superseded by a newer load
            if let dto = response.series[metricKey], let spec {
                let system = UnitPreference.shared.current
                series = TrendsViewModel.makeSeries(from: dto, spec: spec, system: system)
            } else {
                series = nil
            }
        } catch {
            guard generation == loadGeneration else { return } // superseded by a newer load
            errorMessage = error.localizedDescription
        }
        isLoading = false

        // Fired once, in the background, independent of `range` — not
        // gated on this `load()` call succeeding, so a range-pill tap that
        // races the initial load still leaves the distribution fetch alone.
        if !distributionLoadStarted {
            distributionLoadStarted = true
            Task { await loadDistributionWindow() }
        }
    }

    /// Range-pill tap. Clears any in-progress scrub — the old scrub position
    /// belongs to the old window and has no meaning against the new one.
    /// Deliberately does NOT touch `distributionSeries` — its 90-day window
    /// is fixed regardless of which range is selected.
    func selectRange(_ newRange: TrendsDetailRange) {
        guard newRange != range else { return }
        range = newRange
        scrubbedDate = nil
        Task { await load() }
    }

    /// Always a 90-day fetch, never `range.rawValue` — see
    /// `distributionSeries`'s doc comment. A failure here is silent: the
    /// distribution section simply stays omitted (`showDistribution` gates
    /// on `distributionSeries` being non-empty), the same "no placeholder"
    /// treatment the section already gets below 30 days of history. It
    /// shouldn't surface in `errorMessage`, which is reserved for the
    /// primary series this whole view depends on.
    private func loadDistributionWindow() async {
        guard let spec else { return }
        do {
            let response = try await apiClient.fetchTrendsBatch(metrics: [metricKey], days: 90)
            guard let dto = response.series[metricKey] else { return }
            distributionSeries = TrendsViewModel.makeSeries(from: dto, spec: spec, system: UnitPreference.shared.current)
        } catch {
            // Supplementary section — swallow and stay omitted.
        }
    }
}

// MARK: - Pure helpers (testable without I/O)

extension MetricDetailViewModel {
    /// `.chartXSelection(value:)` yields a continuous plot-space `Date`, not
    /// a data point. This snaps that raw selection to the nearest actual
    /// `ChartPoint` — without it the scrub lollipop floats between days
    /// instead of landing on a reading. `nonisolated` (rather than inheriting
    /// the class's `@MainActor`) because it's pure — no state, no I/O — and
    /// tests call it synchronously off the main actor.
    nonisolated static func nearestPoint(to date: Date, in points: [ChartPoint]) -> ChartPoint? {
        points.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
    }

    /// True when `TrendsDownsample.weekly` actually collapsed `raw` into
    /// fewer marks for the chart. Drives the "weekly average" subtitle —
    /// rendering weekly means in the same visual language as daily readings
    /// would claim a precision the data doesn't have. `nonisolated` for the
    /// same reason as `nearestPoint(to:in:)` above.
    nonisolated static func isDownsampled(_ raw: [ChartPoint], calendar: Calendar = .current) -> Bool {
        TrendsDownsample.weekly(raw, calendar: calendar).count != raw.count
    }

    /// The chart's explicit `.chartYScale(domain:)`. Without this, Swift
    /// Charts auto-scales and `AreaMark` drags the domain floor to 0 — for a
    /// metric like HRV whose real variation lives in a narrow band (43–52
    /// ms), that crushes all of it into the top ~15% of the plot and turns
    /// the ±1σ band into a thin strip indistinguishable from the area's own
    /// gradient. The band is the entire point of this chart, so the domain
    /// is instead tightened to the tightest range that contains BOTH the
    /// raw data extremes and the band (when one is drawn).
    ///
    /// - `rawValues` MUST be the raw (non-downsampled) points — a
    ///   downsampled series can clip a raw extreme the domain still needs to
    ///   contain.
    /// - `bandLower`/`bandUpper` are `nil` exactly when the band itself is
    ///   gated off (`.calibrating`/`.noData`), in which case the domain
    ///   tightens to the data alone rather than falling back to a 0 floor.
    /// - `floor` is a small, metric-appropriate absolute pad (in the same
    ///   display units as `rawValues`) that guards the degenerate case where
    ///   the computed span is zero — a flat series, a single point, or (with
    ///   no band) `upper == lower` outright. A *percentage* pad of a zero
    ///   span is still zero, so without this floor the domain would collapse
    ///   to a single value and the chart would render nothing.
    nonisolated static func chartYDomain(
        rawValues: [Double],
        bandLower: Double?,
        bandUpper: Double?,
        floor: Double
    ) -> ClosedRange<Double> {
        guard let rawMin = rawValues.min(), let rawMax = rawValues.max() else {
            let pad = max(floor, 0.001)
            return -pad...pad
        }
        var lower = rawMin
        var upper = rawMax
        if let bandLower { lower = min(lower, bandLower) }
        if let bandUpper { upper = max(upper, bandUpper) }

        let span = upper - lower
        guard span > 0 else {
            let pad = max(floor, 0.001)
            return (lower - pad)...(upper + pad)
        }
        let pad = max(span * 0.12, floor)
        return (lower - pad)...(upper + pad)
    }
}
