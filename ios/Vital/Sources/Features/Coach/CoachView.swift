import SwiftUI

// MARK: - Root view

struct CoachView: View {
    @StateObject private var vm: CoachViewModel
    @Namespace private var bottomAnchor

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
                        case .toolCall(let call):
                            ToolCallActivityView(row: call)
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
            .onChange(of: vm.rows) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: vm.isStreaming) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: vm.isOpening) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Input bar

    private var inputBar: some View {
        VStack(spacing: 0) {
            Divider()
                .background(Theme.Colors.glassBorder)

            HStack(spacing: Theme.Spacing.md) {
                TextField("Message your coach…", text: $vm.input, axis: .vertical)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .tint(Theme.Colors.accentContent)
                    .lineLimit(1...5)
                    .padding(.vertical, Theme.Spacing.sm)
                    .onSubmit {
                        vm.send()
                    }

                Button(action: vm.send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(
                            vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || vm.isStreaming
                                ? Theme.Colors.onAccent
                                : Theme.Colors.onAccent
                        )
                        .frame(width: 32, height: 32)
                        .background(
                            Circle()
                                .fill(
                                    vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || vm.isStreaming
                                        ? Theme.Colors.accent.opacity(0.3)
                                        : Theme.Colors.accent
                                )
                        )
                }
                .disabled(vm.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || vm.isStreaming)
                .animation(.easeInOut(duration: 0.15), value: vm.isStreaming)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(Theme.Colors.canvas)
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

/// Inline, quiet indicator for a backend tool call: a spinner + label while
/// running, collapsing to a small checkmark tag (via `Chip`) once done. Sits
/// left-aligned in the transcript, distinct from message bubbles.
private struct ToolCallActivityView: View {
    let row: ToolCallRow

    var body: some View {
        HStack {
            if row.isDone {
                Chip(text: row.label, icon: "checkmark")
            } else {
                HStack(spacing: Theme.Spacing.xs) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Colors.textSecondary)
                    Text(row.label)
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
            }

            Spacer()
        }
        .animation(.easeInOut(duration: 0.2), value: row.isDone)
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

