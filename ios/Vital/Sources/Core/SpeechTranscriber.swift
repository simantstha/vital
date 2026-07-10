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

/// Reusable on-device speech-to-text engine built on `SFSpeechRecognizer` +
/// `AVAudioEngine`. Extracted from the pattern in
/// `Features/Logging/LogMealViewModel.swift` (that file is left untouched) so
/// both meal-logging voice search and coach tap-to-talk share one
/// implementation.
@MainActor
final class SpeechTranscriber: ObservableObject {

    @Published var transcribedText: String = ""
    @Published var isRecording: Bool = false
    @Published var permissionState: SpeechPermissionState = .notDetermined
    @Published var errorMessage: String? = nil

    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

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
        // the current locale/device.
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        recognitionRequest = req

        recognitionTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcribedText = result.bestTranscription.formattedString
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
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buf, _ in
            req?.append(buf)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            isRecording = true
        } catch {
            inputNode.removeTap(onBus: 0)
            errorMessage = "Could not start recording: \(error.localizedDescription)"
        }
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask = nil
    }
}
