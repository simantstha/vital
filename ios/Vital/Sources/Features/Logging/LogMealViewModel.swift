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

// MARK: - Portion mode

/// Drives the confirm card's portion controls once a candidate/barcode
/// result is applied. `nil` (the default) means no portion control — the
/// flat totals `applyResult` set are shown as-is, exactly like the old
/// single-result flow.
///
/// - `.perGram`: a cache/USDA/barcode result with a per-100g breakdown.
///   `servingGrams` is the "1 serving" size when the source knows it (drives
///   the stepper, default multiplier 1.0); `nil` means the source has no
///   serving size, so the UI must fall back to explicit grams entry rather
///   than silently assuming 100 g.
/// - `.scaledHistory`: a user-history candidate. History rows never carry a
///   per-gram breakdown (see `dedupHistory` server-side), so portion
///   adjustment linearly scales the last-logged totals themselves.
enum PortionMode {
    case perGram(per100g: NutritionCandidatePer100g, servingGrams: Double?, servingDesc: String?)
    case scaledHistory(kcal: Double, c: Double, p: Double, f: Double)
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
    /// Ranked matches from the last text/voice search (POST /api/nutrition/
    /// search's `candidates`). Non-empty means the UI shows a selectable
    /// list instead of jumping straight to the confirm card; empty (old
    /// server, or no candidates key at all) keeps the single-result flow.
    @Published var candidates: [NutritionCandidate] = []

    // ── Recents (quick re-log) ───────────────────────────────────────────────
    /// The user's own recently-logged meals (GET /api/nutrition/recents),
    /// shown as a tappable section above the text input. Painted from the
    /// UserDefaults cache instantly on open, then refreshed in the background.
    @Published var recents: [RecentFood] = []

    // ── Barcode ───────────────────────────────────────────────────────────────
    /// True when the barcode endpoint returned a genuine "not found" miss
    /// (`APIError.barcodeNotFound`) — shows a friendly fallback offering text
    /// search instead of a bare error banner.
    @Published var barcodeNotFound: Bool = false

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

    // ── Portion controls (confirm card) ─────────────────────────────────────
    @Published var portionMode: PortionMode? = nil
    /// 0.5-step serving multiplier, floor 0.5. Drives both `.perGram` (when
    /// `servingGrams` is known) and `.scaledHistory`.
    @Published var portionMultiplier: Double = 1.0
    /// Free-text grams entry, used for `.perGram` when `servingGrams` is
    /// unknown, or when the user opts into it via `toggleCustomPortionGrams()`.
    @Published var portionGramsText: String = ""
    @Published var useCustomPortionGrams: Bool = false

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
        setMacroFields(kcal: kcal, p: p, c: c, f: f)
        pendingSource = source
        showConfirmCard = true
        errorMessage = nil
    }

    private func setMacroFields(kcal: Double, p: Double, c: Double, f: Double) {
        editedKcal    = "\(Int(kcal.rounded()))"
        editedProtein = String(format: "%.1f", p)
        editedCarbs   = String(format: "%.1f", c)
        editedFat     = String(format: "%.1f", f)
    }

    // MARK: - Portion controls

    /// Recomputes the confirm card's macro fields from the active
    /// `portionMode` + the current multiplier/grams entry. A no-op when
    /// there's no portion mode (flat-result flow) or the grams entry doesn't
    /// yet parse to a positive number — the fields simply stay as they were
    /// until the user provides a valid amount.
    private func recomputePortion() {
        guard let mode = portionMode else { return }
        switch mode {
        case .scaledHistory(let kcal, let c, let p, let f):
            setMacroFields(
                kcal: kcal * portionMultiplier,
                p: p * portionMultiplier,
                c: c * portionMultiplier,
                f: f * portionMultiplier
            )
        case .perGram(let per100g, let servingGrams, _):
            let grams: Double?
            if let servingGrams, !useCustomPortionGrams {
                grams = servingGrams * portionMultiplier
            } else {
                grams = Double(portionGramsText)
            }
            guard let grams, grams > 0 else { return }
            let factor = grams / 100
            setMacroFields(
                kcal: per100g.kcal * factor,
                p: per100g.p * factor,
                c: per100g.c * factor,
                f: per100g.f * factor
            )
        }
    }

    /// True only when the confirm card is waiting on an explicit grams entry
    /// (unknown serving size, or the user opted into custom grams) that
    /// hasn't been filled in yet — gates the Log button so nothing gets
    /// logged against a silently-assumed 100 g.
    var portionNeedsGrams: Bool {
        guard case .perGram(_, let servingGrams, _) = portionMode,
              servingGrams == nil || useCustomPortionGrams
        else { return false }
        guard let grams = Double(portionGramsText), grams > 0 else { return true }
        return false
    }

    func incrementPortion() {
        portionMultiplier += 0.5
        recomputePortion()
    }

    func decrementPortion() {
        portionMultiplier = max(0.5, portionMultiplier - 0.5)
        recomputePortion()
    }

    func updatePortionGrams(_ text: String) {
        portionGramsText = text
        recomputePortion()
    }

    /// Toggles between the serving-multiplier stepper and free-text grams
    /// entry for a `.perGram` candidate whose `servingGrams` is known.
    /// Seeds the grams field with the stepper's current reading so the
    /// switch doesn't blank out a value the user already dialed in.
    func toggleCustomPortionGrams() {
        useCustomPortionGrams.toggle()
        if useCustomPortionGrams, case .perGram(_, let servingGrams, _) = portionMode, let servingGrams {
            portionGramsText = String(format: "%.0f", servingGrams * portionMultiplier)
        }
        recomputePortion()
    }

    private func resetPortionState() {
        portionMode = nil
        portionMultiplier = 1.0
        portionGramsText = ""
        useCustomPortionGrams = false
    }

    // MARK: - Text search

    func searchByText() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        candidates = []
        isLoading = true
        defer { isLoading = false }
        do {
            let r = try await api.searchFood(query)
            if let cands = r.candidates, !cands.isEmpty {
                // Old server (no `candidates` key, or an empty one) falls
                // through to the flat single-result flow below unchanged.
                // Hide any stale confirm card from a previous selection —
                // the old flow always overwrote it on a new search.
                showConfirmCard = false
                resetPortionState()
                candidates = cands
            } else {
                resetPortionState()
                applyResult(name: r.name, kcal: r.kcal, p: r.p, c: r.c, f: r.f, source: "text")
            }
        } catch {
            errorMessage = "Search failed: \(error.localizedDescription)"
        }
    }

    /// Selects one candidate from the list rendered after `searchByText()`.
    /// History rows get the "same as last time" scaled-totals portion mode;
    /// cache/USDA rows with a known serving size + per-100g breakdown get
    /// the full stepper/grams portion mode; everything else (estimate rows,
    /// or a cache/USDA row missing a serving size) falls back to the flat
    /// totals `applyResult` sets, unchanged.
    func chooseCandidate(_ candidate: NutritionCandidate) {
        candidates = []
        resetPortionState()

        if candidate.origin == "history" {
            portionMode = .scaledHistory(kcal: candidate.kcal, c: candidate.c, p: candidate.p, f: candidate.f)
        } else if let per100g = candidate.per100g, candidate.servingGrams != nil {
            portionMode = .perGram(per100g: per100g, servingGrams: candidate.servingGrams, servingDesc: candidate.servingDesc)
        }

        applyResult(name: candidate.name, kcal: candidate.kcal, p: candidate.p, c: candidate.c, f: candidate.f, source: "text")
    }

    // MARK: - Recents

    private static let recentsCacheKey = "vital.nutrition.recentsCache"

    /// Paints the cached copy instantly (if any), then refreshes from the
    /// server in the background. Silent on failure — recents are a
    /// nice-to-have quick-pick list, not something worth surfacing an error
    /// banner over — and shows nothing when there's no data at all.
    func loadRecents() async {
        if recents.isEmpty, let cached = Self.loadCachedRecents() {
            recents = cached
        }
        guard let fresh = try? await api.fetchNutritionRecents() else { return }
        recents = fresh
        Self.cacheRecents(fresh)
    }

    /// Applies a recent as-is — no portion controls (recents carry no
    /// per-gram breakdown), zero network.
    func applyRecent(_ recent: RecentFood) {
        candidates = []
        resetPortionState()
        applyResult(name: recent.name, kcal: recent.kcal, p: recent.p, c: recent.c, f: recent.f, source: "text")
    }

    private static func loadCachedRecents() -> [RecentFood]? {
        guard let data = UserDefaults.standard.data(forKey: recentsCacheKey) else { return nil }
        return try? JSONDecoder().decode([RecentFood].self, from: data)
    }

    private static func cacheRecents(_ items: [RecentFood]) {
        guard let data = try? JSONEncoder().encode(items) else { return }
        UserDefaults.standard.set(data, forKey: recentsCacheKey)
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
        barcodeNotFound = false
        defer { isLoading = false }
        do {
            let r = try await api.barcodeFood(code, grams: nil)
            applyBarcodeResult(r)
        } catch APIError.barcodeNotFound {
            // Genuine "every source missed" — the view shows a friendly
            // fallback offering text search instead of a bare error string.
            barcodeNotFound = true
        } catch {
            errorMessage = "Barcode lookup failed: \(error.localizedDescription)"
        }
    }

    /// Sets up the portion mode from a successful barcode lookup and seeds
    /// the confirm card. `grams: nil` was sent on the request, so the
    /// server's own `kcal/c/p/f` reflect its 100 g default — when the source
    /// knows a real serving size we recompute to "1 serving" instead of
    /// silently keeping that 100 g figure; when it doesn't, macros stay
    /// blank until the user types real grams (portion picker default 1
    /// serving when known, else explicit grams entry — never a silent 100 g).
    private func applyBarcodeResult(_ r: BarcodeResult) {
        candidates = []
        resetPortionState()

        guard let per100g = r.per100g else {
            // Old server without per100g — legacy flat-result behavior.
            applyResult(name: r.name, kcal: r.kcal, p: r.p, c: r.c, f: r.f, source: "barcode")
            return
        }

        portionMode = .perGram(per100g: per100g, servingGrams: r.servingGrams, servingDesc: r.servingDesc)

        if let servingGrams = r.servingGrams {
            let factor = servingGrams / 100
            applyResult(
                name: r.name,
                kcal: per100g.kcal * factor,
                p: per100g.p * factor,
                c: per100g.c * factor,
                f: per100g.f * factor,
                source: "barcode"
            )
        } else {
            applyResult(name: r.name, kcal: 0, p: 0, c: 0, f: 0, source: "barcode")
            editedKcal = ""
            editedProtein = ""
            editedCarbs = ""
            editedFat = ""
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
        candidates      = []
        barcodeNotFound = false
        resetPortionState()
    }

    func fullReset() {
        stopRecording()
        transcriber.discardRecording()
        clearResult()
        searchText = ""
    }
}
