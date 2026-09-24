import Foundation
import Speech
import AVFoundation
import os

// MARK: - Permission state

/// Combined view of the two permissions speech recognition needs (Speech
/// framework authorization + microphone access), collapsed into the three
/// states the UI actually cares about.
enum SpeechPermissionState {
    case notDetermined
    case authorized
    case denied
}

// MARK: - SpeechTranscriber

/// Reusable speech-to-text engine built on `SFSpeechRecognizer` +
/// `AVAudioEngine`. Extracted from the pattern in
/// `Features/Logging/LogMealViewModel.swift` (that file is left untouched) so
/// both meal-logging voice search and coach tap-to-talk share one
/// implementation.
///
/// Apple's on-device transcript is shown live as a preview while recording,
/// but it is not the transcript that gets sent: alongside recognition, the
/// raw mic audio is also written to a temp `.m4a` (`recordingURL`), which the
/// caller uploads to the backend's ElevenLabs Scribe proxy (`POST /api/stt`)
/// for a more accurate transcript once recording stops. Three watchdog
/// timers auto-stop the recording — silence after speech, no-speech at all,
/// and a hard max duration — so a voice turn ends without a manual tap.
@MainActor
final class SpeechTranscriber: ObservableObject {

    @Published var transcribedText: String = ""
    @Published var isRecording: Bool = false
    @Published var permissionState: SpeechPermissionState = .notDetermined
    @Published var errorMessage: String? = nil

    /// When the current adaptive endpointing window (see `EndpointPolicy`)
    /// will fire, or nil while not actively waiting on one — i.e. before any
    /// speech has been detected, or once recording has stopped. Published so
    /// a future PR can render the countdown ring from spec §3.2 without
    /// touching this file again; no UI reads it yet.
    @Published private(set) var endpointDeadline: Date? = nil

    /// Normalized mic input level (roughly `0...1`), derived from the RMS of
    /// the same audio-tap buffer used for recognition/recording — no extra
    /// tap install. Published at ≤ 30 Hz (spec `ux-spec-v4` §3.2's
    /// `CoachOrb`, delivery slice V5: "scales 1.00–1.15 with mic level"),
    /// throttled on the audio-render thread before the hop to `@MainActor`
    /// so a 1024-sample buffer's ~43–48 Hz callback rate doesn't flood
    /// SwiftUI with redundant updates. 0 while not recording.
    @Published private(set) var inputLevel: Float = 0

    /// The just-recorded clip, ready to upload once `isRecording` flips back
    /// to false. Nil if the `.m4a` file couldn't be created (recognition
    /// still proceeds Apple-only in that case). Cleared by `discardRecording()`.
    private(set) var recordingURL: URL?

    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    /// Handle to the in-progress recording file. Closed (which flushes the
    /// remaining AAC frames) by setting it to nil in `stop()`.
    private var audioFile: AVAudioFile?

    /// Counter incremented on every segment start, captured in recognition
    /// callbacks to ignore stale results from superseded segments.
    private var recognitionGeneration = 0

    // MARK: - Auto-stop watchdogs

    /// No speech decoded at all: auto-stop after 10s so a turn with nothing
    /// said doesn't hang open. Suspended while `autoEndpointingEnabled` is
    /// false (a held turn) — see `setAutoEndpointing(_:)`.
    private let noSpeechTimeout: TimeInterval = 10
    /// Hard cap regardless of activity, so a stuck recognizer/session can't
    /// keep the mic open indefinitely. This one is NOT suspended by
    /// `setAutoEndpointing(false)` — a held turn still can't run forever —
    /// it's just raised to `Self.heldMaxDuration`.
    private static let maxDuration: TimeInterval = 30
    /// The max-duration cap while held (push-to-talk): a person who is
    /// actually holding the mic down and talking should get much more room
    /// than the hands-free 30s cap before being cut off outright.
    private static let heldMaxDuration: TimeInterval = 60

    private var silenceTask: Task<Void, Never>?
    private var noSpeechTask: Task<Void, Never>?
    private var maxDurationTask: Task<Void, Never>?

    /// When the first non-empty partial of this turn arrived, used to
    /// compute `speechDuration` for `EndpointPolicy` (short utterances get a
    /// wider window so they aren't clipped). Nil until speech is detected;
    /// reset on every `start()`.
    private var speechStartedAt: Date?

    /// True while auto-endpointing (silence watchdog, no-speech timeout,
    /// and stopping on a natural `isFinal`) is active — the hands-free
    /// default. `CoachVoiceController.beginHold()` flips this false the
    /// moment a press crosses the hold threshold, so a held turn is ended
    /// ONLY by release (`stop()`) or the held max-duration cap; see
    /// `setAutoEndpointing(_:)`. Reset to `true` at the top of every
    /// `start()`.
    private var autoEndpointingEnabled = true

    /// Recognized-so-far transcript, accumulated across recognition
    /// *segments*. The on-device recognizer can finalize a segment
    /// (`isFinal == true`) on its own at a pause even while the user keeps
    /// talking — historically this class treated that as "the user is
    /// done" and stopped outright, which is the other half of the
    /// mid-thought pause-cutoff bug (`beginNewRecognitionSegment()`'s doc
    /// comment has the fix). `transcribedText` is always
    /// `committedTranscript` plus the *current* segment's live partial, so
    /// the preview (and the Apple-transcript fallback) always covers the
    /// whole utterance, not just the segment since the last finalize.
    private var committedTranscript: String = ""

    /// Thread-safe indirection the audio tap appends buffers through,
    /// rather than capturing a `SFSpeechAudioBufferRecognitionRequest`
    /// directly. A segment restart (`beginNewRecognitionSegment()`) swaps in
    /// a new request *without* touching the tap or the `.m4a` file — the
    /// cloud STT needs one continuous recording, so the audio engine/tap/
    /// file must never restart, only the recognition request feeding off
    /// the same buffers.
    private let requestBox = RecognitionRequestBox()

    init() {
        refreshPermissionState()
    }

    // MARK: - Pre-warm

    /// Deliberately a no-op (post-V3 review fix). The original version
    /// called `audioEngine.prepare()` here to shave time off the first real
    /// `start()`, but `CoachVoiceController.prewarm()` runs on `.onAppear` —
    /// possibly just from opening the app — while the shared
    /// `VoiceAudioSession` is still inactive (see that type's doc comment:
    /// prewarm only `configure()`s it, never `activate()`s it). Preparing
    /// the engine's input node against an inactive session risks latching a
    /// stale or 0-channel format, which `start()` later feeds straight into
    /// `inputNode.installTap(format:)` — a mismatch there is a crash, not a
    /// latency win. The real engine prep now happens only inside `start()`,
    /// right as the session actually activates, which is also where the
    /// latency budget (spec §3.4 "Tap → mic live") actually pays off.
    ///
    /// Kept in `SpeechTranscribing` (rather than removed) so
    /// `CoachVoiceController.prewarm()` still has a symmetric "prewarm the
    /// transcriber" step to call — a later, safer version of this can fill
    /// it back in — and so `FakeSpeechTranscriber.prewarmCallCount` in
    /// `CoachVoiceControllerTests` keeps meaning "prewarm reached the
    /// transcriber", independent of what this does internally.
    func prewarm() {}

    // MARK: - Permissions

    func refreshPermissionState() {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        let micPermission = AVAudioApplication.shared.recordPermission

        if speechStatus == .authorized && micPermission == .granted {
            permissionState = .authorized
        } else if speechStatus == .denied || speechStatus == .restricted || micPermission == .denied {
            permissionState = .denied
        } else {
            permissionState = .notDetermined
        }
    }

    func requestPermissions() async {
        // Screenshot harness (`-VitalFixture <scenario>`): never show the
        // system speech-recognition/microphone prompts — a blocking system
        // alert would stall `XCUIScreen.main.screenshot()`. Never reached in
        // practice (the screenshot harness never taps mic/voice affordances),
        // but guarded to match HealthKitManager/NotificationManager in case a
        // future scenario does. Compiled out of Release entirely.
        #if DEBUG
        guard !FixtureMode.isActive else { return }
        #endif
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { _ in
                cont.resume()
            }
        }
        _ = await AVAudioApplication.requestRecordPermission()
        refreshPermissionState()
    }

    // MARK: - Recording

    func start() {
        guard permissionState == .authorized else { return }
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognizer unavailable."
            return
        }

        // Tear down any previous session.
        recognitionTask?.cancel()
        recognitionTask = nil
        transcribedText = ""
        committedTranscript = ""
        errorMessage = nil
        cancelWatchdogs()
        speechStartedAt = nil
        endpointDeadline = nil
        autoEndpointingEnabled = true
        discardRecording()
        audioFile = nil

        do {
            try VoiceAudioSession.activate()
        } catch {
            errorMessage = "Audio session error: \(error.localizedDescription)"
            return
        }

        recognitionRequest = makeRecognitionRequest(for: recognizer)
        requestBox.current = recognitionRequest
        recognitionTask = startRecognitionTask(with: recognitionRequest!, recognizer: recognizer)

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        // Record the raw mic audio to a temp .m4a alongside recognition.
        // Settings must match the tap's buffer format (sample rate + channel
        // count) — mono settings on a stereo tap throws on write. Failure
        // here just means no cloud upload later; recognition proceeds
        // Apple-only.
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString).m4a")
        let recordSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount,
        ]
        let file = try? AVAudioFile(forWriting: tempURL, settings: recordSettings)
        audioFile = file
        recordingURL = file != nil ? tempURL : nil

        // Captured locally rather than via `self` — the tap closure runs on
        // the audio thread and must never touch @MainActor state directly;
        // `levelBridge` (and `requestBox`, which is its own lock-protected
        // `@unchecked Sendable`) are the two seams allowed to cross that
        // boundary. `requestBox` — not a captured `req` — is deliberate: a
        // segment restart (`beginNewRecognitionSegment()`) swaps in a new
        // recognition request without ever reinstalling this tap, so the
        // tap must always append to whichever request is *current*, not the
        // one that existed when the tap was installed.
        let fileForTap = file
        let levelBridge = LevelBridge { [weak self] level in self?.inputLevel = level }
        let requestBox = self.requestBox
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buf, _ in
            requestBox.append(buf)
            try? fileForTap?.write(from: buf)
            levelBridge.report(buf)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            isRecording = true
            startNoSpeechWatchdog()
            startMaxDurationWatchdog(duration: Self.maxDuration)
        } catch {
            inputNode.removeTap(onBus: 0)
            errorMessage = "Could not start recording: \(error.localizedDescription)"
        }
    }

    func stop() {
        guard isRecording else { return }
        cancelWatchdogs()
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask = nil
        requestBox.current = nil
        // Closing the file flushes the remaining AAC frames. Do this — and
        // leave `recordingURL` pointing at the finished file — before
        // flipping `isRecording`, since Combine subscribers read
        // `recordingURL` on that flip to kick off the upload.
        audioFile = nil
        isRecording = false
        inputLevel = 0
    }

    /// Deletes the temp recording file (if any) and clears `recordingURL`.
    /// Called once a caller is done with the clip — after an upload attempt
    /// succeeds or fails — so temp files don't accumulate.
    func discardRecording() {
        if let url = recordingURL {
            try? FileManager.default.removeItem(at: url)
        }
        recordingURL = nil
    }

    // MARK: - Auto-endpointing (hold vs. hands-free)

    /// Suspends or resumes auto-endpointing (silence watchdog, no-speech
    /// timeout, and stopping on a natural `isFinal`) without touching the
    /// audio engine/tap/recording file — only `CoachVoiceController
    /// .beginHold()` calls this today, the moment a press crosses the hold
    /// threshold, so the turn is from then on ended ONLY by `stop()`
    /// (release) or the max-duration cap.
    ///
    /// A no-op if the value isn't actually changing. `false` immediately
    /// cancels the silence and no-speech watchdogs (there's no "grace
    /// period" — the whole point is that nothing but release/max-duration
    /// should fire while held) and, if currently recording, restarts the
    /// max-duration watchdog at `Self.heldMaxDuration` instead of
    /// `Self.maxDuration`. `true` restores the hands-free watchdogs (not
    /// used by any caller today, but kept symmetric).
    func setAutoEndpointing(_ enabled: Bool) {
        guard autoEndpointingEnabled != enabled else { return }
        autoEndpointingEnabled = enabled

        if !enabled {
            silenceTask?.cancel(); silenceTask = nil
            noSpeechTask?.cancel(); noSpeechTask = nil
            endpointDeadline = nil
            guard isRecording else { return }
            startMaxDurationWatchdog(duration: Self.heldMaxDuration)
        } else {
            guard isRecording else { return }
            startMaxDurationWatchdog(duration: Self.maxDuration)
            if !transcribedText.isEmpty {
                restartSilenceWatchdog()
            } else {
                startNoSpeechWatchdog()
            }
        }
    }

    // MARK: - Recognition (segments)

    /// Pure decision extracted for unit testing (`SpeechTranscriberTests`):
    /// whether a just-received `isFinal` result is a natural mid-turn
    /// segment boundary that recognition should continue past (`true` — the
    /// caller commits the segment and opens a new recognition request on
    /// the same audio tap/file), versus the expected trailing `isFinal`
    /// that arrives after `stop()` itself already called `endAudio()` and
    /// torn the turn down (`false` — nothing more to do).
    ///
    /// `isRecording` is the tell: `stop()` flips it to `false`
    /// synchronously, before the corresponding `isFinal` callback's hop
    /// back to the main actor can run, so by the time this is evaluated a
    /// `stop()`-caused final already sees `isRecording == false`. This is
    /// deliberately not `held`/`autoEndpointingEnabled`-aware — a segment
    /// restart must happen for a held turn too (auto-endpointing being
    /// suspended only means nothing SHOULD call `stop()` on a pause; it
    /// doesn't change what a natural `isFinal` from the recognizer means).
    static func shouldRestartSegment(isFinal: Bool, isRecording: Bool) -> Bool {
        isFinal && isRecording
    }

    private func makeRecognitionRequest(for recognizer: SFSpeechRecognizer) -> SFSpeechAudioBufferRecognitionRequest {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Prefer on-device recognition (private, works offline); falls back
        // to the server-backed recognizer automatically when unsupported for
        // the current locale/device. Either way this is only the live
        // preview now — the accurate transcript comes from the cloud upload
        // in stop().
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        return req
    }

    private func startRecognitionTask(
        with request: SFSpeechAudioBufferRecognitionRequest,
        recognizer: SFSpeechRecognizer
    ) -> SFSpeechRecognitionTask {
        recognitionGeneration += 1
        let generation = recognitionGeneration
        return recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                self?.handleRecognitionCallback(result: result, error: error, generation: generation)
            }
        }
    }

    /// One handler shared by every recognition segment
    /// (`beginNewRecognitionSegment()` reuses it for each new request/task),
    /// so restarting a segment never duplicates this logic.
    private func handleRecognitionCallback(result: SFSpeechRecognitionResult?, error: Error?, generation: Int) {
        // Ignore late callbacks from a superseded segment's task — a stale error must not stop() the live turn.
        guard generation == recognitionGeneration else { return }
        if let result {
            let segmentText = result.bestTranscription.formattedString
            transcribedText = combinedTranscript(withCurrentSegment: segmentText)
            if !segmentText.isEmpty, autoEndpointingEnabled {
                restartSilenceWatchdog()
            }
            if Self.shouldRestartSegment(isFinal: result.isFinal, isRecording: isRecording) {
                commitSegment(segmentText)
                beginNewRecognitionSegment()
            }
        }
        if let error, isRecording {
            // Suppress cancellation codes; surface genuine errors only.
            let code = (error as NSError).code
            guard code != 203, code != 301 else { return }
            errorMessage = "Voice error: \(error.localizedDescription)"
            stop()
        }
    }

    /// `committedTranscript` (every segment finalized so far) plus
    /// `segmentText` (the current segment's live-or-final transcript),
    /// joined with a single space so the live preview/Apple fallback reads
    /// as one continuous utterance rather than concatenated fragments.
    private func combinedTranscript(withCurrentSegment segmentText: String) -> String {
        if committedTranscript.isEmpty { return segmentText }
        if segmentText.isEmpty { return committedTranscript }
        return committedTranscript + " " + segmentText
    }

    private func commitSegment(_ segmentText: String) {
        let trimmed = segmentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        committedTranscript = committedTranscript.isEmpty ? trimmed : committedTranscript + " " + trimmed
    }

    /// Opens a new `SFSpeechAudioBufferRecognitionRequest`/task after a
    /// segment finalizes mid-turn, continuing recognition on the exact same
    /// audio engine/tap/`.m4a` file — those must never restart, since the
    /// cloud STT upload needs one continuous clip. Buffers reach whichever
    /// request is current via `requestBox` (see `start()`'s tap install),
    /// so swapping `recognitionRequest`/`requestBox.current` here is all
    /// that's needed; the tap itself is untouched.
    ///
    /// A no-op if recording already stopped by the time this runs (e.g. a
    /// race with a concurrent `stop()`) or the recognizer stopped being
    /// available.
    private func beginNewRecognitionSegment() {
        recognitionTask = nil
        recognitionRequest = nil
        guard isRecording, let recognizer = speechRecognizer, recognizer.isAvailable else { return }
        let req = makeRecognitionRequest(for: recognizer)
        recognitionRequest = req
        requestBox.current = req
        recognitionTask = startRecognitionTask(with: req, recognizer: recognizer)
    }

    // MARK: - Watchdogs
    //
    // Three independent, cancellation-safe @MainActor tasks. Each just calls
    // stop(), which is idempotent (guards on `isRecording`), so overlapping
    // fires are harmless. The silence and no-speech watchdogs are only ever
    // (re)started while `autoEndpointingEnabled` — see
    // `setAutoEndpointing(_:)` and `handleRecognitionCallback(result:error:generation:)`.

    /// Restarted on every non-empty partial transcript — partials only
    /// arrive while speech is actively being decoded, so this is a robust
    /// end-of-utterance signal with no RMS/noise-floor tuning needed. Once
    /// speech has been detected the no-speech timeout is moot, so it's
    /// cancelled here too.
    ///
    /// The wait itself is no longer the fixed 1.8s timer — it's
    /// `EndpointPolicy`'s adaptive window (spec §3.3), computed fresh on
    /// every partial from the live transcript and how long the user has
    /// been speaking, so a complete sentence ends the turn sooner and a
    /// trailing filler/conjunction gives more room to keep talking.
    private func restartSilenceWatchdog() {
        noSpeechTask?.cancel()
        noSpeechTask = nil

        if speechStartedAt == nil { speechStartedAt = Date() }
        let speechDuration = Date().timeIntervalSince(speechStartedAt ?? Date())
        let window = EndpointPolicy.silenceWindow(for: transcribedText, speechDuration: speechDuration)
        endpointDeadline = Date().addingTimeInterval(window)

        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(window))
            guard !Task.isCancelled else { return }
            self.endpointDeadline = nil
            self.stop()
        }
    }

    private func startNoSpeechWatchdog() {
        guard autoEndpointingEnabled else { return }
        noSpeechTask?.cancel()
        noSpeechTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(self.noSpeechTimeout))
            guard !Task.isCancelled else { return }
            self.stop()
        }
    }

    private func startMaxDurationWatchdog(duration: TimeInterval) {
        maxDurationTask?.cancel()
        maxDurationTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self.stop()
        }
    }

    private func cancelWatchdogs() {
        silenceTask?.cancel(); silenceTask = nil
        noSpeechTask?.cancel(); noSpeechTask = nil
        maxDurationTask?.cancel(); maxDurationTask = nil
        endpointDeadline = nil
    }
}

// MARK: - RecognitionRequestBox

/// Lock-protected indirection so the audio-render-thread tap callback can
/// append buffers to "whichever recognition request is current" without
/// ever touching `@MainActor` state, and without the tap itself needing to
/// be reinstalled when `beginNewRecognitionSegment()` swaps that request out
/// mid-turn. Same `@unchecked Sendable` + `OSAllocatedUnfairLock` shape as
/// `LevelBridge` just below, for the same reason: `SpeechTranscriber`'s tap
/// closure runs on `AVAudioEngine`'s render thread, never concurrently with
/// itself, but the lock is defense-in-depth rather than a response to any
/// known concurrent caller.
private final class RecognitionRequestBox: @unchecked Sendable {
    private let storage = OSAllocatedUnfairLock<SFSpeechAudioBufferRecognitionRequest?>(initialState: nil)

    var current: SFSpeechAudioBufferRecognitionRequest? {
        get { storage.withLock { $0 } }
        set { storage.withLock { $0 = newValue } }
    }

    /// Called from the audio-render thread on every tap callback.
    /// `SFSpeechAudioBufferRecognitionRequest.append(_:)` is documented as
    /// safe to call from a real-time audio callback, so this only needs the
    /// lock to read `current` itself, not to serialize the append.
    func append(_ buffer: AVAudioPCMBuffer) {
        current?.append(buffer)
    }
}

// MARK: - LevelBridge

/// Rate-limits `inputLevel` samples on the audio-render thread (where the
/// tap callback runs, at the buffer's own cadence — about 43–48 Hz for the
/// 1024-sample buffer `start()` installs) and hops only the ones that clear
/// the gate to `@MainActor` — spec `ux-spec-v4` §3.2's `CoachOrb` listening
/// animation, delivery slice V5: "published at ≤ 30 Hz on main". RMS is
/// still computed on *every* callback (cheap, no allocation, and needed to
/// decide whether this particular sample is worth publishing at all), but a
/// `Task { @MainActor in }` — and the actor hop it costs — is only spun up
/// for the throttled subset, not every buffer.
///
/// `lastPublishedAt` is guarded by `OSAllocatedUnfairLock` even though
/// `report(_:)` is, in practice, only ever invoked serially by
/// `AVAudioEngine` on its one internal render thread (never concurrently
/// with itself) — the lock is defense-in-depth against that assumption
/// rather than a response to any known concurrent caller. `@unchecked
/// Sendable` is still needed for the class itself because `publish` is a
/// stored `@MainActor`-isolated closure, which the lock doesn't change;
/// `publish` is only ever called from inside the `Task { @MainActor in }`
/// hop below, never from the render thread directly.
private final class LevelBridge: @unchecked Sendable {
    private let minInterval: TimeInterval = 1.0 / 30.0
    private let lastPublishedAt = OSAllocatedUnfairLock<TimeInterval>(initialState: 0)
    private let publish: @MainActor (Float) -> Void

    init(publish: @escaping @MainActor (Float) -> Void) {
        self.publish = publish
    }

    /// Called from the audio-render thread on every tap callback. Computes
    /// RMS synchronously first, then atomically checks-and-updates the
    /// publish gate; only when that gate is due does this hop to the main
    /// actor at all — dropping every intermediate value in between.
    func report(_ buffer: AVAudioPCMBuffer) {
        let level = Self.rms(of: buffer)
        let now = ProcessInfo.processInfo.systemUptime

        let due = lastPublishedAt.withLock { last -> Bool in
            guard now - last >= minInterval else { return false }
            last = now
            return true
        }
        guard due else { return }

        let publish = self.publish
        Task { @MainActor in publish(level) }
    }

    /// Root-mean-square of channel 0, scaled so typical speech (RMS roughly
    /// 0.01–0.3 for a normalized `Float` PCM buffer) lands well inside
    /// `0...1` rather than needing the loudest possible input to reach 1.
    private static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return 0 }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return 0 }
        let samples = channelData[0]
        var sumOfSquares: Float = 0
        for i in 0..<frameCount {
            let sample = samples[i]
            sumOfSquares += sample * sample
        }
        let rms = sqrt(sumOfSquares / Float(frameCount))
        return min(1, max(0, rms * 6))
    }
}
