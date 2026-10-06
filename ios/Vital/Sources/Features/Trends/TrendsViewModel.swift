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

    // MARK: Grid index state (batch)

    /// The header's 7D/30D/90D period switch — defaults to 30D (the
    /// previous fixed window). Changing it reloads only the grid (`load()`)
    /// — never the weekly summary strip or goal context, which are
    /// independent of this window. The backend already clamps the
    /// requested value to 1...365, so every `TrendsPeriod` case is a safe
    /// literal to send as-is.
    @Published var period: TrendsPeriod = .thirtyDays {
        didSet {
            guard oldValue != period else { return }
            Task { await load() }
        }
    }

    /// One entry per metric the batch response returned, already converted
    /// to the user's display unit system at decode time — see `makeSeries`.
    /// Keyed by the raw `daily_metrics` metric name, the same vocabulary
    /// `MetricCatalog` / `TrendsIndexSections` use. A metric TrendsIndexSections
    /// should hide entirely (never synced) simply never gets a key here.
    @Published private(set) var loaded: [String: MetricSeries] = [:]
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    /// Goal-ordered grid sections, cached here (recomputed only when
    /// `loaded` or `goal` actually changes) rather than as a computed
    /// property `TrendsView.body` re-derives on every render — see the
    /// plan's performance pass.
    @Published private(set) var sections: [TrendsSection] = []
    /// The "What moved" card's rows — at most `TrendsWhatMoved.maxRows`,
    /// sorted by |z| descending. Empty (and the section hidden) whenever no
    /// metric is `.above`/`.below` its normal.
    @Published private(set) var whatMovedRows: [WhatMovedRow] = []
    /// The header's status — learning / steady / moved (calm-layout revamp,
    /// replacing both the old static "Last 30 days · N metrics tracked"
    /// subtitle and the separate "Baselines are still calibrating" banner,
    /// which used to render at the same time as an "Everything's normal"
    /// headline and directly contradict it). Defaults to `.learning` at the
    /// full 14 days remaining — the same honest "nothing confirmed yet"
    /// starting point `TrendsHeadline.status` itself falls back to for an
    /// empty `verdicts` list.
    @Published private(set) var headlineStatus: TrendsHeadline.Status = .learning(TrendsHeadline.LearningProgress(daysRemaining: 14))

    /// Set once, after the FIRST successful `load()` this session — gates
    /// the grid's staggered entrance motion so it plays exactly once rather
    /// than replaying on every period switch or pull-to-refresh. Flipped a
    /// beat after `loaded` itself updates (see `load()`) so the very first
    /// render — the one `TrendsView`'s `.staggeredAppear` needs to see
    /// `false` — still gets the entrance.
    @Published private(set) var hasAnimatedIn = false

    // MARK: Summary state (Last 7 days headline strip)

    @Published var sleepWindow: TrendsSummary.WeekWindow = .empty
    @Published var hrvWindow: TrendsSummary.WeekWindow = .empty
    @Published var rhrWindow: TrendsSummary.WeekWindow = .empty
    @Published var calibration: CalibrationStatus? = nil
    @Published var sleepGoalMinutes: Int = 480 // 8h default
    @Published var isLoadingSummary = false
    @Published var summaryErrorMessage: String? = nil

    // MARK: Goal-ordered index (customer-panel finding, 2026-09-23 —
    // docs/ux-spec-v4.md §9's screenshot acceptance table)

    /// "weight_loss" | "muscle" | "endurance" | "general" — same
    /// `/api/diet-goal` value `TodayViewModel.goal` decodes, fetched
    /// separately here (Trends has no other reason to hit that endpoint)
    /// so `TrendsGoalOrdering` can lead with the metric that matters most
    /// for this goal. Defaults to "general" (unreordered) until it resolves.
    @Published private(set) var goal: String = "general"

    /// Only fetched for `goal == "weight_loss"` (every other goal has no use
    /// for it) — the SAME `/api/weight-log` payload Today's weight_loss hero
    /// uses, so `TrendsWeightCard` renders the identical smoothed trend
    /// rather than a second, possibly-disagreeing one. `nil` on a fail-soft
    /// failure (matches `loadSummary()`'s profile fetch) — the card simply
    /// doesn't render rather than fabricating a trend.
    @Published private(set) var weightLog: WeightLogResponse? = nil

    // MARK: Strength (workout_sets summary — "Strength" card)

    /// `nil` until `/api/workouts/summary` resolves, and left untouched (not
    /// zeroed) when a refresh fails — the card only ever renders real data.
    /// Kept raw (not the derived `TrendsStrengthLogic.Card`) so the view can
    /// re-derive it with the current unit system and clock each render.
    @Published private(set) var workoutSummary: WorkoutSummaryResponse? = nil

    // MARK: Goal progress ("Am I on track?" card)

    /// `nil` until `/api/goal/progress` resolves, and left untouched (never
    /// zeroed) when a refresh fails — `TrendsView` hides the card whenever
    /// this is `nil`.
    @Published private(set) var goalProgress: GoalProgressDTO? = nil

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
                days: period.days
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
            let isFirstLoad = !hasAnimatedIn
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
                loaded = newLoaded
                calibration = response.calibration
            }
            recomputeDerived()
            if isFirstLoad {
                // Flipped on a later run-loop turn (not synchronously here)
                // so THIS render still sees `hasAnimatedIn == false` — that's
                // what lets `TrendsView`'s `.staggeredAppear` play on the
                // tiles/rows this very update creates. A later `load()` (a
                // period switch, pull-to-refresh) sees it already `true` and
                // renders its rows without the entrance.
                Task { @MainActor in hasAnimatedIn = true }
            }
        } catch {
            guard generation == loadGeneration else { return } // superseded by a newer load
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "TrendsViewModel.load", includesAction: false)
        }
        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    /// Rebuilds `sections`/`whatMovedRows`/`headline` from `loaded` + `goal`
    /// — the only place any of the three are computed, so `TrendsView`
    /// never recomputes them per render. Called after `loaded` changes
    /// (`load()`) and after `goal` changes (`loadGoalContext()`), since both
    /// feed `sections`' ordering.
    private func recomputeDerived() {
        let built = TrendsIndexSections.build(loaded: loaded, today: Date())
        sections = TrendsGoalOrdering.sections(for: goal, available: built)
        whatMovedRows = TrendsWhatMoved.topRows(sections: built)
        let allMoved = TrendsWhatMoved.movedRows(sections: built)
        let goodCount = allMoved.filter(\.isGood).count
        // Every verdict behind a `.chart` tile this period, regardless of
        // group or goal ordering — a tile still `.sparse`/`.dimmed`/hidden
        // contributes nothing, which is what lets an all-`.sparse` grid read
        // as "no metric is established" (an empty list) in
        // `TrendsHeadline.status`.
        let verdicts: [Verdict] = built.flatMap { section in
            section.tiles.compactMap { tile -> Verdict? in
                if case .chart(_, _, let verdict) = tile.content { return verdict }
                return nil
            }
        }
        headlineVerdicts = verdicts
        headlineGoodCount = goodCount
        headlineWatchCount = allMoved.count - goodCount
        weightMetricMoved = allMoved.contains { $0.key == "body_mass_kg" }
        refreshHeadline()
    }

    // Inputs `refreshHeadline()` combines, kept so the headline can be
    // re-derived when the weight log or strength summary arrives after the grid.
    private var headlineVerdicts: [Verdict] = []
    private var headlineGoodCount = 0
    private var headlineWatchCount = 0
    private var weightMetricMoved = false

    /// Headline = metric-tile moves + goal-relevant moves (weight trend for
    /// weight_loss, strength lifts), so it never claims "nothing moved" next
    /// to a visible +kg lift or weight change.
    private func refreshHeadline() {
        let strength = workoutSummary.flatMap { TrendsStrengthLogic.card(from: $0, system: .metric, today: Date()) }
        let goalMoves = TrendsHeadline.GoalMoves.make(
            goal: goal,
            weightTrend: weightLog?.trend,
            strength: strength,
            weightAlreadyCounted: weightMetricMoved
        )
        headlineStatus = TrendsHeadline.status(
            verdicts: headlineVerdicts,
            goodCount: headlineGoodCount,
            watchCount: headlineWatchCount,
            period: period,
            goalMoves: goalMoves
        )
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
            summaryErrorMessage = UserFacingError.message(for: error, context: .read, tag: "TrendsViewModel.loadSummary", includesAction: false)
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

    // MARK: - Load (goal + weight-log — drives goal-ordered sections)

    /// Fail-soft, like `loadSummary()`'s profile fetch: a failure here just
    /// leaves `goal` at its "general" default (so `TrendsIndexSections`'
    /// order is unaffected) and `weightLog` at `nil` (so `TrendsWeightCard`
    /// doesn't render) — it must never blank or error the metric grid, which
    /// has already loaded independently via `load()`.
    func loadGoalContext() async {
        do {
            let dietGoal = try await profileClient.fetchDietGoal()
            goal = dietGoal.current.goal
            recomputeDerived() // `goal` feeds `sections`' ordering
        } catch {
            return
        }
        guard goal == "weight_loss" else { return }
        let fresh = try? await profileClient.fetchWeightLog()
        withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
            weightLog = fresh
        }
        refreshHeadline()
    }

    // MARK: - Load (goal progress — fail-soft)

    /// Fail-soft like `loadStrength()`: a failure leaves `goalProgress` as it
    /// was (nil on a cold start, so the card simply doesn't render) and never
    /// touches `errorMessage`.
    func loadGoalProgress() async {
        do {
            let fresh = try await profileClient.fetchGoalProgress()
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
                goalProgress = fresh
            }
        } catch {
            if !error.isCancellation {
                print("[Vital] fetchGoalProgress failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Load (strength summary — fail-soft)

    /// Fail-soft like `loadGoalContext()`: a failure leaves `workoutSummary`
    /// as it was (nil on a cold start, so the Strength card simply doesn't
    /// render) and never touches `errorMessage` — strength is a secondary card,
    /// not core Trends content. An empty `exercises` map is a valid response
    /// (no lifts logged) and also hides the card via `TrendsStrengthLogic`.
    func loadStrength() async {
        do {
            let fresh = try await profileClient.fetchWorkoutSummary()
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) {
                workoutSummary = fresh
            }
            refreshHeadline()
        } catch {
            if !error.isCancellation {
                print("[Vital] fetchWorkoutSummary failed: \(error.localizedDescription)")
            }
        }
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

    /// Hide the This Week card only if there's a load error and no previously loaded summary data.
    /// If summary data was loaded earlier and a refresh fails, keep showing the old data.
    var showsWeekCard: Bool {
        guard summaryErrorMessage != nil else { return true }
        // If there's an error, only hide if we have no previously loaded data
        return sleepWindow != .empty || hrvWindow != .empty || rhrWindow != .empty
    }

    // MARK: - Helpers

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
