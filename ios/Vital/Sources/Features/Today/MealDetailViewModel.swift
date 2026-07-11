import Foundation
import Combine

/// Drives the meal-detail modal presented when a Today plan row is tapped.
///
/// A planned meal arrives with a name, kcal, and a "why" reason but no macros,
/// so on open we auto-estimate protein/carbs/fat (`estimateOnOpen`). The user
/// can then tweak the meal in natural language (`applyModification`), pull a
/// recipe on demand (`loadRecipe`), or log it as-is (`logIt`).
@MainActor
final class MealDetailViewModel: ObservableObject {

    // Working meal state (macros fill in after the open estimate).
    @Published var name: String
    @Published var kcal: Int
    @Published var carbs: Int = 0
    @Published var protein: Int = 0
    @Published var fat: Int = 0
    @Published var macrosReady = false

    let reason: String                 // the plan's "why this" — shown as-is

    // Modify field
    @Published var instruction: String = ""

    // Recipe
    @Published var recipe: String = ""
    @Published var recipeExpanded = false

    // Loading / result flags
    @Published var isEstimating = false
    @Published var isModifying  = false
    @Published var isLoadingRecipe = false
    @Published var isLogging = false
    @Published var coachReaction: String? = nil
    @Published var didLog = false
    @Published var errorMessage: String? = nil

    private let api = APIClient.shared

    init(meal: MealRow) {
        self.name   = meal.name
        self.kcal   = meal.kcal
        self.reason = meal.reason
    }

    // MARK: - Auto-estimate macros on open

    func estimateOnOpen() async {
        guard !macrosReady, !isEstimating else { return }
        isEstimating = true
        defer { isEstimating = false }
        do {
            let r = try await api.modifyMeal(name: name, kcal: Double(kcal), instruction: nil)
            apply(r)
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] modifyMeal(estimate) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Apply a natural-language edit

    func applyModification() async {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isModifying else { return }
        isModifying = true
        defer { isModifying = false }
        do {
            let r = try await api.modifyMeal(name: name, kcal: Double(kcal), instruction: text)
            apply(r)
            // A changed meal invalidates any recipe already fetched.
            recipe = ""
            recipeExpanded = false
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] modifyMeal(edit) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Recipe (button-driven)

    func toggleRecipe() async {
        // Collapse if already open; otherwise expand and fetch if needed.
        if recipeExpanded {
            recipeExpanded = false
            return
        }
        recipeExpanded = true
        guard recipe.isEmpty, !isLoadingRecipe else { return }
        isLoadingRecipe = true
        defer { isLoadingRecipe = false }
        do {
            recipe = try await api.mealRecipe(name: name)
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] mealRecipe failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Log the meal

    func logIt() async {
        guard !isLogging else { return }
        isLogging = true
        defer { isLogging = false }
        do {
            let res = try await api.logMeal(
                name:   name,
                kcal:   Double(kcal),
                c:      Double(carbs),
                p:      Double(protein),
                f:      Double(fat),
                source: "plan"
            )
            coachReaction = res.coachReaction.isEmpty ? nil : res.coachReaction
            didLog = true
            ReminderScheduler.shared.mealLogged(at: Date())
        } catch {
            errorMessage = error.localizedDescription
            print("[Vital] logMeal(plan) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Helpers

    private func apply(_ r: MealModifyResult) {
        name    = r.name
        kcal    = Int(r.kcal.rounded())
        carbs   = Int(r.c.rounded())
        protein = Int(r.p.rounded())
        fat     = Int(r.f.rounded())
        macrosReady = true
    }
}
