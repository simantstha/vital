import Foundation
import Combine
import UIKit

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
    /// Normalized mic input level, `0...1` (V5: `CoachOrb`'s listening
    /// animation). 0 while not recording.
    var inputLevel: Float { get }

    var transcribedTextPublisher: AnyPublisher<String, Never> { get }
    var isRecordingPublisher: AnyPublisher<Bool, Never> { get }
    var endpointDeadlinePublisher: AnyPublisher<Date?, Never> { get }
    var inputLevelPublisher: AnyPublisher<Float, Never> { get }

    func start()
    func stop()
    func discardRecording()
    func refreshPermissionState()
    func requestPermissions() async
    func prewarm()
}

extension SpeechTranscriber: SpeechTranscribing {
    var transcribedTextPublisher: AnyPublisher<String, Never> { $transcribedText.eraseToAnyPublisher() }
    var isRecordingPublisher: AnyPublisher<Bool, Never> { $isRecording.eraseToAnyPublisher() }
    var endpointDeadlinePublisher: AnyPublisher<Date?, Never> { $endpointDeadline.eraseToAnyPublisher() }
    var inputLevelPublisher: AnyPublisher<Float, Never> { $inputLevel.eraseToAnyPublisher() }
}

// MARK: - VoiceAudioSessionControlling

/// Seam over `VoiceAudioSession`'s static API — same DI shape as
/// `transcriber`/`api` — so unit tests can assert *which* of
/// configure/activate/deactivate `CoachVoiceController` calls, and when,
/// without a real `AVAudioSession` (there is none in the test/simulator
/// process anyway). Closures are `@MainActor` since every call site here is
/// already on the main actor (this whole type is `@MainActor`).
struct VoiceAudioSessionControlling {
    var configure: @MainActor () -> Void
    var activate: @MainActor () -> Void
    var deactivate: @MainActor () -> Void

    static let live = VoiceAudioSessionControlling(
        configure: { try? VoiceAudioSession.configure() },
        activate: { try? VoiceAudioSession.activate() },
        deactivate: { VoiceAudioSession.deactivate() }
    )
}

// MARK: - VoiceScheduling

/// Seam over the two real-time delays conversation mode needs — the "Your
/// turn" pause before auto re-arm, and the backgrounded-too-long grace
/// window (spec `ux-spec-v4` §3.2, delivery slice V5) — so unit tests can
/// drive both deterministically instead of sleeping for real seconds. Same
/// DI shape as `VoiceAudioSessionControlling`.
struct VoiceScheduling {
    var sleep: @MainActor (TimeInterval) async -> Void

    static let live = VoiceScheduling(sleep: { seconds in
        try? await Task.sleep(for: .seconds(seconds))
    })
}

// MARK: - VoiceEnvironmentQuerying

/// Seam over `UIAccessibility.isVoiceOverRunning` (spec §3.8: "VoiceOver
/// defaults to push-to-talk" — i.e. a conversation-mode *request* is
/// downgraded to `.single` while VoiceOver is running) so tests can force
/// either answer without a real accessibility runtime.
struct VoiceEnvironmentQuerying {
    var isVoiceOverRunning: @MainActor () -> Bool

    static let live = VoiceEnvironmentQuerying(isVoiceOverRunning: { UIAccessibility.isVoiceOverRunning })
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
/// spec §3.2's full state machine) adds `.thinking`/`.speaking`/`.yourTurn`
/// alongside these four without changing what they mean, so callers that
/// switch on today's cases keep compiling once those land. `.interrupted`
/// (barge-in) is out of scope here — V7.
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
        /// `.idle` right after the hook returns, *unless* `CoachViewModel`
        /// has already moved it on to `.thinking` (conversation mode).
        case sending
        /// V5, conversation mode only: the request is in flight and no
        /// reply audio has started yet. Entered by `markThinking()`.
        case thinking
        /// V5, conversation mode only: `CoachSpeaker` is playing the reply.
        /// The mic is NOT live here (barge-in is out of scope — V7).
        /// Entered by `markSpeaking()`.
        case speaking
        /// V5, conversation mode only: the ~1s "Your turn" pause between a
        /// reply finishing and the mic re-arming, with no tap. Entered by
        /// `speakingFinished()`/`replyFinishedWithoutSpeaking()`.
        case yourTurn
    }

    /// Which entry-point gesture started (or is currently driving) the
    /// in-flight/most-recent voice turn — plain push-to-talk, or a
    /// hands-free conversation that auto re-arms after every reply (spec
    /// §3.2, delivery slice V5). Reset to `.single` whenever there is no
    /// live conversation (idle at rest, or after `endConversation()`), so a
    /// view can gate the `CoachOrb` on `mode == .conversation` alone.
    enum ConversationMode: Equatable {
        case single
        case conversation
    }

    /// Why a conversation ended — purely informational (nothing branches on
    /// it inside the controller); `CoachView`/`CoachOrb` can use it to pick
    /// the right toast/caption if a future PR wants one.
    enum ConversationEndReason: Equatable {
        case userEnded
        case tooManyEmptyListens
        case backgrounded
        case navigatedAway
        case requestFailed
        case offline
    }

    /// A transient voice-specific error surfaced as a caption (spec §3.6).
    /// Cleared as soon as the next listen produces real speech, or the
    /// conversation ends.
    enum VoiceError: Equatable {
        /// "Didn't catch that. Go ahead." — keeps listening; counts toward
        /// the 2-consecutive-empty-listens cap that ends conversation mode.
        case didntCatchThat
    }

    @Published private(set) var state: VoiceState = .idle

    /// `.conversation` for as long as a hands-free conversation is live —
    /// across every re-arm, not just the current turn — so a view can gate
    /// `CoachOrb` on this alone. `.single` at rest and for a plain
    /// push-to-talk turn.
    @Published private(set) var mode: ConversationMode = .single

    /// The most recent unresolved voice error (spec §3.6), or nil. Only
    /// `.didntCatchThat` is modeled here — offline and request-failure
    /// errors end the conversation outright and surface through
    /// `CoachViewModel.errorMessage`'s existing `ErrorCard`, not this.
    @Published private(set) var lastError: VoiceError? = nil

    /// Live transcript preview while `state == .listening` — mirrors
    /// `SpeechTranscriber.transcribedText`. Cleared at the start of every
    /// new recording.
    @Published private(set) var partialTranscript: String = ""

    /// Pass-through of the adaptive endpointing countdown (spec §3.3) for a
    /// future UI (the endpoint ring) to render — no view reads this yet.
    @Published private(set) var endpointDeadline: Date? = nil

    /// Mirrors `transcriber.inputLevel` (spec §3.2, `CoachOrb`'s listening
    /// animation, V5). Unconditional mirror like `isRecording` — a view
    /// only reads it while `state == .listening`, but nothing here needs to
    /// enforce that.
    @Published private(set) var inputLevel: Float = 0

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

    /// Bumped every time the controller transitions Listening → Transcribing
    /// (spec `ux-spec-v4` §6's `turnEnd` haptic — "Turn captured"). A view
    /// attaches `.sensoryFeedback(Theme.Haptics.turnEnd, trigger:
    /// voice.turnEndTrigger)` to fire it; this counter is also what
    /// `CoachVoiceControllerTests` observes, since UIKit haptics themselves
    /// aren't unit-testable. Only bumped on a real transition into
    /// `.transcribing` — an endpoint fire with nothing recognized goes
    /// straight back to `.idle` (`resetToIdleAfterEmptyTurn()`) and does not
    /// bump this.
    @Published private(set) var turnEndTrigger: Int = 0

    /// Bumped every time the controller re-arms into `.yourTurn` (spec §6's
    /// `yourTurn` haptic — "Mic re-armed"). Same observation shape as
    /// `turnEndTrigger`.
    @Published private(set) var yourTurnTrigger: Int = 0

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
    private let audioSession: VoiceAudioSessionControlling
    private let scheduling: VoiceScheduling
    private let environment: VoiceEnvironmentQuerying
    private var transcriptionTask: Task<Void, Never>?
    private var activeTurnID: UUID?
    private var cancellables = Set<AnyCancellable>()

    /// Consecutive listens (in conversation mode) that produced no
    /// transcript at all — reset the moment real speech is detected. Two in
    /// a row ends the conversation (spec §3.2/§3.6).
    private var emptyListenStreak = 0
    private static let maxConsecutiveEmptyListens = 2

    /// The `.yourTurn` pause before an automatic re-arm (spec §3.2's "Your
    /// turn" row) and the backgrounded-too-long grace window (spec §3.2's
    /// "app backgrounded > 10 s" ending) — both cancellable so a later End,
    /// a foregrounding, or a fresh turn can't have a stale one fire later.
    private var yourTurnTask: Task<Void, Never>?
    private var backgroundTask: Task<Void, Never>?
    private static let yourTurnDuration: TimeInterval = 1.0
    private static let backgroundGraceInterval: TimeInterval = 10

    /// Set once `prewarm()` has actually configured the session and
    /// prewarmed the transcriber — guards against redoing that work on
    /// every `.onAppear` (Coach tab and `VoiceFABView` both call it).
    /// Deliberately NOT set when `prewarm()` no-ops for lack of permission,
    /// so a later call made once permission is granted still does the real
    /// work.
    private var didPrewarm = false

    /// `transcriber` defaults to `nil` rather than `SpeechTranscriber()`
    /// directly: a function parameter's default *expression* is evaluated
    /// nonisolated at the call site (unlike a stored property initializer,
    /// which runs inside this type's own actor-isolated init), so a
    /// default that constructs a `@MainActor` type right in the signature
    /// fails to compile ("call to main actor-isolated initializer in a
    /// synchronous nonisolated context"). Falling back to
    /// `SpeechTranscriber()` inside the (already `@MainActor`) init body
    /// sidesteps that. `VoiceAudioSessionControlling` isn't `@MainActor`
    /// itself (it's a plain struct of closures), so `.live` as its default
    /// doesn't hit the same issue.
    init(
        transcriber: (any SpeechTranscribing)? = nil,
        api: any CoachAPIProviding = APIClient.shared,
        audioSession: VoiceAudioSessionControlling = .live,
        scheduling: VoiceScheduling = .live,
        environment: VoiceEnvironmentQuerying = .live
    ) {
        let transcriber = transcriber ?? SpeechTranscriber()
        self.transcriber = transcriber
        self.api = api
        self.audioSession = audioSession
        self.scheduling = scheduling
        self.environment = environment
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

        transcriber.inputLevelPublisher
            .sink { [weak self] level in self?.inputLevel = level }
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

    // MARK: - Pre-warm

    /// Configures (but never *activates*) the shared `VoiceAudioSession`
    /// ahead of the user's first tap (spec `ux-spec-v4` §3.4, §10 V3) —
    /// called from the Coach tab's and `VoiceFABView`'s `.onAppear`.
    ///
    /// **Must not call `audioSession.activate()`** (post-V3 review fix):
    /// `.onAppear` fires just from the Today tab being on screen, which is
    /// the launch screen — activating a `.duckOthers` session there would
    /// duck the user's music/podcast the instant they open the app, before
    /// they've touched the mic. `configure()` only sets the category/mode/
    /// options on an inactive session, which doesn't take audio focus from
    /// anything. Real activation happens in `SpeechTranscriber.start()`,
    /// which is where the latency win (spec §3.4 "Tap → mic live") actually
    /// matters — see that type's `prewarm()` for why it no longer prepares
    /// the audio engine either.
    ///
    /// Idempotent and cheap: a no-op on every call after the first one that
    /// actually ran, and a no-op entirely while permission isn't yet
    /// `.authorized`. **Never** requests permission itself — that stays a
    /// user-initiated action (`requestPermissions()`), never something a
    /// mere tab appearance triggers.
    func prewarm() {
        guard !didPrewarm, permissionState == .authorized else { return }
        didPrewarm = true
        audioSession.configure()
        transcriber.prewarm()
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
    ///
    /// `mode` (V5, spec §3.2/§3.8): `.conversation` is downgraded to
    /// `.single` while VoiceOver is running — hands-free listening would
    /// compete with VoiceOver's own speech — so a caller can always pass the
    /// gesture's *intended* mode and let this decide the effective one.
    func startRecording(mode: ConversationMode = .single) {
        guard state == .idle else { return }
        let effectiveMode = (mode == .conversation && environment.isVoiceOverRunning()) ? .single : mode
        self.mode = effectiveMode
        if effectiveMode == .conversation { emptyListenStreak = 0 }
        lastError = nil
        beginListening()
    }

    /// Downgrades an in-flight `.conversation` turn to `.single` — the mic
    /// touch-down/release gesture (spec §3.1) always starts recording
    /// immediately as the tentative mode (V3's touch-down-start latency
    /// win), before it's known whether the press is a quick tap or a
    /// ≥300 ms hold; a hold means push-to-talk was intended, so the view
    /// calls this right before `stopRecording()` on release. No-op once
    /// already `.single`, and a no-op if the turn has already ended.
    func demoteToSingleTurn() {
        guard mode == .conversation else { return }
        mode = .single
    }

    func stopRecording() {
        transcriber.stop()
    }

    /// Ends the in-flight turn — while listening or while awaiting STT — and
    /// delivers nothing. Idempotent. Also fully exits conversation mode
    /// (V5): cancels the "Your turn"/backgrounded-grace timers so neither
    /// can fire afterward, and resets `mode` back to `.single` so a view
    /// gating `CoachOrb` on `mode == .conversation` hides it immediately.
    /// Deactivates the shared session (post-V3 review fix): a cancelled
    /// turn never reaches `CoachSpeaker`, which is otherwise the only thing
    /// that deactivates it, so without this the user's other audio would
    /// stay ducked until their next voice turn happens to speak a reply.
    ///
    /// **Ordering note (post-V3-fix parity):** `state` is moved off
    /// `.listening` *before* `transcriber.stop()` runs. `stop()` flips the
    /// transcriber's `isRecording` to false synchronously, and `bind()`'s
    /// endpoint-fired sink reacts to exactly that transition whenever
    /// `state == .listening` — stopping first (state still `.listening`)
    /// would make a deliberate cancel look like an endpoint firing and
    /// re-enter `beginTranscription()`, delivering the very words this call
    /// is meant to discard.
    func cancel() {
        yourTurnTask?.cancel()
        yourTurnTask = nil
        backgroundTask?.cancel()
        backgroundTask = nil
        mode = .single
        lastError = nil
        transcriptionTask?.cancel()
        transcriptionTask = nil
        state = .idle
        activeTurnID = nil
        currentTurnID = nil
        transcriber.stop()
        transcriber.discardRecording()
        voiceTurnTimer = nil
        partialTranscript = ""
        audioSession.deactivate()
    }

    /// The `CoachOrb`'s End control ends conversation mode; `cancel()` is
    /// the full teardown it needs (mic + timers + session), so this exists
    /// only as a name that reads clearly from the view layer. Stopping any
    /// in-progress TTS is `CoachViewModel`'s job (it owns `CoachSpeaker`,
    /// which this controller never touches) — see
    /// `CoachViewModel.endVoiceConversation()`.
    func endConversation(reason: ConversationEndReason = .userEnded) {
        guard mode == .conversation else { return }
        cancel()
    }

    // MARK: - Conversation mode: backgrounding (spec §3.2 "app backgrounded > 10 s")

    /// `CoachView`/`VoiceFABView` call this from `scenePhase` turning
    /// `.background`. No-op outside conversation mode. Ends the conversation
    /// after `backgroundGraceInterval` unless `appDidBecomeActive()` cancels
    /// it first.
    func appDidEnterBackground() {
        guard mode == .conversation else { return }
        backgroundTask?.cancel()
        backgroundTask = Task { [weak self] in
            guard let self else { return }
            await self.scheduling.sleep(Self.backgroundGraceInterval)
            guard !Task.isCancelled else { return }
            self.endConversation(reason: .backgrounded)
        }
    }

    /// `CoachView`/`VoiceFABView` call this from `scenePhase` turning
    /// `.active`. Always safe to call — a no-op if no background timer is
    /// pending.
    func appDidBecomeActive() {
        backgroundTask?.cancel()
        backgroundTask = nil
    }

    // MARK: - Conversation mode: reply lifecycle (spec §3.2, delivery slice V5)
    //
    // `CoachViewModel` drives these three from the existing points it
    // already has for voice telemetry, rather than this controller
    // duplicating any streaming/TTS logic: request start (`send()`, right
    // where `isStreaming` flips true), first TTS audio
    // (`CoachSpeaker.onPlaybackStart`), and TTS finishing
    // (`CoachSpeaker.onPlaybackFinished`, new in V5). Every entry is a no-op
    // outside conversation mode or from an unexpected state, so a typed
    // send/reply mid-conversation (which never calls these) can't be
    // confused for a voice one.

    /// "Request in flight, no audio yet." Called synchronously from inside
    /// the `onFinalTranscript` closure's `send()`, so by the time
    /// `beginTranscription()`'s continuation resumes after calling that
    /// closure, `state` has already moved past `.sending` here — see that
    /// method's own comment.
    func markThinking() {
        guard mode == .conversation, state == .sending || state == .idle else { return }
        state = .thinking
    }

    /// `CoachSpeaker.onPlaybackStart` — the reply's first audio started.
    func markSpeaking() {
        guard mode == .conversation, state == .thinking else { return }
        state = .speaking
    }

    /// `CoachSpeaker.onPlaybackFinished` — the reply's TTS queue drained
    /// naturally (not cut short by a Stop/End/new turn). Re-arms into
    /// `.yourTurn` then `.listening`, with no tap.
    func speakingFinished() {
        guard mode == .conversation, state == .speaking else { return }
        armYourTurn()
    }

    /// `CoachViewModel.send()`'s success path calls this when the reply
    /// never produced any speech at all (e.g. a tool-only turn) —
    /// `onPlaybackStart`/`onPlaybackFinished` never fire in that case, so
    /// without this the controller would sit in `.thinking` forever.
    func replyFinishedWithoutSpeaking() {
        guard mode == .conversation, state == .thinking else { return }
        armYourTurn()
    }

    /// Spec §3.2's "Your turn" row: ~1s pause with the `yourTurn` haptic
    /// (fired by a view observing `yourTurnTrigger`), then straight back
    /// into listening — no tap. Cancellable so `cancel()`/`endConversation`
    /// during the pause can't have this fire after the fact.
    private func armYourTurn() {
        state = .yourTurn
        yourTurnTrigger += 1
        yourTurnTask?.cancel()
        yourTurnTask = Task { [weak self] in
            guard let self else { return }
            await self.scheduling.sleep(Self.yourTurnDuration)
            guard !Task.isCancelled else { return }
            guard self.mode == .conversation, self.state == .yourTurn else { return }
            self.beginListening()
        }
    }

    /// The actual "go live" work shared by a fresh `startRecording()` and
    /// every automatic re-arm (`armYourTurn()`'s timer, and the
    /// keep-listening retry after a single empty listen in
    /// `resetToIdleAfterEmptyTurn()`) — those re-arms must reach this
    /// directly, bypassing `startRecording()`'s `state == .idle` guard,
    /// since they fire from `.yourTurn`/`.idle`-mid-retry rather than a
    /// fresh user tap.
    private func beginListening() {
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
        // `startRecording()` a silent no-op until relaunch. In conversation
        // mode this routes into the same empty-listen retry/end-after-2
        // path as a genuine no-speech listen (bounded to at most
        // `maxConsecutiveEmptyListens` recursive attempts before
        // `endConversation` stops it).
        if !transcriber.isRecording {
            resetToIdleAfterEmptyTurn()
            partialTranscript = ""
        }
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
        turnEndTrigger += 1
        lastError = nil
        if mode == .conversation { emptyListenStreak = 0 }
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
            // `CoachViewModel`'s `onFinalTranscript` handler calls `send()`
            // synchronously, which — for a conversation-mode turn — calls
            // `markThinking()` synchronously before this closure returns.
            // So by the time control comes back here, `state` has already
            // moved past `.sending` for that case; the check right below
            // only resets to `.idle` for single-turn (which never calls
            // `markThinking()`) or the rare case `send()` itself bailed
            // (e.g. raced by another busy turn).
            self.onFinalTranscript?(trimmed)
            self.lastDeliveredTurnID = turnID
            self.activeTurnID = nil
            self.currentTurnID = nil
            if self.state == .sending {
                self.state = .idle
            }
        }
    }

    /// Shared by three non-spoken endings: `startRecording()`'s failed-start
    /// path (`transcriber.start()` returned without ever recording),
    /// `beginTranscription()`'s empty-on-device-transcript-and-no-clip
    /// guard, and the transcription task's empty-after-cloud-STT guard.
    /// None of these reach `CoachSpeaker`, so (post-V3 review fix) this
    /// deactivates the shared session itself — otherwise a voice turn that
    /// never got as far as a spoken reply would leave the user's other
    /// audio ducked indefinitely.
    ///
    /// V5: in conversation mode, an empty listen doesn't end the
    /// conversation by itself — spec §3.6's "Didn't catch that. Go ahead."
    /// keeps listening (no tap, no session churn), counting toward
    /// `maxConsecutiveEmptyListens`. Only a *second* one in a row ends it.
    private func resetToIdleAfterEmptyTurn() {
        voiceTurnTimer = nil
        activeTurnID = nil
        currentTurnID = nil

        guard mode == .conversation else {
            state = .idle
            audioSession.deactivate()
            return
        }

        emptyListenStreak += 1
        if emptyListenStreak >= Self.maxConsecutiveEmptyListens {
            lastError = nil
            state = .idle
            endConversation(reason: .tooManyEmptyListens)
            return
        }

        lastError = .didntCatchThat
        state = .idle
        beginListening()
    }
}
