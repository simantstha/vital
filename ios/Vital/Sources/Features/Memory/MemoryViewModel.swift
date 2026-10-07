import Foundation
import SwiftUI

/// Drives the redesigned Memory tab (memory-contract.md §4): the user's own
/// facts (searchable, grouped, editable), the People list, and the "Did I
/// get this right?" pending-confirmation card. The last of these reuses
/// `fetchPendingFacts()` / `resolvePendingFact(id:action:)` verbatim — no new
/// endpoints — same idiom as `TodayViewModel.resolveFact`.
@MainActor
final class MemoryViewModel: ObservableObject {

    @Published var selfFactCount: Int = 0
    @Published var selfFacts: [MemoryFact] = []
    @Published var entities: [MemoryEntitySummary] = []
    @Published var pendingFacts: [PendingFact] = []
    @Published var searchText: String = ""

    @Published var isLoading = true
    @Published var errorMessage: String? = nil
    @Published var toastMessage: String? = nil

    /// Non-nil while the Edit sheet is presented — the fact currently being
    /// edited. Set to `nil` to dismiss.
    @Published var editingFact: MemoryFact? = nil
    /// Non-nil while the Forget confirmation dialog is presented.
    @Published var factPendingForget: MemoryFact? = nil

    /// The profile's goal line ("Lose weight · 76 kg"), shown read-only in the
    /// Goals card. `nil` until loaded, or when the profile has no goal.
    @Published var goalSummary: String? = nil

    private let apiClient: MemoryAPIProviding
    /// Loads the canonical goal from the profile. Injectable so tests never
    /// touch the network; failures are non-fatal (the card just hides).
    private let goalLoader: @MainActor () async -> String?

    init(
        apiClient: MemoryAPIProviding = APIClient.shared,
        goalLoader: @escaping @MainActor () async -> String? = MemoryViewModel.loadProfileGoal
    ) {
        self.apiClient = apiClient
        self.goalLoader = goalLoader
    }

    /// Default goal source: `GET /api/diet-goal` (goal id) + `GET /api/profile`
    /// (targets) — exactly what `ProfileViewModel` composes its Goal row from.
    static func loadProfileGoal() async -> String? {
        let api = APIClient.shared
        guard let diet = try? await api.fetchDietGoal() else { return nil }
        let profile = try? await api.fetchProfile()
        return MemoryLogic.goalSummary(
            goalId: diet.current.goal,
            targetWeightKg: profile?.targetWeightKg,
            weeklySessions: profile?.weeklySessionsTarget,
            weeklyDistanceKm: profile?.weeklyDistanceKmTarget,
            system: UnitPreference.shared.current
        )
    }

    // MARK: - Derived, search-filtered display state

    /// Grouped, search-filtered facts — Health/Goals/Routines & preferences/
    /// Food/Other, empty groups omitted (`MemoryLogic.groupedSections`).
    var groupedSections: [MemoryLogic.Section] {
        MemoryLogic.groupedSections(facts: MemoryLogic.filterFacts(selfFacts, query: searchText))
    }

    /// Search-filtered People rows.
    var filteredEntities: [MemoryEntitySummary] {
        MemoryLogic.filterEntities(entities, query: searchText)
    }

    /// "What I know about you — N things, only visible to you."
    var headerSubline: String {
        MemoryLogic.headerSubline(factCount: selfFactCount)
    }

    // MARK: - Load

    func load() async {
        withAnimation(Theme.Motion.appear) { isLoading = true }
        errorMessage = nil

        async let memoryTask = apiClient.fetchMemory()
        // Best-effort, same as Today's pending-facts load — a failure here
        // shouldn't block the fact groups / People cards from showing.
        async let factsTask: PendingFactsResponse? = try? await apiClient.fetchPendingFacts()
        async let goalTask: String? = goalLoader()

        do {
            let memory = try await memoryTask
            selfFactCount = memory.selfSummary.factCount
            selfFacts = memory.selfSummary.facts
            entities = memory.entities
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "fetchMemory", includesAction: false)
        }

        if let response = await factsTask {
            pendingFacts = response.items
        }
        goalSummary = await goalTask

        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    // MARK: - "Did I get this right?"

    func resolveFact(id: String, action: String) async {
        do {
            try await apiClient.resolvePendingFact(id: id, action: action)
            withAnimation(Theme.Motion.standard) {
                pendingFacts.removeAll { $0.id == id }
            }
        } catch {
            if !error.isCancellation { toastMessage = "Couldn't save — try again" }
        }
    }

    // MARK: - Edit

    func startEdit(_ fact: MemoryFact) {
        editingFact = fact
    }

    /// Saves the edited label. Optimistic: the row shows the new label
    /// immediately (same id, so `ForEach` identity is stable through the
    /// round trip); on success it's replaced wholesale with the server's
    /// SUPERSEDEd node (a new id, per memory-contract.md §2), and on failure
    /// the original fact is restored and a toast shown.
    func saveEdit(fact: MemoryFact, newLabel: String) async {
        let trimmed = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != fact.label,
              let index = selfFacts.firstIndex(where: { $0.id == fact.id }) else {
            editingFact = nil
            return
        }

        let original = selfFacts[index]
        selfFacts[index] = MemoryFact(
            id: original.id, type: original.type, label: trimmed, isConstraint: original.isConstraint,
            recordedAt: original.recordedAt, origin: original.origin, group: original.group
        )
        editingFact = nil

        do {
            let updated = try await apiClient.editMemoryFact(id: fact.id, label: trimmed)
            if let currentIndex = selfFacts.firstIndex(where: { $0.id == original.id }) {
                selfFacts[currentIndex] = updated
            }
        } catch {
            if let currentIndex = selfFacts.firstIndex(where: { $0.id == original.id }) {
                selfFacts[currentIndex] = original
            }
            if !error.isCancellation { toastMessage = "Couldn't save — try again" }
        }
    }

    // MARK: - Forget

    func confirmForget(_ fact: MemoryFact) {
        factPendingForget = fact
    }

    /// Removes the row immediately (optimistic); restores it in place on
    /// failure, with a toast — same idiom as `saveEdit`.
    func forget(_ fact: MemoryFact) async {
        factPendingForget = nil
        guard let index = selfFacts.firstIndex(where: { $0.id == fact.id }) else { return }
        let original = selfFacts.remove(at: index)

        do {
            try await apiClient.undoMemoryFact(id: fact.id)
        } catch {
            let restoreIndex = min(index, selfFacts.count)
            selfFacts.insert(original, at: restoreIndex)
            if !error.isCancellation { toastMessage = "Couldn't save — try again" }
        }
    }
}
