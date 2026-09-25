import SwiftUI

/// A simple live mic-level indicator — a small row of bars whose heights
/// track `level` (`SpeechTranscriber.inputLevel`/`CoachVoiceController
/// .inputLevel`, `0...1`), used wherever a voice UI needs to show the mic is
/// live without any Apple partial-transcript text (owner decision, spec
/// `voice-cloud-only-stt` #1 — "Listening…" plus a level/waveform
/// indicator, driven by the transcriber's existing `inputLevel`). Shared by
/// `CoachView`'s composer and `VoiceFABView`'s caption overlay; `CoachOrb`
/// already has its own level-driven scale animation and doesn't need this.
///
/// Deliberately not real-time-smoothed beyond `animation(_:value:)` — `level`
/// already arrives at UI-frame cadence from `SpeechTranscriber`, so this is
/// just a cheap visual, not a spectrum analyzer.
struct VoiceLevelMeter: View {
    /// Normalized mic input level, `0...1`.
    var level: Float
    /// The bars' fill color — callers on a tinted background (e.g.
    /// `VoiceFABView`'s accent-filled caption pill) pass `Theme.Colors
    /// .onAccent`; the default suits a plain canvas background.
    var color: Color = Theme.Colors.accent

    /// Tuned so a quiet room still shows a sliver of motion (never fully
    /// flat, which would read as "frozen" rather than "listening, but
    /// quiet") while a loud voice fills the full height.
    private static let barCount = 4
    private let minBarScale: CGFloat = 0.25

    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(0..<Self.barCount, id: \.self) { index in
                Capsule()
                    .fill(color)
                    .frame(width: 3, height: barHeight(for: index))
            }
        }
        .frame(height: 16)
        .animation(Theme.Motion.quick, value: level)
        .accessibilityHidden(true)
    }

    /// Bars alternate slightly around the raw level so the group reads as a
    /// waveform rather than four identical bars moving in lockstep.
    private func barHeight(for index: Int) -> CGFloat {
        let clamped = CGFloat(min(1, max(0, level)))
        let wobble: CGFloat = [0.7, 1.0, 0.85, 0.55][index % 4]
        let scale = max(minBarScale, clamped * wobble)
        return 4 + scale * 12
    }
}
