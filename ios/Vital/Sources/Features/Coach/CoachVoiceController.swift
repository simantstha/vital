import Foundation
import Combine

// MARK: - SpeechTranscribing

/// Narrow protocol seam over `SpeechTranscriber`'s public surface (spec
/// `ux-spec-v4` §3.2/§10 V2), so `CoachVoiceController` can be driven by a
/// fake in unit tests — the same DI shape as `CoachAPIProviding`. Publishers
/// (rather than requiring `ObservableObject` conformance on the existential)
/// are what `CoachVoiceController` binds to internally; `SpeechTranscriber`
/// already has the backing `@Published` storage, so its conformance below is
/// just the projected-value plumbing.
@MainActor
protocol SpeechTranscribing: AnyObject {
    var transcribedText: String { get }
    var isRecording: Bool { get }
    var permissionState: SpeechPermissionState { get }
    var errorMessage: String? { get }
    var endpointDeadline: Date? { get }
    var recordingURL: URL? { get }

    var transcribedTextPublisher: AnyPublisher<String, Never> { get }
    var isRecordingPublisher: AnyPublisher<Bool, Never> { get }
    var endpointDeadlinePublisher: AnyPublisher<Date?, Never> { get }

    func start()
    func stop()
    func discardRecording()
    func refreshPermissionState()
    func requestPermissions() async
}

extension SpeechTranscriber: SpeechTranscribing {
    var transcribedTextPublisher: AnyPublisher<String, Never> { $transcribedText.eraseToAnyPublisher() }
    var isRecordingPublisher: AnyPublisher<Bool, Never> { $isRecording.eraseToAnyPublisher() }
    var endpointDeadlinePublisher: AnyPublisher<Date?, Never> { $endpointDeadline.eraseToAnyPublisher() }
}

// MARK: - CoachVoiceController

/// The single tap-to-talk pipeline shared by the Coach tab's mic and Today's
/// voice FAB (`ux-spec-v4` §3.2, delivery slice V2). Owns one
/// `SpeechTranscriber`, drives it through record → (cloud STT) →
/// final-transcript, and wires the per-turn `VoiceTurnTimer` (spec §10 V1)
/// for the recording leg.
///
/// One instance lives on `CoachViewModel` (`voiceController`), which is
/// itself the app's single shared voice-conversation owner (created once in
/// `RootTabView`, handed to both `CoachView` and `VoiceFABView`) — so a
/// recording started from either entry point is the same recording,
/// observable from both.
///
/// `state` is deliberately a small, additive enum: V5 (conversation mode,
/// spec §3.2's full state machine) adds `.thinking`/`.speaking`/`.interrupted`
/// alongside these four without changing what they mean, so callers that
/// switch on today's cases keep compiling once those land.
@MainActor
final class CoachVoiceController: ObservableObject {

    enum VoiceState: Equatable {
        /// Nothing in flight. The only state a new recording can start from.
        case idle
        /// Mic is live; `partialTranscript` mirrors the on-device preview.
        case listening
        /// Recording stopped (manual tap or a watchdog); waiting on the
        /// cloud STT upload (or, if there's no audio clip, resolving
        /// immediately from the on-device transcript).
        case transcribing
        /// The final transcript has been produced and handed to
        /// `onFinalTranscript`. Transient — the controller returns to
        /// `.idle` right after the hook returns.
        case sending
    }

    @Published private(set) var state: VoiceState = .idle

    /// Live transcript preview while `state == .listening` — mirrors
    /// `SpeechTranscriber.transcribedText`. Cleared at the start of every
    /// new recording.
    @Published private(set) var partialTranscript: String = ""

    /// Pass-through of the adaptive endpointing countdown (spec §3.3) for a
    /// future UI (the endpoint ring) to render — no view reads this yet.
    @Published private(set) var endpointDeadline: Date? = nil

    /// Mirrors `transcriber.isRecording` via `isRecordingPublisher` (see
    /// `bind()`) rather than being a computed pass-through — `CoachView` and
    /// `VoiceFABView` now observe only this controller, not the transcriber
    /// directly, so a transcriber-only change has to be a `@Published`
    /// change here too or those views never re-render for it.
    @Published private(set) var isRecording: Bool = false

    /// Mirrors `transcriber.permissionState`, re-read (not continuously
    /// bound — permission state changes only at three well-defined points)
    /// after `requestPermissions()`, after `refreshPermissionState()`, and
    /// once at `init`.
    @Published private(set) var permissionState: SpeechPermissionState

    /// Identifies the in-flight recording, set fresh in `startRecording()`.
    /// `VoiceFABView` captures this when *it* starts a recording so it can
    /// tell, via `lastDeliveredTurnID`, whether a later successful send was
    /// the turn it kicked off — without needing a second `onFinalTranscript`
    /// subscriber (the hook below is owned solely by `CoachViewModel`, per
    /// spec).
    @Published private(set) var currentTurnID: UUID? = nil

    /// Set to a turn's id the moment `onFinalTranscript` is invoked for it —
    /// i.e. only on a real, non-empty, non-cancelled send. Never set for a
    /// cancelled turn or an empty transcript, so a caller diffing this
    /// against a captured `currentTurnID` never fires on those.
    @Published private(set) var lastDeliveredTurnID: UUID? = nil

    /// Called exactly once per completed voice turn with the trimmed,
    /// non-empty final transcript — after cloud STT resolves, or immediately
    /// with the on-device transcript if STT has nothing to upload or fails.
    /// Never called for a turn ended by `cancel()` or one that produced no
    /// transcript. The owner (`CoachViewModel`) sets this once and uses it
    /// to `send()` — see that type's `bindVoice()`.
    var onFinalTranscript: ((String) -> Void)?

    /// The in-flight turn's latency instrumentation (spec §10 V1). Created
    /// in `startRecording()` and marked through the recording leg here;
    /// `CoachViewModel` reads it (via `onFinalTranscript`) to keep marking
    /// the send/TTS legs on the same instance before calling `finish()`.
    /// Stays set after delivery — only overwritten by the next
    /// `startRecording()` — so the owner has a stable window to grab it.
    private(set) var voiceTurnTimer: VoiceTurnTimer?

    private let transcriber: any SpeechTranscribing
    private let api: any CoachAPIProviding
    private var transcriptionTask: Task<Void, Never>?
    private var activeTurnID: UUID?
    private var cancellables = Set<AnyCancellable>()

    /// `transcriber` defaults to `nil` rather than `SpeechTranscriber()`
    /// directly: a function parameter's default *expression* is evaluated
    /// nonisolated at the call site (unlike a stored property initializer,
    /// which runs inside this type's own actor-isolated init), so a
    /// default that constructs a `@MainActor` type right in the signature
    /// fails to compile ("call to main actor-isolated initializer in a
    /// synchronous nonisolated context"). Falling back to
    /// `SpeechTranscriber()` inside the (already `@MainActor`) init body
    /// sidesteps that.
    init(
        transcriber: (any SpeechTranscribing)? = nil,
        api: any CoachAPIProviding = APIClient.shared
    ) {
        let transcriber = transcriber ?? SpeechTranscriber()
        self.transcriber = transcriber
        self.api = api
        self.isRecording = transcriber.isRecording
        self.permissionState = transcriber.permissionState
        bind()
    }

    private func bind() {
        transcriber.transcribedTextPublisher
            .sink { [weak self] text in
                guard let self, self.state == .listening else { return }
                self.partialTranscript = text
                if !text.isEmpty { self.voiceTurnTimer?.mark(.lastSpeechPartial) }
            }
            .store(in: &cancellables)

        transcriber.endpointDeadlinePublisher
            .sink { [weak self] deadline in self?.endpointDeadline = deadline }
            .store(in: &cancellables)

        // Unconditional mirror of the transcriber's `isRecording` — kept
        // separate from the endpoint-detection sink below (which filters on
        // `state == .listening` and needs `removeDuplicates()` for its
        // edge-triggered true→false logic) so `isRecording` always tracks
        // reality regardless of what state the controller thinks it's in.
        transcriber.isRecordingPublisher
            .sink { [weak self] recording in self?.isRecording = recording }
            .store(in: &cancellables)

        // Recording stopping while we're the one who started it (`.listening`)
        // is the endpoint firing (or a watchdog auto-stop) — move to
        // transcribing. A stop while idle/transcribing is a no-op echo of a
        // state we already caused ourselves (e.g. `discardRecording` doesn't
        // toggle this, but a defensive re-entrant `stop()` would).
        transcriber.isRecordingPublisher
            .removeDuplicates()
            .sink { [weak self] recording in
                guard let self, self.state == .listening, !recording else { return }
                self.voiceTurnTimer?.mark(.endpointFired)
                self.beginTranscription()
            }
            .store(in: &cancellables)
    }

    // MARK: - Permissions

    func requestPermissions() async {
        await transcriber.requestPermissions()
        permissionState = transcriber.permissionState
    }

    /// Re-reads permission state after a grant made in Settings — driven by
    /// `VoiceFABView`'s `didBecomeActiveNotification` handler (and available
    /// for `CoachView` to use the same way) so a grant is picked up without
    /// requiring an app relaunch.
    func refreshPermissionState() {
        transcriber.refreshPermissionState()
        permissionState = transcriber.permissionState
    }

    // MARK: - Recording

    /// Mic tap: start listening, or stop (and let the endpoint-fired binding
    /// above move to transcribing) if already recording.
    func toggleRecording() {
        if transcriber.isRecording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    /// No-op unless idle — a caller mid-transcription/sending that taps
    /// again must not stomp the turn already in flight; `toggleRecording()`
    /// routes a genuine "stop early" tap to `stopRecording()` instead, which
    /// stays available in every state that has a live recording.
    func startRecording() {
        guard state == .idle else { return }
        let turnID = UUID()
        activeTurnID = turnID
        currentTurnID = turnID
        partialTranscript = ""
        state = .listening
        voiceTurnTimer = VoiceTurnTimer()
        voiceTurnTimer?.mark(.recordingStart)
        transcriber.start()

        // `start()` is synchronous and can return without ever putting the
        // transcriber into a recording state — permission not authorized,
        // the recognizer unavailable, the audio session failing to activate
        // (e.g. mid phone-call), or the audio engine failing to start. The
        // endpoint-fired sink in `bind()` only reacts to a true→false
        // transition, so without this check a failed start would leave the
        // controller stuck in `.listening` forever — every later
        // `startRecording()` a silent no-op until relaunch.
        if !transcriber.isRecording {
            resetToIdleAfterEmptyTurn()
            partialTranscript = ""
        }
    }

    func stopRecording() {
        transcriber.stop()
    }

    /// Ends the in-flight turn — while listening or while awaiting STT — and
    /// delivers nothing. Idempotent.
    func cancel() {
        transcriptionTask?.cancel()
        transcriptionTask = nil
        transcriber.stop()
        transcriber.discardRecording()
        voiceTurnTimer = nil
        activeTurnID = nil
        currentTurnID = nil
        partialTranscript = ""
        state = .idle
    }

    // MARK: - Transcription

    private func beginTranscription() {
        let appleTranscript = transcriber.transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)
        let recordingURL = transcriber.recordingURL
        guard !appleTranscript.isEmpty || recordingURL != nil else {
            resetToIdleAfterEmptyTurn()
            return
        }

        state = .transcribing
        transcriptionTask = Task { [weak self] in
            guard let self else { return }
            defer { self.transcriber.discardRecording() }

            var finalText = appleTranscript
            if let recordingURL {
                self.voiceTurnTimer?.mark(.sttUploadStart)
                let cloudText = await self.api.uploadSTTAudio(fileURL: recordingURL)
                self.voiceTurnTimer?.mark(.sttUploadEnd)
                if let cloudText, !cloudText.isEmpty {
                    finalText = cloudText
                }
            }

            // A `cancel()` mid-upload already tore this task's flag down —
            // must not fall through to a send.
            guard !Task.isCancelled else { return }
            self.transcriptionTask = nil

            let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                self.resetToIdleAfterEmptyTurn()
                return
            }

            let turnID = self.activeTurnID
            self.state = .sending
            self.onFinalTranscript?(trimmed)
            self.lastDeliveredTurnID = turnID
            self.activeTurnID = nil
            self.currentTurnID = nil
            self.state = .idle
        }
    }

    private func resetToIdleAfterEmptyTurn() {
        voiceTurnTimer = nil
        activeTurnID = nil
        currentTurnID = nil
        state = .idle
    }
}
