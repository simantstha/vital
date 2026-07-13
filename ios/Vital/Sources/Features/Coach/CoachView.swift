import SwiftUI

// MARK: - Root view

struct CoachView: View {
    @StateObject private var vm: CoachViewModel
    @Namespace private var bottomAnchor
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Set once the user taps the mic while permission is denied, so the
    /// inline "go to Settings" hint only appears after they've actually
    /// tried voice — not as a permanent nag.
    @State private var didAttemptDeniedMic = false
    @State private var isScrolledNearBottom = true
    @State private var specialistGlowExpanded = false
    @State private var pendingConfirmedAction: SpecialistAction?

    /// `mode` is forwarded to every `/api/coach` call via `CoachViewModel`.
    /// The Coach tab uses the default (nil); the onboarding CoachIntro step
    /// passes `"onboarding"`.
    init(mode: String? = nil, initialMessage: String? = nil) {
        let model = CoachViewModel(mode: mode)
        model.input = initialMessage ?? ""
        _vm = StateObject(wrappedValue: model)
    }

    /// Used by `RootTabView`, which owns a single `CoachViewModel` shared
    /// with Today's voice FAB — so a transcript sent from Today
    /// (`CoachViewModel.sendExternalVoiceTranscript`) lands in the exact same
    /// thread the user sees here. `StateObject(wrappedValue:)` is safe with
    /// an externally-owned instance as long as the same instance is passed
    /// on every re-init, which it is here (`coachVM` is itself a
    /// `@StateObject` on `RootTabView`, stable across re-renders).
    init(vm: CoachViewModel) {
        _vm = StateObject(wrappedValue: vm)
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                navigationBar
                messageList
                inputBar
            }

            specialistEdgeGlow
        }
        // Fetch a fresh, data-aware opener when the Coach tab appears.
        .task { vm.loadOpener() }
        // Leaving the view mid-stream (e.g. onboarding CoachIntro → Continue)
        // must not leave a stream task running against a gone view.
        .onDisappear { vm.cancelStreaming() }
        .onChange(of: vm.activePersona.id) { _, personaID in
            specialistGlowExpanded = false
            guard personaID != "vital", !reduceMotion else { return }
            Task { @MainActor in
                await Task.yield()
                specialistGlowExpanded = true
            }
        }
        .confirmationDialog(
            confirmationTitle,
            isPresented: confirmationIsPresented,
            titleVisibility: .visible
        ) {
            if let action = pendingConfirmedAction {
                Button(confirmationButtonTitle(for: action)) {
                    vm.performSpecialistAction(action)
                    pendingConfirmedAction = nil
                }
            }
            Button("Cancel", role: .cancel) {
                pendingConfirmedAction = nil
            }
        }
    }

    // MARK: - Navigation bar

    private var navigationBar: some View {
        let header = CoachViewPresentation.header(for: vm.activePersona)
        let isSpecialist = vm.activePersona.id != "vital"

        return HStack(spacing: Theme.Spacing.md) {
            // Avatar
            Circle()
                .fill((isSpecialist ? Theme.Colors.specialistAccent : Theme.Colors.accent).opacity(0.15))
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: header.iconSystemName)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(isSpecialist ? Theme.Colors.specialistAccent : Theme.Colors.accentContent)
                )
                .shadow(
                    color: isSpecialist ? Theme.Colors.specialistEdgeGlow.opacity(0.45) : .clear,
                    radius: 9
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(header.title)
                    .font(Theme.Typography.titleMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(header.subtitle)
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(isSpecialist ? Theme.Colors.specialistAccent : Theme.Colors.textSecondary)
            }

            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.top, Theme.Spacing.md)
        .padding(.bottom, Theme.Spacing.sm)
        .background(Theme.Colors.canvas)
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: Theme.Spacing.md) {
                    ForEach(vm.rows) { row in
                        switch row {
                        case .message(let msg):
                            MessageBubbleView(message: msg)
                                .id(row.id)
                        case .assistantTurn(let turn):
                            AssistantTurnView(turn: turn)
                                .id(row.id)
                        }
                    }

                    if let card = vm.pendingHandoffCard {
                        SpecialistHandoffCardView(
                            presentation: CoachViewPresentation.handoffCard(
                                for: card,
                                isPerformingAction: vm.isPerformingSpecialistAction
                            ),
                            card: card,
                            perform: performSpecialistAction
                        )
                        .id("specialist-handoff-\(card.sessionId)-\(card.phase.rawValue)")
                    }

                    if vm.showTypingIndicator {
                        TypingIndicatorView()
                            .id("typing")
                    }

                    // Invisible anchor to scroll to bottom
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 80
            } action: { _, nearBottom in
                isScrolledNearBottom = nearBottom
            }
            .onChange(of: vm.rows) {
                scrollToBottomIfPinned(proxy)
            }
            .onChange(of: vm.isStreaming) {
                scrollToBottomIfPinned(proxy)
            }
            .onChange(of: vm.isOpening) {
                scrollToBottomIfPinned(proxy)
            }
            .onChange(of: vm.pendingHandoffCard) {
                scrollToBottomIfPinned(proxy)
            }
        }
    }

    private func scrollToBottomIfPinned(_ proxy: ScrollViewProxy) {
        guard isScrolledNearBottom else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    @ViewBuilder
    private var specialistEdgeGlow: some View {
        if vm.activePersona.id != "vital" {
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .stroke(Theme.Colors.specialistEdgeGlow.opacity(0.72), lineWidth: 1)
                .shadow(color: Theme.Colors.specialistEdgeGlow.opacity(0.55), radius: 10)
                .padding(2)
                .opacity(reduceMotion ? 0.58 : (specialistGlowExpanded ? 0.9 : 0.42))
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .onAppear { specialistGlowExpanded = true }
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 1.8).repeatForever(autoreverses: true),
                    value: specialistGlowExpanded
                )
        }
    }

    private func performSpecialistAction(_ action: CoachViewPresentation.CardAction) {
        guard action.isEnabled else { return }
        if action.requiresConfirmation {
            pendingConfirmedAction = action.action
        } else {
            vm.performSpecialistAction(action.action)
        }
    }

    private var confirmationIsPresented: Binding<Bool> {
        Binding(
            get: { pendingConfirmedAction != nil },
            set: { if !$0 { pendingConfirmedAction = nil } }
        )
    }

    private var confirmationTitle: String {
        guard let action = pendingConfirmedAction,
              let card = vm.pendingHandoffCard
        else { return "Confirm action" }
        let presentation = CoachViewPresentation.handoffCard(
            for: card,
            isPerformingAction: vm.isPerformingSpecialistAction
        )
        return [presentation.primaryAction, presentation.secondaryAction]
            .first(where: { $0.action == action })?.confirmationTitle ?? "Confirm action"
    }

    private func confirmationButtonTitle(for action: SpecialistAction) -> String {
        switch action {
        case .acceptReturn: return "Return to Vital"
        case .declineReturn: return "Stay with Running Coach"
        case .acceptHandoff: return "Bring them in"
        case .declineHandoff: return "Not now"
        }
    }

    // MARK: - Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            if vm.speaker.isSpeaking {
                stopSpeakingRow
            }

            if showMicPermissionHint {
                micPermissionHint
            }

            Divider()
                .background(Theme.Colors.glassBorder)

            HStack(spacing: Theme.Spacing.md) {
                TextField("Message your coach…", text: $vm.input, axis: .vertical)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .tint(Theme.Colors.accentContent)
                    .lineLimit(1...5)
                    .padding(.vertical, Theme.Spacing.sm)
                    // While recording, the field mirrors the live transcript —
                    // typing over it would fight the mic. Also disabled while
                    // the recorded clip is being transcribed.
                    .disabled(vm.transcriber.isRecording || vm.isTranscribing)
                    .onSubmit {
                        vm.send()
                    }

                micButton

                Button(action: vm.send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Theme.Colors.onAccent)
                        .frame(width: 32, height: 32)
                        .background(
                            Circle()
                                .fill(
                                    canSend
                                        ? Theme.Colors.accent
                                        : Theme.Colors.accent.opacity(0.3)
                                )
                        )
                }
                .disabled(!canSend)
                .animation(.easeInOut(duration: 0.15), value: vm.isStreaming)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(Theme.Colors.canvas)
        }
    }

    private var canSend: Bool {
        !vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !vm.isStreaming
            && !vm.transcriber.isRecording
            && !vm.isTranscribing
    }

    // MARK: - Mic button

    /// Tap-to-talk, three states: idle → recording (tap again stops, or a
    /// watchdog auto-stops on silence/timeout) → transcribing (spinner,
    /// disabled, while the cloud upload resolves). Not yet asked → request
    /// permission only — recording starts on the next tap, never in the same
    /// instant the grant lands (starting the audio engine while the audio
    /// server is still spinning up after a first-time grant can abort inside
    /// AudioToolbox; LogMeal's two-step flow avoids this); denied → surface
    /// the inline Settings hint.
    private var micButton: some View {
        Button {
            switch vm.transcriber.permissionState {
            case .authorized:
                vm.toggleVoiceRecording()
            case .notDetermined:
                Task {
                    await vm.requestVoicePermissions()
                    if vm.transcriber.permissionState != .authorized {
                        didAttemptDeniedMic = true
                    }
                }
            case .denied:
                didAttemptDeniedMic = true
            }
        } label: {
            ZStack {
                Circle()
                    .fill(vm.transcriber.isRecording
                          ? Theme.Colors.alert
                          : Theme.Colors.accent.opacity(0.15))
                    .frame(width: 32, height: 32)
                if vm.isTranscribing {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Colors.accentContent)
                } else {
                    Image(systemName: vm.transcriber.isRecording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(vm.transcriber.isRecording ? Theme.Colors.onAccent : Theme.Colors.accentContent)
                }
            }
            .scaleEffect(vm.transcriber.isRecording ? 1.08 : 1.0)
        }
        .buttonStyle(.plain)
        .disabled((vm.isStreaming && !vm.transcriber.isRecording) || vm.isTranscribing)
        .animation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true), value: vm.transcriber.isRecording)
    }

    private var showMicPermissionHint: Bool {
        didAttemptDeniedMic && vm.transcriber.permissionState == .denied
    }

    private var micPermissionHint: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "mic.slash.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
            Text("Allow microphone and speech recognition in Settings to talk to your coach.")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer(minLength: Theme.Spacing.sm)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Settings")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.glassFill)
    }

    // MARK: - Stop-speaking row

    /// Shown above the input bar while the coach's reply is being read
    /// aloud; tapping it cancels speech immediately (the text keeps
    /// streaming/rendering either way).
    private var stopSpeakingRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "speaker.wave.2.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.accentContent)
            Text("Speaking…")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer()
            Button { vm.speaker.stop() } label: {
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Stop")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(Theme.Colors.textPrimary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.xs)
                .background(Capsule().fill(Theme.Colors.glassFill))
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.canvas)
    }
}

// MARK: - Assistant turn

private struct AssistantTurnView: View {
    let turn: AssistantTurn

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(turn.dataCards) { card in
                CoachDataCardView(viz: card.viz)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }

            if let status = turn.statusSummary {
                ToolCallActivityView(label: status, isChecking: turn.isChecking)
            }

            if !turn.visibleText.isEmpty {
                MessageBubbleView(
                    message: ChatMessage(id: turn.id, role: .assistant, text: turn.visibleText),
                    presentation: CoachViewPresentation.assistantTurn(for: turn)
                )
                .transition(.opacity)
            }
        }
    }
}

// MARK: - Message bubble

private struct MessageBubbleView: View {
    let message: ChatMessage
    var presentation: CoachViewPresentation.Bubble? = nil

    var body: some View {
        if message.role == .system {
            JoinedSystemRowView(text: message.text)
        } else {
            HStack {
                if message.role == .user { Spacer(minLength: 48) }

                VStack(alignment: message.role == .user ? .trailing : .leading, spacing: Theme.Spacing.xs) {
                    if let label = resolvedPresentation.bubbleLabel {
                        Text(label)
                            .font(.system(size: 10, weight: .bold))
                            .tracking(0.9)
                            .foregroundStyle(Theme.Colors.specialistAccent)
                            .accessibilityLabel(resolvedPresentation.speakerLabel)
                    }

                    bubbleContent
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(message.role == .user ? Theme.Colors.onAccent : Theme.Colors.textPrimary)
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.vertical, Theme.Spacing.md)
                        .bubbleSurface(
                            isUser: message.role == .user,
                            isSpecialist: resolvedPresentation.bubbleLabel != nil
                        )
                        .fixedSize(horizontal: false, vertical: true)
                }

                if message.role == .assistant { Spacer(minLength: 48) }
            }
        }
    }

    private var resolvedPresentation: CoachViewPresentation.Bubble {
        presentation ?? CoachViewPresentation.messageBubble(for: message)
    }

    /// User bubbles are plain single-line-ish text; the coach reply renders
    /// block-level markdown (lists, paragraphs) via MarkdownText.
    @ViewBuilder
    private var bubbleContent: some View {
        if message.role == .user {
            Text(message.text.asMarkdown)
                .lineSpacing(3)
        } else {
            MarkdownText(markdown: message.text)
        }
    }
}

/// Chat-bubble surface: a solid lime fill for the user, real Liquid Glass for the coach.
private extension View {
    @ViewBuilder
    func bubbleSurface(isUser: Bool, isSpecialist: Bool) -> some View {
        if isUser {
            background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Colors.accent)
            )
        } else {
            glassEffect(
                isSpecialist
                    ? .regular.tint(Theme.Colors.specialistAccent.opacity(0.10))
                    : .regular,
                in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous)
            )
            .overlay {
                if isSpecialist {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .stroke(Theme.Colors.specialistAccent.opacity(0.42), lineWidth: 0.75)
                }
            }
        }
    }
}

// MARK: - Specialist handoff UI

private struct SpecialistHandoffCardView: View {
    let presentation: CoachViewPresentation.HandoffCard
    let card: CoachHandoffCard
    let perform: (CoachViewPresentation.CardAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: card.specialist.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.specialistAccent)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.Colors.specialistAccent.opacity(0.14)))

                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(card.phase == .proposed ? "SPECIALIST HANDOFF" : "RETURN TO VITAL")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.8)
                        .foregroundStyle(Theme.Colors.specialistAccent)
                    Text(card.specialist.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
            }

            Text(card.phase == .proposed ? card.objective : "Your running consultation is ready to wrap up.")
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textSecondary)

            if card.phase == .returnProposed,
               let summary = card.returnSummary {
                let sections = CoachViewPresentation.returnSummarySections(from: summary)
                if !sections.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        ForEach(sections, id: \.title) { section in
                            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                                Text(section.title.uppercased())
                                    .font(.system(size: 9, weight: .bold))
                                    .tracking(0.7)
                                    .foregroundStyle(Theme.Colors.specialistAccent)
                                Text(section.items.joined(separator: " • "))
                                    .font(Theme.Typography.bodySmall)
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }

            HStack(spacing: Theme.Spacing.sm) {
                actionButton(presentation.primaryAction, prominent: true)
                actionButton(presentation.secondaryAction, prominent: false)
            }
        }
        .padding(Theme.Spacing.lg)
        .specialistCardSurface()
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func actionButton(_ action: CoachViewPresentation.CardAction, prominent: Bool) -> some View {
        if prominent {
            Button(action.title) { perform(action) }
                .buttonStyle(.glassProminent)
                .tint(Theme.Colors.specialistAccent)
                .disabled(!action.isEnabled)
        } else {
            Button(action.title) { perform(action) }
                .buttonStyle(.glass)
                .tint(Theme.Colors.textSecondary)
                .disabled(!action.isEnabled)
        }
    }
}

private struct JoinedSystemRowView: View {
    let text: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Rectangle()
                .fill(Theme.Colors.specialistAccent.opacity(0.55))
                .frame(height: 1)
            Image(systemName: "figure.run")
                .foregroundStyle(Theme.Colors.specialistAccent)
            Text(text)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(CoachViewPresentation.joinedSystemRowLineLimit(for: dynamicTypeSize))
                .layoutPriority(1)
                .fixedSize(horizontal: !dynamicTypeSize.isAccessibilitySize, vertical: true)
            Rectangle()
                .fill(Theme.Colors.specialistAccent.opacity(0.55))
                .frame(height: 1)
        }
        .padding(.vertical, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}

private extension View {
    func specialistCardSurface() -> some View {
        glassEffect(
            .regular.tint(Theme.Colors.specialistAccent.opacity(0.10)),
            in: .rect(cornerRadius: Theme.Radius.xl, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .stroke(Theme.Colors.specialistAccent.opacity(0.48), lineWidth: 0.75)
        )
    }
}

// MARK: - Specialist presentation contract

enum CoachViewPresentation {
    struct Header: Equatable {
        let title: String
        let subtitle: String
        let iconSystemName: String
        let accentHex: String
    }

    struct CardAction: Equatable {
        let title: String
        let action: SpecialistAction
        let requiresConfirmation: Bool
        let confirmationTitle: String?
        let isEnabled: Bool
    }

    struct HandoffCard: Equatable {
        let primaryAction: CardAction
        let secondaryAction: CardAction
    }

    struct Bubble: Equatable {
        let speakerLabel: String
        let bubbleLabel: String?
        let accentHex: String
    }

    struct ReturnSummarySection: Equatable {
        let title: String
        let items: [String]
    }

    static func header(for persona: CoachPersonaSnapshot) -> Header {
        guard persona.id != "vital" else {
            return Header(
                title: "Coach",
                subtitle: "Vital AI",
                iconSystemName: "message.fill",
                accentHex: "#C7F23B"
            )
        }
        return Header(
            title: persona.title,
            subtitle: persona.subtitle,
            iconSystemName: persona.icon,
            accentHex: persona.accent
        )
    }

    static func handoffCard(
        for card: CoachHandoffCard,
        isPerformingAction: Bool
    ) -> HandoffCard {
        let enabled = !isPerformingAction
        switch card.phase {
        case .proposed, .dismissed:
            return HandoffCard(
                primaryAction: CardAction(
                    title: "Bring them in",
                    action: .acceptHandoff,
                    requiresConfirmation: false,
                    confirmationTitle: nil,
                    isEnabled: enabled
                ),
                secondaryAction: CardAction(
                    title: "Not now",
                    action: .declineHandoff,
                    requiresConfirmation: false,
                    confirmationTitle: nil,
                    isEnabled: enabled
                )
            )
        case .returnProposed:
            return HandoffCard(
                primaryAction: CardAction(
                    title: "Return to Vital",
                    action: .acceptReturn,
                    requiresConfirmation: true,
                    confirmationTitle: "Return to Vital?",
                    isEnabled: enabled
                ),
                secondaryAction: CardAction(
                    title: "Stay with Running Coach",
                    action: .declineReturn,
                    requiresConfirmation: true,
                    confirmationTitle: "Stay with Running Coach?",
                    isEnabled: enabled
                )
            )
        }
    }

    static func joinedSystemRowText(for persona: CoachPersonaSnapshot) -> String {
        "\(persona.title) joined."
    }

    static func joinedSystemRowLineLimit(for dynamicTypeSize: DynamicTypeSize) -> Int? {
        dynamicTypeSize.isAccessibilitySize ? nil : 1
    }

    static func returnSummarySections(from summary: JSONValue) -> [ReturnSummarySection] {
        guard case .object(let object) = summary else { return [] }
        let categories = [
            (key: "outcomes", title: "Outcomes"),
            (key: "decisions", title: "Decisions"),
            (key: "recommendations", title: "Recommendations"),
            (key: "unresolvedRisks", title: "Unresolved risks"),
            (key: "nextSteps", title: "Next steps"),
        ]

        return categories.compactMap { category in
            guard case .array(let values) = object[category.key] else { return nil }
            let items = values.compactMap { value -> String? in
                guard case .string(let text) = value else { return nil }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            guard !items.isEmpty else { return nil }
            return ReturnSummarySection(title: category.title, items: items)
        }
    }

    static func messageBubble(for message: ChatMessage) -> Bubble {
        guard let metadata = message.specialistMetadata else {
            return Bubble(speakerLabel: "Coach", bubbleLabel: nil, accentHex: "#C7F23B")
        }
        return Bubble(
            speakerLabel: metadata.name,
            bubbleLabel: metadata.name.uppercased(),
            accentHex: metadata.accentColor
        )
    }

    static func assistantTurn(for turn: AssistantTurn) -> Bubble {
        guard turn.persona.id != "vital" else {
            return Bubble(speakerLabel: "Coach", bubbleLabel: nil, accentHex: "#C7F23B")
        }
        return Bubble(
            speakerLabel: turn.persona.title,
            bubbleLabel: turn.persona.title.uppercased(),
            accentHex: turn.persona.accent
        )
    }

}

// MARK: - Tool-call activity row

/// Inline, quiet indicator for the active backend work in an assistant turn.
/// Completed tool calls are intentionally not left behind as permanent chat
/// content; the data cards and answer carry the durable result.
private struct ToolCallActivityView: View {
    let label: String
    let isChecking: Bool

    var body: some View {
        HStack {
            if isChecking {
                HStack(spacing: Theme.Spacing.xs) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Colors.textSecondary)
                    Text(label)
                        .font(Theme.Typography.labelSmall)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule()
                        .fill(Theme.Colors.glassFill)
                        .overlay(
                            Capsule()
                                .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                        )
                )
            } else {
                Chip(text: label, icon: "checkmark")
            }

            Spacer()
        }
    }
}

// MARK: - Typing indicator

private struct TypingIndicatorView: View {
    @State private var phase: Int = 0

    var body: some View {
        HStack {
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Theme.Colors.textSecondary)
                        .frame(width: 7, height: 7)
                        .scaleEffect(phase == i ? 1.3 : 0.8)
                        .animation(
                            .easeInOut(duration: 0.4)
                                .repeatForever(autoreverses: true)
                                .delay(Double(i) * 0.15),
                            value: phase
                        )
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .glassEffect(
                .regular,
                in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous)
            )

            Spacer()
        }
        .onAppear { phase = 1 }
    }
}
