import Foundation
import SwiftUI
import PhotosUI
import Combine

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
    /// Shared engine (also used by Coach tap-to-talk): Apple live preview +
    /// auto-stop watchdogs + a recorded clip for cloud transcription.
    let transcriber = SpeechTranscriber()
    /// True from the moment recording stops until the cloud STT upload (or
    /// its fallback to the Apple transcript) has resolved and search has run.
    @Published var isTranscribing: Bool = false

    // MARK: Private

    private let api = APIClient.shared
    private var cancellables = Set<AnyCancellable>()

    /// True from the moment the mic is tapped until the resulting transcript
    /// has been handed off to `finishVoiceInput()`. Guards the stop→finish
    /// binding below (mirrors `CoachViewModel`'s voice flow).
    private var isVoiceInputActive = false

    init() {
        bindVoice()
    }

    /// Forwards `transcriber`'s own change notifications into this view
    /// model's `objectWillChange` — `LogMealView` only observes `vm`, not
    /// `vm.transcriber` directly — and wires stopping the recording to
    /// kick off transcription + search.
    private func bindVoice() {
        transcriber.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        transcriber.$isRecording
            .removeDuplicates()
            .sink { [weak self] recording in
                guard let self, self.isVoiceInputActive, !recording else { return }
                self.isVoiceInputActive = false
                Task { await self.finishVoiceInput() }
            }
            .store(in: &cancellables)
    }

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
    //
    // Thin wrappers over the shared `SpeechTranscriber` so the view keeps
    // calling the same method names it always has.

    func checkSpeechPermissions() {
        transcriber.refreshPermissionState()
    }

    func requestSpeechPermissions() async {
        await transcriber.requestPermissions()
    }

    func toggleRecording() {
        if transcriber.isRecording {
            transcriber.stop()
        } else {
            guard !isTranscribing else { return }
            errorMessage = nil
            isVoiceInputActive = true
            transcriber.start()
        }
    }

    func stopRecording() {
        transcriber.stop()
    }

    /// Called once recording stops (manual tap or a watchdog auto-stop).
    /// Apple's live-preview transcript is the fallback; the accurate cloud
    /// transcript from `/api/stt` replaces it when the upload succeeds.
    /// Preserves the previous behavior of auto-searching as soon as a
    /// transcript is available, now on any stop rather than only a final
    /// on-device result.
    private func finishVoiceInput() async {
        let appleTranscript = transcriber.transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)
        let recordingURL = transcriber.recordingURL
        guard !appleTranscript.isEmpty || recordingURL != nil else { return }

        isTranscribing = true
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

        let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        searchText = trimmed
        await searchByText()
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
            ReminderScheduler.shared.mealLogged(on: Date())
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
        transcriber.discardRecording()
        clearResult()
        searchText = ""
    }
}
