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

    // MARK: - Auto-stop watchdogs

    /// No speech decoded at all: auto-stop after 10s so a turn with nothing
    /// said doesn't hang open.
    private let noSpeechTimeout: TimeInterval = 10
    /// Hard cap regardless of activity, so a stuck recognizer/session can't
    /// keep the mic open indefinitely.
    private let maxDuration: TimeInterval = 30

    private var silenceTask: Task<Void, Never>?
    private var noSpeechTask: Task<Void, Never>?
    private var maxDurationTask: Task<Void, Never>?

    /// When the first non-empty partial of this turn arrived, used to
    /// compute `speechDuration` for `EndpointPolicy` (short utterances get a
    /// wider window so they aren't clipped). Nil until speech is detected;
    /// reset on every `start()`.
    private var speechStartedAt: Date?

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
        errorMessage = nil
        cancelWatchdogs()
        speechStartedAt = nil
        endpointDeadline = nil
        discardRecording()
        audioFile = nil

        do {
            try VoiceAudioSession.activate()
        } catch {
            errorMessage = "Audio session error: \(error.localizedDescription)"
            return
        }

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
        recognitionRequest = req

        recognitionTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcribedText = result.bestTranscription.formattedString
                    if !self.transcribedText.isEmpty {
                        self.restartSilenceWatchdog()
                    }
                    if result.isFinal {
                        self.stop()
                    }
                }
                if let error, self.isRecording {
                    // Suppress cancellation codes; surface genuine errors only.
                    let code = (error as NSError).code
                    guard code != 203, code != 301 else { return }
                    self.errorMessage = "Voice error: \(error.localizedDescription)"
                    self.stop()
                }
            }
        }

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
        // `levelBridge` is the one seam that's allowed to, since it hops to
        // `@MainActor` itself before touching anything.
        let fileForTap = file
        let levelBridge = LevelBridge { [weak self] level in self?.inputLevel = level }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buf, _ in
            req?.append(buf)
            try? fileForTap?.write(from: buf)
            levelBridge.report(buf)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            isRecording = true
            startNoSpeechWatchdog()
            startMaxDurationWatchdog()
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

    // MARK: - Watchdogs
    //
    // Three independent, cancellation-safe @MainActor tasks. Each just calls
    // stop(), which is idempotent (guards on `isRecording`), so overlapping
    // fires are harmless.

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
        noSpeechTask?.cancel()
        noSpeechTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(self.noSpeechTimeout))
            guard !Task.isCancelled else { return }
            self.stop()
        }
    }

    private func startMaxDurationWatchdog() {
        maxDurationTask?.cancel()
        maxDurationTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(self.maxDuration))
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
