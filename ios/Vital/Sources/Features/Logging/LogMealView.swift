import SwiftUI
import PhotosUI
import VisionKit

// MARK: - Sheet root

struct LogMealView: View {
    @StateObject private var vm = LogMealViewModel()
    @Environment(\.dismiss) private var dismiss

    /// Local photo-picker selection — view-local UI state.
    @State private var photoItem: PhotosPickerItem? = nil

    /// Drives focus into the text search field — used by the barcode
    /// "Search by Name" fallback so the switch to the Text tab lands the
    /// keyboard immediately instead of requiring an extra tap.
    @FocusState private var searchFieldFocused: Bool

    /// Which method tab to open on. Backward-compatible: existing call sites
    /// (`LogMealView()`) keep defaulting to `.text` unchanged. Lets the diet
    /// sheet (redesign-v3 Phase 3) deep-link straight into Photo/Barcode.
    private let initialMethod: MealInputMethod

    init(initialMethod: MealInputMethod = .text) {
        self.initialMethod = initialMethod
    }

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
                        // Tab-agnostic, like the confirm card below it: voice
                        // funnels into searchByText() too, so its candidate
                        // results must render on the Voice tab as well —
                        // switching tabs to look for them would wipe them via
                        // the onChange clearResult above.
                        if !vm.candidates.isEmpty { candidateListSection }
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
        .onAppear {
            vm.selectedMethod = initialMethod
        }
        // Paints the UserDefaults-cached recents instantly, then refreshes
        // from the server in the background — runs once per sheet open.
        .task {
            await vm.loadRecents()
        }
    }
}

// MARK: - Private sub-views

private extension LogMealView {

    // ── Date parsing (candidate "Logged Jul 12" badges) ─────────────────────

    static let isoParserFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static let badgeDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

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
                            ? Theme.Colors.onAccent
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
            // Recents — hidden once a search has results or the confirm
            // card is up, so it doesn't compete with the active flow.
            if !vm.recents.isEmpty, vm.candidates.isEmpty, !vm.showConfirmCard {
                recentsSection
            }

            // Search field
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.Colors.textSecondary)
                TextField("banana, grilled chicken, oat milk latte…", text: $vm.searchText)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .tint(Theme.Colors.accentContent)
                    .focused($searchFieldFocused)
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
                ProgressView().tint(Theme.Colors.accentContent)
            } else {
                Button {
                    Task { await vm.searchByText() }
                } label: {
                    Text("Search")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(Theme.Colors.accent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .disabled(vm.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            // Candidate list renders tab-agnostically from the sheet root
            // (next to the confirm card) so voice searches surface it too.
        }
    }

    // ── Recents (quick re-log) ───────────────────────────────────────────────

    var recentsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Recent")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.sm) {
                    ForEach(vm.recents, id: \.name) { recent in
                        Button {
                            vm.applyRecent(recent)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(recent.name)
                                    .font(Theme.Typography.labelMedium)
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                    .lineLimit(1)
                                Text("\(Int(recent.kcal.rounded())) kcal")
                                    .font(Theme.Typography.labelSmall)
                                    .foregroundStyle(Theme.Colors.textSecondary)
                            }
                            .padding(.horizontal, Theme.Spacing.md)
                            .padding(.vertical, Theme.Spacing.sm)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.Radius.pill, style: .continuous)
                                    .fill(Theme.Colors.glassFill)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: Theme.Radius.pill, style: .continuous)
                                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                                    )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, Theme.Spacing.xxs)
            }
        }
    }

    // ── Candidate list ───────────────────────────────────────────────────────

    var candidateListSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Results")
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(Array(vm.candidates.enumerated()), id: \.offset) { _, candidate in
                    candidateRow(candidate)
                }
            }
        }
    }

    func candidateRow(_ candidate: NutritionCandidate) -> some View {
        Button {
            vm.chooseCandidate(candidate)
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Theme.Spacing.xs) {
                        Text(candidate.name)
                            .font(Theme.Typography.bodyMedium)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .lineLimit(1)
                        if let badge = loggedBadge(candidate.lastLoggedAt) {
                            Text(badge)
                                .font(Theme.Typography.labelSmall)
                                .foregroundStyle(Theme.Colors.accentContent)
                                .padding(.horizontal, Theme.Spacing.sm)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Theme.Colors.accentSoft))
                        }
                    }
                    if let subtitle = candidateSubtitle(candidate) {
                        Text(subtitle)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text("\(Int(candidate.kcal.rounded())) kcal")
                    .font(Theme.Typography.numericSmall(15))
                    .foregroundStyle(Theme.Colors.textPrimary)
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
        }
        .buttonStyle(.plain)
    }

    /// Brand + serving description, e.g. "Chobani • 170 g cup" — nil when
    /// the candidate has neither (history rows, estimates).
    func candidateSubtitle(_ candidate: NutritionCandidate) -> String? {
        let parts = [candidate.brand, candidate.servingDesc]
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " • ")
    }

    /// "Logged Jul 12" from a history candidate's `lastLoggedAt` ISO8601
    /// timestamp. Tries with-fractional-seconds first, falls back to
    /// without — server timestamps can come either way.
    func loggedBadge(_ isoTimestamp: String?) -> String? {
        guard let isoTimestamp else { return nil }
        guard let date = Self.isoParserFractional.date(from: isoTimestamp)
                ?? Self.isoParser.date(from: isoTimestamp)
        else { return nil }
        return "Logged \(Self.badgeDateFormatter.string(from: date))"
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
                            .foregroundStyle(Theme.Colors.accentContent)
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
                    ProgressView().tint(Theme.Colors.accentContent)
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
                        ProgressView().tint(Theme.Colors.accentContent)
                        Text("Looking up product…")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                } else if vm.barcodeNotFound {
                    barcodeNotFoundCard
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

    /// Friendly fallback for `APIError.barcodeNotFound` — every source
    /// genuinely missed this scan. Offers text search instead of a bare
    /// error string, switching to the Text tab with the search field
    /// pre-focused so the user can retype the name immediately.
    var barcodeNotFoundCard: some View {
        GlassCard {
            VStack(spacing: Theme.Spacing.lg) {
                Image(systemName: "questionmark.barcode")
                    .font(.system(size: 38))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text("Couldn't find that product")
                    .font(Theme.Typography.bodyMedium)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Try searching by name instead.")
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                Button {
                    vm.barcodeNotFound = false
                    vm.selectedMethod = .text
                    searchFieldFocused = true
                } label: {
                    Text("Search by Name")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .padding(.horizontal, Theme.Spacing.xl)
                        .padding(.vertical, Theme.Spacing.sm)
                        .background(Theme.Colors.accent)
                        .clipShape(Capsule())
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.lg)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Voice  (simulator-testable via Mac microphone)
    // ─────────────────────────────────────────────────────────────────────────

    @ViewBuilder
    var voiceSection: some View {
        if vm.transcriber.permissionState == .authorized {
            VStack(spacing: Theme.Spacing.lg) {
                GlassCard {
                    VStack(spacing: Theme.Spacing.xl) {
                        // Mic / stop button
                        Button { vm.toggleRecording() } label: {
                            ZStack {
                                Circle()
                                    .fill(vm.transcriber.isRecording
                                          ? Theme.Colors.alert.opacity(0.18)
                                          : Theme.Colors.accent.opacity(0.12))
                                    .frame(width: 80, height: 80)
                                Image(systemName: vm.transcriber.isRecording ? "stop.fill" : "mic.fill")
                                    .font(.system(size: 28, weight: .semibold))
                                    .foregroundStyle(vm.transcriber.isRecording ? Theme.Colors.alert : Theme.Colors.accentContent)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.isTranscribing)
                        .scaleEffect(vm.transcriber.isRecording ? 1.05 : 1.0)
                        .animation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true),
                                   value: vm.transcriber.isRecording)

                        if vm.isTranscribing {
                            HStack(spacing: Theme.Spacing.sm) {
                                ProgressView().tint(Theme.Colors.accentContent)
                                Text("Transcribing…")
                                    .font(Theme.Typography.bodyMedium)
                                    .foregroundStyle(Theme.Colors.accentContent)
                            }
                        } else if vm.transcriber.isRecording {
                            Text("Listening…")
                                .font(Theme.Typography.bodyMedium)
                                .foregroundStyle(Theme.Colors.accentContent)
                        } else {
                            Text("Tap to speak a food name")
                                .font(Theme.Typography.bodyMedium)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }

                        if !vm.transcriber.transcribedText.isEmpty {
                            Text("\u{201C}\(vm.transcriber.transcribedText)\u{201D}")
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
                        ProgressView().tint(Theme.Colors.accentContent)
                        Text("Searching…")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }
        } else if vm.transcriber.permissionState == .denied {
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
                            .foregroundStyle(Theme.Colors.onAccent)
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
                        .foregroundStyle(Theme.Colors.accentContent)
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
                            .foregroundStyle(Theme.Colors.onAccent)
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
                        .tint(Theme.Colors.accentContent)
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

                portionControl

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
                            ProgressView().tint(Theme.Colors.onAccent)
                        } else {
                            Text("Log Meal")
                                .font(.system(size: 16, weight: .semibold))
                        }
                    }
                    .foregroundStyle(Theme.Colors.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(Theme.Colors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                }
                .disabled(
                    vm.isLoading
                    || vm.editedName.trimmingCharacters(in: .whitespaces).isEmpty
                    || vm.portionNeedsGrams
                )
            }
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: vm.showConfirmCard)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MARK: Portion controls
    // ─────────────────────────────────────────────────────────────────────────

    /// Only rendered when `vm.portionMode` is set — a cache/USDA/barcode
    /// candidate with a per-100g breakdown, or a history candidate (scaled
    /// totals, no per-gram data needed). Everything else (estimate rows, an
    /// old server with no candidates) keeps the flat totals hidden, exactly
    /// like the pre-existing single-result flow.
    @ViewBuilder
    var portionControl: some View {
        if let mode = vm.portionMode {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Portion")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)

                switch mode {
                case .scaledHistory:
                    portionStepperRow(
                        title: "Same as last time",
                        subtitle: String(format: "%.1f×", vm.portionMultiplier)
                    )

                case .perGram(_, let servingGrams, let servingDesc):
                    if let servingGrams, !vm.useCustomPortionGrams {
                        portionStepperRow(
                            title: servingDesc ?? "1 serving",
                            subtitle: "\(Int((servingGrams * vm.portionMultiplier).rounded())) g · \(String(format: "%.1f×", vm.portionMultiplier))"
                        )
                    } else {
                        portionGramsEntryRow
                    }

                    if servingGrams != nil {
                        Button {
                            vm.toggleCustomPortionGrams()
                        } label: {
                            Text(vm.useCustomPortionGrams ? "Use serving stepper" : "Enter grams instead")
                                .font(Theme.Typography.labelMedium)
                                .foregroundStyle(Theme.Colors.accentContent)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    func portionStepperRow(title: String, subtitle: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer()
            HStack(spacing: Theme.Spacing.md) {
                Button {
                    vm.decrementPortion()
                } label: {
                    Image(systemName: "minus.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(
                            vm.portionMultiplier <= 0.5
                                ? Theme.Colors.textTertiary
                                : Theme.Colors.accentContent
                        )
                }
                .buttonStyle(.plain)
                .disabled(vm.portionMultiplier <= 0.5)

                Text(String(format: "%.1f×", vm.portionMultiplier))
                    .font(Theme.Typography.numericSmall(15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(minWidth: 36)

                Button {
                    vm.incrementPortion()
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Theme.Colors.accentContent)
                }
                .buttonStyle(.plain)
            }
        }
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

    var portionGramsEntryRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            TextField("Grams eaten", text: Binding(
                get: { vm.portionGramsText },
                set: { vm.updatePortionGrams($0) }
            ))
            .keyboardType(.decimalPad)
            .font(Theme.Typography.numericSmall(15))
            .foregroundStyle(Theme.Colors.textPrimary)
            .tint(Theme.Colors.accentContent)
            Text("g")
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
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
                    .foregroundStyle(Theme.Colors.onAccent)
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
                .tint(Theme.Colors.accentContent)
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
