import Combine
import XCTest
@testable import Vital

@MainActor
final class CoachVoiceControllerTests: XCTestCase {

    func testStartRecordingTransitionsToListeningAndStartsTranscriber() {
        let transcriber = FakeSpeechTranscriber()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        controller.startRecording()

        XCTAssertEqual(controller.state, .listening)
        XCTAssertEqual(transcriber.startCallCount, 1)
        XCTAssertNotNil(controller.currentTurnID)
        XCTAssertEqual(controller.partialTranscript, "")
    }

    /// A recording already in flight (`.listening`/`.transcribing`/`.sending`)
    /// must not be clobbered by a second `startRecording()` — only `.idle`
    /// can start a new turn.
    func testStartRecordingIsANoOpWhileATurnIsAlreadyInFlight() {
        let transcriber = FakeSpeechTranscriber()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        controller.startRecording()
        let firstTurnID = controller.currentTurnID
        controller.startRecording()

        XCTAssertEqual(transcriber.startCallCount, 1)
        XCTAssertEqual(controller.currentTurnID, firstTurnID)
    }

    /// A `start()` that never actually begins recording (denied permission,
    /// unavailable recognizer, an audio session/engine failure) must not
    /// leave the controller stuck in `.listening` forever — it has to fall
    /// back to `.idle` so a later tap can try again.
    func testStartRecordingResetsToIdleWhenTranscriberFailsToStart() {
        let transcriber = FakeSpeechTranscriber()
        transcriber.startShouldSucceed = false
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        controller.startRecording()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertNil(controller.currentTurnID)
        XCTAssertEqual(controller.partialTranscript, "")
        XCTAssertEqual(transcriber.startCallCount, 1)

        // A later, successful start works normally — the failed attempt
        // above didn't leave anything wedged.
        transcriber.startShouldSucceed = true
        controller.startRecording()

        XCTAssertEqual(controller.state, .listening)
        XCTAssertEqual(transcriber.startCallCount, 2)
        XCTAssertNotNil(controller.currentTurnID)
    }

    /// The endpoint firing (the transcriber's `isRecording` flipping back to
    /// false while we're listening) moves to `.transcribing`, and once the
    /// (STT-less, in this test) transcript resolves, `onFinalTranscript`
    /// fires exactly once with the trimmed text before the controller
    /// returns to `.idle`.
    func testEndpointFiredMovesToTranscribingThenDeliversFinalTranscriptExactlyOnce() async {
        let transcriber = FakeSpeechTranscriber()
        let api = FakeVoiceAPI()
        let controller = CoachVoiceController(transcriber: transcriber, api: api)

        var delivered: [String] = []
        controller.onFinalTranscript = { delivered.append($0) }

        controller.startRecording()
        let turnID = controller.currentTurnID
        transcriber.isRecording = true // the mic is live

        transcriber.transcribedText = "log two eggs and toast"
        transcriber.recordingURL = nil // nothing to upload — resolves from the on-device transcript
        transcriber.isRecording = false // endpoint fired / watchdog auto-stop

        XCTAssertEqual(controller.state, .transcribing)

        await waitUntil(controller, "final transcript delivered") { controller.state == .idle }

        XCTAssertEqual(delivered, ["log two eggs and toast"])
        XCTAssertEqual(api.uploadCallCount, 0)
        XCTAssertEqual(controller.lastDeliveredTurnID, turnID)
        XCTAssertEqual(controller.state, .idle)
        XCTAssertNil(controller.currentTurnID)

        // A second endpoint fire (e.g. a stray duplicate callback) without a
        // new `startRecording()` must not deliver again.
        transcriber.isRecording = true
        transcriber.isRecording = false
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(delivered.count, 1)
    }

    /// Cancelling while the cloud STT upload is still in flight must not
    /// deliver a transcript once that upload eventually resolves.
    func testCancelMidTranscribeDeliversNothing() async {
        let transcriber = FakeSpeechTranscriber()
        let api = FakeVoiceAPI()
        api.holdUpload = true
        let controller = CoachVoiceController(transcriber: transcriber, api: api)

        var delivered: [String] = []
        controller.onFinalTranscript = { delivered.append($0) }

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "wait for it"
        transcriber.recordingURL = URL(fileURLWithPath: "/tmp/turn.m4a")
        transcriber.isRecording = false // endpoint fired -> begins the (held) upload

        XCTAssertEqual(controller.state, .transcribing)
        // Give the spawned Task an actual chance to run and reach (and
        // suspend on) the held upload before cancelling — cancelling the
        // `Task` handle before its body has started still sets its
        // cancelled flag correctly, but the assertion below also wants the
        // fake's continuation to exist so `resumeHeldUpload` isn't a no-op.
        await poll(timeout: 2.0) { api.uploadCallCount == 1 }
        XCTAssertEqual(api.uploadCallCount, 1)

        controller.cancel()
        XCTAssertEqual(controller.state, .idle)

        // The network call "comes back" only after cancellation.
        api.resumeHeldUpload(with: "wait for it, corrected")
        try? await Task.sleep(nanoseconds: 20_000_000)

        XCTAssertTrue(delivered.isEmpty)
        XCTAssertEqual(controller.state, .idle)
        XCTAssertNil(controller.lastDeliveredTurnID)
    }

    /// An endpoint fire with nothing recognized and no audio clip to upload
    /// must not deliver anything — it drops straight back to idle.
    func testEmptyTranscriptDeliversNothing() async {
        let transcriber = FakeSpeechTranscriber()
        let api = FakeVoiceAPI()
        let controller = CoachVoiceController(transcriber: transcriber, api: api)

        var delivered: [String] = []
        controller.onFinalTranscript = { delivered.append($0) }

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "   "
        transcriber.recordingURL = nil
        transcriber.isRecording = false

        try? await Task.sleep(nanoseconds: 20_000_000)

        XCTAssertTrue(delivered.isEmpty)
        XCTAssertEqual(api.uploadCallCount, 0)
        XCTAssertEqual(controller.state, .idle)
        XCTAssertNil(controller.currentTurnID)
    }

    /// A failed (or empty) cloud STT response falls back to the on-device
    /// transcript rather than dropping the turn.
    func testCloudSTTFailureFallsBackToOnDeviceText() async {
        let transcriber = FakeSpeechTranscriber()
        let api = FakeVoiceAPI()
        api.sttResult = nil // simulates offline / 503 / no ElevenLabs key
        let controller = CoachVoiceController(transcriber: transcriber, api: api)

        var delivered: [String] = []
        controller.onFinalTranscript = { delivered.append($0) }

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "on device fallback text"
        transcriber.recordingURL = URL(fileURLWithPath: "/tmp/turn.m4a")
        transcriber.isRecording = false

        await waitUntil(controller, "fallback transcript delivered") { controller.state == .idle }

        XCTAssertEqual(delivered, ["on device fallback text"])
        XCTAssertEqual(api.uploadCallCount, 1)
        XCTAssertEqual(transcriber.discardCallCount, 1)
    }

    /// The cloud transcript replaces the on-device preview when the upload
    /// succeeds with non-empty text.
    func testCloudSTTSuccessReplacesOnDeviceText() async {
        let transcriber = FakeSpeechTranscriber()
        let api = FakeVoiceAPI()
        api.sttResult = "corrected by scribe"
        let controller = CoachVoiceController(transcriber: transcriber, api: api)

        var delivered: [String] = []
        controller.onFinalTranscript = { delivered.append($0) }

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "roughly what apple heard"
        transcriber.recordingURL = URL(fileURLWithPath: "/tmp/turn.m4a")
        transcriber.isRecording = false

        await waitUntil(controller, "corrected transcript delivered") { controller.state == .idle }

        XCTAssertEqual(delivered, ["corrected by scribe"])
    }

    /// `isRecording` must be `@Published` on the controller itself (not a
    /// computed pass-through) — `CoachView`/`VoiceFABView` observe only the
    /// controller, so a transcriber-only change that isn't accompanied by a
    /// `state` change (e.g. the mic just stopping) has to still re-publish
    /// here or those views never re-render for it.
    func testIsRecordingMirrorsTranscriberRegardlessOfControllerState() {
        let transcriber = FakeSpeechTranscriber()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        XCTAssertFalse(controller.isRecording)

        controller.startRecording()
        XCTAssertTrue(controller.isRecording)

        transcriber.isRecording = false // endpoint fires
        XCTAssertFalse(controller.isRecording)
    }

    /// `permissionState` is re-read (and re-published) after
    /// `requestPermissions()` and after `refreshPermissionState()` — the
    /// latter is how a Settings grant made mid-session (no relaunch) is
    /// picked up, e.g. `VoiceFABView`'s `didBecomeActiveNotification` hook.
    func testPermissionStateRefreshesAfterRequestAndManualRefresh() async {
        let transcriber = FakeSpeechTranscriber()
        transcriber.permissionState = .notDetermined
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        XCTAssertEqual(controller.permissionState, .notDetermined)

        await controller.requestPermissions()
        XCTAssertEqual(controller.permissionState, .authorized) // the fake grants unconditionally

        transcriber.permissionState = .denied
        transcriber.nextRefreshedPermissionState = .authorized
        controller.refreshPermissionState()
        XCTAssertEqual(controller.permissionState, .authorized)
    }

    // MARK: - V3: prewarm

    /// `prewarm()` must be a no-op — never touch the audio session, never
    /// prewarm the transcriber, never request permission — while permission
    /// isn't `.authorized`.
    func testPrewarmDoesNothingWithoutAuthorizedPermission() {
        let transcriber = FakeSpeechTranscriber()
        transcriber.permissionState = .notDetermined
        let session = SpyAudioSession()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI(), audioSession: session.controlling)

        controller.prewarm()
        controller.prewarm()

        XCTAssertEqual(transcriber.prewarmCallCount, 0)
        XCTAssertEqual(transcriber.requestPermissionsCallCount, 0)
        XCTAssertEqual(session.configureCallCount, 0)
        XCTAssertEqual(session.activateCallCount, 0)
    }

    /// Once permission is authorized, `prewarm()` configures the session
    /// (and prewarms the transcriber) exactly once regardless of how many
    /// times it's called — both `.onAppear`s (Coach tab and
    /// `VoiceFABView`) call it on every appearance, and it must stay cheap.
    /// It must never request permission, whatever the caller.
    ///
    /// Critically (post-review fix): `prewarm()` must call `configure()`
    /// only, **never** `activate()` — `.onAppear` can fire just from
    /// opening the app to the Today tab, and activating a `.duckOthers`
    /// session there would duck the user's music before they've touched
    /// the mic. This is the one assertion that guards that regression.
    func testPrewarmConfiguresButNeverActivatesTheSession() {
        let transcriber = FakeSpeechTranscriber()
        transcriber.permissionState = .authorized
        let session = SpyAudioSession()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI(), audioSession: session.controlling)

        controller.prewarm()
        controller.prewarm()
        controller.prewarm()

        XCTAssertEqual(transcriber.prewarmCallCount, 1)
        XCTAssertEqual(transcriber.requestPermissionsCallCount, 0)
        XCTAssertEqual(session.configureCallCount, 1)
        XCTAssertEqual(session.activateCallCount, 0, "prewarm() must never activate the session — that ducks other apps' audio.")
    }

    /// A `prewarm()` that no-op'd for lack of permission must still work
    /// once permission is later granted (e.g. the Settings-grant refresh
    /// flow), rather than being permanently latched off by the earlier call.
    func testPrewarmRunsOnceLaterAuthorizedAfterAnEarlierNoOp() {
        let transcriber = FakeSpeechTranscriber()
        transcriber.permissionState = .denied
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        controller.prewarm()
        XCTAssertEqual(transcriber.prewarmCallCount, 0)

        transcriber.permissionState = .authorized
        transcriber.nextRefreshedPermissionState = .authorized
        controller.refreshPermissionState()
        controller.prewarm()
        controller.prewarm()

        XCTAssertEqual(transcriber.prewarmCallCount, 1)
    }

    // MARK: - V3: session released on non-spoken endings

    /// `cancel()` must deactivate the shared session — a cancelled turn
    /// never reaches `CoachSpeaker`, which is otherwise the only thing that
    /// deactivates it, so without this the user's other audio would stay
    /// ducked until their next voice turn happens to speak a reply.
    func testCancelDeactivatesTheSession() {
        let transcriber = FakeSpeechTranscriber()
        let session = SpyAudioSession()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI(), audioSession: session.controlling)

        controller.startRecording()
        transcriber.isRecording = true
        controller.cancel()

        XCTAssertEqual(session.deactivateCallCount, 1)
    }

    /// An endpoint fire with nothing recognized (empty transcript, no
    /// audio clip) resolves straight to `.idle` without ever speaking a
    /// reply — must still deactivate the session.
    func testEmptyTurnDeactivatesTheSession() async {
        let transcriber = FakeSpeechTranscriber()
        let session = SpyAudioSession()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI(), audioSession: session.controlling)

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "   "
        transcriber.recordingURL = nil
        transcriber.isRecording = false

        try? await Task.sleep(nanoseconds: 20_000_000)

        XCTAssertEqual(session.deactivateCallCount, 1)
    }

    /// `transcriber.start()` returning without ever recording (permission
    /// revoked mid-flight, recognizer unavailable, engine failure, …) must
    /// also deactivate — it shares `resetToIdleAfterEmptyTurn()` with the
    /// empty-transcript case above.
    func testFailedStartDeactivatesTheSession() {
        let transcriber = FakeSpeechTranscriber()
        transcriber.startShouldSucceed = false
        let session = SpyAudioSession()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI(), audioSession: session.controlling)

        controller.startRecording()

        XCTAssertEqual(session.deactivateCallCount, 1)
    }

    // MARK: - V3: turnEnd haptic trigger

    /// The Listening → Transcribing transition (the endpoint firing) must
    /// bump `turnEndTrigger` exactly once — this is what a view's
    /// `.sensoryFeedback(Theme.Haptics.turnEnd, trigger:)` observes; UIKit
    /// haptics themselves aren't unit-testable, so the counter is the seam.
    func testEndpointFiredBumpsTurnEndTrigger() async {
        let transcriber = FakeSpeechTranscriber()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        XCTAssertEqual(controller.turnEndTrigger, 0)

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "log two eggs and toast"
        transcriber.recordingURL = nil
        transcriber.isRecording = false // endpoint fired

        await waitUntil(controller, "turn delivered") { controller.state == .idle }

        XCTAssertEqual(controller.turnEndTrigger, 1)
    }

    /// An endpoint fire with nothing recognized never entered `.transcribing`
    /// — it goes straight back to `.idle` — so it must not bump the trigger.
    func testEmptyTurnDoesNotBumpTurnEndTrigger() async {
        let transcriber = FakeSpeechTranscriber()
        let controller = CoachVoiceController(transcriber: transcriber, api: FakeVoiceAPI())

        controller.startRecording()
        transcriber.isRecording = true
        transcriber.transcribedText = "   "
        transcriber.recordingURL = nil
        transcriber.isRecording = false

        try? await Task.sleep(nanoseconds: 20_000_000)

        XCTAssertEqual(controller.turnEndTrigger, 0)
    }

    // MARK: - Helpers

    private func waitUntil(
        _ controller: CoachVoiceController,
        _ condition: String,
        timeout: TimeInterval = 2.0,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ predicate: @escaping @MainActor () -> Bool
    ) async {
        if predicate() { return }

        let satisfied = expectation(description: condition)
        satisfied.assertForOverFulfill = false

        let cancellable = controller.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { _ in
                MainActor.assumeIsolated {
                    if predicate() { satisfied.fulfill() }
                }
            }
        defer { cancellable.cancel() }

        await fulfillment(of: [satisfied], timeout: timeout)

        XCTAssertTrue(
            predicate(),
            "Timed out after \(timeout)s waiting for \(condition).",
            file: file,
            line: line
        )
    }

    /// Plain polling wait for state that doesn't live on an `ObservableObject`
    /// (e.g. `FakeVoiceAPI.uploadCallCount`) — short-sleeps in a loop rather
    /// than subscribing to a publisher.
    private func poll(
        timeout: TimeInterval,
        interval: TimeInterval = 0.01,
        _ predicate: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate(), Date() < deadline {
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
    }
}

// MARK: - Fakes

/// Records calls to `VoiceAudioSessionControlling`'s three hooks instead of
/// touching a real `AVAudioSession` (there is none in the test process).
/// `controlling` is what's passed to `CoachVoiceController(audioSession:)`.
@MainActor
private final class SpyAudioSession {
    private(set) var configureCallCount = 0
    private(set) var activateCallCount = 0
    private(set) var deactivateCallCount = 0

    var controlling: VoiceAudioSessionControlling {
        VoiceAudioSessionControlling(
            configure: { [weak self] in self?.configureCallCount += 1 },
            activate: { [weak self] in self?.activateCallCount += 1 },
            deactivate: { [weak self] in self?.deactivateCallCount += 1 }
        )
    }
}

@MainActor
private final class FakeSpeechTranscriber: SpeechTranscribing {
    @Published var transcribedText: String = ""
    @Published var isRecording: Bool = false
    var permissionState: SpeechPermissionState = .authorized
    var errorMessage: String? = nil
    @Published var endpointDeadline: Date? = nil
    var recordingURL: URL? = nil

    var transcribedTextPublisher: AnyPublisher<String, Never> { $transcribedText.eraseToAnyPublisher() }
    var isRecordingPublisher: AnyPublisher<Bool, Never> { $isRecording.eraseToAnyPublisher() }
    var endpointDeadlinePublisher: AnyPublisher<Date?, Never> { $endpointDeadline.eraseToAnyPublisher() }

    private(set) var startCallCount = 0
    private(set) var stopCallCount = 0
    private(set) var discardCallCount = 0
    private(set) var prewarmCallCount = 0
    private(set) var requestPermissionsCallCount = 0

    func prewarm() {
        prewarmCallCount += 1
    }

    /// Mirrors the real `SpeechTranscriber.start()`'s several failure paths
    /// (permission not authorized, recognizer unavailable, audio session
    /// activation throwing, engine start throwing) — all of which return
    /// without ever setting `isRecording = true`.
    var startShouldSucceed = true

    func start() {
        startCallCount += 1
        if startShouldSucceed {
            isRecording = true
        }
    }

    func stop() {
        stopCallCount += 1
        isRecording = false
    }

    func discardRecording() {
        discardCallCount += 1
        recordingURL = nil
    }

    /// Applied by `refreshPermissionState()` — lets a test simulate a grant
    /// picked up from Settings without a real permission prompt.
    var nextRefreshedPermissionState: SpeechPermissionState?

    func refreshPermissionState() {
        if let next = nextRefreshedPermissionState { permissionState = next }
    }

    func requestPermissions() async {
        requestPermissionsCallCount += 1
        permissionState = .authorized
    }
}

/// Minimal `CoachAPIProviding` stand-in — only `uploadSTTAudio` is exercised
/// by `CoachVoiceController`; every other requirement is unused by it and
/// fails loudly if a future change starts relying on one.
@MainActor
private final class FakeVoiceAPI: CoachAPIProviding {
    var sttResult: String? = nil
    var holdUpload = false
    private(set) var uploadCallCount = 0
    private var heldContinuation: CheckedContinuation<String?, Never>?

    func uploadSTTAudio(fileURL: URL) async -> String? {
        uploadCallCount += 1
        if holdUpload {
            return await withCheckedContinuation { continuation in
                self.heldContinuation = continuation
            }
        }
        return sttResult
    }

    func resumeHeldUpload(with text: String?) {
        heldContinuation?.resume(returning: text)
        heldContinuation = nil
    }

    func fetchCoachRestoration() async throws -> CoachRestorationResponse {
        fatalError("unused by CoachVoiceController")
    }

    func fetchCoachOpener() async throws -> String {
        fatalError("unused by CoachVoiceController")
    }

    func resetCoachConversation() async throws {
        fatalError("unused by CoachVoiceController")
    }

    func fetchDietGoal() async throws -> DietGoalResponse {
        fatalError("unused by CoachVoiceController")
    }

    func streamCoach(
        message: String,
        imageBase64: String?,
        mode: String?,
        findingId: String?
    ) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        fatalError("unused by CoachVoiceController")
    }

    func streamCoachAction(
        sessionId: String,
        cardOccurrenceId: String,
        actionId: String,
        action: SpecialistAction
    ) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        fatalError("unused by CoachVoiceController")
    }
}
