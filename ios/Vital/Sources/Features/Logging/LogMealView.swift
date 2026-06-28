import SwiftUI
import PhotosUI
import VisionKit
import Speech

// MARK: - Sheet root

struct LogMealView: View {
    @StateObject private var vm = LogMealViewModel()
    @Environment(\.dismiss) private var dismiss

    /// Local photo-picker selection — view-local UI state.
    @State private var photoItem: PhotosPickerItem? = nil

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                headerBar
                methodSegmentPicker
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.vertical, Theme.Spacing.lg)
                Divider()
                    .background(Theme.Colors.glassBorder)
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                        methodContent
                        if vm.showConfirmCard { confirmCard }
                        if vm.isLogged      { loggedSection }
                        if let err = vm.errorMessage {
                            errorBanner(message: err)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.xl)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
        }
        // When the user switches tabs, cancel any in-flight recording.
        .onChange(of: vm.selectedMethod) {
            vm.stopRecording()
            vm.clearResult()
            photoItem = nil
        }
        // Handle photo picker selection.
        .onChange(of: photoItem) { _, newItem in
            Task { await vm.handlePhotoItem(newItem) }
        }
    }
}

// MARK: - Private sub-views

private extension LogMealView {

    // ── Header ────────────────────────────────────────────────────────────────

    var headerBar: some View {
        HStack {
            Text("Log Food")
                .font(Theme.Typography.titleMedium)
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            Button {
                vm.fullReset()
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 26))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.top, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.md)
    }

    // ── Custom segmented picker ───────────────────────────────────────────────

    var methodSegmentPicker: some View {
        HStack(spacing: 4) {
            ForEach(MealInputMethod.allCases) { method in
                Button {
                    vm.selectedMethod = method
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: method.icon)
                            .font(.system(size: 11, weight: .semibold))
                        Text(method.rawValue)
                            .font(Theme.Typography.labelMedium)
                    }
                    .foregroundStyle(
                        vm.selectedMethod == method
                            ? Theme.Colors.canvas
                            : Theme.Colors.textSecondary
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(vm.selectedMethod == method
                                  ? Theme.Colors.accent
                                  : Color.clear)
                    )
                }
                .buttonStyle(.plain)
                .animation(.easeInOut(duration: 0.15), value: vm.selectedMethod)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.sm + 4, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm + 4, style: .continuous)
                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                )
        )
    }

    // ── Method dispatch ───────────────────────────────────────────────────────

    @ViewBuilder
    var methodContent: some View {
        switch vm.selectedMethod {
        case .text:    textInputSection
        case .photo:   photoSection
        case .barcode: barcodeSection
        case .voice:   voiceSection
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Text
    // ─────────────────────────────────────────────────────────────────────────

    var textInputSection: some View {
        VStack(spacing: Theme.Spacing.lg) {
            // Search field
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.Colors.textSecondary)
                TextField("banana, grilled chicken, oat milk latte…", text: $vm.searchText)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .tint(Theme.Colors.accent)
                    .onSubmit { Task { await vm.searchByText() } }
            }
            .padding(Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                    )
            )

            if vm.isLoading {
                ProgressView().tint(Theme.Colors.accent)
            } else {
                Button {
                    Task { await vm.searchByText() }
                } label: {
                    Text("Search")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.Colors.canvas)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(Theme.Colors.accent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .disabled(vm.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Photo  (simulator-testable via simulator photo library)
    // ─────────────────────────────────────────────────────────────────────────

    var photoSection: some View {
        VStack(spacing: Theme.Spacing.lg) {
            PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                GlassCard {
                    VStack(spacing: Theme.Spacing.md) {
                        Image(systemName: "photo.fill.on.rectangle.fill")
                            .font(.system(size: 38))
                            .foregroundStyle(Theme.Colors.accent)
                        Text("Choose a photo")
                            .font(Theme.Typography.bodyMedium)
                            .fontWeight(.semibold)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Pick an image of a meal from your library and Vital will identify the food automatically.")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.lg)
                }
            }
            .buttonStyle(.plain)

            if vm.isLoading {
                HStack(spacing: Theme.Spacing.sm) {
                    ProgressView().tint(Theme.Colors.accent)
                    Text("Identifying food…")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Barcode  (device-only — DataScannerViewController.isSupported = false on sim)
    // ─────────────────────────────────────────────────────────────────────────

    @ViewBuilder
    var barcodeSection: some View {
        if DataScannerViewController.isSupported {
            VStack(spacing: Theme.Spacing.lg) {
                BarcodeScannerView { code in
                    Task { await vm.handleBarcode(code) }
                }
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                )

                if vm.isLoading {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProgressView().tint(Theme.Colors.accent)
                        Text("Looking up product…")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                } else if !vm.showConfirmCard {
                    Text("Point the camera at a product barcode")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }
        } else {
            // Graceful simulator / unsupported device state
            GlassCard {
                VStack(spacing: Theme.Spacing.lg) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(Theme.Colors.textSecondary)
                    Text("Camera required")
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("Barcode scanning uses the device camera and is not available in the simulator. Use Text or Photo on the simulator, or run on a real device.")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.xl)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Voice  (simulator-testable via Mac microphone)
    // ─────────────────────────────────────────────────────────────────────────

    @ViewBuilder
    var voiceSection: some View {
        if vm.speechAuthStatus == .authorized && vm.micAuthGranted {
            VStack(spacing: Theme.Spacing.lg) {
                GlassCard {
                    VStack(spacing: Theme.Spacing.xl) {
                        // Mic / stop button
                        Button { vm.toggleRecording() } label: {
                            ZStack {
                                Circle()
                                    .fill(vm.isRecording
                                          ? Theme.Colors.alert.opacity(0.18)
                                          : Theme.Colors.accent.opacity(0.12))
                                    .frame(width: 80, height: 80)
                                Image(systemName: vm.isRecording ? "stop.fill" : "mic.fill")
                                    .font(.system(size: 28, weight: .semibold))
                                    .foregroundStyle(vm.isRecording ? Theme.Colors.alert : Theme.Colors.accent)
                            }
                        }
                        .buttonStyle(.plain)
                        .scaleEffect(vm.isRecording ? 1.05 : 1.0)
                        .animation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true),
                                   value: vm.isRecording)

                        if vm.isRecording {
                            Text("Listening…")
                                .font(Theme.Typography.bodyMedium)
                                .foregroundStyle(Theme.Colors.accent)
                        } else {
                            Text("Tap to speak a food name")
                                .font(Theme.Typography.bodyMedium)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }

                        if !vm.transcribedText.isEmpty {
                            Text("\u{201C}\(vm.transcribedText)\u{201D}")
                                .font(Theme.Typography.bodySmall)
                                .italic()
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.xl)
                }

                if vm.isLoading {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProgressView().tint(Theme.Colors.accent)
                        Text("Searching…")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }
        } else if vm.speechAuthStatus == .denied || (vm.speechAuthStatus != .notDetermined && !vm.micAuthGranted) {
            // Permissions denied
            GlassCard {
                VStack(spacing: Theme.Spacing.lg) {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 38))
                        .foregroundStyle(Theme.Colors.textSecondary)
                    Text("Microphone access needed")
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("Allow Microphone and Speech Recognition in Settings to use voice input.")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        Text("Open Settings")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.Colors.canvas)
                            .padding(.horizontal, Theme.Spacing.xl)
                            .padding(.vertical, Theme.Spacing.sm)
                            .background(Theme.Colors.accent)
                            .clipShape(Capsule())
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.xl)
            }
        } else {
            // Not yet asked
            GlassCard {
                VStack(spacing: Theme.Spacing.lg) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 38))
                        .foregroundStyle(Theme.Colors.accent)
                    Text("Enable voice input")
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("Speak a food name and Vital searches automatically.")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                    Button {
                        Task { await vm.requestSpeechPermissions() }
                    } label: {
                        Text("Allow Microphone")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.Colors.canvas)
                            .padding(.horizontal, Theme.Spacing.xl)
                            .padding(.vertical, Theme.Spacing.sm)
                            .background(Theme.Colors.accent)
                            .clipShape(Capsule())
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.xl)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Confirm card
    // ─────────────────────────────────────────────────────────────────────────

    var confirmCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                HStack {
                    SectionHeader(title: "Confirm Meal")
                    Spacer()
                    Button {
                        vm.clearResult()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }

                // Photo preview (photo method only)
                if let image = vm.pendingImage {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity)
                        .frame(height: 160)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                                .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                        )
                }

                // Editable name
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("Name")
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    TextField("Food name", text: $vm.editedName)
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .tint(Theme.Colors.accent)
                        .padding(Theme.Spacing.md)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(Theme.Colors.glassFill)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                                )
                        )
                }

                // Macro fields — 2×2 grid
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())],
                          spacing: Theme.Spacing.md) {
                    MacroEditField(label: "Calories",  unit: "kcal", text: $vm.editedKcal)
                    MacroEditField(label: "Protein",   unit: "g",    text: $vm.editedProtein)
                    MacroEditField(label: "Carbs",     unit: "g",    text: $vm.editedCarbs)
                    MacroEditField(label: "Fat",       unit: "g",    text: $vm.editedFat)
                }

                // Log button
                Button {
                    Task { await vm.logMeal() }
                } label: {
                    Group {
                        if vm.isLoading {
                            ProgressView().tint(Theme.Colors.canvas)
                        } else {
                            Text("Log Meal")
                                .font(.system(size: 16, weight: .semibold))
                        }
                    }
                    .foregroundStyle(Theme.Colors.canvas)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .disabled(vm.isLoading || vm.editedName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: vm.showConfirmCard)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Post-log section
    // ─────────────────────────────────────────────────────────────────────────

    var loggedSection: some View {
        VStack(spacing: Theme.Spacing.xl) {
            if let reaction = vm.coachReaction {
                // Reuse CoachBubble from the design system
                CoachBubble(message: reaction)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .animation(.spring(response: 0.5, dampingFraction: 0.8), value: vm.isLogged)
            }

            Button {
                vm.fullReset()
                dismiss()
            } label: {
                Text("Done")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.canvas)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Error banner
    // ─────────────────────────────────────────────────────────────────────────

    func errorBanner(message: String) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.Colors.alert)
            Text(message)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button { vm.errorMessage = nil } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .padding(Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Colors.alert.opacity(0.12))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(Theme.Colors.alert.opacity(0.25), lineWidth: 0.5)
                )
        )
    }
}

// MARK: - MacroEditField

/// A labelled numeric TextField for the confirm card.
private struct MacroEditField: View {
    let label: String
    let unit: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("\(label) (\(unit))")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            TextField("0", text: $text)
                .keyboardType(.decimalPad)
                .font(Theme.Typography.numericSmall(15))
                .foregroundStyle(Theme.Colors.textPrimary)
                .tint(Theme.Colors.accent)
                .multilineTextAlignment(.center)
                .padding(.vertical, Theme.Spacing.sm)
                .padding(.horizontal, Theme.Spacing.md)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .fill(Theme.Colors.glassFill)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                        )
                )
        }
    }
}

// MARK: - BarcodeScannerView

/// Wraps VisionKit `DataScannerViewController` for SwiftUI.
/// Guard with `DataScannerViewController.isSupported` before presenting —
/// `isSupported` is false on the simulator (no camera hardware).
private struct BarcodeScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode()],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {
        // Start scanning once the VC is in the hierarchy.
        guard !uiViewController.isScanning else { return }
        try? uiViewController.startScanning()
    }

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController,
                                          coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    // MARK: Coordinator

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        private var didScan = false

        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        func dataScanner(_ dataScanner: DataScannerViewController,
                         didAdd addedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            guard !didScan else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item,
                   let payload = barcode.payloadStringValue {
                    didScan = true
                    dataScanner.stopScanning()
                    onScan(payload)
                    return
                }
            }
        }
    }
}
