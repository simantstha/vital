import SwiftUI

// MARK: - CoachOrb

/// The Coach tab's conversation-mode surface (spec `ux-spec-v4` §3.2,
/// delivery slice V5): a 72 pt orb that replaces the whole composer row
/// while `CoachVoiceController.mode == .conversation` (see `CoachView`'s
/// `inputBar`), with a live caption and an End control.
///
/// Visual per state (spec §3.2's table):
/// - `.idle`: lime disc with `mic.fill` — only ever seen for an instant,
///   right before the first listen of a conversation actually starts.
/// - `.listening`/`.yourTurn`: scales 1.00–1.15 with `voice.inputLevel`.
/// - `.transcribing` (endpointing): a ring traces 360°→0 across the window.
/// - `.thinking`: 3 breathing dots.
/// - `.speaking`: a simple ambient pulse.
///
/// Respects Reduce Motion: no level-driven scaling, no breathing loop (dots
/// render static-but-visible instead), icon swaps cross-fade rather than
/// pop — but the endpoint ring stays, since spec §3.8 calls it out as
/// carrying information, not just motion.
struct CoachOrb: View {
    @ObservedObject var voice: CoachVoiceController
    var onEnd: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let diameter: CGFloat = 72
    private let ringInset: CGFloat = 7

    var body: some View {
        VStack(spacing: Theme.Spacing.sm) {
            ZStack {
                // "Endpointing" isn't a separate `VoiceState` — it's
                // `.listening` with a live countdown
                // (`SpeechTranscriber.restartSilenceWatchdog` sets
                // `endpointDeadline` on every partial, and clears it the
                // instant the window fires, right as `state` moves on to
                // `.transcribing`) — so the ring's condition has to be this
                // pair, not a `.transcribing` check.
                if voice.state == .listening, let deadline = voice.endpointDeadline {
                    CoachOrbEndpointRing(deadline: deadline)
                        .frame(width: diameter + ringInset * 2, height: diameter + ringInset * 2)
                }

                Circle()
                    .fill(Theme.Colors.accent)
                    .frame(width: diameter, height: diameter)
                    .scaleEffect(orbScale)
                    .animation(reduceMotion ? Theme.Motion.standard : Theme.Motion.quick, value: orbScale)

                orbIcon
                    .animation(Theme.Motion.standard, value: orbIconKey)
                    .transition(.opacity)
            }
            .frame(width: diameter + ringInset * 2, height: diameter + ringInset * 2)

            Text(captionText)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(minHeight: 20)
                .id(captionText)
                .motionTransition(.fade)

            Button(action: onEnd) {
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                    Text("End")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(Theme.Colors.textSecondary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.xs)
                .background(Capsule().fill(Theme.Colors.glassFill))
            }
            .buttonStyle(.vital)
            // The orb's own `.accessibilityAction` below already ends the
            // conversation on a VoiceOver double-tap, so this explicit
            // button would be a second, redundant way to do the same thing
            // for VoiceOver users — hide it from the accessibility tree
            // rather than announce it twice.
            .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.sm)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onEnd() }
        .sensoryFeedback(Theme.Haptics.turnEnd, trigger: voice.turnEndTrigger)
        .sensoryFeedback(Theme.Haptics.yourTurn, trigger: voice.yourTurnTrigger)
    }

    // MARK: - Orb visuals

    private var orbScale: CGFloat {
        guard !reduceMotion, voice.state == .listening || voice.state == .yourTurn else { return 1.0 }
        return 1.0 + CGFloat(min(1, max(0, voice.inputLevel))) * 0.15
    }

    /// Cheap `Equatable` key for the icon's cross-fade — only the handful of
    /// states that actually change the icon matter; `.transcribing`,
    /// `.sending`, and `.yourTurn` all render the same mic glyph as
    /// `.listening`/`.idle`, so they must not be treated as distinct keys
    /// (that would cross-fade the *identical* icon on every state change).
    private enum IconKey: Equatable { case mic, dots, speaking }
    private var orbIconKey: IconKey {
        switch voice.state {
        case .thinking: return .dots
        case .speaking: return .speaking
        default: return .mic
        }
    }

    @ViewBuilder
    private var orbIcon: some View {
        switch orbIconKey {
        case .dots:
            CoachOrbThinkingDots()
        case .speaking:
            Image(systemName: "waveform")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.Colors.onAccent)
                .ambient(Theme.Motion.pulse, value: voice.state == .speaking)
        case .mic:
            Image(systemName: "mic.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.Colors.onAccent)
        }
    }

    // MARK: - Caption (spec §3.2: live partial while listening, "Thinking…" while thinking)

    private var captionText: String {
        if let error = voice.lastError {
            switch error {
            case .didntCatchThat: return "Didn't catch that. Go ahead."
            }
        }
        switch voice.state {
        case .idle:
            return "Tap to talk"
        case .listening, .transcribing:
            return voice.partialTranscript.isEmpty ? "Listening…" : voice.partialTranscript
        case .sending:
            return voice.partialTranscript.isEmpty ? "Listening…" : voice.partialTranscript
        case .thinking:
            return "Thinking…"
        case .speaking:
            return "Vital"
        case .yourTurn:
            return "Your turn"
        }
    }

    // MARK: - Accessibility (spec §3.8)

    private var accessibilityLabel: String {
        switch voice.state {
        case .thinking:
            return "Voice conversation, thinking. Double-tap to end."
        case .speaking:
            return "Voice conversation, Vital speaking. Double-tap to end."
        default:
            // Listening, transcribing, sending, yourTurn, and the
            // instantaneous idle-before-first-listen all read as
            // "listening" — spec §3.8 gives this exact label.
            return "Voice conversation, listening. Double-tap to end."
        }
    }
}

// MARK: - CoachOrbEndpointRing

/// Traces 360°→0° across the adaptive endpointing window (spec §3.2/§3.3) —
/// `deadline` is `CoachVoiceController.endpointDeadline`, recomputed fresh
/// on every partial transcript (see `SpeechTranscriber.restartSilenceWatchdog`),
/// so a new deadline (the user talking again) restarts this ring rather than
/// letting it run out. Deliberately NOT gated on Reduce Motion — spec §3.8
/// keeps it because it carries information, not just motion.
private struct CoachOrbEndpointRing: View {
    let deadline: Date
    @State private var progress: CGFloat = 1

    var body: some View {
        Circle()
            .trim(from: 0, to: progress)
            .stroke(Theme.Colors.accentContent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
            .rotationEffect(.degrees(-90))
            .onAppear { restart() }
            .onChange(of: deadline) { _, _ in restart() }
    }

    private func restart() {
        let window = max(0.05, deadline.timeIntervalSinceNow)
        progress = 1
        withAnimation(Theme.Motion.endpoint(window)) {
            progress = 0
        }
    }
}

// MARK: - CoachOrbThinkingDots

/// 3 breathing dots (spec §3.2's "Thinking" row). Static-but-visible under
/// Reduce Motion rather than looping.
private struct CoachOrbThinkingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var animating = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Theme.Colors.onAccent)
                    .frame(width: 6, height: 6)
                    .opacity(reduceMotion ? 0.85 : (animating ? 1.0 : 0.35))
                    .ambient(Theme.Motion.breathe.delay(Double(index) * 0.15), value: animating)
            }
        }
        .onAppear { animating = true }
    }
}
