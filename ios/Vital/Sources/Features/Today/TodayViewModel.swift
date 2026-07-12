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

    // Today's plan timeline — derived (client-side, Phase 1) from /api/today's
    // `plan` + a synthesized sleep item. Local-only mutations; Phase 2 swaps
    // this for /api/plan without changing the shape callers see.
    @Published var planItems: [PlanItem] = []

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

    // MARK: - Init

    init() {
        refreshGreeting()
    }

    // MARK: - Called from TodayView.task

    func loadHealthData() async {
        isLoading = true
        // Run HealthKit + API calls concurrently
        async let healthTask: () = loadFromHealthKit()
        async let todayTask: () = loadTodayFromAPI()
        async let factsTask: () = loadPendingFacts()
        _ = await (healthTask, todayTask, factsTask)
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

    private func loadTodayFromAPI() async {
        do {
            let response = try await apiClient.fetchToday()
            applyTodayResponse(response)
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] fetchToday failed: \(error.localizedDescription)")
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

        // Today's plan timeline — derive PlanItems from the brief's meals +
        // a synthesized sleep item. Keep the existing derived plan if the
        // brief isn't ready yet.
        derivePlanItems(from: r.plan)
    }

    // MARK: - Plan timeline derivation (Phase 1: client-side heuristics)

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

    /// Recomputes `.now` / `.next` / `.later` for items whose status isn't a
    /// user-set `.done`/`.skipped` (those are left untouched). Items within
    /// ±45 min of now become `.now`; the earliest future item beyond that
    /// window becomes `.next`; everything else — including past items we
    /// have no signal actually happened — stays `.later` rather than being
    /// guessed as done. Simple and deterministic; Phase 2 replaces this with
    /// server-tracked status.
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

    private func derivePlanItems(from plan: [TodayPlanItem]) {
        guard !plan.isEmpty else { return }

        // Preserve any user-set done/skipped status across re-derivation
        // (e.g. after a background refresh), matched by title since the
        // brief's meal names are stable within a day.
        let previousCoachStatus: [String: PlanItem.Status] = Dictionary(
            planItems
                .filter { $0.source == .coach && ($0.status == .done || $0.status == .skipped) }
                .map { ($0.title, $0.status) },
            uniquingKeysWith: { first, _ in first }
        )

        var mealItems = buildMealPlanItems(from: plan)
        for i in mealItems.indices {
            if let prev = previousCoachStatus[mealItems[i].title] {
                mealItems[i].status = prev
            }
        }

        var lightsOut = PlanItem(
            timeMinutes: 22 * 60 + 30,
            title: "Lights out",
            subtitle: "8h target",
            sfSymbol: "moon",
            status: .later,
            source: .coach,
            kind: .sleep
        )
        if let prev = previousCoachStatus[lightsOut.title] {
            lightsOut.status = prev
        }

        let userItems = planItems.filter { $0.source == .user }
        let nowMinutes = Self.minutesSinceMidnight(Date())

        planItems = computeStatuses(mealItems + [lightsOut] + userItems, nowMinutes: nowMinutes)
    }

    private static func minutesSinceMidnight(_ date: Date) -> Int {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    }

    // MARK: - Plan timeline mutations (local-only this phase)

    func setStatus(id: PlanItem.ID, _ status: PlanItem.Status) {
        guard let idx = planItems.firstIndex(where: { $0.id == id }) else { return }
        planItems[idx].status = status
    }

    func removeItem(id: PlanItem.ID) {
        planItems.removeAll { $0.id == id }
    }

    func addItem(_ item: PlanItem) {
        planItems.append(item)
        planItems = computeStatuses(planItems, nowMinutes: Self.minutesSinceMidnight(Date()))
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
