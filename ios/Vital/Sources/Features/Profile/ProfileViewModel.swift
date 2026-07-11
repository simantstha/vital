import Foundation
import SwiftUI

// MARK: - Stat cell model

struct ProfileStatCell: Identifiable {
    let id = UUID()
    let label: String
    let value: String
    let sfSymbol: String
}

enum ProfileUnitSystem: Equatable {
    case metric
    case us

    static func from(measurementSystem: Locale.MeasurementSystem) -> ProfileUnitSystem {
        measurementSystem == .us ? .us : .metric
    }
}

// MARK: - ViewModel

@MainActor
final class ProfileViewModel: ObservableObject {

    @Published var name: String = ""
    @Published var avatarInitial: String = "?"
    @Published var integrations: [ProfileIntegration] = []
    @Published var profileDetails: [ProfileStatCell] = []
    @Published var activityStats: [ProfileStatCell] = []
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
            let units = ProfileUnitSystem.from(measurementSystem: Locale.current.measurementSystem)
            profileDetails = Self.profileCells(from: response.profile, units: units)
            activityStats = Self.activityCells(from: response.stats)
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

    static func profileCells(from profile: ProfileDetails, units: ProfileUnitSystem) -> [ProfileStatCell] {
        [
            ProfileStatCell(label: "Age",            value: profile.age.map(String.init) ?? "--", sfSymbol: "person.fill"),
            ProfileStatCell(label: "Height",         value: formatHeight(profile.heightCm, units: units), sfSymbol: "ruler"),
            ProfileStatCell(label: "Current weight", value: formatWeight(profile.weightKg, units: units), sfSymbol: "scalemass"),
            ProfileStatCell(label: "Biological sex", value: profile.biologicalSex?.capitalized ?? "--", sfSymbol: "person.2.fill"),
        ]
    }

    static func activityCells(from s: ProfileStats) -> [ProfileStatCell] {
        [
            ProfileStatCell(label: "Logged days",    value: "\(s.loggedDays)", sfSymbol: "calendar"),
            ProfileStatCell(label: "Meals logged",   value: "\(s.mealsLogged)", sfSymbol: "fork.knife"),
            ProfileStatCell(label: "Avg HRV",        value: s.avgHrv.map { "\(Int($0.rounded())) ms" } ?? "--", sfSymbol: "waveform.path.ecg"),
            ProfileStatCell(label: "Workouts",       value: "\(s.workouts)", sfSymbol: "figure.run"),
        ]
    }

    private static func formatHeight(_ heightCm: Double?, units: ProfileUnitSystem) -> String {
        guard let heightCm else { return "--" }

        switch units {
        case .metric:
            return "\(Int(heightCm.rounded())) cm"
        case .us:
            let totalInches = Int((heightCm / 2.54).rounded())
            return "\(totalInches / 12)' \(totalInches % 12)\""
        }
    }

    private static func formatWeight(_ weightKg: Double?, units: ProfileUnitSystem) -> String {
        guard let weightKg else { return "--" }

        switch units {
        case .metric:
            return "\(formatNumber(weightKg, maximumFractionDigits: 1)) kg"
        case .us:
            return "\(Int((weightKg * 2.2046226218).rounded())) lb"
        }
    }

    private static func formatNumber(_ value: Double, maximumFractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = maximumFractionDigits
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
