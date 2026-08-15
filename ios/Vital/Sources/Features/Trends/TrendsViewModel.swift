import Foundation
import SwiftUI

// MARK: - ViewModel
//
// `TrendsSummary` (the pure "Last 7 days" helpers) lives in
// TrendsSummary.swift. `MetricCatalog`, `TrendsVerdict`, `MetricSeries`, and
// `TrendsIndexSections` are the pure layer this batch loader feeds into —
// this file's only job is I/O + unit conversion, never gating or judgment.

@MainActor
final class TrendsViewModel: ObservableObject {

    /// The grid index always requests 30 days, never 365 — the plan reserves
    /// longer ranges (and weekly downsampling) for the PR5 detail view's
    /// range pills.
    static let windowDays = 30

    // MARK: Grid index state (batch)

    /// One entry per metric the batch response returned, already converted
    /// to the user's display unit system at decode time — see `makeSeries`.
    /// Keyed by the raw `daily_metrics` metric name, the same vocabulary
    /// `MetricCatalog` / `TrendsIndexSections` use. A metric TrendsIndexSections
    /// should hide entirely (never synced) simply never gets a key here.
    @Published private(set) var loaded: [String: MetricSeries] = [:]
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    // MARK: Summary state (Last 7 days headline strip)

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

    // MARK: - Load (grid index — one batch call for every tile)

    /// Haptics never fire from this path — not on the initial load, a
    /// pull-to-refresh, or a failure. `Theme.Haptics` fires only on state the
    /// user COMMITTED (a tile tap, a range pill, a scrub snap in the PR5
    /// detail view); data arriving in the background is state the user
    /// merely OBSERVES, and a screen that buzzes on every refresh trains the
    /// user to ignore the haptic entirely. See `Theme.Haptics`'s doc comment.
    func load() async {
        loadGeneration += 1
        let generation = loadGeneration

        withAnimation(Theme.Motion.appear) { isLoading = true }
        errorMessage = nil
        do {
            let response = try await apiClient.fetchTrendsBatch(
                metrics: MetricCatalog.indexKeys,
                days: Self.windowDays
            )
            // Superseded by a newer `load()` — e.g. a pull-to-refresh that
            // lands after a slower in-flight call, the same hazard the
            // explorer's single-metric `load()` used to guard against.
            guard generation == loadGeneration else { return }

            let system = UnitPreference.shared.current
            var newLoaded: [String: MetricSeries] = [:]
            for (key, dto) in response.series {
                guard let spec = MetricCatalog.spec(for: key) else { continue }
                newLoaded[key] = Self.makeSeries(from: dto, spec: spec, system: system)
            }
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
                loaded = newLoaded
                calibration = response.calibration
            }
        } catch {
            guard generation == loadGeneration else { return } // superseded by a newer load
            errorMessage = error.localizedDescription
        }
        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    /// Converts one batch series DTO into a display-ready `MetricSeries`:
    /// `MetricSpec.displayScale(system)` applied exactly once, here, to
    /// **both** `points[].value` and every `baseline` field — never in a
    /// computed property recomputed on every render (see the plan's "Where
    /// each unit conversion happens — exactly once"). Both are pure scalar
    /// multiplies, so scaling `sd30` alongside the means/percentiles is
    /// exact. Internal (not `private`) so tests can exercise the conversion
    /// directly with an injected `system`, without mutating the
    /// `UnitPreference.shared` singleton.
    static func makeSeries(from dto: TrendsSeriesDTO, spec: MetricSpec, system: UnitSystem) -> MetricSeries {
        let scale = spec.displayScale(system)
        let points = dto.points.compactMap { pt -> ChartPoint? in
            guard let date = Self.dateFormatter.date(from: pt.date) else { return nil }
            return ChartPoint(date: date, value: pt.value * scale)
        }
        let baseline = dto.baseline.map { b in
            TrendsBaselineDTO(
                mean7: b.mean7.map { $0 * scale },
                mean30: b.mean30.map { $0 * scale },
                mean60: b.mean60.map { $0 * scale },
                sd30: b.sd30.map { $0 * scale },
                p25: b.p25.map { $0 * scale },
                p50: b.p50.map { $0 * scale },
                p75: b.p75.map { $0 * scale }
            )
        }
        let lastDate = dto.lastDate.flatMap { Self.dateFormatter.date(from: $0) }
        return MetricSeries(
            key: dto.metric,
            points: points,
            baseline: baseline,
            dataDays: dto.dataDays,
            established: dto.established,
            lastDate: lastDate
        )
    }

    // MARK: - Load (Last 7 days summary — unchanged from the explorer build)

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
        } catch {
            summaryErrorMessage = error.localizedDescription
        }

        let profile = await profileResp
        sleepGoalMinutes = profile?.sleepGoalMinutes ?? 480
        // Locale-default adoption PATCH: opportunistic housekeeping, not a
        // user-initiated action, so failure is silent and simply retries
        // next launch (see UnitPreference.applyServerValue).
        if UnitPreference.shared.applyServerValue(profile?.unitSystem) {
            try? await profileClient.updateProfile(unitSystem: UnitPreference.shared.current.rawValue)
        }
        isLoadingSummary = false
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

    // MARK: - Helpers

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
