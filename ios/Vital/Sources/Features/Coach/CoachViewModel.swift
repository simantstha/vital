import Foundation

// MARK: - Chat message model

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant }

    let id: UUID
    let role: Role
    var text: String

    init(id: UUID = UUID(), role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

// MARK: - Tool-call activity row

/// Transient (then collapsed) row rendered inline in the transcript while the
/// coach queries health data via a backend tool call, e.g. "Checking your HRV
/// trend…" → "Checked your HRV trend" once the tool_call "done" event arrives.
struct ToolCallRow: Identifiable, Equatable {
    let id: String   // tool_call id from the backend SSE event
    let name: String
    var label: String
    var isDone: Bool = false
}

// MARK: - Transcript row

/// A single row in the coach conversation — either a chat bubble or an inline
/// tool-call activity indicator. Both live in one ordered array so tool calls
/// render at the correct position relative to the surrounding message text.
enum ChatRow: Identifiable, Equatable {
    case message(ChatMessage)
    case toolCall(ToolCallRow)

    var id: String {
        switch self {
        case .message(let m):  return m.id.uuidString
        case .toolCall(let t): return "tool-\(t.id)"
        }
    }
}

// MARK: - ViewModel

@MainActor
final class CoachViewModel: ObservableObject {

    @Published var rows: [ChatRow] = [
        .message(ChatMessage(
            role: .assistant,
            text: "Hey! I'm your Vital coach. Ask me anything about your health trends, sleep, or how to optimize your day."
        ))
    ]

    @Published var input: String = ""
    @Published var isStreaming: Bool = false
    @Published var errorMessage: String? = nil

    private let api = APIClient.shared
    private var streamTask: Task<Void, Never>? = nil

    /// Passed through to every `/api/coach` call. Set to `"onboarding"` when
    /// this view model backs the CoachIntro onboarding step; nil (the
    /// default) for the regular Coach tab, which is unchanged.
    private let mode: String?

    init(mode: String? = nil) {
        self.mode = mode
    }

    // MARK: - Send

    func send() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }

        input = ""
        errorMessage = nil

        // Append user message
        rows.append(.message(ChatMessage(role: .user, text: trimmed)))

        // Create placeholder assistant message that we fill in as tokens arrive
        let assistantId = UUID()
        rows.append(.message(ChatMessage(id: assistantId, role: .assistant, text: "")))

        isStreaming = true

        streamTask = Task {
            defer { isStreaming = false }

            do {
                let stream = api.streamCoach(message: trimmed, mode: mode)
                for try await event in stream {
                    switch event {
                    case .text(let delta):
                        appendText(delta, toMessage: assistantId)
                    case .toolCall(let id, let name, let label, let done):
                        applyToolCall(id: id, name: name, label: label, done: done)
                    }
                }
            } catch {
                // Replace empty placeholder with error text so the bubble isn't blank
                if let idx = rows.firstIndex(where: { $0.id == assistantId.uuidString }),
                   case .message(var m) = rows[idx], m.text.isEmpty {
                    m.text = "Sorry, I couldn't reach the server. Please try again."
                    rows[idx] = .message(m)
                }
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Cancels any in-flight coach stream. Called when the hosting view
    /// disappears (e.g. leaving the onboarding CoachIntro step mid-stream)
    /// so the typing indicator can't outlive the conversation on screen.
    func cancelStreaming() {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }

    // MARK: - Row mutation helpers

    private func appendText(_ delta: String, toMessage id: UUID) {
        guard let idx = rows.firstIndex(where: { $0.id == id.uuidString }),
              case .message(var m) = rows[idx]
        else { return }
        m.text += delta
        rows[idx] = .message(m)
    }

    /// Appends a new activity row on "started"; flips the matching row to its
    /// collapsed done state on "done". Each tool_call id owns its own row, so
    /// multiple concurrent/sequential tool calls each render independently.
    private func applyToolCall(id: String, name: String, label: String, done: Bool) {
        let rowId = "tool-\(id)"
        if let idx = rows.firstIndex(where: { $0.id == rowId }),
           case .toolCall(var row) = rows[idx] {
            row.isDone = done
            if done { row.label = Self.doneLabel(from: row.label) }
            rows[idx] = .toolCall(row)
        } else if !done {
            rows.append(.toolCall(ToolCallRow(id: id, name: name, label: label)))
        }
    }

    /// Turns a present-tense label ("Checking your HRV trend…") into a short
    /// past-tense done tag ("Checked your HRV trend").
    private static func doneLabel(from label: String) -> String {
        var text = label.trimmingCharacters(in: .whitespaces)
        if text.hasSuffix("…") { text.removeLast() }
        if text.hasSuffix("...") { text.removeLast(3) }
        if text.hasPrefix("Checking ") {
            text = "Checked " + text.dropFirst("Checking ".count)
        }
        return text
    }
}
