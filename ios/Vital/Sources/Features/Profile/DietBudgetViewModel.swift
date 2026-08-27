import Foundation

/// Backs the Daily Budget editor. Local state drives the UI instantly; every
/// committed change is persisted via PATCH /api/diet-goal, which returns the
/// re-resolved budget (so the auto preview stays correct when the goal changes).
@MainActor
final class DietBudgetViewModel: ObservableObject {

    struct GoalOption: Identifiable {
        let id: String
        let label: String
    }

    // Fixed display order + labels for the four supported goals.
    static let goalLabels: [String: String] = [
        "weight_loss": "Lose weight",
        "muscle":      "Build muscle",
        "endurance":   "Endurance",
        "general":     "Maintain",
    ]

    @Published var isLoading = true
    @Published var isSaving = false
    @Published var errorMessage: String?

    @Published var mode = "auto"          // "auto" | "custom"
    @Published var goal = "general"
    @Published var targetKcal = 2000
    @Published var protein = 150
    @Published var carbs = 200
    @Published var fat = 67

    /// The auto-calculated values for the current goal — shown in Auto mode and
    /// previewed behind "Reset to auto".
    @Published var autoKcal = 2000
    @Published var autoProtein = 150
    @Published var autoCarbs = 200
    @Published var autoFat = 67

    @Published var goalOptions: [GoalOption] = []

    /// Set whenever the server's resolved budget is at/under the low-energy
    /// floor. Saving already happened (custom targets are never blocked) —
    /// this only drives the confirm-banner UI in the editor.
    @Published private(set) var lowEnergyWarning: LowEnergyWarning?
    /// The kcal value the user explicitly chose to keep despite the warning
    /// (via "Keep {value}"). Compared against `targetKcal` so the banner
    /// re-surfaces if they edit the number again.
    @Published private var acknowledgedLowEnergyKcal: Int?

    /// Whether the confirm banner + its two buttons should show. Custom mode
    /// only — an auto budget is never user-editable to a risky number.
    var showLowEnergyWarning: Bool {
        mode == "custom" && lowEnergyWarning != nil && acknowledgedLowEnergyKcal != targetKcal
    }

    private let api = APIClient.shared

    var goalDisplay: String { Self.goalLabels[goal] ?? "Maintain" }

    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let r = try await api.fetchDietGoal()
            apply(response: r)
            goalOptions = r.goals.map { GoalOption(id: $0, label: Self.goalLabels[$0] ?? $0) }
        } catch {
            errorMessage = "Couldn't load your budget."
        }
        isLoading = false
    }

    // ── Local mutations (each persists) ─────────────────────────────────────

    func setMode(_ newMode: String) {
        guard newMode != mode else { return }
        if newMode == "custom" {
            // Seed custom fields from whatever is showing now, so switching in
            // starts from a sensible split rather than blank.
            targetKcal = mode == "auto" ? autoKcal : targetKcal
            protein = mode == "auto" ? autoProtein : protein
            carbs = mode == "auto" ? autoCarbs : carbs
            fat = mode == "auto" ? autoFat : fat
        }
        mode = newMode
        Task { await persist() }
    }

    func setGoal(_ newGoal: String) {
        guard newGoal != goal else { return }
        goal = newGoal
        Task { await persist() }
    }

    func adjustKcal(by delta: Int) {
        targetKcal = max(800, min(6000, targetKcal + delta))
    }

    /// Commit the current custom numbers (called on stepper release / field commit / Done).
    func commit() { Task { await persist() } }

    func resetToAuto() { setMode("auto") }

    /// "Use {thresholdKcal}" — raises the target to the safe floor and saves.
    func useSafeFloor() {
        guard let threshold = lowEnergyWarning?.thresholdKcal else { return }
        targetKcal = threshold
        Task { await persist() }
    }

    /// "Keep {value}" — the target was already saved (custom targets are
    /// never blocked); this just acknowledges the warning so the banner
    /// stops showing for this value.
    func keepCurrentTarget() {
        acknowledgedLowEnergyKcal = targetKcal
    }

    // ── Networking ───────────────────────────────────────────────────────────

    private func persist() async {
        isSaving = true
        errorMessage = nil
        do {
            let r: DietGoalResponse
            if mode == "custom" {
                r = try await api.updateDietGoal(
                    goal: goal, mode: "custom",
                    targetKcal: targetKcal, protein: protein, carbs: carbs, fat: fat
                )
            } else {
                r = try await api.updateDietGoal(goal: goal, mode: "auto")
            }
            apply(response: r)
        } catch {
            errorMessage = "Couldn't save. Try again."
        }
        isSaving = false
    }

    private func apply(response r: DietGoalResponse) {
        mode = r.current.mode
        goal = r.current.goal
        targetKcal = r.current.targetKcal
        protein = r.current.protein
        carbs = r.current.carbs
        fat = r.current.fat
        lowEnergyWarning = r.current.lowEnergyWarning

        autoKcal = r.auto.targetKcal
        autoProtein = r.auto.protein
        autoCarbs = r.auto.carbs
        autoFat = r.auto.fat
    }
}
