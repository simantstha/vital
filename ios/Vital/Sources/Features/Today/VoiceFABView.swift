import SwiftUI
import UIKit

// MARK: - VoiceFABView

/// Lime mic FAB, bottom-right on Today (Phase 4 of the redesign — see
/// `docs/redesign-v3-plan.md`). Tap to start listening: a pulse ring grows
/// around the button, a full-screen lime edge-glow overlay appears, and the
/// in-progress transcript is shown live as a caption. Tap again (or let one
/// of `SpeechTranscriber`'s watchdogs auto-stop) to end the turn.
///
/// Drives `coachVM.voiceController` — the same shared record→(cloud
/// STT)→final-transcript pipeline the Coach tab's own mic button uses (spec
/// `ux-spec-v4` §3.2, delivery slice V2). A recording started here is the
/// same recording the Coach tab sees, and vice versa: only one can be live
/// at a time, since they're the same controller. The controller's
/// `onFinalTranscript` hook (owned by `CoachViewModel`) already sends every
/// completed turn through the normal chat pipeline — this view only needs
/// to know when *its own* turn was the one that landed, so it can fire
/// `onSent()` (toast + switch to the Coach tab). It does that by capturing
/// `voiceController.currentTurnID` when it starts a recording and watching
/// `voiceController.lastDeliveredTurnID` for a match.
struct VoiceFABView: View {
    @ObservedObject var coachVM: CoachViewModel

    /// Fired once this FAB's own transcript has been sent through
    /// `coachVM` — the caller shows the "Sent to your coach" toast and
    /// switches to the Coach tab.
    var onSent: () -> Void

    @ObservedObject private var voice: CoachVoiceController
    @State private var myTurnID: UUID? = nil
    @State private var showDeniedAlert = false

    private let fabSize: CGFloat = 60

    init(coachVM: CoachViewModel, onSent: @escaping () -> Void) {
        self.coachVM = coachVM
        self.onSent = onSent
        self._voice = ObservedObject(wrappedValue: coachVM.voiceController)
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if voice.isRecording {
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
        .animation(Theme.Motion.quick, value: voice.isRecording)
        .onChange(of: voice.lastDeliveredTurnID) { _, delivered in
            guard let delivered, delivered == myTurnID else { return }
            myTurnID = nil
            onSent()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            // Picks up a permission grant made in Settings without requiring
            // an app relaunch, so the FAB "stays usable to retry" per spec.
            voice.refreshPermissionState()
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
                if voice.isRecording {
                    PulseRing(diameter: fabSize)
                }

                Circle()
                    .fill(Theme.Colors.accent)
                    .frame(width: fabSize, height: fabSize)
                    .shadow(color: .black.opacity(0.22), radius: 14, x: 0, y: 8)

                if voice.state == .transcribing {
                    ProgressView()
                        .tint(Theme.Colors.onAccent)
                } else {
                    Image(systemName: voice.isRecording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Theme.Colors.onAccent)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(voice.state == .transcribing || (coachVM.isStreaming && !voice.isRecording))
        .opacity(coachVM.isStreaming && !voice.isRecording ? 0.5 : 1.0)
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
        Text(voice.partialTranscript.isEmpty ? "Listening…" : voice.partialTranscript)
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
        switch voice.permissionState {
        case .authorized:
            if voice.isRecording {
                voice.stopRecording()
            } else {
                guard voice.state != .transcribing, !coachVM.isStreaming else { return }
                voice.startRecording()
                myTurnID = voice.currentTurnID
            }
        case .notDetermined:
            Task {
                await voice.requestPermissions()
                if voice.permissionState != .authorized {
                    showDeniedAlert = true
                }
            }
        case .denied:
            showDeniedAlert = true
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
            .ambient(Theme.Motion.pulseRing, value: animating)
            .onAppear { animating = true }
    }
}
