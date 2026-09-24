import SwiftUI

/// Today's endurance goal hero (docs/ux-spec-v4.md §4.1): a readiness word
/// derived only from the existing gated verdicts, a one-line HRV/Sleep/RHR
/// reason, today's session from the plan, and a "this week" line. Weekly
/// volume and the session dots are fed by `GET /api/training/summary`
/// (#202, `TodayViewModel.trainingSummary`) and hidden whenever that data
/// is absent — never fabricated (P4).
struct EnduranceHeroView: View {
    /// `nil` while still calibrating — the headline then shows
    /// `calibratingText` instead of a word derived from possibly-ungated
    /// verdicts.
    let readinessWord: EnduranceHeroLogic.ReadinessWord?
    let calibratingText: String?
    let reasonLine: String?

    /// Today's move-kind plan item, or `nil` for a rest day.
    let session: PlanItem?
    /// Done/total for the "● ● ○ ○" dot row — same rule and source data as
    /// the muscle hero (`TodayViewModel.trainingSessionDots`).
    var sessionDots: (done: Int, total: Int)? = nil
    /// Combined "3 sessions · 24.5 km this week" line — combines both
    /// sessions and weekly volume into one display. `nil` hides the line.
    var weeklyOverviewText: String? = nil

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

                if sessionDots != nil || weeklyOverviewText != nil {
                    weekRow
                        .transition(.opacity)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    /// Dot row (if plan data exists) or combined overview line.
    @ViewBuilder
    private var weekRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if let sessionDots {
                SessionDotsRow(done: sessionDots.done, total: sessionDots.total)
            }
            if let weeklyOverviewText {
                Text(weeklyOverviewText)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .monospacedDigit()
            }
        }
        .accessibilityIdentifier("today.enduranceHero.weekRow")
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
        if let weeklyOverviewText { parts.append(weeklyOverviewText) }
        return parts.joined(separator: ". ")
    }
}
