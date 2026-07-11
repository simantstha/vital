import SwiftUI

// MARK: - Root view

struct CoachView: View {
    @StateObject private var vm: CoachViewModel
    @Namespace private var bottomAnchor

    /// Set once the user taps the mic while permission is denied, so the
    /// inline "go to Settings" hint only appears after they've actually
    /// tried voice — not as a permanent nag.
    @State private var didAttemptDeniedMic = false
    @State private var isScrolledNearBottom = true

    /// `mode` is forwarded to every `/api/coach` call via `CoachViewModel`.
    /// The Coach tab uses the default (nil); the onboarding CoachIntro step
    /// passes `"onboarding"`.
    init(mode: String? = nil) {
        _vm = StateObject(wrappedValue: CoachViewModel(mode: mode))
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                navigationBar
                messageList
                inputBar
            }
        }
        // Fetch a fresh, data-aware opener when the Coach tab appears.
        .task { vm.loadOpener() }
        // Leaving the view mid-stream (e.g. onboarding CoachIntro → Continue)
        // must not leave a stream task running against a gone view.
        .onDisappear { vm.cancelStreaming() }
    }

    // MARK: - Navigation bar

    private var navigationBar: some View {
        HStack(spacing: Theme.Spacing.md) {
            // Avatar
            Circle()
                .fill(Theme.Colors.accent.opacity(0.15))
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: "message.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text("Coach")
                    .font(Theme.Typography.titleMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Vital AI")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
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
        }
    }

    private func scrollToBottomIfPinned(_ proxy: ScrollViewProxy) {
        guard isScrolledNearBottom else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
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
                    // typing over it would fight the mic.
                    .disabled(vm.transcriber.isRecording)
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
    }

    // MARK: - Mic button

    /// Tap-to-talk: authorized → toggle recording (tap again stops and
    /// sends); not yet asked → request permission only — recording starts on
    /// the next tap, never in the same instant the grant lands (starting the
    /// audio engine while the audio server is still spinning up after a
    /// first-time grant can abort inside AudioToolbox; LogMeal's two-step
    /// flow avoids this); denied → surface the inline Settings hint.
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
                Image(systemName: vm.transcriber.isRecording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(vm.transcriber.isRecording ? Theme.Colors.onAccent : Theme.Colors.accentContent)
            }
            .scaleEffect(vm.transcriber.isRecording ? 1.08 : 1.0)
        }
        .buttonStyle(.plain)
        .disabled(vm.isStreaming && !vm.transcriber.isRecording)
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
                MessageBubbleView(message: ChatMessage(id: turn.id, role: .assistant, text: turn.visibleText))
                    .transition(.opacity)
            }
        }
    }
}

// MARK: - Message bubble

private struct MessageBubbleView: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 48) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 0) {
                bubbleContent
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(message.role == .user ? Theme.Colors.onAccent : Theme.Colors.textPrimary)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.md)
                    .bubbleSurface(isUser: message.role == .user)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if message.role == .assistant { Spacer(minLength: 48) }
        }
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
    func bubbleSurface(isUser: Bool) -> some View {
        if isUser {
            background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Colors.accent)
            )
        } else {
            glassEffect(
                .regular,
                in: .rect(cornerRadius: Theme.Radius.lg, style: .continuous)
            )
        }
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
