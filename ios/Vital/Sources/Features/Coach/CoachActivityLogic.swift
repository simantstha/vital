import Foundation

/// Pure logic behind the "coach shows its work" UI (chat-activity-contract.md
/// §4) — the working card, the receipt pill/detail, and the memory chips.
/// Nothing here touches `AssistantTurn`/SwiftUI directly so it's plain,
/// synchronous, and unit-testable off the main actor.
enum CoachActivityLogic {

    // MARK: - Timing (contract §4's motion/appear-gate numbers)

    /// A running step must be running at least this long before the working
    /// card appears at all — avoids a flash for a tool call that resolves
    /// almost instantly.
    static let workingCardAppearDelay: TimeInterval = 0.4
    /// One step's fade + rise-in.
    static let stepAppearDuration: TimeInterval = 0.18
    /// The working card folding into the receipt pill.
    static let foldSpringDuration: TimeInterval = 0.32

    // MARK: - Kind → icon / grouping

    /// SF Symbol per `kind` (chat-activity-contract.md §1's `kind` enum).
    /// Unknown/missing kinds fall through to `"other"`'s icon, never a blank
    /// row.
    static func icon(forKind kind: String) -> String {
        switch kind {
        case "data": return "chart.xyaxis.line"
        case "memory": return "doc.text"
        case "action": return "checkmark.circle"
        case "calendar": return "calendar"
        default: return "sparkles"
        }
    }

    /// Derives `kind` from a tool `name` — used when a row/history item
    /// arrives with no `kind` at all (an older backend). Mirrors
    /// chat-activity-contract.md §1's table exactly.
    static func kind(forToolName name: String) -> String {
        switch name {
        case "read_memory", "write_memory", "append_observation", "query_ontology",
             "read_entity", "remember_fact", "propose_fact", "confirm_fact", "resolve_fact":
            return "memory"
        case "log_meal", "delete_meal", "log_weight", "log_workout", "update_diet_budget":
            return "action"
        case "get_schedule":
            return "calendar"
        case "get_metric_trend", "get_weight_trend", "get_sleep_summary", "get_workouts",
             "get_baseline", "compare_periods", "query_events", "get_training_history",
             "calculate_macros":
            return "data"
        default:
            return "other"
        }
    }

    /// Whether `kind` should render with the memory (purple) tint rather
    /// than the accent tint — chat-activity-contract.md §4: "memory in the
    /// purple tint and everything else in the accent tint".
    static func usesMemoryTint(_ kind: String) -> Bool { kind == "memory" }

    // MARK: - Working card vs. pill vs. nothing

    /// chat-activity-contract.md §4's visibility rules, decided all in one
    /// place so the view is a straight `switch` on the result:
    /// - `.none` — no tool calls in the turn at all.
    /// - `.workingCard` — a step is running, no prose has streamed yet, and
    ///   the oldest still-running step has been running ≥400 ms.
    /// - `.pill` — prose has started, or the turn is finished, or a step is
    ///   still running but hasn't cleared the 400 ms gate yet (nothing to
    ///   show but also nothing to hide behind — the pill degrades to
    ///   whatever's already completed, or is simply absent if nothing has).
    enum Presentation: Equatable {
        case none
        case workingCard
        case pill
    }

    static func presentation(
        hasActivity: Bool,
        hasRunningStep: Bool,
        oldestRunningStepAge: TimeInterval,
        hasProse: Bool,
        isFinished: Bool
    ) -> Presentation {
        guard hasActivity else { return .none }
        if hasRunningStep, !hasProse, !isFinished {
            return oldestRunningStepAge >= workingCardAppearDelay ? .workingCard : .none
        }
        return .pill
    }

    // MARK: - Receipt pill summary

    /// One row's contribution to the pill, abstracted away from
    /// `ToolCallRow` so this stays a plain-value pure function.
    struct PillEntry {
        let kind: String
        /// The done-form label this row would show in the receipt list —
        /// used to derive a short noun for the pill ("Sleep", "HRV", …).
        let label: String
        /// For a memory READ, how many notes it surfaced (defaults to 1 when
        /// unknown) — folded into one combined "N of your notes" entry
        /// rather than counted per tool call.
        let noteCount: Int

        init(kind: String, label: String, noteCount: Int = 1) {
            self.kind = kind
            self.label = label
            self.noteCount = noteCount
        }
    }

    /// "Sleep, HRV and 2 of your notes" — chat-activity-contract.md §4.
    /// Handles 1, 2 and 3+ items, and a memory-only turn (every entry
    /// collapses into the single notes phrase).
    static func pillSummary(_ entries: [PillEntry]) -> String {
        guard !entries.isEmpty else { return "" }
        let memoryNotes = entries.filter { $0.kind == "memory" }.reduce(0) { $0 + $1.noteCount }
        let otherLabels = entries.filter { $0.kind != "memory" }.map { noun(fromDoneLabel: $0.label) }

        var labels = otherLabels
        if memoryNotes > 0 {
            labels.append(memoryNotes == 1 ? "1 of your notes" : "\(memoryNotes) of your notes")
        }
        return joinedList(labels)
    }

    /// Oxford-style join: 1 → itself, 2 → "A and B", 3+ → "A, B and C".
    static func joinedList(_ labels: [String]) -> String {
        switch labels.count {
        case 0: return ""
        case 1: return labels[0]
        case 2: return "\(labels[0]) and \(labels[1])"
        default:
            let head = labels.dropLast().joined(separator: ", ")
            return "\(head) and \(labels[labels.count - 1])"
        }
    }

    /// Distills a done-form label ("Checked your sleep", "Compared HRV with
    /// your normal") down to its short subject noun ("Sleep", "HRV") for the
    /// pill. Falls back to the label itself, title-cased, if nothing
    /// recognizable strips off.
    static func noun(fromDoneLabel label: String) -> String {
        var text = label.trimmingCharacters(in: .whitespaces)
        for prefix in ["Checked ", "Compared ", "Pulled up ", "Looked at ", "Read ", "Logged ", "Got ", "Found "]
        where text.hasPrefix(prefix) {
            text = String(text.dropFirst(prefix.count))
            break
        }
        if text.hasPrefix("your ") { text = String(text.dropFirst(5)) }
        if text.hasPrefix("my ") { text = String(text.dropFirst(3)) }
        for cutter in [" with ", " vs ", " compared to ", " over ", " for ", " on ", " · "] {
            if let range = text.range(of: cutter) {
                text = String(text[..<range.lowerBound])
                break
            }
        }
        text = text.trimmingCharacters(in: .whitespaces)
        guard let first = text.first else { return label }
        return String(first).uppercased() + text.dropFirst()
    }

    // MARK: - Done-label fallback

    /// A short past-tense fallback for a tool call whose label is missing or
    /// empty — e.g. a history `activity` entry from a very old row. Not the
    /// server's own `doneLabel(name, input)` (§3) — a plain readable guess
    /// from the tool name alone.
    static func doneLabelFallback(forToolName name: String) -> String {
        let words = name.split(separator: "_").map(String.init)
        guard !words.isEmpty else { return "Checked that" }
        let readable = words.joined(separator: " ")
        return "Checked \(readable)"
    }

    /// `pillSummary(_:)` built directly from a turn's finished receipt rows
    /// (`AssistantTurn.receiptRows`) — a memory READ's `sources` count folds
    /// into the combined notes phrase; every other kind counts as one item.
    static func pillSummary(forRows rows: [ToolCallRow]) -> String {
        let entries = rows.filter(\.isDone).map { row in
            PillEntry(kind: row.resolvedKind, label: row.label, noteCount: row.sources?.count ?? 1)
        }
        return pillSummary(entries)
    }

    // MARK: - Source quote date

    /// Parses `source.date`'s wire format ("yyyy-MM-dd") in a fixed
    /// `en_US_POSIX` locale — the format never varies with the device's
    /// locale even though the rendered string does.
    private static let sourceDateParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Renders in the current locale: "4 Sep" for a date in `now`'s year,
    /// "4 Sep 2025" otherwise. Cached `DateFormatter`s, one per template, so
    /// repeated calls (one per quote row) don't re-derive the locale's
    /// preferred ordering on every render.
    private static let sameYearFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("dMMM")
        return formatter
    }()

    private static let otherYearFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("dMMMy")
        return formatter
    }()

    /// "You told me · 4 Sep" (current year) or "You told me · 4 Sep 2025"
    /// (any other year) from the raw "yyyy-MM-dd" wire string — falls back to
    /// the raw string unchanged if it doesn't parse.
    static func formattedSourceDate(_ raw: String, now: Date = Date()) -> String {
        guard let parsed = sourceDateParser.date(from: raw) else { return raw }
        let calendar = Calendar(identifier: .gregorian)
        let sameYear = calendar.component(.year, from: parsed) == calendar.component(.year, from: now)
        let formatter = sameYear ? sameYearFormatter : otherYearFormatter
        return formatter.string(from: parsed)
    }
}
