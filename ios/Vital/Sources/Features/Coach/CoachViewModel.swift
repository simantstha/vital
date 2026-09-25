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

// MARK: - Inline meal receipt row

/// The receipt inserted into the transcript for a `log_meal` tool call
/// (`meal_logged` SSE event) — the coach half of "meal logs instant + Undo".
/// Lives in the turn (not a 5-second toast) so Undo stays reachable for the
/// whole session, exactly like `LogReceiptCard`'s doc comment describes.
struct MealReceiptRow: Identifiable, Equatable {
    /// The backend `events` row id — what `APIClient.deleteMealLog(id:)`
    /// deletes and what Undo is keyed on.
    let id: String
    let name: String
    // var (not let): scaleMealLog(id:factor:) rewrites these in place via
    // updateMealReceiptMacros after a successful portion-chip correction —
    // the row keeps its identity (id/name/timestamp), only the macros change.
    var kcal: Int
    var protein: Int
    var carbs: Int
    var fat: Int
    /// Preformatted at receipt-creation time (the event fires the moment the
    /// meal is inserted, i.e. "now") — see `CoachViewModel.timeString(_:)`.
    let timestamp: String
    var cardState: LogReceiptCard.State = .normal

    /// "520 kcal · 32P 40C 18F" — compact macro line for `LogReceiptCard`'s
    /// detail row (the title itself carries "Logged <name>").
    var detail: String {
        "\(kcal) kcal · \(protein)P \(carbs)C \(fat)F"
    }

    var canUndo: Bool {
        switch cardState {
        case .normal, .undoFailed: return true
        case .pending, .undoing, .undone: return false
        }
    }
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
    private(set) var mealReceipts: [MealReceiptRow] = []
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

    mutating func applyMealReceipt(_ receipt: MealReceiptRow) {
        guard !mealReceipts.contains(where: { $0.id == receipt.id }) else { return }
        mealReceipts.append(receipt)
    }

    /// Drives the receipt's Undo state machine (logged → undoing → removed /
    /// error). No-op if the id isn't in this turn.
    mutating func updateMealReceipt(id: String, state: LogReceiptCard.State) {
        guard let idx = mealReceipts.firstIndex(where: { $0.id == id }) else { return }
        mealReceipts[idx].cardState = state
    }

    /// Applies a successful `POST /api/meals/scale` result to a receipt's
    /// macros — the portion chips' (½× · 1× · 1.5× · 2×) effect. No-op if the
    /// id isn't in this turn.
    mutating func updateMealReceiptMacros(id: String, kcal: Int, protein: Int, carbs: Int, fat: Int) {
        guard let idx = mealReceipts.firstIndex(where: { $0.id == id }) else { return }
        mealReceipts[idx].kcal = kcal
        mealReceipts[idx].protein = protein
        mealReceipts[idx].carbs = carbs
        mealReceipts[idx].fat = fat
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

    /// Whether a turn is being produced by *either* entry point — a normal
    /// `send()` or an accepted handoff streaming the specialist's opening
    /// turn through `performSpecialistAction`. Both write to the same
    /// `rows`/`pendingAssistantId` state, so both mutually exclude each other
    /// (see the guards on those two methods) and every composer affordance
    /// that must not start a competing turn keys off this rather than
    /// `isStreaming` alone — otherwise the controls stay live during a
    /// handoff and their taps silently no-op against the guard.
    ///
    /// Deliberately *not* what the composer's stop button keys off:
    /// `stopGenerating()` only ends a `send()`, and a specialist action is
    /// not user-cancellable the same way, so that button stays bound to
    /// `isStreaming` and renders a disabled arrow (never a stop control)
    /// mid-handoff.
    var isBusy: Bool { isStreaming || isPerformingSpecialistAction }

    /// Cheap signal for the view's scroll logic: increments once per reveal
    /// drain tick (see `pendingReveal` below) instead of `rows`, which would
    /// otherwise deep-compare the whole growing transcript on every token.
    @Published private(set) var revealVersion: Int = 0

    /// Whether a voice turn is anywhere between "mic tapped" and "handed to
    /// `send()`" — recording, transcribing, or the transient hand-off — used
    /// to gate concurrent sends (typed or voice) against a voice turn still
    /// in flight. Views read `voiceController.state` directly for anything
    /// state-shaped (spec §4's "views observe the controller directly"
    /// note); this is app-level busy logic, not UI state.
    private var isVoiceTurnActive: Bool { voiceController.state != .idle }

    /// True while the fresh opener is being fetched (before any rows exist), so
    /// the view can show the typing indicator during load.
    @Published var isOpening: Bool = false

    /// The user's diet goal (`weight_loss | muscle | endurance | general`),
    /// fetched once per view-model lifetime and used to pick the Coach
    /// composer's starter chips (`CoachStarterChips.chips(for:)`). Defaults
    /// to `nil` (which the chip picker treats as `general`) until the fetch
    /// resolves, so a slow network never blocks the chips from rendering —
    /// they just start generic and refine once the goal loads.
    @Published private(set) var userGoal: String? = nil

    /// The derived latencies from the most recently completed voice turn
    /// (spec §10 V1 telemetry). Only the DEBUG voice HUD (`-VitalVoiceHUD`
    /// launch arg, `CoachView`) reads this — it's not shown in release UI.
    @Published private(set) var lastVoiceTurnDurations: VoiceTurnTimer.Durations? = nil

    private let api: any CoachAPIProviding
    private var streamTask: Task<Void, Never>? = nil
    private var openerTask: Task<Void, Never>? = nil
    private var actionTask: Task<Void, Never>? = nil
    private var hasRestoredConversation = false
    private var lastActivityAt: Date? = nil

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

    /// The single record→(cloud STT)→final-transcript pipeline shared by the
    /// Coach tab's mic and Today's voice FAB (`ux-spec-v4` §3.2, delivery
    /// slice V2). `CoachViewModel` is itself the app's one shared
    /// voice-conversation owner (see `RootTabView`), so owning the
    /// controller here — rather than each mic UI owning its own — is what
    /// makes a recording started from either entry point visible from both.
    let voiceController = CoachVoiceController()

    /// Text-to-speech for streamed replies. Owned here (not by the view) so
    /// a stream survives view identity changes, and so `send()` can reach
    /// into the speaker directly.
    let speaker = CoachSpeaker()

    private var cancellables = Set<AnyCancellable>()

    /// Set right before a voice-originated `send()` call and consumed at the
    /// top of `send()`. Determines whether the reply is spoken aloud as it
    /// streams in — voice-in implies voice-out, typed messages stay silent.
    private var pendingSentByVoice = false

    /// The current voice turn's latency instrumentation (spec §10 V1),
    /// captured from `voiceController.voiceTurnTimer` the moment its
    /// `onFinalTranscript` hook fires (see `bindVoice()`) and read through to
    /// `finish()` in the `speaker.onPlaybackStart` hook below. Nil for typed
    /// turns — every mark on it is a harmless no-op via optional chaining in
    /// that case.
    private var voiceTurnTimer: VoiceTurnTimer?

    // MARK: - Typing indicator

    /// Show the standalone typing indicator while the opener loads, or while a
    /// reply is streaming but no assistant text (or active tool call) has
    /// surfaced yet. Once tokens arrive the bubble takes over and the dots hide.
    var showTypingIndicator: Bool {
        if isOpening { return true }
        // `isPerformingSpecialistAction` also covers the gap after an
        // accepted handoff dismisses its card (nothing else on screen
        // signals activity there) up until the specialist's opening turn
        // produces its first token — without it the UI goes idle mid-handoff.
        guard isStreaming || isPerformingSpecialistAction else { return false }
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

    /// Forwards `speaker`'s change notifications into this view model's
    /// `objectWillChange` so `CoachView` (which observes `vm`, not
    /// `vm.speaker` directly) still re-renders on every speaking-state flip.
    /// `voiceController` is deliberately NOT forwarded here (spec §4's perf
    /// note on the old blanket-forwarding pattern) — `CoachView` observes it
    /// directly for anything voice-state-shaped. Also wires the hook that
    /// turns a completed voice turn into a normal `send()`.
    private func bindVoice() {
        speaker.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        // Post-V3 review fix: lets `CoachSpeaker.deactivateSession()` tell
        // whether a new recording is already live on the shared
        // `VoiceAudioSession` by the time this turn's playback finishes, so
        // it doesn't deactivate out from under it.
        speaker.isRecordingProvider = { [weak self] in self?.voiceController.isRecording ?? false }

        // The controller's one `onFinalTranscript` hook, owned exclusively
        // here regardless of which mic UI (Coach tab or Today's FAB) started
        // the recording — both share this same `voiceController`, so this is
        // the single place a finished voice turn becomes a chat message.
        voiceController.onFinalTranscript = { [weak self] text in
            guard let self else { return }
            self.voiceTurnTimer = self.voiceController.voiceTurnTimer
            self.speaker.stop()
            self.input = text
            self.pendingSentByVoice = true
            self.send()
        }

        // Fired once per voice turn, the moment the reply's first audio
        // actually starts playing — the last leg of the voice latency
        // budget (spec §3.4). Set once here rather than per-turn: `speaker`
        // is a single long-lived instance, and `voiceTurnTimer` (read at
        // fire time, not capture time) is whatever turn is currently
        // in-flight.
        speaker.onPlaybackStart = { [weak self] in
            guard let self, let timer = self.voiceTurnTimer else { return }
            timer.mark(.firstTTSAudioPlaybackStart)
            self.lastVoiceTurnDurations = timer.finish()
            // Spec §3.2, V5: Listening → Thinking already happened when
            // `send()` called `markThinking()`; this is Thinking → Speaking.
            // No-op outside conversation mode.
            self.voiceController.markSpeaking()
        }

        // Spec §3.2, V5: the reply's TTS queue drained naturally — re-arm
        // into "Your turn" then back to listening, no tap. No-op outside
        // conversation mode (see `CoachVoiceController.speakingFinished()`).
        speaker.onPlaybackFinished = { [weak self] in
            self?.voiceController.speakingFinished()
        }
    }

    // MARK: - Voice actions

    func requestVoicePermissions() async {
        await voiceController.requestPermissions()
    }

    /// Mic button action: tap once to start listening, tap again to stop —
    /// the resulting transcript is delivered through `voiceController`'s
    /// `onFinalTranscript` hook (wired in `bindVoice()`), which sends it as
    /// a normal chat message flagged so the reply is read aloud.
    ///
    /// `mode` (V5): which gesture is starting a *fresh* recording — plain
    /// push-to-talk (default, unchanged) or hands-free conversation mode.
    /// Irrelevant to the stop branch, which always just ends whatever's
    /// already in flight.
    func toggleVoiceRecording(mode: CoachVoiceController.ConversationMode = .single) {
        if voiceController.isRecording {
            voiceController.stopRecording()
        } else {
            // `!isBusy`: recording started mid-handoff would transcribe fine
            // and then hand off to `send()`, which the same flag rejects —
            // the user would speak a whole message into a silent no-op.
            // Stopping (the branch above) stays unconditional.
            guard !isBusy, !isVoiceTurnActive else { return }
            speaker.stop()
            input = ""
            voiceController.startRecording(mode: mode)
        }
    }

    /// `CoachOrb`'s End control (spec §3.2 "Ended", delivery slice V5):
    /// leaves conversation mode immediately, wherever it is in the turn —
    /// stops TTS if it's speaking (this view model is the only thing that
    /// owns both `speaker` and `voiceController`, so it's the one place
    /// that can do both), stops/discards any in-flight recording, cancels
    /// the "Your turn"/backgrounded-grace timers, and deactivates the
    /// shared audio session. Deliberately does NOT touch `streamTask`/
    /// `isStreaming` — an in-flight reply keeps streaming into the
    /// transcript exactly as a typed turn would, just silently, same as
    /// `stopGenerating()` not being conflated with this.
    func endVoiceConversation() {
        speaker.stop()
        voiceController.cancel()
    }

    // MARK: - External voice entry point (Today's voice FAB)

    /// Entry point for a transcript captured by a mic *outside* the Coach
    /// tab's own tap-to-talk button — specifically Today's voice FAB
    /// (`Features/Today/VoiceFABView.swift`). Both now record through the
    /// same shared `voiceController`, whose `onFinalTranscript` hook already
    /// routes every completed turn through this exact send/stream/speak
    /// pipeline — so in the normal case Today's FAB never needs to call
    /// this. It's kept as a public entry point for a transcript sourced any
    /// other way (or a future one), following the same "voice-in implies
    /// voice-out" rule `toggleVoiceRecording` does.
    func sendExternalVoiceTranscript(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // `!isBusy`: this funnels into `send()`, so bail before touching
        // `input`/`speaker` rather than letting that guard silently drop it.
        guard !trimmed.isEmpty, !isBusy else { return }
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

    /// Turns one restored message into a transcript row. A plain prose
    /// bubble (`.message`), unless the server attached `mealReceipts`
    /// (lib/specialists/restoration.ts's `attachMealReceipts`) — then this
    /// synthesizes the same `AssistantTurn` shape a live `meal_logged` SSE
    /// event would have built, so the `LogReceiptCard` + Undo survive a
    /// restart or conversation-window reset exactly like the live turn that
    /// created them; `undoMealLog(id:)` finds these receipts by searching
    /// `rows` the same way it finds a live one, so Undo needs no special
    /// casing here.
    private static func restoredRow(_ message: CoachRestoredMessage) -> ChatRow? {
        let role: ChatMessage.Role
        switch message.role {
        case "user": role = .user
        case "assistant": role = .assistant
        default: return nil
        }

        guard role == .assistant, let receipts = message.mealReceipts, !receipts.isEmpty else {
            return .message(ChatMessage(
                id: UUID(uuidString: message.id) ?? UUID(),
                role: role,
                text: message.content,
                specialistMetadata: message.specialistMetadata
            ))
        }

        var turn = AssistantTurn(
            id: UUID(uuidString: message.id) ?? UUID(),
            persona: Self.persona(forRestored: message)
        )
        turn.appendText(message.content)
        let timestamp = Self.parseISODate(message.timestamp).map { Self.timeFormatter.string(from: $0) } ?? ""
        for receipt in receipts {
            turn.applyMealReceipt(MealReceiptRow(
                id: receipt.id,
                name: receipt.name,
                kcal: receipt.kcal,
                protein: receipt.p,
                carbs: receipt.c,
                fat: receipt.f,
                timestamp: timestamp
            ))
        }
        turn.finish()
        return .assistantTurn(turn)
    }

    /// Reconstructs the `CoachPersonaSnapshot` a restored message was spoken
    /// by, from its (narrower) persisted `specialistMetadata` — Vital itself
    /// when there is none.
    private static func persona(forRestored message: CoachRestoredMessage) -> CoachPersonaSnapshot {
        guard let meta = message.specialistMetadata else { return .vital }
        return CoachPersonaSnapshot(
            id: meta.specialistId,
            title: meta.name,
            subtitle: meta.role,
            accent: meta.accentColor,
            icon: meta.icon,
            sessionId: message.specialistSessionId
        )
    }

    /// Fetches the user's diet goal for the starter chips (`userGoal`).
    /// Fire-and-forget: a failure just leaves `userGoal` nil, which
    /// `CoachStarterChips.chips(for:)` already treats as `general`.
    private func loadGoal() {
        guard mode == nil, userGoal == nil else { return }
        Task {
            userGoal = try? await api.fetchDietGoal().current.goal
        }
    }

    /// Fetches a fresh, data-aware opening line and inserts it as the first
    /// assistant row. No-op if the conversation already has any rows (so it
    /// never clobbers an in-progress chat) or if it's already loading. In
    /// onboarding mode the opener comes from the streaming coach itself, so we
    /// skip this entirely.
    func loadOpener() {
        loadGoal()
        guard mode == nil, rows.isEmpty, !isOpening, openerTask == nil else { return }
        isOpening = true
        openerTask = Task {
            defer {
                isOpening = false
                openerTask = nil
            }
            await restoreConversation()
            guard rows.isEmpty else { return }
            // `hasRestoredConversation`, at this point, means restoration
            // succeeded *and* found no messages to restore (had it found
            // any, `rows` wouldn't be empty and the guard above would have
            // already returned) — i.e. this is a verified fresh account with
            // no conversation history yet. If restoration instead failed
            // (feature-flagged/older backend), we can't tell, so this falls
            // back to the previous generic greeting rather than assuming
            // either state. Either way this reuses data already being
            // fetched for restoration — no extra network call.
            let text = (try? await api.fetchCoachOpener())
                ?? Self.fallbackOpenerText(isVerifiedNewConversation: hasRestoredConversation)
            // The user may have started typing/sending while we waited — only
            // seed the opener if the transcript is still empty.
            if rows.isEmpty {
                withAnimation(Theme.Motion.appear) {
                    rows.append(.message(ChatMessage(role: .assistant, text: text)))
                }
            }
        }
    }

    /// Shown when `/api/coach/opener` can't be reached and the transcript is
    /// verifiably brand new (no health data/history to reference yet) —
    /// invites the user to start somewhere instead of praising history they
    /// don't have.
    nonisolated static let newUserFallbackOpener =
        "Hi, I'm Vital, your coach. Tell me your goal, or just say what you ate or how you slept, and I'll take it from there."

    /// Shown when `/api/coach/opener` can't be reached and the transcript's
    /// new-vs-returning state is unknown (restoration itself failed) — the
    /// original neutral greeting, safe either way.
    nonisolated static let returningFallbackOpener =
        "Hey! I'm your Vital coach. Ask me anything about your health trends, sleep, or how to optimize your day."

    /// Pure selection rule, kept `nonisolated` so it's directly unit-testable
    /// with no `@MainActor` hop. `isVerifiedNewConversation` should be
    /// `hasRestoredConversation` read right after `restoreConversation()`
    /// returns with an empty transcript (see `loadOpener()`).
    nonisolated static func fallbackOpenerText(isVerifiedNewConversation: Bool) -> String {
        isVerifiedNewConversation ? newUserFallbackOpener : returningFallbackOpener
    }

    /// Pure send-enabled rule: whitespace-only or empty input never sends.
    /// Kept `nonisolated` (and free of any instance state) so it's directly
    /// unit-testable and reusable from `CoachView`'s `canSend`.
    nonisolated static func isSendableInput(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Nudge entry point (coach-nudge push notification)

    /// Entry point for a tapped `coach_nudge` push notification
    /// (`vital://coach-nudge/<pendingNudgeId>` — see `PushRoute.coachNudge`).
    /// Auto-starts the conversation's first turn with the nudge's finding
    /// attached as `findingId`, so the coach's reply engages with what it
    /// already nudged about (Task 15's `/api/coach` support) instead of the
    /// generic ephemeral opener. This is why PR #120's regression — a
    /// notification tap that opened a no-op sheet — can't happen here: the
    /// tap always lands in a live, context-aware exchange.
    ///
    /// The exact wording the model wrote for the push notification
    /// (`pending_nudges.payload.openingMessage`) is never sent to the client
    /// — only `findingId` is. This trigger phrase is what stands in for it:
    /// honest (it describes exactly what the user did), and it reads
    /// naturally even if a later `restoreConversation()` renders it back as
    /// an ordinary user message.
    func openFromNudge(findingId: String) {
        guard mode == nil, !isBusy else { return }
        // A nudge open supersedes the generic opener fetch — same rule
        // `send()` already applies to any opener fetch still in flight.
        openerTask?.cancel()
        openerTask = nil
        isOpening = false
        input = "I saw your notification — tell me more."
        send(findingId: findingId)
    }

    // MARK: - Send

    func send(findingId: String? = nil) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // `!isBusy` rather than `!isStreaming`: an accepted handoff/return can
        // now stream a real specialist turn on the action path (see
        // `performSpecialistAction`), so a send that lands mid-stream there
        // would race it for `pendingAssistantId` and `rows` — block it the
        // same way an in-flight `send()` already blocks a second `send()`.
        guard !trimmed.isEmpty, !isBusy else { return }

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
        // Spec §3.2, V5: "request in flight, no audio yet" — Listening (or
        // Transcribing/Sending) → Thinking. No-op outside conversation mode.
        if sentByVoice { voiceController.markThinking() }

        streamTask = Task {
            var turnPersona = assistantPersona
            var receivedVitalRollback = false
            if sentByVoice { voiceTurnTimer?.mark(.sendStart) }
            defer {
                isStreaming = false
                pendingAssistantId = nil
            }

            do {
                // voice: true switches the server's reply style when this turn
                // was sent by voice (see lib/brain/persona.ts's voiceStyleBlock).
                // clientTurnId is a fresh UUID per send so a retried request is
                // idempotent server-side (messages_user_client_turn_idx).
                let stream = api.streamCoach(
                    message: trimmed,
                    imageBase64: nil,
                    mode: mode,
                    findingId: findingId,
                    voice: sentByVoice,
                    clientTurnId: UUID().uuidString
                )
                try await drainCoachEvents(
                    stream,
                    assistantId: assistantId,
                    persona: &turnPersona,
                    speakDeltas: sentByVoice,
                    onPersonaChanging: { [self] persona in
                        receivedVitalRollback = activePersona.id != "vital" && persona.id == "vital"
                    }
                )
                flushPendingReveal()
                finishTurn(assistantId, persona: turnPersona)
                lastActivityAt = Date()
                if sentByVoice {
                    speaker.finish()
                    // Spec §3.2, V5: a reply that never produced any speech
                    // at all (e.g. a tool-only turn) would otherwise leave
                    // the controller stuck in `.thinking` forever —
                    // `onPlaybackStart`/`onPlaybackFinished` never fire for
                    // it. `speaker.isSpeaking` is already accurate by now:
                    // `finish()` above synchronously flushes (and enqueues)
                    // whatever's left in the buffer. No-op outside
                    // conversation mode.
                    if !speaker.isSpeaking {
                        voiceController.replyFinishedWithoutSpeaking()
                    }
                }
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
                let text = UserFacingError.message(for: error, context: .write, tag: "coach send")
                errorMessage = text
                if receivedVitalRollback {
                    specialistState = .recoverableRollback(text)
                }
                // Post-V3 review fix: a voice-initiated turn whose request
                // failed never reaches `speaker.finish()`/TTS, which is
                // otherwise what deactivates the shared `VoiceAudioSession`
                // — without this, a failed voice send would leave the
                // user's other audio ducked. `!speaker.isSpeaking` guards
                // against racing an unrelated reply still speaking.
                if sentByVoice, !speaker.isSpeaking {
                    VoiceAudioSession.deactivate()
                }
                // Spec §3.6, V5: a request failure (offline or otherwise)
                // ends conversation mode outright rather than sitting in
                // `.thinking` — the `errorMessage`/`ErrorCard` set above is
                // the "existing error surface" spec item 4 calls for.
                // No-op outside conversation mode.
                if sentByVoice {
                    voiceController.endConversation(reason: UserFacingError.isOffline(error) ? .offline : .requestFailed)
                }
            }
        }
    }

    /// Consumes one coach SSE stream into the transcript: text deltas append
    /// to the turn (and are spoken if `speakDeltas`), `tool_call`/`tool_data`
    /// mutate the same turn, `handoff_card` updates the authoritative card
    /// state, and `persona_changed` updates both `persona` (so any content
    /// that arrives after it — including the turn's own lazy creation — is
    /// attributed correctly) and the turn already on screen. `done` and
    /// unknown/no-op cases fall through; an `error` event throws so the
    /// caller's own catch block handles it the same way a transport failure
    /// would.
    ///
    /// Shared by `send()` and `performSpecialistAction()` — the two paths
    /// diverging (the action path used to silently drop `.text`) was the
    /// original defect this fixes, so this is the single place either path
    /// is allowed to interpret a `CoachStreamEvent`.
    private func drainCoachEvents(
        _ stream: AsyncThrowingStream<CoachStreamEvent, Error>,
        assistantId: UUID,
        persona: inout CoachPersonaSnapshot,
        speakDeltas: Bool,
        onPersonaChanging: ((CoachPersonaSnapshot) -> Void)? = nil
    ) async throws {
        for try await event in stream {
            switch event {
            case .text(let delta):
                appendText(delta, toTurn: assistantId, persona: persona)
                // .toolCall/.toolData are never spoken — only prose.
                if speakDeltas {
                    speaker.feed(delta: delta)
                    // First-write-wins inside VoiceTurnTimer, so marking on
                    // every delta (not just the first) is harmless.
                    voiceTurnTimer?.mark(.firstSSEToken)
                }
            case .toolCall(let id, let name, let label, let done):
                applyToolCall(id: id, name: name, label: label, done: done, toTurn: assistantId, persona: persona)
            case .toolData(let id, let viz):
                applyToolData(id: id, viz: viz, toTurn: assistantId, persona: persona)
            case .mealLogged(let receipt):
                applyMealLogged(receipt, toTurn: assistantId, persona: persona)
            case .mealUnlogged(let id):
                applyMealUnlogged(id: id)
            case .handoffCard(let card):
                applyHandoffCard(card)
            case .personaChanged(let newPersona):
                // Called before `persona` is overwritten, so callers can
                // still see the pre-change value (e.g. `send()` uses it to
                // detect a Vital rollback for error recovery).
                onPersonaChanging?(newPersona)
                persona = newPersona
                updateTurnPersona(assistantId, persona: newPersona)
                applyPersona(newPersona)
            case .error(let message):
                throw APIError.coachStreamError(message)
            case .done:
                break
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
        voiceController.cancel()
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
        // `!isBusy`: this clears `rows` and resets `activePersona`, so running
        // it while an accepted handoff is still streaming would drop the
        // specialist's opening turn into a transcript that was just emptied
        // and fight the persona the action is transitioning to.
        guard mode == nil, !isBusy else { return }
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
                errorMessage = UserFacingError.message(for: error, context: .write, tag: "resetCoachConversation")
            }
        }
    }

    /// Checks for inactivity and resets the conversation if the 4-hour
    /// window (14400 seconds) has elapsed. Mirrors CONVERSATION_GAP_MS
    /// in lib/brain/conversationWindow.ts; server is authoritative.
    /// This is only the client-side trigger for stale conversations.
    func refreshIfStale() {
        // `!isBusy`: like `startNewChat`, this empties `rows` — it must not
        // fire while an accepted handoff is streaming into them.
        guard mode == nil, !isBusy, openerTask == nil else { return }
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
        // `!isBusy`: a normal `send()` and an accepted handoff can now both
        // stream real content into `rows`/`pendingAssistantId` — the two must
        // never run concurrently (same guard `send()` uses, from the other
        // side).
        guard let card = pendingHandoffCard, !isBusy else { return }
        let sessionId = card.sessionId
        let cardOccurrenceId = card.cardOccurrenceId
        let actionId = Self.stableActionId(
            sessionId: sessionId,
            cardOccurrenceId: cardOccurrenceId,
            action: action
        )
        isPerformingSpecialistAction = true
        errorMessage = nil

        // Accepting a handoff/return can continue straight into the
        // specialist's (or Vital's) opening turn on the same SSE response —
        // `persona_changed` arrives before that turn's first token, so the
        // bubble is set up exactly like `send()`'s: created lazily on first
        // content, attributed via `persona` (updated as events land, see
        // `drainCoachEvents`) rather than the stale `activePersona` this
        // action is about to move away from.
        let assistantId = UUID()
        var turnPersona = activePersona
        pendingAssistantId = assistantId

        actionTask = Task {
            defer {
                // Stays set for the whole task — including any streamed
                // specialist reply, not just the two lifecycle events — so
                // `showTypingIndicator` (which also checks this flag) can't
                // report idle mid-handoff. Decline/replay have no reply to
                // stream, so this clears at the same point it always did:
                // once the (near-instant) stream closes.
                isPerformingSpecialistAction = false
                pendingAssistantId = nil
                actionTask = nil
            }
            do {
                let stream = api.streamCoachAction(
                    sessionId: sessionId,
                    cardOccurrenceId: cardOccurrenceId,
                    actionId: actionId,
                    action: action
                )
                try await drainCoachEvents(
                    stream,
                    assistantId: assistantId,
                    persona: &turnPersona,
                    speakDeltas: false
                )
                flushPendingReveal()
                // Decline and a replayed actionId never produce content, so
                // no turn row exists — only finish one if content actually
                // streamed, the same guard `stopGenerating()` uses to avoid
                // leaving a permanent empty bubble behind.
                if rows.contains(where: { $0.id == assistantId.uuidString }) {
                    finishTurn(assistantId, persona: turnPersona)
                    lastActivityAt = Date()
                }
            } catch is CancellationError {
                return
            } catch {
                // A partially-streamed specialist turn must not linger
                // unfinished (it would keep showing its streaming caret
                // forever) — finish it in place before rolling the UI back
                // to a known Vital state, mirroring `send()`'s own recovery.
                if let idx = rows.firstIndex(where: { $0.id == assistantId.uuidString }),
                   case .assistantTurn(var turn) = rows[idx] {
                    turn.finish()
                    rows[idx] = .assistantTurn(turn)
                }
                // An action failure is recoverable: return the controls to a
                // known Vital state and let a fresh restoration reconcile any
                // transition that may have completed server-side.
                activePersona = .vital
                pendingHandoffCard = nil
                let text = UserFacingError.message(for: error, context: .write, tag: "coach specialist action")
                specialistState = .recoverableRollback(text)
                errorMessage = text
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

    /// Formats "now" as e.g. "2:14 PM" for a fresh `MealReceiptRow` —
    /// `meal_logged` fires the instant `log_meal` inserts the row, so the
    /// wall-clock time it arrives IS the logged time (no server timestamp is
    /// sent on the event).
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    private func applyMealLogged(_ receipt: CoachMealReceipt, toTurn turnId: UUID, persona: CoachPersonaSnapshot) {
        let row = MealReceiptRow(
            id: receipt.id,
            name: receipt.name,
            kcal: receipt.kcal,
            protein: receipt.p,
            carbs: receipt.c,
            fat: receipt.f,
            timestamp: Self.timeFormatter.string(from: AppClock.now)
        )
        // Insert-shaped, same as applyToolData's card insertion — this is
        // what lets LogReceiptCard's own transition play instead of a hard cut.
        withAnimation(Theme.Motion.appear) {
            mutateTurn(turnId, persona: persona) { turn in
                turn.applyMealReceipt(row)
            }
        }

        // "Tell Today": a coach meal log is exactly as fresh as a manual one —
        // the fuel strip should not wait for pull-to-refresh. See
        // `Notification.Name.vitalCoachMealLogChanged`'s doc comment.
        NotificationCenter.default.post(name: .vitalCoachMealLogChanged, object: nil)
        ReminderScheduler.shared.mealLogged(slot: ReminderScheduler.timeAppropriateSlot(for: AppClock.now))
    }

    /// Finds which turn currently holds a receipt with this id — a receipt's
    /// turn isn't tracked separately from `rows`, so Undo (fired from a tap
    /// on the card, long after the turn stopped streaming) has to search for
    /// it the same way `mutateTurn` looks up any other row.
    private func turnId(containingMealReceipt id: String) -> UUID? {
        for row in rows {
            if case .assistantTurn(let turn) = row, turn.mealReceipts.contains(where: { $0.id == id }) {
                return turn.id
            }
        }
        return nil
    }

    /// `LogReceiptCard`'s Undo action for an inline coach meal receipt.
    /// Marks the card `.undoing`, calls the same delete endpoint the Diet
    /// sheet uses, then collapses it to "Removed" on success (with a
    /// Reduce-Motion-aware transition + haptic) or shows an inline error and
    /// leaves the card actionable for a retry on failure.
    func undoMealLog(id: String) {
        guard let turnId = turnId(containingMealReceipt: id) else { return }
        setMealReceiptState(id: id, turnId: turnId, state: .undoing, animated: false)

        Task {
            do {
                try await api.deleteMealLog(id: id)
                setMealReceiptState(
                    id: id, turnId: turnId, state: .undone,
                    animated: !Theme.Motion.isReduced
                )
                NotificationCenter.default.post(name: .vitalCoachMealLogChanged, object: nil)
            } catch {
                let message = UserFacingError.message(for: error, context: .write, tag: "coach undo meal log")
                setMealReceiptState(id: id, turnId: turnId, state: .undoFailed(message), animated: false)
            }
        }
    }

    /// `LogReceiptCard`'s portion-chip action (½× · 1× · 1.5× · 2×) for an
    /// inline coach meal receipt — POSTs the multiplier to
    /// `/api/meals/scale`, then rewrites the receipt's macros on success. No
    /// card-state transition (unlike Undo): the receipt stays `.normal` and
    /// actionable so the user can tap another chip. Silently no-ops on
    /// failure — a portion correction is a low-stakes convenience, not worth
    /// an inline error row, and the API-side kcal shown before the tap
    /// already stands.
    func scaleMealLog(id: String, factor: Double) {
        guard let turnId = turnId(containingMealReceipt: id) else { return }

        Task {
            do {
                let result = try await api.scaleMealLog(id: id, factor: factor)
                withAnimation(Theme.Motion.standard) {
                    mutateTurn(turnId, persona: activePersona) { turn in
                        turn.updateMealReceiptMacros(
                            id: id,
                            kcal: Int(result.kcal.rounded()),
                            protein: Int(result.p.rounded()),
                            carbs: Int(result.c.rounded()),
                            fat: Int(result.f.rounded())
                        )
                    }
                }
                NotificationCenter.default.post(name: .vitalCoachMealLogChanged, object: nil)
            } catch {
                // Best-effort — see doc comment above.
            }
        }
    }

    /// Handles a `meal_unlogged` SSE event: the coach's own `delete_meal`
    /// tool call (voice/text "undo that") just removed a meal it had logged.
    /// Reuses the same `.undone` ("Removed") state Undo drives, and the same
    /// "tell Today" notification, so the fuel strip and Diet sheet catch up
    /// exactly as they do for a manual Undo tap. No-op if the id isn't
    /// showing as a receipt in this session (e.g. it belonged to an earlier,
    /// already-restored turn not currently on screen).
    private func applyMealUnlogged(id: String) {
        guard let turnId = turnId(containingMealReceipt: id) else { return }
        setMealReceiptState(id: id, turnId: turnId, state: .undone, animated: !Theme.Motion.isReduced)
        NotificationCenter.default.post(name: .vitalCoachMealLogChanged, object: nil)
    }

    private func setMealReceiptState(id: String, turnId: UUID, state: LogReceiptCard.State, animated: Bool) {
        let update: () -> Void = { [self] in
            mutateTurn(turnId, persona: activePersona) { turn in
                turn.updateMealReceipt(id: id, state: state)
            }
        }
        if animated {
            withAnimation(Theme.Motion.standard, update)
        } else {
            update()
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
