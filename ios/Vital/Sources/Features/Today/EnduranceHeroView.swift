import SwiftUI

/// Today's endurance goal hero (docs/ux-spec-v4.md §4.1): a readiness word
/// derived only from the existing gated verdicts, a one-line HRV/Sleep/RHR
/// reason, and today's session from the plan. Weekly volume needs history
/// Today doesn't load yet — see `EnduranceHeroLogic.weeklyVolumeText`'s doc
/// comment — so it's shown only when the caller has it (P4).
struct EnduranceHeroView: View {
    /// `nil` while still calibrating — the headline then shows
    /// `calibratingText` instead of a word derived from possibly-ungated
    /// verdicts.
    let readinessWord: EnduranceHeroLogic.ReadinessWord?
    let calibratingText: String?
    let reasonLine: String?

    /// Today's move-kind plan item, or `nil` for a rest day.
    let session: PlanItem?
    let weeklyVolumeText: String?

    var onTapSession: (PlanItem) -> Void

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.xl) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(calibratingText ?? readinessWord?.rawValue ?? EnduranceHeroLogic.ReadinessWord.goodToTrain.rawValue)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    if calibratingText == nil, let reasonLine {
                        Text(reasonLine)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }

                Rectangle()
                    .fill(Theme.Colors.glassBorder)
                    .frame(height: 1)

                sessionSection

                if let weeklyVolumeText {
                    Text(weeklyVolumeText)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var sessionSection: some View {
        if let session {
            Button { onTapSession(session) } label: {
                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    Image(systemName: "figure.run")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                    Text(session.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(2)
                    Spacer(minLength: Theme.Spacing.sm)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("today.enduranceHero.session")
        } else {
            Text(EnduranceHeroLogic.restDayText)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
    }

    private var accessibilityLabel: String {
        var parts: [String] = [calibratingText ?? readinessWord?.rawValue ?? EnduranceHeroLogic.ReadinessWord.goodToTrain.rawValue]
        if calibratingText == nil, let reasonLine { parts.append(reasonLine) }
        parts.append(session?.title ?? EnduranceHeroLogic.restDayText)
        if let weeklyVolumeText { parts.append(weeklyVolumeText) }
        return parts.joined(separator: ". ")
    }
}
