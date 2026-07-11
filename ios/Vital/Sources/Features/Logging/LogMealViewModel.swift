import Foundation
import SwiftUI
import PhotosUI
import Speech
import AVFoundation

// MARK: - Input method

enum MealInputMethod: String, CaseIterable, Identifiable {
    case text    = "Text"
    case photo   = "Photo"
    case barcode = "Barcode"
    case voice   = "Voice"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .text:    return "magnifyingglass"
        case .photo:   return "photo"
        case .barcode: return "barcode.viewfinder"
        case .voice:   return "mic.fill"
        }
    }
}

// MARK: - Image Transferable bridge

/// Wraps raw image data so PhotosPicker can hand it to us via the Transferable API.
struct ImageTransfer: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { ImageTransfer(data: $0) }
    }
}

// MARK: - ViewModel

@MainActor
final class LogMealViewModel: ObservableObject {

    // ── Session state ─────────────────────────────────────────────────────────
    @Published var selectedMethod: MealInputMethod = .text
    @Published var isLoading: Bool = false
    @Published var errorMessage: String? = nil

    // ── Text input ────────────────────────────────────────────────────────────
    @Published var searchText: String = ""

    // ── Confirm card (shown after any method returns a result) ────────────────
    @Published var showConfirmCard: Bool = false
    @Published var editedName: String = ""
    @Published var editedKcal: String = ""
    @Published var editedProtein: String = ""
    @Published var editedCarbs: String = ""
    @Published var editedFat: String = ""
    /// Full-resolution image the user picked (photo method) — shown in the confirm card.
    @Published var pendingImage: UIImage? = nil
    private var pendingSource: String = "text"

    // ── Post-log ──────────────────────────────────────────────────────────────
    @Published var isLogged: Bool = false
    @Published var coachReaction: String? = nil

    // ── Voice ─────────────────────────────────────────────────────────────────
    @Published var isRecording: Bool = false
    @Published var transcribedText: String = ""
    @Published var speechAuthStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
    @Published var micAuthGranted: Bool = false

    // MARK: Private

    private let api = APIClient.shared
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    // MARK: - Pending meal helpers

    private func applyResult(name: String, kcal: Double, p: Double, c: Double, f: Double, source: String) {
        editedName    = name
        editedKcal    = "\(Int(kcal.rounded()))"
        editedProtein = String(format: "%.1f", p)
        editedCarbs   = String(format: "%.1f", c)
        editedFat     = String(format: "%.1f", f)
        pendingSource = source
        showConfirmCard = true
        errorMessage = nil
    }

    // MARK: - Text search

    func searchByText() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let r = try await api.searchFood(query)
            applyResult(name: r.name, kcal: r.kcal, p: r.p, c: r.c, f: r.f, source: "text")
        } catch {
            errorMessage = "Search failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Photo

    func handlePhotoItem(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let transfer = try await item.loadTransferable(type: ImageTransfer.self) else {
                errorMessage = "Could not read photo."
                return
            }
            // Compress to JPEG before sending; keeps payload under ~1 MB.
            let uiImage = UIImage(data: transfer.data)
            pendingImage = uiImage
            let jpeg = uiImage?.jpegData(compressionQuality: 0.6) ?? transfer.data
            let r = try await api.photoFood(imageBase64: jpeg.base64EncodedString())
            applyResult(name: r.name, kcal: r.kcal, p: r.p, c: r.c, f: r.f, source: "photo")
        } catch {
            errorMessage = "Photo analysis failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Barcode

    func handleBarcode(_ code: String) async {
        // Ignore if a scan is already in-flight or we already have a result.
        guard !isLoading, !showConfirmCard else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let r = try await api.barcodeFood(code, grams: nil)
            applyResult(name: r.name, kcal: r.kcal, p: r.p, c: r.c, f: r.f, source: "barcode")
        } catch {
            errorMessage = "Barcode lookup failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Voice

    func checkSpeechPermissions() {
        speechAuthStatus = SFSpeechRecognizer.authorizationStatus()
        micAuthGranted   = AVAudioApplication.shared.recordPermission == .granted
    }

    func requestSpeechPermissions() async {
        // Request speech recognition auth first.
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                Task { @MainActor in
                    self.speechAuthStatus = status
                    cont.resume()
                }
            }
        }
        // Then request microphone access.
        let granted = await AVAudioApplication.requestRecordPermission()
        micAuthGranted = granted
    }

    func toggleRecording() {
        if isRecording { stopRecording() } else { startRecording() }
    }

    private func startRecording() {
        guard speechAuthStatus == .authorized, micAuthGranted else { return }
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognizer unavailable."
            return
        }

        // Tear down any previous session.
        recognitionTask?.cancel()
        recognitionTask  = nil
        transcribedText  = ""
        errorMessage     = nil

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
        recognitionRequest = req

        recognitionTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcribedText = result.bestTranscription.formattedString
                    if result.isFinal {
                        let text = result.bestTranscription.formattedString
                        self.stopRecording()
                        if !text.isEmpty {
                            self.searchText = text
                            await self.searchByText()
                        }
                    }
                }
                if let error, self.isRecording {
                    // Suppress cancellation codes; surface genuine errors only.
                    let code = (error as NSError).code
                    guard code != 203, code != 301 else { return }
                    self.errorMessage = "Voice error: \(error.localizedDescription)"
                    self.stopRecording()
                }
            }
        }

        let inputNode = audioEngine.inputNode
        let format    = inputNode.outputFormat(forBus: 0)
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

    func stopRecording() {
        guard isRecording else { return }
        isRecording = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask    = nil
    }

    // MARK: - Log meal

    func logMeal() async {
        guard showConfirmCard else { return }
        let name    = editedName.trimmingCharacters(in: .whitespaces)
        let kcal    = Double(editedKcal)   ?? 0
        let protein = Double(editedProtein) ?? 0
        let carbs   = Double(editedCarbs)  ?? 0
        let fat     = Double(editedFat)    ?? 0

        // Attach a small thumbnail when the meal came from a photo, so the
        // Logs feed can show it. Kept tiny to stay light in the events ledger.
        let thumb = pendingImage.flatMap { Self.thumbnailBase64($0) }

        isLoading    = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await api.logMeal(
                name: name, kcal: kcal, c: carbs, p: protein, f: fat,
                source: pendingSource, imageThumb: thumb
            )
            coachReaction = response.coachReaction
            isLogged      = true
            ReminderScheduler.shared.mealLogged(at: Date())
        } catch {
            errorMessage = "Log failed: \(error.localizedDescription)"
        }
    }

    /// Downscale to a small square-ish JPEG and base64-encode it (no data-URL prefix).
    /// Target ~160px longest edge keeps the stored payload to a few KB.
    private static func thumbnailBase64(_ image: UIImage, maxEdge: CGFloat = 160) -> String? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, maxEdge / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        return resized.jpegData(compressionQuality: 0.5)?.base64EncodedString()
    }

    // MARK: - Reset (called when user starts a new search)

    func clearResult() {
        showConfirmCard = false
        isLogged        = false
        coachReaction   = nil
        errorMessage    = nil
        pendingImage    = nil
        editedName      = ""
        editedKcal      = ""
        editedProtein   = ""
        editedCarbs     = ""
        editedFat       = ""
    }

    func fullReset() {
        stopRecording()
        clearResult()
        searchText      = ""
        transcribedText = ""
    }
}
