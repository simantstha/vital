import SwiftUI
import PhotosUI
import UIKit

// MARK: - Auto-log decision

/// Pure decision logic for whether a photo-analysis result is confident
/// enough to log automatically (Cal AI style: log now, offer Undo) or must
/// fall back to the existing confirm card instead. No `@MainActor`, no
/// network, no view-model dependency — just the gate, so it's trivially
/// unit-testable and reusable if a future confidence signal is added.
enum PhotoLogDecision {
    /// Never auto-logs a zero-kcal or empty-name result — those are the only
    /// signals `POST /api/nutrition/photo` gives today (it doesn't yet return
    /// an explicit confidence score). If/when it does, thread it through here
    /// alongside a threshold rather than changing every call site.
    static func shouldAutoLog(name: String, kcal: Double) -> Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedName.isEmpty && kcal > 0
    }
}

// MARK: - PhotoLogFlowView

/// Camera-first photo meal logging (redesign-v4, "the Cal AI way"): shutter
/// → analyze → auto-log with Undo, presented full-screen from the Diet
/// sheet's Photo button whenever the device has a camera (see
/// `DietSheetView.deeperFlowsRow`; the Simulator/camera-less path never
/// reaches this view — it goes straight to the existing `LogMealView` Photo
/// tab instead).
///
/// A "Library" button is always visible as a fallback (spec build note 1),
/// routing into the same analyze → auto-log pipeline via `PhotosPicker`
/// rather than a second, separate flow.
struct PhotoLogFlowView: View {
    @ObservedObject var dietVM: DietSheetViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var capturedImage: UIImage?
    @State private var isAnalyzing = false
    @State private var errorMessage: String?
    /// Set once analysis fails, or comes back with no name/kcal — routes to
    /// the existing confirm-card flow (`LogMealView`) instead of silently
    /// dropping the shot. Pre-filled from whatever the analysis DID return.
    @State private var fallbackPayload: FallbackPayload?

    @State private var libraryItem: PhotosPickerItem?
    @State private var showLibraryPicker = false

    @State private var shutterTrigger = false
    @State private var loggedTrigger = false

    struct FallbackPayload: Identifiable {
        let id = UUID()
        let image: UIImage?
        let name: String
        let kcal: Double
        let c: Double
        let p: Double
        let f: Double
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let capturedImage {
                analyzingOverlay(capturedImage)
            } else {
                CameraCaptureView(
                    onCapture: { image in
                        shutterTrigger.toggle()
                        capturedImage = image
                        Task { await analyze(image) }
                    },
                    onCancel: { dismiss() }
                )
                .ignoresSafeArea()
            }

            VStack {
                Spacer()
                if capturedImage == nil {
                    libraryFallbackButton
                }
            }
            .padding(.bottom, Theme.Spacing.xxl)
        }
        .sensoryFeedback(Theme.Haptics.commit, trigger: shutterTrigger)
        .sensoryFeedback(Theme.Haptics.success, trigger: loggedTrigger)
        .photosPicker(isPresented: $showLibraryPicker, selection: $libraryItem, matching: .images)
        .onChange(of: libraryItem) { _, newItem in
            Task { await handleLibraryItem(newItem) }
        }
        .fullScreenCover(item: $fallbackPayload) { payload in
            LogMealView(initialMethod: .photo, prefill: LogMealPrefill(
                image: payload.image, name: payload.name,
                kcal: payload.kcal, c: payload.c, p: payload.p, f: payload.f
            ))
        }
        .onChange(of: fallbackPayload?.id) { oldValue, newValue in
            // The confirm-card fallback owns its own log; once it's
            // dismissed (`newValue == nil` after having been shown), this
            // whole camera-first flow is done too — back to the Diet sheet.
            if oldValue != nil, newValue == nil {
                dismiss()
            }
        }
    }

    // MARK: - Library fallback button

    private var libraryFallbackButton: some View {
        Button {
            showLibraryPicker = true
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "photo.on.rectangle")
                    .font(.system(size: 14, weight: .semibold))
                Text("Library")
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm + 2)
            .background(Capsule().fill(.white.opacity(0.16)))
            .overlay(Capsule().strokeBorder(.white.opacity(0.3), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose from Library")
        .accessibilityHint("Pick a meal photo instead of using the camera")
    }

    // MARK: - Analyzing state

    /// Calm, honest state over the captured photo: subtle shimmer, no fake
    /// percentages — just "Reading your plate…" until the request resolves.
    private func analyzingOverlay(_ image: UIImage) -> some View {
        ZStack(alignment: .bottom) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .ignoresSafeArea()
                .overlay(shimmer)

            VStack(spacing: Theme.Spacing.md) {
                if isAnalyzing {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProgressView()
                            .tint(.white)
                        Text("Reading your plate…")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(Capsule().fill(.black.opacity(0.45)))
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 13))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Theme.Spacing.xl)
                }
            }
            .padding(.bottom, Theme.Spacing.xxxl)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isAnalyzing ? "Reading your plate" : "Meal photo captured")
    }

    @ViewBuilder
    private var shimmer: some View {
        if !reduceMotion, isAnalyzing {
            ShimmerOverlay()
        } else {
            Color.black.opacity(0.15)
        }
    }

    // MARK: - Analysis → auto-log

    private func analyze(_ image: UIImage) async {
        isAnalyzing = true
        errorMessage = nil
        defer { isAnalyzing = false }

        let jpeg = image.jpegData(compressionQuality: 0.6) ?? Data()
        do {
            let result = try await APIClient.shared.photoFood(imageBase64: jpeg.base64EncodedString())
            await handleResult(result, image: image)
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .read, tag: "photoFoodCameraFirst")
            // Genuine failure (no name/kcal at all) — hand off to the
            // confirm card so the user can retry or enter it manually
            // instead of losing the shot.
            fallbackPayload = FallbackPayload(image: image, name: "", kcal: 0, c: 0, p: 0, f: 0)
        }
    }

    private func handleResult(_ result: NutritionResult, image: UIImage) async {
        guard PhotoLogDecision.shouldAutoLog(name: result.name, kcal: result.kcal) else {
            fallbackPayload = FallbackPayload(
                image: image, name: result.name,
                kcal: result.kcal, c: result.c, p: result.p, f: result.f
            )
            return
        }

        let thumb = Self.thumbnailBase64(image)
        let ok = await dietVM.logPhotoResult(
            name: result.name, kcal: result.kcal, c: result.c, p: result.p, f: result.f,
            imageThumb: thumb
        )
        if ok {
            loggedTrigger.toggle()
            dismiss()
        } else {
            // Network failure on the log call itself — same fallback as an
            // analysis failure, pre-filled with what we already know.
            fallbackPayload = FallbackPayload(
                image: image, name: result.name,
                kcal: result.kcal, c: result.c, p: result.p, f: result.f
            )
        }
    }

    private func handleLibraryItem(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        do {
            guard let transfer = try await item.loadTransferable(type: ImageTransfer.self),
                  let uiImage = UIImage(data: transfer.data)
            else {
                errorMessage = "Could not read photo."
                return
            }
            capturedImage = uiImage
            await analyze(uiImage)
        } catch {
            errorMessage = "Could not read photo."
        }
    }

    /// Downscale to a small square-ish JPEG and base64-encode it (no
    /// data-URL prefix) — mirrors `LogMealViewModel.thumbnailBase64`.
    private static func thumbnailBase64(_ image: UIImage, maxEdge: CGFloat = 160) -> String? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, maxEdge / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        return resized.jpegData(compressionQuality: 0.5)?.base64EncodedString()
    }
}

// MARK: - Shimmer

/// Subtle ambient shimmer sweep over the captured photo while analysis is in
/// flight — no fake progress percentage, just motion that says "working".
/// Honors Reduce Motion via the caller's `shimmer` computed property, which
/// substitutes a plain dim overlay instead of rendering this at all.
private struct ShimmerOverlay: View {
    @State private var phase: CGFloat = -1

    var body: some View {
        LinearGradient(
            colors: [.clear, .white.opacity(0.18), .clear],
            startPoint: .top, endPoint: .bottom
        )
        .frame(height: 220)
        .offset(y: phase * 400)
        .onAppear {
            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }
}

// MARK: - CameraCaptureView

/// Thin `UIImagePickerController` wrapper for full-screen camera capture.
/// Guard every call site with `UIImagePickerController.isSourceTypeAvailable
/// (.camera)` first — it's `false` on the Simulator (no camera hardware),
/// exactly like `DataScannerViewController.isSupported` for barcode
/// scanning above.
struct CameraCaptureView: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage) -> Void
        let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            } else {
                onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
