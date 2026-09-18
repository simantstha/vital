import Foundation
import SwiftUI

@MainActor
final class EntityDocumentViewModel: ObservableObject {
    @Published var document: EntityDocumentResponse? = nil
    @Published var isLoading = true
    @Published var errorMessage: String? = nil

    private let apiClient = APIClient.shared

    func load(id: String) async {
        withAnimation(Theme.Motion.appear) { isLoading = true }
        errorMessage = nil
        do {
            document = try await apiClient.fetchEntityDocument(id: id)
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "fetchEntityDocument")
        }
        withAnimation(Theme.Motion.appear) { isLoading = false }
    }

    // MARK: - Pure formatting helpers (testable)

    /// One fact "type" section, in first-seen order — `Dictionary(grouping:)`
    /// alone doesn't preserve order, and a stable, deterministic section
    /// order matters here (re-fetching the same document shouldn't reshuffle
    /// the screen).
    struct FactGroup: Identifiable {
        let type: String
        let facts: [EntityFact]
        var id: String { type }
    }

    static func groupFactsByType(_ facts: [EntityFact]) -> [FactGroup] {
        var order: [String] = []
        var buckets: [String: [EntityFact]] = [:]
        for fact in facts {
            if buckets[fact.type] == nil { order.append(fact.type) }
            buckets[fact.type, default: []].append(fact)
        }
        return order.map { FactGroup(type: $0, facts: buckets[$0] ?? []) }
    }

    /// "Aug 14, 2026" from an ISO-8601 `createdAt` (with or without
    /// fractional seconds). Falls back to the raw string rather than
    /// dropping the date entirely if it's unparseable — the evidence date is
    /// part of what makes a fact checkable.
    static func dateLabel(fromISO iso: String) -> String {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = withFractional.date(from: iso) ?? plain.date(from: iso) else { return iso }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "MMM d, yyyy"
        return formatter.string(from: date)
    }

    /// "Confirmed" (lime) for a user-confirmed fact, "From chat" (muted) for
    /// anything the coach picked up conversationally. Unrecognized sources
    /// fall back to a capitalized render of the raw value rather than
    /// disappearing, since the backend is the source of truth here.
    static func sourceBadgeText(_ source: String) -> String {
        switch source {
        case "confirmed": return "Confirmed"
        case "coach": return "From chat"
        default: return source.capitalized
        }
    }
}
