import Foundation
import SwiftUI

/// Drives the Memory tab: the user's own fact summary, the People list, and
/// the "Needs your confirmation" queue. The last of these reuses
/// `fetchPendingFacts()` / `resolvePendingFact(id:action:)` verbatim — no new
/// endpoints — same idiom as `TodayViewModel.resolveFact`.
@MainActor
final class MemoryViewModel: ObservableObject {

    @Published var selfFactCount: Int = 0
    @Published var selfFacts: [MemoryFact] = []
    @Published var entities: [MemoryEntitySummary] = []
    @Published var pendingFacts: [PendingFact] = []

    @Published var isLoading = true
    @Published var errorMessage: String? = nil
    @Published var toastMessage: String? = nil

    private let apiClient: MemoryAPIProviding

    init(apiClient: MemoryAPIProviding = APIClient.shared) {
        self.apiClient = apiClient
    }

    func load() async {
        withAnimation(Theme.Motion.appear) { isLoading = true }
        errorMessage = nil

        async let memoryTask = apiClient.fetchMemory()
        // Best-effort, same as Today's pending-facts load — a failure here
        // shouldn't block the About you / People cards from showing.
        async let factsTask: PendingFactsResponse? = try? await apiClient.fetchPendingFacts()

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

        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

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
}
