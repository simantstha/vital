import Foundation
import Combine

// MARK: - Mock models (also used as fallback when HealthKit returns nil)

struct HRVMetric {
    let value: Int          // milliseconds
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
    let current: Int        // grams consumed
    let target: Int         // daily target grams
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
    var kcalRemaining: Int { kcalTarget - kcalConsumed }
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
    let icon: String        // SF Symbol name
}

// MARK: - ViewModel

@MainActor
final class TodayViewModel: ObservableObject {

    // Greeting
    @Published var greeting: String = ""
    @Published var dateSubtitle: String = ""
    @Published var streakDays: Int = 12

    // Coach
    @Published var coachInsight: String =
        "HRV's up 8 % and you slept 7h 40m — green light for a hard session today."

    // Biometrics — default values shown until HealthKit data loads
    @Published var hrv = HRVMetric(value: 71, trend: .upGood, delta: "+8 %")
    @Published var sleep = SleepMetric(hours: 7, minutes: 40, trend: .upGood, delta: "+18 m")
    @Published var restingHR = RestingHRMetric(bpm: 52, trend: .downGood, delta: "−3")

    // Diet (mock — real nutrition pipeline is future work)
    @Published var diet = DietCard(
        kcalConsumed: 1_160,
        kcalTarget:   2_400,
        protein: MacroProgress(current: 68,  target: 180),
        carbs:   MacroProgress(current: 142, target: 260),
        fat:     MacroProgress(current: 44,  target: 80)
    )

    // Meals (mock — MFP / Telegram pipeline is future work)
    @Published var meals: [MealRow] = [
        MealRow(name: "Oats + whey protein",
                kcal: 420,
                reason: "Slow carbs for sustained energy pre-training",
                icon: "sunrise.fill"),
        MealRow(name: "Grilled chicken bowl",
                kcal: 680,
                reason: "High protein midday — keeps muscle synthesis up",
                icon: "fork.knife"),
        MealRow(name: "Greek yoghurt + berries",
                kcal: 260,
                reason: "Antioxidants and probiotics post-workout",
                icon: "leaf.fill"),
        MealRow(name: "Salmon + roasted greens",
                kcal: 580,
                reason: "Omega-3 to support tonight's HRV recovery",
                icon: "moon.fill"),
    ]

    // MARK: - Dependencies

    private let healthKit = HealthKitManager()
    private let apiClient = APIClient.shared

    // MARK: - Init

    init() {
        refreshGreeting()
    }

    // MARK: - Called from TodayView.task

    /// Requests HealthKit authorization, loads real readings into the metric tiles,
    /// then posts the deltas to the backend (best-effort — network errors are swallowed).
    func loadHealthData() async {
        await healthKit.requestAuthorization()

        // Fetch all three readings concurrently
        async let hrvTask       = healthKit.fetchLatestHRV()
        async let sleepTask     = healthKit.fetchLastNightSleep()
        async let restingHRTask = healthKit.fetchLatestRestingHR()

        let (hrvReading, sleepReading, restingHRReading) =
            await (hrvTask, sleepTask, restingHRTask)

        var deltas: [HealthDelta] = []

        // HRV — update tile and queue delta
        if let r = hrvReading {
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

        // Sleep — update tile and queue delta
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

        // Resting HR — update tile and queue delta
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

        // POST to backend — best-effort; a failed ingest never surfaces to the user
        if !deltas.isEmpty {
            do {
                try await apiClient.postIngest(deltas)
            } catch {
                print("[Vital] Ingest failed (will retry next launch): \(error.localizedDescription)")
            }
        }
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
