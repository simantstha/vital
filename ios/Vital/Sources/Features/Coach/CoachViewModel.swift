import Foundation
import Combine

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

// MARK: - Inline data card row

/// An inline chart / stat card rendered from a chartable tool's structured
/// result (get_metric_trend / get_sleep_summary / compare_periods). Sits just
/// below its tool-call chip. `id` is the tool_call id it belongs to.
struct CoachDataRow: Identifiable, Equatable {
    let id: String
    let viz: CoachViz
}

// MARK: - Assistant answer bundle

/// One coach reply, grouped as stable UI: data cards first, transient tool
/// activity while work is in-flight, then the formatted prose answer.
struct AssistantTurn: Identifiable, Equatable {
    let id: UUID
    private(set) var text: String = ""
    private(set) var toolCalls: [ToolCallRow] = []
    private(set) var dataCards: [CoachDataRow] = []
    private(set) var isFinished: Bool = false

    var visibleText: String {
        isChecking ? "" : text
    }

    var statusSummary: String? {
        if let active = toolCalls.first(where: { !$0.isDone }) {
            return active.label
        }
        let completed = toolCalls.filter(\.isDone)
        guard !completed.isEmpty else { return nil }
        if completed.count == 1 {
            return completed[0].label
        }
        return "Checked " + completed.map { Self.summaryNoun(fromDoneLabel: $0.label) }.joined(separator: ", ")
    }

    var isChecking: Bool {
        toolCalls.contains { !$0.isDone }
    }

    mutating func appendText(_ delta: String) {
        text += delta
    }

    mutating func applyToolCall(id: String, name: String, label: String, done: Bool) {
        if let idx = toolCalls.firstIndex(where: { $0.id == id }) {
            var row = toolCalls[idx]
            row.isDone = done
            if done { row.label = Self.doneLabel(from: row.label) }
            toolCalls[idx] = row
        } else if !done {
            toolCalls.append(ToolCallRow(id: id, name: name, label: label))
        }
    }

    mutating func applyToolData(id: String, viz: CoachViz) {
        guard !dataCards.contains(where: { $0.id == id }) else { return }
        dataCards.append(CoachDataRow(id: id, viz: viz))
    }

    mutating func finish() {
        isFinished = true
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
        if text.hasPrefix("Pulling up ") {
            text = "Pulled up " + text.dropFirst("Pulling up ".count)
        }
        if text.hasPrefix("Looking at ") {
            text = "Looked at " + text.dropFirst("Looking at ".count)
        }
        text = text.replacingOccurrences(of: "your ", with: "")
        return text
    }

    private static func summaryNoun(fromDoneLabel label: String) -> String {
        var text = label
        for prefix in ["Checked ", "Pulled up ", "Looked at "] where text.hasPrefix(prefix) {
            text = String(text.dropFirst(prefix.count))
            break
        }
        return text
    }
}

// MARK: - Transcript row

/// A single row in the coach conversation. User/opener messages remain simple
/// bubbles; streaming coach replies are grouped into assistant turns so cards,
/// tool activity, and prose keep a stable order.
enum ChatRow: Identifiable, Equatable {
    case message(ChatMessage)
    case assistantTurn(AssistantTurn)

    var id: String {
        switch self {
        case .message(let m):       return m.id.uuidString
        case .assistantTurn(let t): return t.id.uuidString
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

    /// True from the moment recording stops until the cloud STT upload (or
    /// its fallback to the Apple transcript) has resolved and been handed
    /// off to `send()`.
    @Published var isTranscribing: Bool = false

    /// True while the fresh opener is being fetched (before any rows exist), so
    /// the view can show the typing indicator during load.
    @Published var isOpening: Bool = false

    private let api = APIClient.shared
    private var streamTask: Task<Void, Never>? = nil
    private var openerTask: Task<Void, Never>? = nil
    private var transcriptionTask: Task<Void, Never>? = nil

    /// The assistant message id for the in-flight turn. The bubble is inserted
    /// lazily on the first text delta (not up front), so the typing indicator
    /// renders where the reply will appear rather than below an empty bubble.
    private var pendingAssistantId: UUID? = nil

    // MARK: - Voice

    /// Tap-to-talk transcription and text-to-speech. Owned here (not by the
    /// view) so a stream survives view identity changes, and so `send()` can
    /// reach into the speaker directly.
    let transcriber = SpeechTranscriber()
    let speaker = CoachSpeaker()

    private var cancellables = Set<AnyCancellable>()

    /// True from the moment the mic is tapped until the resulting transcript
    /// has been handed off to `send()`. Guards the transcript-mirroring and
    /// stop→send bindings below.
    private var isVoiceInputActive = false

    /// Set right before a voice-originated `send()` call and consumed at the
    /// top of `send()`. Determines whether the reply is spoken aloud as it
    /// streams in — voice-in implies voice-out, typed messages stay silent.
    private var pendingSentByVoice = false

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
            if case .assistantTurn(let turn) = $0 { return turn.statusSummary != nil }
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
        bindVoice()
    }

    /// Forwards the two voice objects' own change notifications into this
    /// view model's `objectWillChange` so `CoachView` (which only observes
    /// `vm`, not `vm.transcriber`/`vm.speaker` directly) still re-renders on
    /// every transcript token and speaking-state flip. Also wires the two
    /// behavioral rules from the spec: live transcript mirrors into `input`
    /// while recording, and stopping the recording sends it.
    private func bindVoice() {
        transcriber.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        speaker.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        transcriber.$transcribedText
            .sink { [weak self] text in
                guard let self, self.isVoiceInputActive else { return }
                self.input = text
            }
            .store(in: &cancellables)

        transcriber.$isRecording
            .removeDuplicates()
            .sink { [weak self] recording in
                guard let self, self.isVoiceInputActive, !recording else { return }
                self.isVoiceInputActive = false
                self.finishVoiceInput()
            }
            .store(in: &cancellables)
    }

    // MARK: - Voice actions

    func requestVoicePermissions() async {
        await transcriber.requestPermissions()
    }

    /// Mic button action: tap once to start listening (mirroring the live
    /// transcript into the input field), tap again to stop and send it as a
    /// normal chat message, flagged so the reply is read aloud.
    func toggleVoiceRecording() {
        if transcriber.isRecording {
            transcriber.stop()
        } else {
            guard !isStreaming, !isTranscribing else { return }
            speaker.stop()
            input = ""
            isVoiceInputActive = true
            transcriber.start()
        }
    }

    /// Called once recording stops (manual tap or a watchdog auto-stop).
    /// Apple's live-preview transcript is the fallback; the accurate cloud
    /// transcript from `/api/stt` replaces it when the upload succeeds. Only
    /// sends if either transcript ended up non-empty.
    private func finishVoiceInput() {
        let appleTranscript = transcriber.transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)
        let recordingURL = transcriber.recordingURL
        guard !appleTranscript.isEmpty || recordingURL != nil else { return }

        isTranscribing = true
        transcriptionTask = Task {
            defer {
                isTranscribing = false
                transcriber.discardRecording()
            }

            var finalText = appleTranscript
            if let recordingURL,
               let cloudText = await api.uploadSTTAudio(fileURL: recordingURL),
               !cloudText.isEmpty {
                finalText = cloudText
            }

            // cancelStreaming() (fired by the view's onDisappear) cancels this task mid-upload.
            // A cancelled voice turn must not send.
            guard !Task.isCancelled else { return }

            let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                input = ""
                return
            }
            input = trimmed
            pendingSentByVoice = true
            send()
        }
    }

    // MARK: - External voice entry point (Today's voice FAB)

    /// Entry point for a transcript captured by a mic *outside* this view
    /// model's own tap-to-talk button — specifically Today's voice FAB
    /// (`Features/Today/VoiceFABView.swift`), which owns its own
    /// `SpeechTranscriber` instance and does its own record → cloud-STT
    /// upload, then hands the final transcript here so it flows through the
    /// exact same send/stream/speak pipeline as a Coach-tab voice turn: the
    /// message lands in this shared `rows` thread, and the reply is spoken
    /// aloud via `speaker` (voice-in implies voice-out — same rule
    /// `toggleVoiceRecording` already follows, no new setting invented).
    func sendExternalVoiceTranscript(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }
        speaker.stop()
        input = trimmed
        pendingSentByVoice = true
        send()
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

        let sentByVoice = pendingSentByVoice
        pendingSentByVoice = false

        input = ""
        errorMessage = nil

        // A new turn always interrupts any reply still being read aloud —
        // whether it's starting a fresh recording or sending (typed or
        // voice).
        speaker.stop()

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
                        appendText(delta, toTurn: assistantId)
                        // .toolCall/.toolData are never spoken — only prose.
                        if sentByVoice { speaker.feed(delta: delta) }
                    case .toolCall(let id, let name, let label, let done):
                        applyToolCall(id: id, name: name, label: label, done: done, toTurn: assistantId)
                    case .toolData(let id, let viz):
                        applyToolData(id: id, viz: viz, toTurn: assistantId)
                    }
                }
                finishTurn(assistantId)
                if sentByVoice { speaker.finish() }
            } catch {
                // Surface the error in the assistant bubble. Since the bubble is
                // created lazily, it may not exist yet (error before any token) —
                // insert one if the reply never started.
                let errorText = "Sorry, I couldn't reach the server. Please try again."
                if let idx = rows.firstIndex(where: { $0.id == assistantId.uuidString }),
                   case .assistantTurn(var turn) = rows[idx] {
                    if turn.text.isEmpty { turn.appendText(errorText) }
                    turn.finish()
                    rows[idx] = .assistantTurn(turn)
                } else {
                    var turn = AssistantTurn(id: assistantId)
                    turn.appendText(errorText)
                    turn.finish()
                    rows.append(.assistantTurn(turn))
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
        transcriptionTask?.cancel()
        transcriptionTask = nil
        isTranscribing = false
        transcriber.stop()
        speaker.stop()
    }

    // MARK: - Row mutation helpers

    private func appendText(_ delta: String, toTurn id: UUID) {
        mutateTurn(id) { turn in
            turn.appendText(delta)
        }
    }

    private func applyToolCall(id: String, name: String, label: String, done: Bool, toTurn turnId: UUID) {
        mutateTurn(turnId) { turn in
            turn.applyToolCall(id: id, name: name, label: label, done: done)
        }
    }

    private func applyToolData(id: String, viz: CoachViz, toTurn turnId: UUID) {
        mutateTurn(turnId) { turn in
            turn.applyToolData(id: id, viz: viz)
        }
    }

    private func finishTurn(_ id: UUID) {
        mutateTurn(id) { turn in
            turn.finish()
        }
    }

    private func mutateTurn(_ id: UUID, _ update: (inout AssistantTurn) -> Void) {
        if let idx = rows.firstIndex(where: { $0.id == id.uuidString }),
           case .assistantTurn(var turn) = rows[idx] {
            update(&turn)
            rows[idx] = .assistantTurn(turn)
        } else {
            var turn = AssistantTurn(id: id)
            update(&turn)
            rows.append(.assistantTurn(turn))
        }
    }
}
