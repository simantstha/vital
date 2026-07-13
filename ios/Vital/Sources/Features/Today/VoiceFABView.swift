import SwiftUI
import UIKit

// MARK: - VoiceFABView

/// Lime mic FAB, bottom-right on Today (Phase 4 of the redesign — see
/// `docs/redesign-v3-plan.md`). Tap to start listening: a pulse ring grows
/// around the button, a full-screen lime edge-glow overlay appears, and the
/// in-progress transcript is shown live as a caption. Tap again (or let one
/// of `SpeechTranscriber`'s watchdogs auto-stop) to end the turn: the final
/// transcript is uploaded to the cloud STT proxy (falling back to Apple's
/// on-device preview if that fails/returns empty — same rule as
/// `CoachViewModel.finishVoiceInput`) and handed to
/// `CoachViewModel.sendExternalVoiceTranscript`, which runs it through the
/// exact same send/stream/speak pipeline a Coach-tab voice turn uses.
///
/// Owns its own `SpeechTranscriber` instance rather than reusing
/// `coachVM.transcriber` — a Today voice turn should never contend with (or
/// be silently cancelled by) an in-progress recording started from the Coach
/// tab's own mic button, and vice versa. `coachVM` is still the single
/// shared instance from `RootTabView`, so both entry points funnel into the
/// same conversation thread and TTS speaker regardless of which mic recorded.
struct VoiceFABView: View {
    @ObservedObject var coachVM: CoachViewModel

    /// Fired once the transcript has been handed to
    /// `coachVM.sendExternalVoiceTranscript` — the caller shows the "Sent to
    /// your coach" toast and switches to the Coach tab.
    var onSent: () -> Void

    @StateObject private var transcriber = SpeechTranscriber()
    @State private var isUploading = false
    @State private var isVoiceTurnActive = false
    @State private var showDeniedAlert = false

    private let fabSize: CGFloat = 60

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if transcriber.isRecording {
                edgeGlow
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .ignoresSafeArea()
                    .transition(.opacity)

                captionOverlay
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, fabSize + Theme.Spacing.xxxl)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            fab
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .animation(.easeInOut(duration: 0.2), value: transcriber.isRecording)
        .onChange(of: transcriber.isRecording) { _, isRecording in
            guard !isRecording, isVoiceTurnActive else { return }
            isVoiceTurnActive = false
            finishAndSend()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            // Picks up a permission grant made in Settings without requiring
            // an app relaunch, so the FAB "stays usable to retry" per spec.
            transcriber.refreshPermissionState()
        }
        .alert("Microphone access needed", isPresented: $showDeniedAlert) {
            Button("Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Allow microphone and speech recognition access in Settings to talk to your coach.")
        }
    }

    // MARK: - FAB button

    private var fab: some View {
        Button(action: handleTap) {
            ZStack {
                if transcriber.isRecording {
                    PulseRing(diameter: fabSize)
                }

                Circle()
                    .fill(Theme.Colors.accent)
                    .frame(width: fabSize, height: fabSize)
                    .shadow(color: .black.opacity(0.22), radius: 14, x: 0, y: 8)

                if isUploading {
                    ProgressView()
                        .tint(Theme.Colors.onAccent)
                } else {
                    Image(systemName: transcriber.isRecording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(isUploading || (coachVM.isStreaming && !transcriber.isRecording))
        .opacity(coachVM.isStreaming && !transcriber.isRecording ? 0.5 : 1.0)
        .padding(.trailing, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.xxxl)
    }

    // MARK: - Listening overlays

    private var edgeGlow: some View {
        RoundedRectangle(cornerRadius: 0)
            .strokeBorder(Theme.Colors.accent.opacity(0.55), lineWidth: 36)
            .blur(radius: 28)
            .allowsHitTesting(false)
    }

    private var captionOverlay: some View {
        Text(transcriber.transcribedText.isEmpty ? "Listening…" : transcriber.transcribedText)
            .font(Theme.Typography.bodyMedium)
            .fontWeight(.medium)
            .foregroundStyle(Theme.Colors.onAccent)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Colors.accent)
                    .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 6)
            )
            .padding(.horizontal, Theme.Spacing.xxl)
            .allowsHitTesting(false)
    }

    // MARK: - Actions

    private func handleTap() {
        switch transcriber.permissionState {
        case .authorized:
            if transcriber.isRecording {
                transcriber.stop()
            } else {
                guard !isUploading, !coachVM.isStreaming else { return }
                isVoiceTurnActive = true
                transcriber.start()
            }
        case .notDetermined:
            Task {
                await transcriber.requestPermissions()
                if transcriber.permissionState != .authorized {
                    showDeniedAlert = true
                }
            }
        case .denied:
            showDeniedAlert = true
        }
    }

    /// Mirrors `CoachViewModel.finishVoiceInput`'s upload-then-fallback rule
    /// for the one Today-specific difference: instead of populating an
    /// on-screen text field, the resolved transcript is handed straight to
    /// `sendExternalVoiceTranscript` and `onSent()` fires so the caller can
    /// toast + switch tabs.
    private func finishAndSend() {
        let appleTranscript = transcriber.transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)
        let recordingURL = transcriber.recordingURL
        guard !appleTranscript.isEmpty || recordingURL != nil else { return }

        isUploading = true
        Task {
            defer {
                isUploading = false
                transcriber.discardRecording()
            }

            var finalText = appleTranscript
            if let recordingURL,
               let cloudText = await APIClient.shared.uploadSTTAudio(fileURL: recordingURL),
               !cloudText.isEmpty {
                finalText = cloudText
            }

            guard !Task.isCancelled else { return }

            let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            coachVM.sendExternalVoiceTranscript(trimmed)
            onSent()
        }
    }
}

// MARK: - Pulse ring

/// Grows and fades out on a continuous loop while a `ZStack` sibling shows
/// it (i.e. only while recording — the caller conditionally includes this
/// view, so `.onAppear` fires fresh at the start of every voice turn).
private struct PulseRing: View {
    let diameter: CGFloat
    @State private var animating = false

    var body: some View {
        Circle()
            .stroke(Theme.Colors.accent.opacity(0.6), lineWidth: 3)
            .frame(width: diameter, height: diameter)
            .scaleEffect(animating ? 1.9 : 1.0)
            .opacity(animating ? 0 : 0.7)
            .onAppear {
                withAnimation(.easeOut(duration: 1.3).repeatForever(autoreverses: false)) {
                    animating = true
                }
            }
    }
}
