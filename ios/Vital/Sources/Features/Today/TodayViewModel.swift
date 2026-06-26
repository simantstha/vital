import Foundation
import Combine

// MARK: - Mock models

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

    // Biometrics
    @Published var hrv = HRVMetric(value: 71, trend: .upGood, delta: "+8 %")
    @Published var sleep = SleepMetric(hours: 7, minutes: 40, trend: .upGood, delta: "+18 m")
    @Published var restingHR = RestingHRMetric(bpm: 52, trend: .downGood, delta: "−3")

    // Diet
    @Published var diet = DietCard(
        kcalConsumed: 1_160,
        kcalTarget:   2_400,
        protein: MacroProgress(current: 68,  target: 180),
        carbs:   MacroProgress(current: 142, target: 260),
        fat:     MacroProgress(current: 44,  target: 80)
    )

    // Meals
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

    init() {
        refreshGreeting()
    }

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
