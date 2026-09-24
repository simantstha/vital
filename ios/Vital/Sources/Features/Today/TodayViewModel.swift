import Foundation
import Combine
import EventKit
import UIKit
import SwiftUI

// MARK: - Local metric models (UI layer)

// `value`/`bpm`/`hours`+`minutes` are optional so "not measured yet" (a
// fresh account with no HealthKit reading and no server data) is a distinct,
// representable state from "measured zero" — never seed or decode these as
// a literal `0` (and never a sentinel like `-1` either). See `displayValue`
// / `formatted` for the "—" placeholder each drives in `TodayView`.

struct HRVMetric {
    let value: Int?
    let trend: TrendDirection
    let delta: String

    var displayValue: String { value.map { "\($0)" } ?? "—" }
    var displayUnit: String { value == nil ? "" : "ms" }
}

struct SleepMetric {
    let hours: Int?
    let minutes: Int?
    let trend: TrendDirection
    let delta: String

    var formatted: String {
        guard let hours, let minutes else { return "—" }
        return "\(hours)h \(minutes)m"
    }
}

struct RestingHRMetric {
    let bpm: Int?
    let trend: TrendDirection
    let delta: String

    var displayValue: String { bpm.map { "\($0)" } ?? "—" }
    var displayUnit: String { bpm == nil ? "" : "bpm" }
}

struct MacroProgress {
    let current: Int
    let target: Int
    var fraction: Double {
        guard target > 0 else { return 0 }
        return min(1.0, Double(current) / Double(target))
    }
    var consumedLabel: String { "\(current)g" }
    var targetLabel: String  { "\(target)g" }
}

struct DietCard {
    let kcalConsumed: Int
    let kcalTarget: Int
    var kcalRemaining: Int { max(0, kcalTarget - kcalConsumed) }
    var kcalFraction: Double {
        guard kcalTarget > 0 else { return 0 }
        return min(1.0, Double(kcalConsumed) / Double(kcalTarget))
    }
    let protein: MacroProgress
    let carbs: MacroProgress
    let fat: MacroProgress
    /// Present when the effective target is at/under the low-energy-
    /// availability floor — see `LowEnergyWarning` in APIClient.swift.
    var lowEnergyWarning: LowEnergyWarning? = nil
    /// "logged" | "healthkit" | "none" — see `TodayDietBudget.consumedSource`.
    var consumedSource: String? = nil
    var consumedSourceName: String? = nil
}

struct MealRow: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let kcal: Int
    let reason: String
    let icon: String
}

// MARK: - ViewModel

@MainActor
final class TodayViewModel: ObservableObject {

    // Loading / error state — the view switches on `loadState` so a fresh
    // launch shows a skeleton, a real failure with no data on screen shows
    // `.failed`, and a partial failure (some data already loaded) never gets
    // blanked out from underneath the user — see `hasRenderableContent`.
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var loadState: LoadState = .loading
    @Published private(set) var didLoadToday = false

    /// Coalesces the five call sites that can trigger a load so two runs can't
    /// interleave and flip `loadState` out from under each other.
    private var loadTask: Task<Void, Never>?

    // Greeting
    @Published var greeting: String = ""
    @Published var dateSubtitle: String = ""
    @Published var streakDays: Int = 0
    /// Distinguishes "haven't fetched a streak yet" from "fetched and it's
    /// genuinely 0" — `streakDays` alone can't, since both start/land on 0.
    /// The chip uses this to avoid asserting "0-day streak" the first time
    /// `refreshStreak()` fails, before any real value has ever landed.
    @Published private(set) var hasLoadedStreak = false

    // Coach insight — overwritten from /api/today
    @Published var coachInsight: String = ""

    // Header hint line under the streak chip. TODO(Phase 2+): have the brief
    // supply this copy directly instead of deriving a static placeholder
    // from calibration status. For now, kept nil so no fabricated hint is shown.
    @Published var planHint: String? = nil

    // Biometrics — seeded `nil` ("not measured"), not `0`. `loadState`
    // gating does NOT cover this case: a fresh account's load completes
    // *successfully* with no HRV/sleep/resting-HR data at all, so these
    // published values are exactly what TodayView renders once loading
    // finishes. A seeded `0` would then read as a measured 0 ms HRV instead
    // of the "—" placeholder the optional now produces.
    @Published var hrv = HRVMetric(value: nil, trend: .neutral, delta: "—")
    @Published var sleep = SleepMetric(hours: nil, minutes: nil, trend: .neutral, delta: "—")
    @Published var restingHR = RestingHRMetric(bpm: nil, trend: .neutral, delta: "—")

    /// Drives the Today "Vital isn't seeing your Health data" recovery
    /// banner — see `shouldShowHealthKitRecoveryBanner` for the exact
    /// inference rule (HealthKit never reports a read denial, so this is
    /// never more than an inference) and
    /// docs/superpowers/plans/2026-09-05-healthkit-denial-recovery.md.
    @Published private(set) var showHealthKitRecoveryBanner = false

    // Diet — driven from /api/today
    @Published var diet = DietCard(
        kcalConsumed: 0,
        kcalTarget:   0,
        protein: MacroProgress(current: 0, target: 0),
        carbs:   MacroProgress(current: 0, target: 0),
        fat:     MacroProgress(current: 0, target: 0)
    )

    // Today's plan timeline — server-persisted via /api/plan (Phase 2),
    // merged client-side with today's calendar events (Phase 8, never sent
    // to the server — see `mergeAndSetPlanItems`). Falls back to the Phase 1
    // client-side derivation (from /api/today's `plan` + a synthesized sleep
    // item, local-only mutations) when /api/plan isn't available — see
    // `applyPlanResult`.
    @Published var planItems: [PlanItem] = []

    /// Drives the Today footer's calendar-sync affordance: `.notDetermined`
    /// shows a tappable "Sync your calendar" row instead of the plain
    /// caption; `.authorized`/`.denied` both show the plain caption (never
    /// nag once the user has answered the system prompt).
    enum CalendarSyncState: Equatable { case notDetermined, authorized, denied }
    @Published private(set) var calendarSyncState: CalendarSyncState = .notDetermined

    // Top-center toast host (see `.toast(message:)`).
    @Published var toastMessage: String? = nil

    /// Bottom-pinned actionable confirmations (§5.5) — used by the weigh-in
    /// flow's "Logged 82.4 kg" toast. `TodayView` attaches
    /// `.actionToastHost(vm.actionToast)`.
    let actionToast = ActionToastPresenter()

    // Pending facts banner
    @Published var pendingFacts: [PendingFact] = []

    // Calibration state — driven from /api/today
    @Published var calibrationStatus: String? = nil
    @Published var calibrationProgress: Double = 0 // 0...1 based on min(dataDays) / 14

    // MARK: - Muscle / endurance heroes (§4.1)

    /// Today's move-kind plan row, or `nil` for a rest day — shared by both
    /// `MuscleHeroView` and `EnduranceHeroView` (`MuscleHeroLogic
    /// .todaySession` / `EnduranceHeroLogic.todaySession`, identical rule).
    var todayMoveSession: PlanItem? {
        MuscleHeroLogic.todaySession(from: planItems)
    }

    /// Baselines for the endurance readiness word — `nil` until `/api/trends`
    /// resolves (or on a fail-soft failure, same convention as `weightLog`).
    /// Fetched for every goal alongside the rest of `performLoad`'s
    /// concurrent calls (like `weightLog`) rather than gated on `goal`,
    /// since `goal` itself isn't known until `/api/today` resolves in the
    /// same batch.
    @Published private(set) var enduranceTrendsBatch: TrendsBatchResponse? = nil

    private static let enduranceReadinessMetricKeys = ["hrv_sdnn", "resting_hr", "sleep_minutes"]

    /// The gated `Verdict` for one of the three metrics feeding readiness —
    /// `.noData` whenever the latest reading, the batch fetch, or the
    /// metric's `MetricSpec` isn't available, never a fabricated judgment.
    private func enduranceVerdict(key: String, latest: Double?) -> Verdict {
        guard let latest,
              let series = enduranceTrendsBatch?.series[key],
              let spec = MetricCatalog.spec(for: key) else { return .noData }
        return TrendsVerdict.evaluate(
            latest: latest,
            established: series.established,
            dataDays: series.dataDays,
            mean30: series.baseline?.mean30,
            sd30: series.baseline?.sd30,
            minMeaningfulSD: spec.minMeaningfulSD
        )
    }

    private var sleepHoursValue: Double? {
        guard let hours = sleep.hours, let minutes = sleep.minutes else { return nil }
        return Double(hours) + Double(minutes) / 60
    }

    /// §4.1's readiness word, derived only from the same gated `Verdict`
    /// `TrendsVerdict` already produces for Trends — see
    /// `EnduranceHeroLogic.readinessWord`.
    var enduranceReadinessWord: EnduranceHeroLogic.ReadinessWord {
        EnduranceHeroLogic.readinessWord(
            hrv: enduranceVerdict(key: "hrv_sdnn", latest: hrv.value.map(Double.init)),
            sleep: enduranceVerdict(key: "sleep_minutes", latest: sleepHoursValue),
            restingHR: enduranceVerdict(key: "resting_hr", latest: restingHR.bpm.map(Double.init))
        )
    }

    /// §4.1's "Calibrating · day X of 14" override — takes priority over
    /// `enduranceReadinessWord` in the view. Mirrors `calibrationCard`'s own
    /// days-collected derivation.
    var enduranceCalibratingText: String? {
        guard calibrationStatus == "calibrating" else { return nil }
        return EnduranceHeroLogic.calibratingText(daysCollected: Int((calibrationProgress * 14).rounded()))
    }

    /// "HRV +8 % · Sleep 7h 40m · RHR −2 %" — only the metrics that actually
    /// have a value today; `nil` if none do. Never a raw z-score or σ (§6 /
    /// `TrendsVerdict`'s doc comment — those never reach UI copy).
    var enduranceReasonLine: String? {
        var parts: [String] = []
        if hrv.value != nil { parts.append("HRV \(hrv.delta)") }
        if sleep.hours != nil { parts.append("Sleep \(sleep.formatted)") }
        if restingHR.bpm != nil { parts.append("RHR \(restingHR.delta)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func loadEnduranceTrends() async {
        do {
            enduranceTrendsBatch = try await apiClient.fetchTrendsBatch(
                metrics: Self.enduranceReadinessMetricKeys, days: 30
            )
        } catch {
            print("[Vital] fetchTrendsBatch (endurance readiness) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Training summary (Today muscle/endurance heroes, #202)

    /// `nil` until `/api/training/summary` resolves — fetched (fail-soft,
    /// same convention as `weightLog`/`enduranceTrendsBatch`) only for the
    /// muscle/endurance goals that actually render its data. Deliberately
    /// NOT part of `performLoad`'s awaited batch: it's a secondary
    /// enhancement, not core Today content, so it must never add a network
    /// round-trip to the time-to-`.loaded` critical path. Instead
    /// `performLoad` kicks it off unstructured (`refreshTrainingSummary`)
    /// right after `loadState = .loaded`, and the new hero lines fade in
    /// (`Theme.Motion.appear` + the views' `.transition(.opacity)`) once it
    /// arrives — see docs/ux-spec-v4.md §4.1.
    @Published private(set) var trainingSummary: TrainingSummaryResponse? = nil

    private var trainingSummaryTask: Task<Void, Never>?
    /// Bumped on every `refreshTrainingSummary()` call so a stale in-flight
    /// fetch (superseded by a pull-to-refresh or another reload before the
    /// first one returned) can detect it lost the race and drop its result
    /// instead of overwriting newer data — cancelling the previous task
    /// alone isn't enough, since a request already past its await point can
    /// still resolve after cancellation.
    private var trainingSummaryGeneration = 0

    /// Cancels any in-flight fetch and starts a fresh one — called for
    /// every load (initial + pull-to-refresh) when the goal is muscle or
    /// endurance, and clears `trainingSummary` immediately for every other
    /// goal (a goal switch must never leave a stale hero's data behind).
    private func refreshTrainingSummary() {
        trainingSummaryTask?.cancel()

        guard isMuscleGoal || isEnduranceGoal else {
            trainingSummary = nil
            return
        }

        trainingSummaryGeneration += 1
        let generation = trainingSummaryGeneration

        trainingSummaryTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.apiClient.fetchTrainingSummary()
                guard !Task.isCancelled, generation == self.trainingSummaryGeneration else { return }
                withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.appear) {
                    self.trainingSummary = result
                }
            } catch {
                if !error.isCancellation {
                    print("[Vital] fetchTrainingSummary failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// The muscle hero's "Last (Mon): Deadlift 2×5 @ 150 kg" line — `nil`
    /// whenever there's no logged strength history yet (never fabricated).
    var muscleLastLiftText: String? {
        guard let lift = trainingSummary?.lastLift else { return nil }
        return MuscleHeroLogic.lastLiftText(
            exercise: lift.exercise,
            date: lift.date,
            sets: lift.sets,
            reps: lift.reps,
            weightKg: lift.weightKg,
            system: UnitPreference.shared.current
        )
    }

    /// Planned-vs-completed records for `MuscleHeroLogic.sessionsThisWeek`,
    /// or `nil` before `trainingSummary` loads.
    private var weeklySessionRecords: [MuscleHeroLogic.WeeklySessionRecord]? {
        trainingSummary?.week.days.map {
            MuscleHeroLogic.WeeklySessionRecord(planned: $0.planned, completed: $0.completed)
        }
    }

    /// Done/total for the "● ● ○ ○" dot row shared by both heroes
    /// (`SessionDotsRow`) — `nil` when `plannedSessions` is null (nothing
    /// planned this week to compare against) or before `trainingSummary`
    /// loads. Same rule for muscle and endurance (task's §4 note). Exposed
    /// as counts rather than `MuscleHeroLogic.sessionDots`'s formatted
    /// string so the view can color each dot individually.
    var trainingSessionDots: (done: Int, total: Int)? {
        guard trainingSummary?.week.plannedSessions != nil, let records = weeklySessionRecords else { return nil }
        let counts = MuscleHeroLogic.sessionsThisWeek(records)
        return MuscleHeroLogic.sessionDots(done: counts.done, total: counts.total) != nil ? counts : nil
    }

    /// "2 of 4 sessions" when `plannedSessions` is known, or the honest
    /// "N sessions this week" fallback when it's null — `nil` only before
    /// `trainingSummary` loads.
    var trainingSessionsThisWeekText: String? {
        guard let week = trainingSummary?.week else { return nil }
        if week.plannedSessions != nil, let records = weeklySessionRecords {
            let counts = MuscleHeroLogic.sessionsThisWeek(records)
            return MuscleHeroLogic.sessionsThisWeekText(done: counts.done, total: counts.total)
        }
        return MuscleHeroLogic.sessionsThisWeekFallbackText(completed: week.completedSessions)
    }

    /// The endurance hero's "X km this week" / "X of Y km" line — `nil`
    /// when `volume.done` is null (no workout this week carries a distance
    /// reading).
    var enduranceWeeklyVolumeText: String? {
        guard let volume = trainingSummary?.volume else { return nil }
        return EnduranceHeroLogic.weeklyVolumeText(
            kmDone: volume.done, kmTarget: volume.target, system: UnitPreference.shared.current
        )
    }

    /// Combined "3 sessions · 24.5 km this week" line for the endurance hero.
    /// Returns `nil` when neither sessions nor volume data is available.
    var enduranceWeeklyOverviewText: String? {
        guard let week = trainingSummary?.week else { return nil }
        let sessionsCompleted = week.completedSessions
        let kmDone = trainingSummary?.volume.done
        return EnduranceHeroLogic.weeklySessionsAndVolumeText(
            sessionsCompleted: sessionsCompleted,
            kmDone: kmDone,
            system: UnitPreference.shared.current
        )
    }

    // MARK: - Weight-loss hero (§4.1, §5.3)

    /// "weight_loss" | "muscle" | "endurance" | "general" — from
    /// `/api/today`'s `dietBudget.goal`. Defaults to "general" (never shows
    /// the weight_loss hero) until the first load resolves.
    @Published private(set) var goal: String = "general"
    var isWeightLossGoal: Bool { goal == "weight_loss" }
    var isMuscleGoal: Bool { goal == "muscle" }
    var isEnduranceGoal: Bool { goal == "endurance" }

    /// `nil` until `/api/weight-log` resolves (or on a fail-soft failure —
    /// same fail-soft convention as `pendingFacts`/`calibration`). Never
    /// fabricated: the hero shows the honest "appears after 3 weigh-ins"
    /// placeholder via `WeightHeroLogic` when `trend.established` is false.
    @Published private(set) var weightLog: WeightLogResponse? = nil

    /// Today's HealthKit scale reading (kg), if any — drives the weigh-in
    /// chip's 1-tap "Confirm" state (§5.3).
    @Published private(set) var healthKitBodyMassTodayKg: Double? = nil

    @Published var showWeighInSheet = false
    @Published private(set) var isLoggingWeight = false

    var weighInChip: WeightHeroLogic.WeighInChip {
        WeightHeroLogic.weighInChip(healthKitTodayKg: healthKitBodyMassTodayKg)
    }

    /// The single "Next up" row shown in place of the full plan list (owner
    /// decision, 2026-09-23) — for every goal, not just weight_loss. `nil`
    /// once every remaining item has passed `WeightHeroLogic
    /// .nextUpGraceMinutes` ago — screenshot-review fix, 2026-09-23 (a
    /// not-done 7am breakfast is not "next up" at 3pm).
    var nextUpItem: PlanItem? {
        WeightHeroLogic.nextUpItem(from: planItems, nowMinutes: Self.minutesSinceMidnight(AppClock.now))
    }

    /// New-user first-run checklist (§4.2) replaces the three biometric
    /// tiles until real data exists.
    var showFirstRunChecklist: Bool {
        WeightHeroLogic.shouldShowFirstRunChecklist(
            calibrationStatus: calibrationStatus,
            hasAnyBiometric: hrv.value != nil || sleep.hours != nil || restingHR.bpm != nil
        )
    }

    /// The checklist's third row (§4.2: weigh-in for weight_loss/general,
    /// first workout for muscle/endurance).
    var showFirstRunChecklistSecondItemDone: Bool {
        if goal == "muscle" || goal == "endurance" {
            return planItems.contains { $0.kind == .move && $0.status == .done }
        }
        return !(weightLog?.entries.isEmpty ?? true)
    }

    // MARK: - Dependencies

    private let healthKit = HealthKitManager()
    private let apiClient = APIClient.shared
    private let calendarProvider = CalendarEventsProvider()
    private let fetchStreak: () async throws -> StreakResponse
    private let deletePlanItem: (String) async throws -> Void

    // Phase 8 calendar-merge state. `lastServerPlanItems` is the most recent
    // server (or Phase-1-fallback) plan, kept so `syncCalendar()` can re-merge
    // immediately after a grant without re-hitting /api/plan. Removing a
    // calendar item hides it for the rest of the session — it's never
    // deleted server-side (there's nothing to delete; it never existed
    // there) and reappears if the app is relaunched.
    private var lastServerPlanItems: [PlanItem] = []
    private var hiddenCalendarItemIDs: Set<String> = []

    // Notification observer tokens for calendar and app foreground events.
    // Calendar events are read locally per merge; these observers keep the
    // plan timeline fresh when the calendar changes (EKEventStoreChanged) or
    // the app foregrounds (willEnterForegroundNotification).
    private var calendarStoreObserverToken: NSObjectProtocol?
    private var foregroundObserverToken: NSObjectProtocol?

    // MARK: - Init

    init(
        fetchStreak: @escaping () async throws -> StreakResponse = { try await APIClient.shared.fetchStreak() },
        deletePlanItem: @escaping (String) async throws -> Void = { try await APIClient.shared.deletePlanItem(id: $0) }
    ) {
        self.fetchStreak = fetchStreak
        self.deletePlanItem = deletePlanItem
        refreshGreeting()

        // Set up observers for calendar changes and app foreground events.
        // When the calendar store changes or the app foregrounds, re-merge
        // plan items so any new or moved calendar events appear immediately.
        calendarStoreObserverToken = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.mergeAndSetPlanItems(serverItems: self?.lastServerPlanItems ?? [])
            }
        }

        foregroundObserverToken = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.mergeAndSetPlanItems(serverItems: self?.lastServerPlanItems ?? [])
            }
        }
    }

    deinit {
        if let token = calendarStoreObserverToken {
            NotificationCenter.default.removeObserver(token)
        }
        if let token = foregroundObserverToken {
            NotificationCenter.default.removeObserver(token)
        }
    }

    // MARK: - Called from TodayView.task

    func loadHealthData() async {
        if let existing = loadTask {
            await existing.value
            return
        }
        // Unstructured on purpose: a caller being cancelled (tab switch, an
        // interrupted pull-to-refresh) must not cancel the load itself.
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performLoad()
        }
        loadTask = task
        defer { loadTask = nil }
        await task.value
    }

    private func performLoad() async {
        if shouldShowLoadingSkeleton {
            withAnimation(Theme.Motion.appear) { loadState = .loading }
        }
        didLoadToday = false
        // Run HealthKit + API calls concurrently. /api/today and /api/plan run
        // side by side (not one-after-the-other) — the plan step below waits
        // for both to finish so it can match meal-kind plan rows against
        // /api/today's `plan` array for the MealDetailView flow.
        async let healthTask: () = loadFromHealthKit()
        async let todayOutcome = loadTodayResponse()
        async let factsTask: () = loadPendingFacts()
        async let planResult = loadPlanResponse()
        async let weightLogTask: () = loadWeightLog()
        async let bodyMassTask: () = loadHealthKitBodyMassToday()
        async let unitPrefTask: () = syncUnitPreference()
        async let enduranceTrendsTask: () = loadEnduranceTrends()

        let (_, today, _, plan, _, _, _, _) =
            await (healthTask, todayOutcome, factsTask, planResult, weightLogTask, bodyMassTask, unitPrefTask, enduranceTrendsTask)

        switch today {
        case .success(let response):
            applyTodayResponse(response)
            didLoadToday = true
            applyPlanResult(plan, todayPlan: response.plan)
            withAnimation(Theme.Motion.appear) { loadState = .loaded }
            // `/api/training/summary` only feeds the muscle/endurance heroes
            // — `goal` is only known once `applyTodayResponse` above runs,
            // so this can't join the concurrent batch further up. Kicked off
            // AFTER `.loaded` (never awaited here): it's a secondary
            // enhancement, not core Today content, and must never add a
            // round-trip to the time-to-`.loaded` critical path. See
            // `refreshTrainingSummary`'s doc comment.
            refreshTrainingSummary()

        case .cancelled:
            // A stale in-flight load was superseded (tab switch, interrupted
            // refresh) — never surface this as failure. See
            // `loadStateAfterCancellation` for the exact rule and why it's
            // almost always a no-op now that `.loading` is only entered when
            // the screen was empty to begin with.
            applyPlanResult(plan, todayPlan: [])
            let resolved = Self.loadStateAfterCancellation(from: loadState)
            if resolved != loadState {
                withAnimation(Theme.Motion.appear) { loadState = resolved }
            }

        case .failure(let message):
            applyPlanResult(plan, todayPlan: [])
            withAnimation(Theme.Motion.appear) {
                loadState = loadStateAfterFailure(message: message)
            }
            if hasRenderableContent {
                toastMessage = "Couldn't refresh — showing your last data"
            }
        }
    }

    /// True once there's real user data on screen worth protecting from a
    /// blank-out — used to decide whether a failed load replaces the dashboard
    /// with `.failed` or just surfaces a non-blocking toast on top of what's
    /// already there. Deliberately checks the currently-published values (which
    /// persist across loads until overwritten), not a "did a load ever succeed"
    /// flag — a pull-to-refresh failure after a prior successful load must find
    /// this `true` even though this load's `today` fetch just failed.
    private var hasRenderableContent: Bool {
        hrv.value != nil
            || sleep.hours != nil
            || restingHR.bpm != nil
            || diet.kcalTarget > 0
            || !planItems.isEmpty
    }

    /// Not `private` — lets tests pin the partial-failure rule (a failed load
    /// must not blank a screen that already has real data on it) without
    /// driving a live network call. Mirrors the decision `performLoad` makes.
    func loadStateAfterFailure(message: String) -> LoadState {
        hasRenderableContent ? .loaded : .failed(message)
    }

    /// Only swap the dashboard for a skeleton when there is nothing to swap
    /// out. A refresh over real data leaves it rendered — `.refreshable`
    /// already draws its own spinner, and replacing a populated dashboard with
    /// a full-shape skeleton on every pull-to-refresh is exactly the churn this
    /// state machine exists to remove. Not `private` — lets tests pin that a
    /// refresh with content on screen never enters `.loading`.
    var shouldShowLoadingSkeleton: Bool { !hasRenderableContent }

    /// A superseded request (tab switch, interrupted refresh, a `URLError
    /// .cancelled` from a network transition) carries no data, so it must never
    /// overwrite what is on screen — and because `performLoad` now only enters
    /// `.loading` when the screen was empty, there is normally nothing to
    /// restore. The one case that still needs rescuing is an empty first load
    /// cancelled before anything resolved it: nothing re-triggers a load until
    /// the user switches tabs or pulls to refresh, so leaving `.loading` in
    /// place would strand the skeleton indefinitely. Static and parameterized so
    /// tests can pin every prior state without a network seam (`loadState` is
    /// `private(set)`, so a test cannot stage `.loaded` any other way).
    static func loadStateAfterCancellation(from current: LoadState) -> LoadState {
        current == .loading ? .loaded : current
    }

    /// Denial cannot be *detected* — HealthKit never reports it (see
    /// `HealthKitManager.requestAuthorization`) — only inferred: the system
    /// prompt has been shown at least once, and every requested read type
    /// still has zero samples. If any type has data this must return
    /// false even when others are empty — a user who granted sleep but not
    /// HRV, or simply hasn't logged data under a granted type yet, must
    /// never be told they refused something they didn't. Static and pure
    /// so tests can pin the rule without touching HealthKit or
    /// UserDefaults.
    static func shouldShowHealthKitRecoveryBanner(
        didRequestAuthorization: Bool,
        hasAnyHealthData: Bool
    ) -> Bool {
        didRequestAuthorization && !hasAnyHealthData
    }

    // MARK: - Pending facts

    func resolveFact(id: String, action: String) async {
        do {
            try await apiClient.resolvePendingFact(id: id, action: action)
            pendingFacts.removeAll { $0.id == id }
        } catch {
            if !error.isCancellation { toastMessage = "Couldn't save — try again" }
            print("[Vital] resolvePendingFact failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Private loaders

    private func loadFromHealthKit() async {
        // Authorization is requested once, up front, at the start of the
        // onboarding flow (see OnboardingViewModel.begin) — by the time
        // Today loads, the user has already been asked. Re-requesting here
        // was harmless but redundant, so it moved with the rest of the
        // onboarding permission surface.
        async let hrvTask       = healthKit.fetchLatestHRV()
        async let sleepTask     = healthKit.fetchLastNightSleep()
        async let restingHRTask = healthKit.fetchLatestRestingHR()

        let (hrvReading, sleepReading, restingHRReading) =
            await (hrvTask, sleepTask, restingHRTask)

        // Local reads above are for instant UI display only (overwritten by
        // /api/today once it loads). Persisting to the server is now
        // HealthSyncCoordinator's job — it re-aggregates by day and upserts
        // through /api/ingest/daily, which is what backfill + background
        // sync also write through, so there's no separate delta-post path
        // to keep in sync here.
        if let r = hrvReading {
            let newHRV = HRVMetric(
                value: Int(r.valueMs.rounded()),
                trend: .upGood,
                delta: "\(Int(r.valueMs.rounded())) ms"
            )
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { hrv = newHRV }
        }

        if let r = sleepReading {
            let newSleep = SleepMetric(
                hours: r.totalMinutes / 60,
                minutes: r.totalMinutes % 60,
                trend: .upGood,
                delta: "\(r.totalMinutes / 60)h \(r.totalMinutes % 60)m"
            )
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { sleep = newSleep }
        }

        if let r = restingHRReading {
            let newRestingHR = RestingHRMetric(
                bpm: Int(r.bpm.rounded()),
                trend: .downGood,
                delta: "\(Int(r.bpm.rounded())) bpm"
            )
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { restingHR = newRestingHR }
        }

        // The three reads above already cover three of HealthKit's read
        // types — only fall through to the broader (all-types) scan when
        // none of them found anything, so the common case (data exists)
        // never pays for it.
        let hasAnyData = hrvReading != nil || sleepReading != nil || restingHRReading != nil
            ? true
            : await healthKit.hasAnyData()
        showHealthKitRecoveryBanner = Self.shouldShowHealthKitRecoveryBanner(
            didRequestAuthorization: HealthKitManager.didRequestAuthorization,
            hasAnyHealthData: hasAnyData
        )

        await HealthSyncCoordinator.shared.syncNow()
        await refreshStreak()
    }

    /// Streak is intentionally fail-soft: the rest of Today remains usable,
    /// and a transient request failure never replaces the last known value.
    func refreshStreak() async {
        do {
            streakDays = try await fetchStreak().streakDays
            hasLoadedStreak = true
        } catch {
            print("[Vital] fetchStreak failed: \(error.localizedDescription)")
        }
    }

    /// Distinguishes a superseded in-flight request (tab switch, interrupted
    /// pull-to-refresh) from a real failure — `performLoad` must never let a
    /// cancellation touch `loadState`, but a real failure must. Collapsing
    /// both into a single `nil` (the old signature) made that distinction
    /// impossible to act on at the call site.
    private enum FetchOutcome<T> {
        case success(T)
        case failure(String)
        case cancelled
    }

    private func loadTodayResponse() async -> FetchOutcome<TodayResponse> {
        do {
            return .success(try await apiClient.fetchToday())
        } catch {
            if error.isCancellation { return .cancelled }
            return .failure(UserFacingError.message(for: error, context: .read, tag: "fetchToday", includesAction: false))
        }
    }

    /// PHASE 2 FALLBACK: nil here (network error, 404, decode failure — most
    /// notably an older backend deployed before /api/plan existed) is not
    /// surfaced as an error; `applyPlanResult` falls back to the Phase 1
    /// client-side derivation so Today still renders a plan.
    private func loadPlanResponse() async -> PlanResponse? {
        do {
            return try await apiClient.fetchPlan()
        } catch {
            print("[Vital] fetchPlan failed, falling back to Phase 1 derivation: \(error.localizedDescription)")
            return nil
        }
    }

    /// Not `private` so tests can drive it directly with a hand-built
    /// `TodayResponse` — `apiClient` isn't injectable, so this is the seam
    /// that lets tests exercise the empty-insight / null-metric paths
    /// without a live network call.
    func applyTodayResponse(_ r: TodayResponse) {
        // Calibration state — extract if present
        if let cal = r.calibration {
            calibrationStatus = cal.status
            // Calculate progress as min of the three metrics' dataDays / 14 (target)
            let dataDays = [
                cal.metrics["hrv_sdnn"]?.dataDays ?? 0,
                cal.metrics["resting_hr"]?.dataDays ?? 0,
                cal.metrics["sleep_minutes"]?.dataDays ?? 0
            ].min() ?? 0
            calibrationProgress = min(1.0, Double(dataDays) / 14.0)
        }

        // Coach insight — keep the existing default if the brief isn't ready yet
        if !r.insight.isEmpty {
            coachInsight = r.insight
        }

        // Metrics — prefer API over HealthKit defaults. Null value/deltaPct
        // means the user has no data for that metric yet (fresh account) —
        // keep the neutral defaults (or HealthKit reads) in that case.
        let m = r.metrics

        // HRV
        if let value = m.hrv.value {
            let deltaPct = m.hrv.deltaPct ?? 0
            let hrvTrend: TrendDirection = deltaPct >= 0 ? .upGood : .downBad
            let hrvSign = deltaPct >= 0 ? "+" : ""
            let newHRV = HRVMetric(
                value: Int(value.rounded()),
                trend: hrvTrend,
                delta: "\(hrvSign)\(deltaPct) %"
            )
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { hrv = newHRV }
        }

        // Sleep — value is in hours (e.g. 7.8)
        if let value = m.sleep.value {
            let deltaPct = m.sleep.deltaPct ?? 0
            let totalSleepMins = Int((value * 60).rounded())
            let sleepTrend: TrendDirection = deltaPct >= 0 ? .upGood : .downBad
            let sleepSign = deltaPct >= 0 ? "+" : ""
            let newSleep = SleepMetric(
                hours: totalSleepMins / 60,
                minutes: totalSleepMins % 60,
                trend: sleepTrend,
                delta: "\(sleepSign)\(deltaPct) %"
            )
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { sleep = newSleep }
        }

        // Resting HR — lower is better
        if let value = m.restingHr.value {
            let deltaPct = m.restingHr.deltaPct ?? 0
            let hrTrend: TrendDirection = deltaPct <= 0 ? .downGood : .upBad
            let hrSign = deltaPct >= 0 ? "+" : ""
            let newRestingHR = RestingHRMetric(
                bpm: Int(value.rounded()),
                trend: hrTrend,
                delta: "\(hrSign)\(deltaPct) %"
            )
            withAnimation(Theme.Motion.isReduced ? nil : Theme.Motion.standard) { restingHR = newRestingHR }
        }

        // Diet budget
        let db = r.dietBudget
        goal = db.goal ?? "general"
        // Macro targets are now server-authoritative (user override or auto-calc
        // from goal). Fall back to a 30/40/30 split only if an older backend
        // doesn't send them yet.
        let proteinTarget = db.proteinTarget ?? Int((Double(db.targetKcal) * 0.30 / 4).rounded())
        let carbsTarget   = db.carbsTarget   ?? Int((Double(db.targetKcal) * 0.40 / 4).rounded())
        let fatTarget     = db.fatTarget     ?? Int((Double(db.targetKcal) * 0.30 / 9).rounded())

        diet = DietCard(
            kcalConsumed: db.consumedKcal,
            kcalTarget:   db.targetKcal,
            protein: MacroProgress(current: db.protein, target: proteinTarget),
            carbs:   MacroProgress(current: db.carbs,   target: carbsTarget),
            fat:     MacroProgress(current: db.fat,     target: fatTarget),
            lowEnergyWarning: db.lowEnergyWarning,
            consumedSource: db.consumedSource,
            consumedSourceName: db.consumedSourceName
        )
    }

    // MARK: - Plan timeline (Phase 2: server-persisted via /api/plan)

    /// Maps a `/api/plan` row to the UI's `PlanItem`. `sfSymbol` is derived
    /// client-side from `kind` + `title` (meals reuse `mealIcon`'s keyword
    /// heuristics; sleep/rest → moon, move → figure.walk, other → circle) —
    /// the server never sends an icon. Meal-kind items are matched by title
    /// against `/api/today`'s `plan` array so the row keeps its `MealRow` for
    /// `MealDetailView`'s suggest/log flow.
    private func planItem(from dto: PlanItemDTO, todayPlan: [TodayPlanItem]) -> PlanItem {
        let kind = PlanItem.Kind(rawValue: dto.kind) ?? .other

        // Server status is pending/done/skipped only; `.later` is a harmless
        // placeholder for `.pending` here — computeStatuses (below) recomputes
        // every non-done/skipped item's now/next/later from the clock right
        // after this mapping runs.
        let status: PlanItem.Status
        switch dto.status {
        case "done":    status = .done
        case "skipped": status = .skipped
        default:        status = .later
        }

        var meal: MealRow?
        let sfSymbol: String
        switch kind {
        case .meal:
            sfSymbol = mealIcon(for: dto.title)
            if let match = todayPlan.first(where: { $0.name == dto.title }) {
                meal = MealRow(name: match.name, kcal: match.kcal, reason: match.why, icon: sfSymbol)
            }
        case .sleep, .rest:
            sfSymbol = "moon"
        case .move:
            sfSymbol = "figure.walk"
        case .other:
            sfSymbol = "circle"
        }

        return PlanItem(
            id: dto.id,
            timeMinutes: dto.timeMinutes,
            title: dto.title,
            subtitle: dto.subtitle ?? "",
            sfSymbol: sfSymbol,
            status: status,
            source: dto.source == "user" ? .user : .coach,
            kind: kind,
            meal: meal
        )
    }

    /// Applies the `/api/plan` result, or falls back to the Phase 1
    /// client-side derivation when the endpoint isn't available, then merges
    /// in today's calendar events (Phase 8) — see `mergeAndSetPlanItems`.
    /// Not `private` for the same reason as `applyTodayResponse` — lets
    /// tests exercise the empty-plan fallback path directly.
    func applyPlanResult(_ response: PlanResponse?, todayPlan: [TodayPlanItem]) {
        let serverItems: [PlanItem]
        if let response {
            serverItems = response.items.map { planItem(from: $0, todayPlan: todayPlan) }
        } else {
            serverItems = derivePlanItems(from: todayPlan) // PHASE 2 FALLBACK — see below
        }
        mergeAndSetPlanItems(serverItems: serverItems)
    }

    // MARK: - Plan timeline: calendar merge (Phase 8)
    //
    // Calendar events are read on-device only and never sent to /api/plan —
    // see docs/redesign-v3-plan.md §4 decision 5. This is the single merge
    // point both `applyPlanResult` paths (server + Phase 1 fallback) funnel
    // through, so calendar items always appear regardless of which plan
    // source resolved.

    /// Merges `serverItems` with today's calendar events (if authorized),
    /// recomputes now/next/later, and publishes the result. Also refreshes
    /// `calendarSyncState` so the footer affordance reflects the current
    /// authorization.
    private func mergeAndSetPlanItems(serverItems: [PlanItem]) {
        lastServerPlanItems = serverItems
        let calendarItems = calendarProvider.fetchTodayPlanItems(now: AppClock.now)
        let merged = CalendarPlanMapping.merge(
            serverItems: serverItems,
            calendarItems: calendarItems,
            hiddenCalendarItemIDs: hiddenCalendarItemIDs
        )
        planItems = computeStatuses(merged, nowMinutes: Self.minutesSinceMidnight(AppClock.now))
        refreshCalendarSyncState()
    }

    private func refreshCalendarSyncState() {
        switch calendarProvider.authorizationStatus {
        case .notDetermined: calendarSyncState = .notDetermined
        case .fullAccess:    calendarSyncState = .authorized
        default:             calendarSyncState = .denied
        }
    }

    /// Called only from an explicit user tap on the "Sync your calendar"
    /// affordance (never automatically — no surprise permission prompt at
    /// launch). On grant, immediately re-merges using the last-known server
    /// plan so calendar items appear without waiting for the next /api/plan
    /// load.
    func syncCalendar() async {
        let granted = await calendarProvider.requestAccess()
        if granted {
            mergeAndSetPlanItems(serverItems: lastServerPlanItems)
        } else {
            refreshCalendarSyncState()
        }
    }

    // MARK: - Plan timeline: Phase 1 fallback derivation (old backend only)
    //
    // PHASE 2 FALLBACK: everything below is dead weight once every deployed
    // backend has /api/plan — kept only so the app degrades gracefully
    // against a prod backend from before this release (see `loadPlanResponse`
    // / `applyPlanResult` above). Mutations made while running on this path
    // are local-only and reset on relaunch, same as Phase 1.

    /// Buckets a meal plan into breakfast/lunch/dinner slots so it can be
    /// given a heuristic time-of-day. Mirrors `mealIcon(for:)`'s keyword
    /// sets so the same meal always lands in the same slot as its icon.
    private enum MealSlot: Equatable { case breakfast, lunch, dinner, unmatched }

    private func mealSlot(for name: String) -> MealSlot {
        let lower = name.lowercased()
        if lower.contains("breakfast") || lower.contains("oat") || lower.contains("egg") {
            return .breakfast
        } else if lower.contains("lunch") || lower.contains("chicken") || lower.contains("bowl") {
            return .lunch
        } else if lower.contains("dinner") || lower.contains("salmon") || lower.contains("pasta") {
            return .dinner
        }
        return .unmatched
    }

    /// Builds meal-kind PlanItems from the brief's plan items, assigning each
    /// a heuristic time-of-day: breakfast 8:00, lunch 12:45, dinner 19:30;
    /// anything that doesn't match one of those name heuristics (e.g.
    /// snacks, recovery items) is spread evenly between lunch and dinner.
    private func buildMealPlanItems(from plan: [TodayPlanItem]) -> [PlanItem] {
        let breakfastMinutes = 8 * 60
        let lunchMinutes = 12 * 60 + 45
        let dinnerMinutes = 19 * 60 + 30

        let unmatched = plan.filter { mealSlot(for: $0.name) == .unmatched }
        let unmatchedTime: [String: Int] = Dictionary(
            uniqueKeysWithValues: unmatched.enumerated().map { index, item in
                let fraction = Double(index + 1) / Double(unmatched.count + 1)
                let minutes = lunchMinutes + Int((Double(dinnerMinutes - lunchMinutes) * fraction).rounded())
                return (item.name, minutes)
            }
        )

        return plan.map { item in
            let minutes: Int
            switch mealSlot(for: item.name) {
            case .breakfast: minutes = breakfastMinutes
            case .lunch:     minutes = lunchMinutes
            case .dinner:    minutes = dinnerMinutes
            case .unmatched: minutes = unmatchedTime[item.name] ?? lunchMinutes
            }

            let meal = MealRow(name: item.name, kcal: item.kcal, reason: item.why, icon: mealIcon(for: item.name))
            let subtitle = item.why.isEmpty ? "\(item.kcal) kcal" : "\(item.why) · \(item.kcal) kcal"
            return PlanItem(
                timeMinutes: minutes,
                title: item.name,
                subtitle: subtitle,
                sfSymbol: mealIcon(for: item.name),
                status: .later, // overwritten by computeStatuses(...) below
                source: .coach,
                kind: .meal,
                meal: meal
            )
        }
    }

    /// Recomputes `.now` / `.next` / `.later` for items whose status isn't
    /// `.done`/`.skipped` (those are left untouched — server-tracked, or
    /// user-set in the fallback path). Items within ±45 min of now become
    /// `.now`; the earliest future item beyond that window becomes `.next`;
    /// everything else — including past items we have no signal actually
    /// happened — stays `.later` rather than being guessed as done. now/
    /// next/later is deliberately never sent to the server (see
    /// `docs/redesign-v3-plan.md` Phase 2): it's a clock-derived display
    /// concern recomputed on every load, not stored state.
    private func computeStatuses(_ items: [PlanItem], nowMinutes: Int) -> [PlanItem] {
        var items = items.sorted { $0.timeMinutes < $1.timeMinutes }
        var assignedNext = false
        for i in items.indices {
            guard items[i].status != .done, items[i].status != .skipped else { continue }
            let diff = items[i].timeMinutes - nowMinutes
            if abs(diff) <= 45 {
                items[i].status = .now
            } else if diff > 45 {
                if !assignedNext {
                    items[i].status = .next
                    assignedNext = true
                } else {
                    items[i].status = .later
                }
            } else {
                items[i].status = .later
            }
        }
        return items
    }

    /// PHASE 2 FALLBACK — builds the same shape /api/plan would have seeded
    /// (meal items from the brief's heuristic times + a synthesized "Lights
    /// out" row), entirely client-side and local-only. No status-preservation
    /// merge across reloads (the server owned that in Phase 1's plan; without
    /// it, a fallback reload simply rebuilds fresh — acceptable since this
    /// path only runs against a backend that predates plan persistence).
    /// Status/sort is left to `mergeAndSetPlanItems`'s single `computeStatuses`
    /// call so calendar items merged in afterward are recomputed together.
    private func derivePlanItems(from plan: [TodayPlanItem]) -> [PlanItem] {
        guard !plan.isEmpty else { return [] }

        let mealItems = buildMealPlanItems(from: plan)
        let lightsOut = PlanItem(
            timeMinutes: 22 * 60 + 30,
            title: "Lights out",
            subtitle: "8h target",
            sfSymbol: "moon",
            status: .later,
            source: .coach,
            kind: .sleep
        )

        return mealItems + [lightsOut]
    }

    private static func minutesSinceMidnight(_ date: Date) -> Int {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    }

    // MARK: - Plan timeline mutations (optimistic — see docs/redesign-v3-plan.md Phase 2)
    //
    // Each mutates `planItems` immediately, fires the matching /api/plan
    // call, and reverts + shows a short error toast if the call fails
    // (including when there's no /api/plan at all — the Phase 1 fallback
    // path above still renders, but writes here won't persist against an
    // old backend; that's an accepted degradation, not a crash).

    /// Client status → server status. `.now`/`.next`/`.later` all collapse to
    /// `'pending'` — the server only ever tracks pending/done/skipped, and
    /// now/next/later is recomputed from the clock on every load (see
    /// `computeStatuses`). "Mark not done" calls `setStatus(_, .later)`,
    /// which — via this mapping — clears a done/skipped item back to pending.
    private func serverStatus(for status: PlanItem.Status) -> String {
        switch status {
        case .done:    return "done"
        case .skipped: return "skipped"
        case .now, .next, .later: return "pending"
        }
    }

    /// Calendar-sourced items (`id` prefixed `cal-`) never exist server-side
    /// — mutating them is session-local only, no `APIClient` call, ever.
    func setStatus(id: PlanItem.ID, _ status: PlanItem.Status) {
        guard let idx = planItems.firstIndex(where: { $0.id == id }) else { return }

        if planItems[idx].source == .calendar {
            planItems[idx].status = status
            return
        }

        let previousStatus = planItems[idx].status
        planItems[idx].status = status

        Task {
            do {
                try await apiClient.updatePlanItem(id: id, status: serverStatus(for: status))
                await refreshStreak()
            } catch {
                if let idx = planItems.firstIndex(where: { $0.id == id }) {
                    planItems[idx].status = previousStatus
                }
                toastMessage = "Couldn't save — try again"
                print("[Vital] updatePlanItem failed: \(error.localizedDescription)")
            }
        }
    }

    /// Removing a calendar item hides it for the rest of the session
    /// (`hiddenCalendarItemIDs`, consulted by `mergeAndSetPlanItems`) and
    /// never calls `APIClient` — there is no server row to delete.
    func removeItem(id: PlanItem.ID) {
        guard let removed = planItems.first(where: { $0.id == id }) else { return }

        if removed.source == .calendar {
            hiddenCalendarItemIDs.insert(id)
            planItems.removeAll { $0.id == id }
            return
        }

        planItems.removeAll { $0.id == id }

        Task {
            do {
                try await deletePlanItem(id)
                await refreshStreak()
            } catch {
                planItems.append(removed)
                planItems.sort { $0.timeMinutes < $1.timeMinutes }
                toastMessage = "Couldn't save — try again"
                print("[Vital] deletePlanItem failed: \(error.localizedDescription)")
            }
        }
    }

    /// `item` arrives with a client-synthesized temp id (see
    /// `AddPlanItemSheet`); on success the temp id is swapped for the
    /// server-issued one so a subsequent setStatus/removeItem round-trips
    /// correctly. On failure the optimistic row is pulled back out.
    func addItem(_ item: PlanItem) {
        planItems.append(item)
        planItems = computeStatuses(planItems, nowMinutes: Self.minutesSinceMidnight(AppClock.now))
        let tempId = item.id

        Task {
            do {
                let dto = try await apiClient.addPlanItem(
                    timeMinutes: item.timeMinutes,
                    title: item.title,
                    subtitle: item.subtitle,
                    kind: item.kind.rawValue,
                    kcal: nil
                )
                if let idx = planItems.firstIndex(where: { $0.id == tempId }) {
                    planItems[idx].id = dto.id
                }
            } catch {
                planItems.removeAll { $0.id == tempId }
                toastMessage = "Couldn't save — try again"
                print("[Vital] addPlanItem failed: \(error.localizedDescription)")
            }
        }
    }

    private func loadPendingFacts() async {
        // Fail-soft: pending facts are a secondary surface and shouldn't claim
        // "Couldn't load today's data" like refreshStreak() and loadPlanResponse() below.
        do {
            let response = try await apiClient.fetchPendingFacts()
            pendingFacts = response.items
        } catch {
            print("[Vital] fetchPendingFacts failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Weight-loss hero loaders (fail-soft — same convention as loadPendingFacts)

    private func loadWeightLog() async {
        do {
            weightLog = try await apiClient.fetchWeightLog()
        } catch {
            print("[Vital] fetchWeightLog failed: \(error.localizedDescription)")
        }
    }

    private func loadHealthKitBodyMassToday() async {
        healthKitBodyMassTodayKg = await healthKit.fetchTodayBodyMass()
    }

    /// Mirrors `ProfileViewModel.load()` / `TrendsViewModel.loadSummary()`'s
    /// unit-preference sync exactly (see `UnitPreference.applyServerValue`'s
    /// doc comment) — Today now formats weight itself (the hero), so it must
    /// resolve the server's `unitSystem` the same way those screens do
    /// instead of only ever seeing the device-locale default.
    private func syncUnitPreference() async {
        do {
            let response = try await apiClient.fetchProfile()
            if UnitPreference.shared.applyServerValue(response.unitSystem) {
                try? await apiClient.updateProfile(unitSystem: UnitPreference.shared.current.rawValue)
            }
        } catch {
            print("[Vital] syncUnitPreference failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Weigh-in (§5.3)

    /// Logs a manual weigh-in from the sheet (2 taps) and refreshes the
    /// hero's trend. `weightInUserUnits` is in `system`'s unit — never
    /// pre-converted by the caller. Optimistic UI is not attempted here
    /// (unlike plan mutations): the trend line and rate genuinely change
    /// server-side (EWMA), so the toast and chip wait for the real refreshed
    /// numbers rather than showing a value that might not match what
    /// `loadWeightLog()` returns next.
    func logManualWeighIn(weightInUserUnits: Double, system: UnitSystem) async {
        let unitWire = system == .metric ? "kg" : "lbs"
        await performWeighIn(weight: weightInUserUnits, unitWire: unitWire, system: system)
    }

    /// 1-tap confirm of today's HealthKit scale reading (§5.3) — always sent
    /// in kg (HealthKit's native unit; no lossy round-trip through the
    /// user's display unit), but the confirmation toast still formats in
    /// whatever the user's actual unit preference is.
    func confirmHealthKitWeight(kg: Double) async {
        await performWeighIn(weight: kg, unitWire: "kg", system: UnitPreference.shared.current)
    }

    private func performWeighIn(weight: Double, unitWire: String, system: UnitSystem) async {
        guard !isLoggingWeight else { return }
        isLoggingWeight = true
        defer { isLoggingWeight = false }

        let today = TodayViewModel.localDateKey(Date())

        do {
            try await apiClient.logWeight(weight: weight, unit: unitWire, date: today)
            await loadWeightLog()
            showWeighInSheet = false
            // No Undo: there is no delete-a-weigh-in endpoint (§5.5's Undo
            // requires a real reversal path — see the task brief). The
            // success haptic still fires (`ActionToastHostModifier`'s
            // `.sensoryFeedback(Theme.Haptics.success, ...)`).
            //
            // Dietitian review (2026-09-23): the toast leads with the
            // refreshed TREND, never the raw number just typed/confirmed —
            // see `WeightHeroLogic.weighInToastMessage`.
            actionToast.show(message: WeightHeroLogic.weighInToastMessage(
                entries: weightLog?.entries ?? [],
                trend: weightLog?.trend,
                system: system
            ))
        } catch {
            toastMessage = "Couldn't save — try again"
            print("[Vital] logWeight failed: \(error.localizedDescription)")
        }
    }

    private static func localDateKey(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func mealIcon(for name: String) -> String {
        let lower = name.lowercased()
        if lower.contains("breakfast") || lower.contains("oat") || lower.contains("egg") {
            return "sunrise.fill"
        } else if lower.contains("lunch") || lower.contains("chicken") || lower.contains("bowl") {
            return "fork.knife"
        } else if lower.contains("snack") || lower.contains("yogurt") || lower.contains("fruit") {
            return "leaf.fill"
        } else if lower.contains("dinner") || lower.contains("salmon") || lower.contains("pasta") {
            return "moon.fill"
        } else if lower.contains("run") || lower.contains("recovery") || lower.contains("post") {
            return "figure.run"
        }
        return "fork.knife"
    }

    // MARK: - Private helpers

    private func refreshGreeting() {
        // Neutral, name-free greeting until real sign-up/accounts exist; the
        // personalized "Morning, <name>" form returns with the next-cycle auth work.
        // Routed through `AppClock.now` (not `Date()` directly) so the
        // screenshot harness's pinned fixture time also pins this — see
        // `AppClock`'s doc comment.
        let hour = Calendar.current.component(.hour, from: AppClock.now)
        switch hour {
        case 0..<12: greeting = "Good morning"
        case 12..<17: greeting = "Good afternoon"
        default: greeting = "Good evening"
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE · MMM d"
        dateSubtitle = formatter.string(from: AppClock.now)
    }
}
