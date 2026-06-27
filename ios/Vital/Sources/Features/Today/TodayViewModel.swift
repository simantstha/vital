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

struct MealRow: Identifiable {
    let id = UUID()
    let name: String
    let kcal: Int
    let reason: String
    let icon: String
}

// MARK: - ViewModel

@MainActor
final class TodayViewModel: ObservableObject {

    // Greeting
    @Published var greeting: String = ""
    @Published var dateSubtitle: String = ""
    @Published var streakDays: Int = 12

    // Coach insight — overwritten from /api/today
    @Published var coachInsight: String =
        "HRV's up 8 % and you slept 7h 40m — green light for a hard session today."

    // Biometrics — fallback values shown until data loads
    @Published var hrv = HRVMetric(value: 71, trend: .upGood, delta: "+8 %")
    @Published var sleep = SleepMetric(hours: 7, minutes: 40, trend: .upGood, delta: "+18 m")
    @Published var restingHR = RestingHRMetric(bpm: 52, trend: .downGood, delta: "−3")

    // Diet — driven from /api/today
    @Published var diet = DietCard(
        kcalConsumed: 1_160,
        kcalTarget:   2_400,
        protein: MacroProgress(current: 68,  target: 180),
        carbs:   MacroProgress(current: 142, target: 260),
        fat:     MacroProgress(current: 44,  target: 80)
    )

    // Today's plan — driven from /api/today
    @Published var meals: [MealRow] = []

    // Pending facts banner
    @Published var pendingFacts: [PendingFact] = []

    // MARK: - Dependencies

    private let healthKit = HealthKitManager()
    private let apiClient = APIClient.shared

    // MARK: - Init

    init() {
        refreshGreeting()
    }

    // MARK: - Called from TodayView.task

    func loadHealthData() async {
        // Run HealthKit + API calls concurrently
        async let healthTask: () = loadFromHealthKit()
        async let todayTask: () = loadTodayFromAPI()
        async let factsTask: () = loadPendingFacts()
        _ = await (healthTask, todayTask, factsTask)
    }

    // MARK: - Pending facts

    func resolveFact(id: String, action: String) async {
        do {
            try await apiClient.resolvePendingFact(id: id, action: action)
            pendingFacts.removeAll { $0.id == id }
        } catch {
            print("[Vital] resolvePendingFact failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Private loaders

    private func loadFromHealthKit() async {
        await healthKit.requestAuthorization()

        async let hrvTask       = healthKit.fetchLatestHRV()
        async let sleepTask     = healthKit.fetchLastNightSleep()
        async let restingHRTask = healthKit.fetchLatestRestingHR()

        let (hrvReading, sleepReading, restingHRReading) =
            await (hrvTask, sleepTask, restingHRTask)

        var deltas: [HealthDelta] = []

        if let r = hrvReading {
            // Only override HRV tile if /api/today hasn't loaded yet
            hrv = HRVMetric(
                value: Int(r.valueMs.rounded()),
                trend: .upGood,
                delta: "\(Int(r.valueMs.rounded())) ms"
            )
            deltas.append(HealthDelta(
                type: "hrv_reading",
                timestamp: r.timestamp,
                payload: ["valueMs": .double(r.valueMs)]
            ))
        }

        if let r = sleepReading {
            sleep = SleepMetric(
                hours: r.totalMinutes / 60,
                minutes: r.totalMinutes % 60,
                trend: .upGood,
                delta: "\(r.totalMinutes / 60)h \(r.totalMinutes % 60)m"
            )
            deltas.append(HealthDelta(
                type: "sleep_session",
                timestamp: r.bedTime,
                payload: ["totalMinutes": .int(r.totalMinutes)]
            ))
        }

        if let r = restingHRReading {
            restingHR = RestingHRMetric(
                bpm: Int(r.bpm.rounded()),
                trend: .downGood,
                delta: "\(Int(r.bpm.rounded())) bpm"
            )
            deltas.append(HealthDelta(
                type: "resting_hr_reading",
                timestamp: r.timestamp,
                payload: ["bpm": .double(r.bpm)]
            ))
        }

        if !deltas.isEmpty {
            do {
                try await apiClient.postIngest(deltas)
            } catch {
                print("[Vital] Ingest failed: \(error.localizedDescription)")
            }
        }
    }

    private func loadTodayFromAPI() async {
        do {
            let response = try await apiClient.fetchToday()
            applyTodayResponse(response)
        } catch {
            print("[Vital] fetchToday failed: \(error.localizedDescription)")
        }
    }

    private func applyTodayResponse(_ r: TodayResponse) {
        // Coach insight — keep the existing default if the brief isn't ready yet
        if !r.insight.isEmpty {
            coachInsight = r.insight
        }

        // Metrics — prefer API over HealthKit defaults
        let m = r.metrics

        // HRV
        let hrvTrend: TrendDirection = m.hrv.deltaPct >= 0 ? .upGood : .downBad
        let hrvSign = m.hrv.deltaPct >= 0 ? "+" : ""
        hrv = HRVMetric(
            value: Int(m.hrv.value.rounded()),
            trend: hrvTrend,
            delta: "\(hrvSign)\(m.hrv.deltaPct) %"
        )

        // Sleep — value is in hours (e.g. 7.8)
        let totalSleepMins = Int((m.sleep.value * 60).rounded())
        let sleepTrend: TrendDirection = m.sleep.deltaPct >= 0 ? .upGood : .downBad
        let sleepSign = m.sleep.deltaPct >= 0 ? "+" : ""
        sleep = SleepMetric(
            hours: totalSleepMins / 60,
            minutes: totalSleepMins % 60,
            trend: sleepTrend,
            delta: "\(sleepSign)\(m.sleep.deltaPct) %"
        )

        // Resting HR — lower is better
        let hrTrend: TrendDirection = m.restingHr.deltaPct <= 0 ? .downGood : .upBad
        let hrSign = m.restingHr.deltaPct >= 0 ? "+" : ""
        restingHR = RestingHRMetric(
            bpm: Int(m.restingHr.value.rounded()),
            trend: hrTrend,
            delta: "\(hrSign)\(m.restingHr.deltaPct) %"
        )

        // Diet budget
        let db = r.dietBudget
        // Derive macro targets from total kcal using standard splits: P 30%, C 40%, F 30%
        let proteinTarget = Int((Double(db.targetKcal) * 0.30 / 4).rounded())
        let carbsTarget   = Int((Double(db.targetKcal) * 0.40 / 4).rounded())
        let fatTarget     = Int((Double(db.targetKcal) * 0.30 / 9).rounded())

        diet = DietCard(
            kcalConsumed: db.consumedKcal,
            kcalTarget:   db.targetKcal,
            protein: MacroProgress(current: db.protein, target: proteinTarget),
            carbs:   MacroProgress(current: db.carbs,   target: carbsTarget),
            fat:     MacroProgress(current: db.fat,     target: fatTarget)
        )

        // Today's plan — map to MealRow, picking an icon by name heuristics.
        // Keep the existing default plan if the brief isn't ready yet.
        if !r.plan.isEmpty {
            meals = r.plan.map { item in
                MealRow(
                    name:   item.name,
                    kcal:   item.kcal,
                    reason: item.why,
                    icon:   mealIcon(for: item.name)
                )
            }
        }
    }

    private func loadPendingFacts() async {
        do {
            let response = try await apiClient.fetchPendingFacts()
            pendingFacts = response.items
        } catch {
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
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 0..<12: greeting = "Morning, Simant"
        case 12..<17: greeting = "Afternoon, Simant"
        default: greeting = "Evening, Simant"
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE · MMM d"
        dateSubtitle = formatter.string(from: Date())
    }
}
