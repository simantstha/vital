import Foundation
import SwiftUI

// MARK: - Stat cell model

struct ProfileStatCell: Identifiable {
    let id = UUID()
    let label: String
    let value: String
    let sfSymbol: String
}

// MARK: - ViewModel

@MainActor
final class ProfileViewModel: ObservableObject {

    @Published var name: String = ""
    @Published var avatarInitial: String = "?"
    @Published var integrations: [ProfileIntegration] = []
    @Published var stats: [ProfileStatCell] = []
    @Published var isLoading = true
    @Published var errorMessage: String? = nil

    // Diet budget summary for the Nutrition entry point.
    @Published var budgetKcal: Int?
    @Published var budgetMode: String = "auto"   // "auto" | "custom"
    @Published var budgetGoalLabel: String = ""

    private let apiClient = APIClient.shared

    func load() async {
        isLoading = true
        do {
            let response = try await apiClient.fetchProfile()
            name = response.name
            avatarInitial = String(response.name.prefix(1)).uppercased()
            integrations = response.integrations
            stats = buildStats(from: response.stats)
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] fetchProfile failed: \(error.localizedDescription)")
        }
        await loadBudget()
        isLoading = false
    }

    /// Loads the diet-budget summary shown on the Nutrition row. Called on
    /// initial load and again when the editor is dismissed so the row updates.
    func loadBudget() async {
        do {
            let r = try await apiClient.fetchDietGoal()
            budgetKcal = r.current.targetKcal
            budgetMode = r.current.mode
            budgetGoalLabel = DietBudgetViewModel.goalLabels[r.current.goal] ?? r.current.goal
        } catch {
            // Non-fatal — the row just shows a neutral placeholder.
            print("[Vital] fetchDietGoal failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Private

    private func buildStats(from s: ProfileStats) -> [ProfileStatCell] {
        [
            ProfileStatCell(label: "Logged days", value: "\(s.loggedDays)",         sfSymbol: "calendar"),
            ProfileStatCell(label: "Meals logged", value: "\(s.mealsLogged)",        sfSymbol: "fork.knife"),
            ProfileStatCell(label: "Avg HRV",      value: "\(Int(s.avgHrv.rounded())) ms", sfSymbol: "waveform.path.ecg"),
            ProfileStatCell(label: "Workouts",     value: "\(s.workouts)",           sfSymbol: "figure.run"),
        ]
    }
}
