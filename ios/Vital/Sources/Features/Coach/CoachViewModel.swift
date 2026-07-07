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

    // Starts empty — the opening line is fetched fresh from /api/coach/opener on
    // appear (see loadOpener), so the chat reflects the user's data instead of a
    // static greeting.
    @Published var rows: [ChatRow] = []

    @Published var input: String = ""
    @Published var isStreaming: Bool = false
    @Published var errorMessage: String? = nil

    /// True while the fresh opener is being fetched (before any rows exist), so
    /// the view can show the typing indicator during load.
    @Published var isOpening: Bool = false

    private let api = APIClient.shared
    private var streamTask: Task<Void, Never>? = nil
    private var openerTask: Task<Void, Never>? = nil

    /// The assistant message id for the in-flight turn. The bubble is inserted
    /// lazily on the first text delta (not up front), so the typing indicator
    /// renders where the reply will appear rather than below an empty bubble.
    private var pendingAssistantId: UUID? = nil

    // MARK: - Typing indicator

    /// Show the standalone typing indicator while the opener loads, or while a
    /// reply is streaming but no assistant text (or active tool call) has
    /// surfaced yet. Once tokens arrive the bubble takes over and the dots hide.
    var showTypingIndicator: Bool {
        if isOpening { return true }
        guard isStreaming else { return false }
        let assistantStarted = pendingAssistantId.map { id in
            rows.contains { $0.id == id.uuidString }
        } ?? false
        let hasActiveToolCall = rows.contains {
            if case .toolCall(let t) = $0 { return !t.isDone }
            return false
        }
        return !assistantStarted && !hasActiveToolCall
    }

    /// Passed through to every `/api/coach` call. Set to `"onboarding"` when
    /// this view model backs the CoachIntro onboarding step; nil (the
    /// default) for the regular Coach tab, which is unchanged.
    private let mode: String?

    init(mode: String? = nil) {
        self.mode = mode
    }

    // MARK: - Opener

    /// Fetches a fresh, data-aware opening line and inserts it as the first
    /// assistant row. No-op if the conversation already has any rows (so it
    /// never clobbers an in-progress chat) or if it's already loading. In
    /// onboarding mode the opener comes from the streaming coach itself, so we
    /// skip this entirely.
    func loadOpener() {
        guard mode == nil, rows.isEmpty, !isOpening, openerTask == nil else { return }
        isOpening = true
        openerTask = Task {
            defer {
                isOpening = false
                openerTask = nil
            }
            let text = (try? await api.fetchCoachOpener())
                ?? "Hey! I'm your Vital coach. Ask me anything about your health trends, sleep, or how to optimize your day."
            // The user may have started typing/sending while we waited — only
            // seed the opener if the transcript is still empty.
            if rows.isEmpty {
                rows.append(.message(ChatMessage(role: .assistant, text: text)))
            }
        }
    }

    // MARK: - Send

    func send() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }

        input = ""
        errorMessage = nil

        // A fresh send supersedes a still-loading opener.
        openerTask?.cancel()
        openerTask = nil
        isOpening = false

        // Append user message
        rows.append(.message(ChatMessage(role: .user, text: trimmed)))

        // The assistant bubble is created lazily on the first token (see
        // appendText) so the typing indicator shows in its place until then.
        let assistantId = UUID()
        pendingAssistantId = assistantId

        isStreaming = true

        streamTask = Task {
            defer {
                isStreaming = false
                pendingAssistantId = nil
            }

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
                // Surface the error in the assistant bubble. Since the bubble is
                // created lazily, it may not exist yet (error before any token) —
                // insert one if the reply never started.
                let errorText = "Sorry, I couldn't reach the server. Please try again."
                if let idx = rows.firstIndex(where: { $0.id == assistantId.uuidString }),
                   case .message(var m) = rows[idx] {
                    if m.text.isEmpty { m.text = errorText; rows[idx] = .message(m) }
                } else {
                    rows.append(.message(ChatMessage(id: assistantId, role: .assistant, text: errorText)))
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
        openerTask?.cancel()
        openerTask = nil
        isOpening = false
    }

    // MARK: - Row mutation helpers

    private func appendText(_ delta: String, toMessage id: UUID) {
        // Lazily create the assistant bubble on the first token so the typing
        // indicator (rendered while no bubble exists) is replaced in place.
        guard let idx = rows.firstIndex(where: { $0.id == id.uuidString }),
              case .message(var m) = rows[idx]
        else {
            rows.append(.message(ChatMessage(id: id, role: .assistant, text: delta)))
            return
        }
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
