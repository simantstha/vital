import Foundation
import Combine

// MARK: - Local metric models (UI layer)

struct HRVMetric {
    let value: Int
    let trend: TrendDirection
    let delta: String
}

struct SleepMetric {
    let hours: Int
    let minutes: Int
    let trend: TrendDirection
    let delta: String

    var formatted: String { "\(hours)h \(minutes)m" }
}

struct RestingHRMetric {
    let bpm: Int
    let trend: TrendDirection
    let delta: String
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

    // Loading / error state — the view gates on isLoading so a fresh launch
    // shows a spinner instead of a flash of stale/fake numbers.
    @Published var isLoading = true
    @Published var errorMessage: String? = nil
    @Published private(set) var didLoadToday = false

    // Greeting
    @Published var greeting: String = ""
    @Published var dateSubtitle: String = ""
    @Published var streakDays: Int = 0

    // Coach insight — overwritten from /api/today
    @Published var coachInsight: String = ""

    // Header hint line under the streak chip. TODO(Phase 2+): have the brief
    // supply this copy directly instead of deriving a static placeholder
    // from calibration status.
    @Published var planHint: String = "Keep the streak going"

    // Biometrics — neutral until real data loads (view is gated on isLoading)
    @Published var hrv = HRVMetric(value: 0, trend: .neutral, delta: "—")
    @Published var sleep = SleepMetric(hours: 0, minutes: 0, trend: .neutral, delta: "—")
    @Published var restingHR = RestingHRMetric(bpm: 0, trend: .neutral, delta: "—")

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

    // Pending facts banner
    @Published var pendingFacts: [PendingFact] = []

    // Calibration state — driven from /api/today
    @Published var calibrationStatus: String? = nil
    @Published var calibrationProgress: Double = 0 // 0...1 based on min(dataDays) / 14

    // MARK: - Dependencies

    private let healthKit = HealthKitManager()
    private let apiClient = APIClient.shared
    private let calendarProvider = CalendarEventsProvider()

    // Phase 8 calendar-merge state. `lastServerPlanItems` is the most recent
    // server (or Phase-1-fallback) plan, kept so `syncCalendar()` can re-merge
    // immediately after a grant without re-hitting /api/plan. Removing a
    // calendar item hides it for the rest of the session — it's never
    // deleted server-side (there's nothing to delete; it never existed
    // there) and reappears if the app is relaunched.
    private var lastServerPlanItems: [PlanItem] = []
    private var hiddenCalendarItemIDs: Set<String> = []

    // MARK: - Init

    init() {
        refreshGreeting()
    }

    // MARK: - Called from TodayView.task

    func loadHealthData() async {
        isLoading = true
        didLoadToday = false
        // Run HealthKit + API calls concurrently. /api/today and /api/plan run
        // side by side (not one-after-the-other) — the plan step below waits
        // for both to finish so it can match meal-kind plan rows against
        // /api/today's `plan` array for the MealDetailView flow.
        async let healthTask: () = loadFromHealthKit()
        async let todayResult = loadTodayResponse()
        async let factsTask: () = loadPendingFacts()
        async let planResult = loadPlanResponse()

        let (_, today, _, plan) = await (healthTask, todayResult, factsTask, planResult)

        if let today {
            applyTodayResponse(today)
            didLoadToday = true
        }
        applyPlanResult(plan, todayPlan: today?.plan ?? [])

        isLoading = false
    }

    // MARK: - Pending facts

    func resolveFact(id: String, action: String) async {
        do {
            try await apiClient.resolvePendingFact(id: id, action: action)
            pendingFacts.removeAll { $0.id == id }
        } catch {
            errorMessage = error.localizedDescription
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
            hrv = HRVMetric(
                value: Int(r.valueMs.rounded()),
                trend: .upGood,
                delta: "\(Int(r.valueMs.rounded())) ms"
            )
        }

        if let r = sleepReading {
            sleep = SleepMetric(
                hours: r.totalMinutes / 60,
                minutes: r.totalMinutes % 60,
                trend: .upGood,
                delta: "\(r.totalMinutes / 60)h \(r.totalMinutes % 60)m"
            )
        }

        if let r = restingHRReading {
            restingHR = RestingHRMetric(
                bpm: Int(r.bpm.rounded()),
                trend: .downGood,
                delta: "\(Int(r.bpm.rounded())) bpm"
            )
        }

        await HealthSyncCoordinator.shared.syncNow()
    }

    private func loadTodayResponse() async -> TodayResponse? {
        do {
            return try await apiClient.fetchToday()
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] fetchToday failed: \(error.localizedDescription)")
            return nil
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

    private func applyTodayResponse(_ r: TodayResponse) {
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
            planHint = cal.status == "calibrating" ? "Take it easy today — recover" : "Keep the streak going"
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
            hrv = HRVMetric(
                value: Int(value.rounded()),
                trend: hrvTrend,
                delta: "\(hrvSign)\(deltaPct) %"
            )
        }

        // Sleep — value is in hours (e.g. 7.8)
        if let value = m.sleep.value {
            let deltaPct = m.sleep.deltaPct ?? 0
            let totalSleepMins = Int((value * 60).rounded())
            let sleepTrend: TrendDirection = deltaPct >= 0 ? .upGood : .downBad
            let sleepSign = deltaPct >= 0 ? "+" : ""
            sleep = SleepMetric(
                hours: totalSleepMins / 60,
                minutes: totalSleepMins % 60,
                trend: sleepTrend,
                delta: "\(sleepSign)\(deltaPct) %"
            )
        }

        // Resting HR — lower is better
        if let value = m.restingHr.value {
            let deltaPct = m.restingHr.deltaPct ?? 0
            let hrTrend: TrendDirection = deltaPct <= 0 ? .downGood : .upBad
            let hrSign = deltaPct >= 0 ? "+" : ""
            restingHR = RestingHRMetric(
                bpm: Int(value.rounded()),
                trend: hrTrend,
                delta: "\(hrSign)\(deltaPct) %"
            )
        }

        // Diet budget
        let db = r.dietBudget
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
            fat:     MacroProgress(current: db.fat,     target: fatTarget)
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
    private func applyPlanResult(_ response: PlanResponse?, todayPlan: [TodayPlanItem]) {
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
        let calendarItems = calendarProvider.fetchTodayPlanItems(now: Date())
        let merged = CalendarPlanMapping.merge(
            serverItems: serverItems,
            calendarItems: calendarItems,
            hiddenCalendarItemIDs: hiddenCalendarItemIDs
        )
        planItems = computeStatuses(merged, nowMinutes: Self.minutesSinceMidnight(Date()))
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
                try await apiClient.deletePlanItem(id: id)
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
        planItems = computeStatuses(planItems, nowMinutes: Self.minutesSinceMidnight(Date()))
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
        do {
            let response = try await apiClient.fetchPendingFacts()
            pendingFacts = response.items
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] fetchPendingFacts failed: \(error.localizedDescription)")
        }
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
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 0..<12: greeting = "Good morning"
        case 12..<17: greeting = "Good afternoon"
        default: greeting = "Good evening"
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE · MMM d"
        dateSubtitle = formatter.string(from: Date())
    }
}
