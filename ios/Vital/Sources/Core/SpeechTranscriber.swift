import Foundation
import Speech
import AVFoundation

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

    /// Silence after non-empty speech: auto-stop ~1.8s after the last
    /// partial transcript, so a natural pause ends the turn.
    private let silenceThreshold: TimeInterval = 1.8
    /// No speech decoded at all: auto-stop after 10s so a turn with nothing
    /// said doesn't hang open.
    private let noSpeechTimeout: TimeInterval = 10
    /// Hard cap regardless of activity, so a stuck recognizer/session can't
    /// keep the mic open indefinitely.
    private let maxDuration: TimeInterval = 30

    private var silenceTask: Task<Void, Never>?
    private var noSpeechTask: Task<Void, Never>?
    private var maxDurationTask: Task<Void, Never>?

    init() {
        refreshPermissionState()
    }

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
        discardRecording()
        audioFile = nil

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
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
        // the audio thread and must never touch @MainActor state.
        let fileForTap = file
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buf, _ in
            req?.append(buf)
            try? fileForTap?.write(from: buf)
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
    private func restartSilenceWatchdog() {
        noSpeechTask?.cancel()
        noSpeechTask = nil

        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(self.silenceThreshold))
            guard !Task.isCancelled else { return }
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
    }
}
