import Foundation
import Combine
import SwiftUI

// MARK: - Chat message model

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant, system }

    let id: UUID
    let role: Role
    var text: String
    let specialistMetadata: SpecialistMessageMetadata?

    var speakerLabel: String? {
        switch role {
        case .user: return nil
        case .assistant: return specialistMetadata?.name ?? CoachPersonaSnapshot.vital.title
        case .system: return nil
        }
    }

    init(
        id: UUID = UUID(),
        role: Role,
        text: String,
        specialistMetadata: SpecialistMessageMetadata? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.specialistMetadata = specialistMetadata
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
    private(set) var persona: CoachPersonaSnapshot
    private(set) var text: String = ""
    private(set) var toolCalls: [ToolCallRow] = []
    private(set) var dataCards: [CoachDataRow] = []
    private(set) var isFinished: Bool = false

    init(id: UUID, persona: CoachPersonaSnapshot = .vital) {
        self.id = id
        self.persona = persona
    }

    var speakerLabel: String { persona.title }

    // Text must never disappear once it has streamed in — a mid-turn tool
    // call describes work happening alongside/after the prose, not a reason
    // to hide it. `visibleText` used to blank out during `isChecking`; kept
    // as an alias for `text` so existing call sites don't need to change.
    var visibleText: String { text }

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

    mutating func updatePersona(_ persona: CoachPersonaSnapshot) {
        guard text.isEmpty else { return }
        self.persona = persona
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

// MARK: - Authoritative specialist lifecycle

enum CoachSpecialistState: Equatable {
    case vital
    case pendingProposal(CoachHandoffCard)
    case activeConsultation(CoachPersonaSnapshot)
    case pendingReturn(CoachHandoffCard)
    case recoverableRollback(String)
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
    @Published private(set) var activePersona: CoachPersonaSnapshot = .vital
    @Published private(set) var pendingHandoffCard: CoachHandoffCard? = nil
    @Published private(set) var specialistState: CoachSpecialistState = .vital
    @Published private(set) var isPerformingSpecialistAction: Bool = false

    /// Cheap signal for the view's scroll logic: increments once per reveal
    /// drain tick (see `pendingReveal` below) instead of `rows`, which would
    /// otherwise deep-compare the whole growing transcript on every token.
    @Published private(set) var revealVersion: Int = 0

    /// True from the moment recording stops until the cloud STT upload (or
    /// its fallback to the Apple transcript) has resolved and been handed
    /// off to `send()`.
    @Published var isTranscribing: Bool = false

    /// True while the fresh opener is being fetched (before any rows exist), so
    /// the view can show the typing indicator during load.
    @Published var isOpening: Bool = false

    private let api: any CoachAPIProviding
    private var streamTask: Task<Void, Never>? = nil
    private var openerTask: Task<Void, Never>? = nil
    private var actionTask: Task<Void, Never>? = nil
    private var hasRestoredConversation = false
    private var lastActivityAt: Date? = nil
    private var transcriptionTask: Task<Void, Never>? = nil

    // Server timestamps come from Date.toISOString(), which includes
    // fractional seconds — a default ISO8601DateFormatter can't parse those.
    // Cached (formatters are expensive to allocate); fractional first, plain
    // fallback. Same pattern as LogsViewModel.
    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoParserNF: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func parseISODate(_ string: String) -> Date? {
        isoParser.date(from: string) ?? isoParserNF.date(from: string)
    }

    /// The assistant message id for the in-flight turn. The bubble is inserted
    /// lazily on the first text delta (not up front), so the typing indicator
    /// renders where the reply will appear rather than below an empty bubble.
    private var pendingAssistantId: UUID? = nil

    // MARK: - Reveal buffer

    /// Network deltas queue here instead of landing straight in the turn.
    /// `speaker.feed(delta:)` still reads the raw delta directly in `send()` —
    /// only the visual path is buffered, so TTS is never delayed behind the
    /// reveal cadence.
    private var pendingReveal: String = ""
    private var revealTask: Task<Void, Never>? = nil
    /// Bumped every time `startRevealTaskIfNeeded()` spins up a new drain
    /// loop. A cancelled task's own exit path only nils `revealTask` if its
    /// captured generation still matches — otherwise a task cancelled by
    /// `flushPendingReveal()` (which nils `revealTask` itself) could resume
    /// just after a newer drain loop already started, nil out that newer
    /// task's handle, and let `startRevealTaskIfNeeded()` spawn a second
    /// concurrent drain loop that double-drains the buffer.
    private var revealGeneration: Int = 0
    /// The turn/persona the drain loop writes into — set on every enqueue so
    /// a mid-turn persona change (`.personaChanged`) is reflected even for
    /// text still sitting in the buffer.
    private var revealTargetId: UUID? = nil
    private var revealTargetPersona: CoachPersonaSnapshot? = nil

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

    /// Whether this view model backs the onboarding CoachIntro step. Exposed
    /// so the view can hide chat-management chrome (e.g. the New chat button).
    var isOnboarding: Bool { mode != nil }

    init(mode: String? = nil, api: any CoachAPIProviding = APIClient.shared) {
        self.mode = mode
        self.api = api
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

    /// Restores transcript and specialist UI state from the server. Message
    /// attribution is copied into each historical row so a later persona
    /// change cannot relabel a Running Coach response as Vital.
    func restoreConversation() async {
        await restoreConversation(force: false, preserveTranscript: false)
    }

    private func restoreConversation(force: Bool, preserveTranscript: Bool) async {
        guard mode == nil, force || !hasRestoredConversation else { return }
        do {
            let restoration = try await api.fetchCoachRestoration()
            if !preserveTranscript {
                rows = restoration.messages.compactMap(Self.restoredRow)
                // Extract newest message's timestamp for inactivity tracking
                if let newestMessage = restoration.messages.last,
                   let timestamp = Self.parseISODate(newestMessage.timestamp) {
                    lastActivityAt = timestamp
                }
            }
            activePersona = restoration.activePersona
            pendingHandoffCard = restoration.pendingCard
            hasRestoredConversation = true
            recomputeSpecialistState()
        } catch {
            // The GET endpoint is feature-flagged and may return 404 on an
            // older backend. Opener fallback preserves the legacy experience.
        }
    }

    private static func restoredRow(_ message: CoachRestoredMessage) -> ChatRow? {
        let role: ChatMessage.Role
        switch message.role {
        case "user": role = .user
        case "assistant": role = .assistant
        default: return nil
        }
        return .message(ChatMessage(
            id: UUID(uuidString: message.id) ?? UUID(),
            role: role,
            text: message.content,
            specialistMetadata: message.specialistMetadata
        ))
    }

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
            await restoreConversation()
            guard rows.isEmpty else { return }
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

        // Append user message. Animated: this is an insert-shaped mutation
        // (a brand-new row appearing), unlike the per-token text mutation
        // later, which must stay unanimated.
        withAnimation(Theme.Motion.appear) {
            rows.append(.message(ChatMessage(role: .user, text: trimmed)))
        }
        lastActivityAt = Date()

        // The assistant bubble is created lazily on the first token (see
        // appendText) so the typing indicator shows in its place until then.
        let assistantId = UUID()
        let assistantPersona = activePersona
        pendingAssistantId = assistantId

        isStreaming = true

        streamTask = Task {
            var turnPersona = assistantPersona
            var receivedVitalRollback = false
            defer {
                isStreaming = false
                pendingAssistantId = nil
            }

            do {
                let stream = api.streamCoach(message: trimmed, imageBase64: nil, mode: mode)
                for try await event in stream {
                    switch event {
                    case .text(let delta):
                        appendText(delta, toTurn: assistantId, persona: turnPersona)
                        // .toolCall/.toolData are never spoken — only prose.
                        if sentByVoice { speaker.feed(delta: delta) }
                    case .toolCall(let id, let name, let label, let done):
                        applyToolCall(id: id, name: name, label: label, done: done, toTurn: assistantId, persona: turnPersona)
                    case .toolData(let id, let viz):
                        applyToolData(id: id, viz: viz, toTurn: assistantId, persona: turnPersona)
                    case .handoffCard(let card):
                        applyHandoffCard(card)
                    case .personaChanged(let persona):
                        receivedVitalRollback = activePersona.id != "vital" && persona.id == "vital"
                        turnPersona = persona
                        updateTurnPersona(assistantId, persona: persona)
                        applyPersona(persona)
                    case .error(let message):
                        throw APIError.coachStreamError(message)
                    case .done:
                        break
                    }
                }
                flushPendingReveal()
                finishTurn(assistantId, persona: turnPersona)
                lastActivityAt = Date()
                if sentByVoice { speaker.finish() }
            } catch is CancellationError {
                // A deliberate stop (stopGenerating()) or teardown
                // (cancelStreaming()) already did its own cleanup
                // synchronously — this is just the for-await loop noticing
                // the cancellation afterward. Must not fall through to the
                // generic catch below, which would flash a fake "couldn't
                // reach the server" error over a reply the user chose to stop.
                return
            } catch {
                // Surface the error in the assistant bubble. Since the bubble is
                // created lazily, it may not exist yet (error before any token) —
                // insert one if the reply never started.
                flushPendingReveal()
                let errorText = "Sorry, I couldn't reach the server. Please try again."
                if let idx = rows.firstIndex(where: { $0.id == assistantId.uuidString }),
                   case .assistantTurn(var turn) = rows[idx] {
                    if turn.text.isEmpty { turn.appendText(errorText) }
                    turn.finish()
                    rows[idx] = .assistantTurn(turn)
                } else {
                    var turn = AssistantTurn(id: assistantId, persona: turnPersona)
                    turn.appendText(errorText)
                    turn.finish()
                    rows.append(.assistantTurn(turn))
                }
                errorMessage = error.localizedDescription
                if receivedVitalRollback {
                    specialistState = .recoverableRollback(error.localizedDescription)
                }
            }
        }
    }

    /// Cancels any in-flight coach stream. Called when the hosting view
    /// disappears (e.g. leaving the onboarding CoachIntro step mid-stream)
    /// so the typing indicator can't outlive the conversation on screen.
    func cancelStreaming() {
        streamTask?.cancel()
        streamTask = nil
        revealTask?.cancel()
        revealTask = nil
        pendingReveal = ""
        isStreaming = false
        openerTask?.cancel()
        openerTask = nil
        isOpening = false
        actionTask?.cancel()
        actionTask = nil
        isPerformingSpecialistAction = false
        transcriptionTask?.cancel()
        transcriptionTask = nil
        isTranscribing = false
        transcriber.stop()
        speaker.stop()
    }

    /// Composer "stop" tap: narrower than `cancelStreaming()`, which is a
    /// full teardown that also kills transcription and TTS.
    /// This only ends the in-flight reply. Implemented as a direct,
    /// synchronous cleanup rather than just cancelling `streamTask` and
    /// waiting — the `for try await` loop in `send()` only notices
    /// cancellation at its next suspension point, which can lag behind the
    /// tap, so the turn is flushed and finished here immediately instead.
    func stopGenerating() {
        guard isStreaming else { return }
        streamTask?.cancel()
        streamTask = nil
        flushPendingReveal()
        // Only finish a turn that already has a row. `finishTurn` goes
        // through `mutateTurn`, whose no-row branch lazily *creates* the row
        // — fine for a real in-flight reply, but stopping during the
        // thinking phase (before any token arrived) would otherwise append a
        // permanent empty `AssistantTurn` that renders nothing yet still
        // occupies a transcript slot.
        if let id = pendingAssistantId, rows.contains(where: { $0.id == id.uuidString }) {
            finishTurn(id, persona: revealTargetPersona ?? activePersona)
        }
        speaker.stop()
        isStreaming = false
        pendingAssistantId = nil
    }

    // MARK: - Manual chat reset

    /// Manually starts a new conversation. Guards against onboarding mode
    /// and concurrent streams. Calls server reset endpoint, then clears
    /// transcript and refreshes with a fresh opener.
    func startNewChat() {
        guard mode == nil, !isStreaming else { return }
        openerTask?.cancel()
        openerTask = nil
        isOpening = false

        Task {
            do {
                try await api.resetCoachConversation()
                rows = []
                errorMessage = nil
                pendingHandoffCard = nil
                activePersona = .vital
                hasRestoredConversation = false
                lastActivityAt = nil
                recomputeSpecialistState()
                loadOpener()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Checks for inactivity and resets the conversation if the 4-hour
    /// window (14400 seconds) has elapsed. Mirrors CONVERSATION_GAP_MS
    /// in lib/brain/conversationWindow.ts; server is authoritative.
    /// This is only the client-side trigger for stale conversations.
    func refreshIfStale() {
        guard mode == nil, !isStreaming, openerTask == nil else { return }
        guard let lastActivity = lastActivityAt else { return }
        let secondsSinceActivity = Date().timeIntervalSince(lastActivity)
        guard secondsSinceActivity > 4 * 3600 else { return }

        rows = []
        hasRestoredConversation = false
        loadOpener()
    }

    // MARK: - Specialist actions and authoritative events

    static func stableActionId(
        sessionId: String,
        cardOccurrenceId: String,
        action: SpecialistAction
    ) -> String {
        "ios:\(sessionId):\(cardOccurrenceId):\(action.rawValue)"
    }

    /// Executes an explicit card action. The in-flight flag is set before the
    /// task starts so repeated taps cannot race a second request onto the wire.
    func performSpecialistAction(_ action: SpecialistAction) {
        guard let card = pendingHandoffCard, !isPerformingSpecialistAction else { return }
        let sessionId = card.sessionId
        let cardOccurrenceId = card.cardOccurrenceId
        let actionId = Self.stableActionId(
            sessionId: sessionId,
            cardOccurrenceId: cardOccurrenceId,
            action: action
        )
        isPerformingSpecialistAction = true
        errorMessage = nil

        actionTask = Task {
            defer {
                isPerformingSpecialistAction = false
                actionTask = nil
            }
            do {
                for try await event in api.streamCoachAction(
                    sessionId: sessionId,
                    cardOccurrenceId: cardOccurrenceId,
                    actionId: actionId,
                    action: action
                ) {
                    switch event {
                    case .handoffCard(let card): applyHandoffCard(card)
                    case .personaChanged(let persona): applyPersona(persona)
                    case .error(let message): throw APIError.coachStreamError(message)
                    case .text, .toolCall, .toolData, .done: break
                    }
                }
            } catch {
                // An action failure is recoverable: return the controls to a
                // known Vital state and let a fresh restoration reconcile any
                // transition that may have completed server-side.
                activePersona = .vital
                pendingHandoffCard = nil
                specialistState = .recoverableRollback(error.localizedDescription)
                errorMessage = error.localizedDescription
                hasRestoredConversation = false
                await restoreConversation(force: true, preserveTranscript: true)
            }
        }
    }

    private func applyHandoffCard(_ card: CoachHandoffCard) {
        if card.phase == .dismissed {
            if pendingHandoffCard?.sessionId == card.sessionId &&
                pendingHandoffCard?.cardOccurrenceId == card.cardOccurrenceId {
                pendingHandoffCard = nil
            }
        } else {
            pendingHandoffCard = card
        }
        recomputeSpecialistState()
    }

    private func applyPersona(_ persona: CoachPersonaSnapshot) {
        let previous = activePersona
        activePersona = persona
        if persona.id == "vital" {
            pendingHandoffCard = nil
        }
        if previous.id == "vital", persona.id != "vital" {
            let joinedText = "\(persona.title) joined."
            let alreadyJoined = rows.contains {
                guard case .message(let message) = $0 else { return false }
                return message.role == .system && message.text == joinedText
            }
            if !alreadyJoined {
                rows.append(.message(ChatMessage(role: .system, text: joinedText)))
            }
        }
        recomputeSpecialistState()
    }

    private func recomputeSpecialistState() {
        if let card = pendingHandoffCard {
            switch card.phase {
            case .proposed:
                specialistState = .pendingProposal(card)
                return
            case .returnProposed:
                specialistState = .pendingReturn(card)
                return
            case .dismissed:
                break
            }
        }
        specialistState = activePersona.id == "vital"
            ? .vital
            : .activeConsultation(activePersona)
    }

    // MARK: - Row mutation helpers

    /// Entry point for every network text delta. Rather than writing straight
    /// into the turn, deltas queue in `pendingReveal` and a drain loop
    /// releases them at a steady cadence (see `startRevealTaskIfNeeded` /
    /// `drainRevealTick`) — this is what turns lumpy 3–40 character network
    /// bursts into a calm, finished-looking reveal instead of flickering text.
    private func appendText(_ delta: String, toTurn id: UUID, persona: CoachPersonaSnapshot) {
        guard !Theme.Motion.isReduced else {
            // Reduce Motion bypasses the buffer entirely: no reveal cadence
            // to animate, so there's nothing to gain from delaying the text.
            mutateTurn(id, persona: persona) { turn in
                turn.appendText(delta)
            }
            return
        }
        revealTargetId = id
        revealTargetPersona = persona
        pendingReveal += delta
        startRevealTaskIfNeeded()
    }

    private func startRevealTaskIfNeeded() {
        guard revealTask == nil else { return }
        revealGeneration += 1
        let generation = revealGeneration
        revealTask = Task { @MainActor [weak self] in
            while true {
                guard let self, !Task.isCancelled, !self.pendingReveal.isEmpty else {
                    // Only clear the handle if this is still the current
                    // generation — see `revealGeneration`'s doc comment.
                    if self?.revealGeneration == generation { self?.revealTask = nil }
                    return
                }
                self.drainRevealTick()
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    /// One reveal-buffer tick. The chunk size is adaptive rather than fixed —
    /// it targets draining the *current* backlog in ~7 frames (~120ms at
    /// 16ms/tick) instead of a constant characters-per-tick. That way a small
    /// burst trickles in smoothly over those 7 frames instead of landing in
    /// one, while a large backlog (e.g. the network catching up after a
    /// pause) still drains fast enough that the reveal never perceptibly
    /// falls behind the network.
    private func drainRevealTick() {
        let charsPerTick = max(1, Int(ceil(Double(pendingReveal.count) / 7.0)))
        let cut = pendingReveal.index(pendingReveal.startIndex, offsetBy: min(charsPerTick, pendingReveal.count))
        let chunk = String(pendingReveal[pendingReveal.startIndex..<cut])
        pendingReveal.removeSubrange(pendingReveal.startIndex..<cut)
        if let id = revealTargetId, let persona = revealTargetPersona {
            mutateTurn(id, persona: persona) { turn in
                turn.appendText(chunk)
            }
        }
        revealVersion += 1
    }

    /// Pushes any text still sitting in the reveal buffer straight into the
    /// turn and stops the drain loop. Called on stream done, on error, and
    /// from `stopGenerating()`, before the turn is finished — because the
    /// adaptive rate keeps the backlog small, this flush is imperceptible.
    private func flushPendingReveal() {
        revealTask?.cancel()
        revealTask = nil
        guard !pendingReveal.isEmpty else { return }
        let remaining = pendingReveal
        pendingReveal = ""
        if let id = revealTargetId, let persona = revealTargetPersona {
            mutateTurn(id, persona: persona) { turn in
                turn.appendText(remaining)
            }
            revealVersion += 1
        }
    }

    private func applyToolCall(id: String, name: String, label: String, done: Bool, toTurn turnId: UUID, persona: CoachPersonaSnapshot) {
        mutateTurn(turnId, persona: persona) { turn in
            turn.applyToolCall(id: id, name: name, label: label, done: done)
        }
    }

    private func applyToolData(id: String, viz: CoachViz, toTurn turnId: UUID, persona: CoachPersonaSnapshot) {
        // Card insertion is insert-shaped (a new row-level element appearing
        // in an existing turn), so unlike the per-token text mutation it's
        // animated — this is what makes the CoachDataCardView's
        // `.transition(.opacity.combined(with: .move(edge: .leading)))`
        // actually play instead of hard-cutting in.
        withAnimation(Theme.Motion.appear) {
            mutateTurn(turnId, persona: persona) { turn in
                turn.applyToolData(id: id, viz: viz)
            }
        }
    }

    private func finishTurn(_ id: UUID, persona: CoachPersonaSnapshot) {
        mutateTurn(id, persona: persona) { turn in
            turn.finish()
        }
    }

    private func updateTurnPersona(_ id: UUID, persona: CoachPersonaSnapshot) {
        guard let idx = rows.firstIndex(where: { $0.id == id.uuidString }),
              case .assistantTurn(var turn) = rows[idx]
        else { return }
        turn.updatePersona(persona)
        rows[idx] = .assistantTurn(turn)
    }

    private func mutateTurn(_ id: UUID, persona: CoachPersonaSnapshot, _ update: (inout AssistantTurn) -> Void) {
        if let idx = rows.firstIndex(where: { $0.id == id.uuidString }),
           case .assistantTurn(var turn) = rows[idx] {
            // Not animated: this branch is also hit by the per-token text
            // drain (~60x/second) once the turn exists, and animating that
            // would make every character spring in individually.
            update(&turn)
            rows[idx] = .assistantTurn(turn)
        } else {
            // Animated: this is the lazy creation of a brand-new turn row —
            // an insert, hit exactly once per turn — so it's what actually
            // lets the assistant bubble's `.transition(.opacity)` play.
            var turn = AssistantTurn(id: id, persona: persona)
            update(&turn)
            withAnimation(Theme.Motion.appear) {
                rows.append(.assistantTurn(turn))
            }
        }
    }
}
