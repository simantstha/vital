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
    /// Guards the FAB's touch-down gesture (spec §3.1/§10 V3: start on
    /// finger down, not tap-up) so `DragGesture`'s repeated `onChanged`
    /// firings while a finger is held down only trigger the mic action once
    /// per press. Reset in `onEnded`.
    @State private var isFabPressed = false

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
        // Spec §3.4/§10 V3: pre-warm the shared voice session/engine the
        // moment Today is on screen. No-op unless mic permission is already
        // authorized, and never prompts for it.
        .onAppear { voice.prewarm() }
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

    /// Spec §3.1/§10 V3: starts on finger **down**, not tap-up, so a plain
    /// `Button` (touch-up-inside) won't do — its action is driven by a
    /// `DragGesture(minimumDistance: 0)` instead, whose `onChanged` fires on
    /// first touch. `isFabPressed` de-dupes the many `onChanged` callbacks a
    /// single held touch produces. Losing `Button` also loses its automatic
    /// accessibility button trait/action, so both are added back explicitly
    /// — VoiceOver's double-tap invokes `.accessibilityAction`, which calls
    /// the same `handleMicPress()`. `fabSize` (60pt) is already well above
    /// Apple's 44×44 minimum, so no separate hit-area frame is needed here.
    private var fab: some View {
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
        .contentShape(Circle())
        .opacity(isFabDisabled ? 0.5 : 1.0)
        .allowsHitTesting(!isFabDisabled)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !isFabPressed else { return }
                    isFabPressed = true
                    handleMicPress()
                }
                .onEnded { _ in isFabPressed = false }
        )
        .accessibilityElement()
        .accessibilityLabel(voice.isRecording ? "Stop recording" : "Talk to your coach")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { handleMicPress() }
        .sensoryFeedback(Theme.Haptics.toggle, trigger: voice.isRecording)
        .sensoryFeedback(Theme.Haptics.turnEnd, trigger: voice.turnEndTrigger)
        .padding(.trailing, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.xxxl)
    }

    private var isFabDisabled: Bool {
        voice.state == .transcribing || (coachVM.isStreaming && !voice.isRecording)
    }

    // MARK: - Listening overlays

    private var edgeGlow: some View {
        RoundedRectangle(cornerRadius: 0)
            .strokeBorder(Theme.Colors.accent.opacity(0.55), lineWidth: 36)
            .blur(radius: 28)
            .allowsHitTesting(false)
    }

    /// No live Apple words on screen (owner decision, spec
    /// `voice-cloud-only-stt`) — a fixed "Listening…"/"Transcribing…" label
    /// plus a `VoiceLevelMeter` instead of `voice.partialTranscript`.
    private var captionOverlay: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(voice.state == .transcribing ? "Transcribing…" : "Listening…")
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.onAccent)
            if voice.state != .transcribing {
                VoiceLevelMeter(level: voice.inputLevel, color: Theme.Colors.onAccent)
            }
        }
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

    private func handleMicPress() {
        switch voice.permissionState {
        case .authorized:
            if voice.isRecording {
                voice.stopRecording()
            } else {
                guard !isFabDisabled else { return }
                // Spec §3.2/§10 V5: tapping the Today FAB always starts
                // conversation mode (unlike the Coach composer's mic, which
                // also supports a held push-to-talk single turn) — the FAB
                // itself switches to the Coach tab the moment this first
                // turn is sent (`onSent` below), where `CoachOrb` takes over
                // for the rest of the conversation. The controller itself
                // downgrades this to `.single` while VoiceOver is running
                // (spec §3.8).
                voice.startRecording(mode: .conversation)
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
