import SwiftUI

// MARK: - Root view

struct CoachView: View {
    @StateObject private var vm = CoachViewModel()
    @Namespace private var bottomAnchor

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                navigationBar
                messageList
                inputBar
            }
        }
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
                        .foregroundStyle(Theme.Colors.accent)
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
                    ForEach(vm.messages) { msg in
                        MessageBubbleView(message: msg)
                            .id(msg.id)
                    }

                    if vm.isStreaming {
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
            .onChange(of: vm.messages.count) { _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: vm.messages.last?.text) { _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onChange(of: vm.isStreaming) { _ in
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
                    .tint(Theme.Colors.accent)
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
                                ? Theme.Colors.canvas
                                : Theme.Colors.canvas
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
                Text(message.text.isEmpty ? " " : message.text) // keep height while streaming
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(message.role == .user ? Theme.Colors.canvas : Theme.Colors.textPrimary)
                    .lineSpacing(3)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(bubbleBackground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if message.role == .assistant { Spacer(minLength: 48) }
        }
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if message.role == .user {
            // Lime bubble, right-aligned
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.accent)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .strokeBorder(Theme.Colors.accent.opacity(0.6), lineWidth: 0.5)
                )
        } else {
            // Glass bubble, left-aligned
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                )
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
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                    )
            )

            Spacer()
        }
        .onAppear { phase = 1 }
    }
}

