import Foundation

/// Pure, unit-tested logic behind the redesigned Memory screen
/// (memory-contract.md §4) — grouping, origin/date copy, search filtering,
/// and the header's count sentence. Kept free of SwiftUI so every branch is
/// directly testable without a view host.
enum MemoryLogic {

    // MARK: - Groups

    /// `self.facts[].group` (memory-contract.md §1) — Health, Goals,
    /// Routines & preferences, Food, Other, in this fixed display order.
    /// `People` is a separate section the view appends after these, not a
    /// case here (entities never carry a `group`).
    enum Group: String, CaseIterable {
        case health
        case goals
        case routines
        case food
        case other

        var title: String {
            switch self {
            case .health:   return "Health"
            case .goals:    return "Goals"
            case .routines: return "Routines & preferences"
            case .food:     return "Food"
            case .other:    return "Other"
            }
        }
    }

    /// Client-side fallback used only when a fact's `group` is missing (an
    /// older server) — memory-contract.md §1's mapping, mirrored here so an
    /// old backend still renders sensible sections instead of dumping
    /// everything into "Other". Kept as ONE pure function, same as the
    /// server-side mapping the contract asks for.
    static func group(forType type: String) -> Group {
        switch type {
        case "Condition", "Medication", "Allergy", "Intolerance", "Injury", "LabMarker", "FamilyHistory":
            return .health
        case "Goal":
            return .goals
        case "Habit", "Schedule", "Routine":
            return .routines
        case "FoodPreference", "Cuisine", "PantryItem":
            return .food
        default:
            return .other
        }
    }

    /// The effective group for a fact: the server's `group` when present and
    /// recognized, otherwise the client-side fallback derived from `type`.
    static func group(for fact: MemoryFact) -> Group {
        if let raw = fact.group, let known = Group(rawValue: raw) {
            return known
        }
        return group(forType: fact.type)
    }

    /// One "Health"/"Goals"/… section — empty sections are never produced,
    /// so the view can render every entry in this array unconditionally.
    struct Section: Identifiable {
        let group: Group
        let facts: [MemoryFact]
        var id: String { group.rawValue }
    }

    /// Buckets `facts` into their groups, in `Group`'s fixed display order,
    /// preserving each fact's original relative order within its group.
    /// Groups with no facts are omitted entirely.
    static func groupedSections(facts: [MemoryFact]) -> [Section] {
        var buckets: [Group: [MemoryFact]] = [:]
        for fact in facts {
            buckets[group(for: fact), default: []].append(fact)
        }
        return Group.allCases.compactMap { group in
            guard let bucket = buckets[group], !bucket.isEmpty else { return nil }
            return Section(group: group, facts: bucket)
        }
    }

    // MARK: - Origin phrase + date line

    /// "told" | "noticed" | "confirmed" | "onboarding" (memory-contract.md
    /// §1) → the fact row's leading phrase. Anything else (including `nil`,
    /// for an older server) reads the same as "told" — matching the
    /// contract's own "anything unknown maps to told" rule for the server
    /// side of this mapping.
    static func originPhrase(_ origin: String?) -> String {
        switch origin {
        case "noticed":   return "Noticed from your data"
        case "confirmed": return "You confirmed"
        case "onboarding": return "Set in onboarding"
        default:          return "You told me"
        }
    }

    /// The fact row's secondary line: "<origin phrase> · <formatted date>",
    /// or just the origin phrase when `recordedAt` is missing (an older
    /// server, or a fact the server genuinely has no day for).
    static func sourceLine(origin: String?, recordedAt: String?, now: Date = Date()) -> String {
        let phrase = originPhrase(origin)
        guard let recordedAt, !recordedAt.isEmpty else { return phrase }
        return "\(phrase) · \(CoachActivityLogic.formattedSourceDate(recordedAt, now: now))"
    }

    /// The pending-fact card's secondary line — the evidence/reason text
    /// when the server sent one, otherwise the standard fallback.
    static func pendingReasonText(_ reason: String?) -> String {
        guard let reason, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "Noticed from your data"
        }
        return reason
    }

    // MARK: - Header count sentence

    /// "What I know about you — N things, only visible to you." — singular
    /// "1 thing" for a count of exactly one.
    static func headerSubline(factCount: Int) -> String {
        let noun = factCount == 1 ? "thing" : "things"
        return "What I know about you — \(factCount) \(noun), only visible to you."
    }

    // MARK: - Search

    /// Case- and diacritic-insensitive substring match, e.g. "cafe" matches
    /// "café". An empty (or all-whitespace) query matches everything, so
    /// callers can feed the search field's raw text straight through without
    /// special-casing "no search yet".
    static func matches(_ text: String, query: String) -> Bool {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else { return true }
        let foldedText = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        let foldedQuery = trimmedQuery.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        return foldedText.contains(foldedQuery)
    }

    static func filterFacts(_ facts: [MemoryFact], query: String) -> [MemoryFact] {
        facts.filter { matches($0.label, query: query) }
    }

    static func filterEntities(_ entities: [MemoryEntitySummary], query: String) -> [MemoryEntitySummary] {
        entities.filter { matches($0.label, query: query) }
    }
}
