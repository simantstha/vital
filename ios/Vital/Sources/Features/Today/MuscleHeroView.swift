import SwiftUI

/// Today's muscle goal hero (docs/ux-spec-v4.md §4.1): today's strength
/// session from the plan, a protein have/goal bar, and a rest-day fallback.
/// "Last time" lift values and "sessions this week" both need history Today
/// doesn't load yet — see `MuscleHeroLogic`'s doc comments for the exact
/// backend gap — so they're omitted rather than fabricated (P4).
struct MuscleHeroView: View {
    /// Today's move-kind plan item, or `nil` for a rest day —
    /// `MuscleHeroLogic.todaySession(from:)`.
    let session: PlanItem?
    let proteinHave: Int
    let proteinGoal: Int

    /// Opens the existing plan-item actions sheet for `session` — the
    /// nearest thing to a "Start" flow this slice has (no dedicated logger
    /// exists yet, per the task's scope note).
    var onTapSession: (PlanItem) -> Void

    private var proteinFraction: Double {
        guard proteinGoal > 0 else { return 0 }
        return min(1.0, Double(proteinHave) / Double(proteinGoal))
    }

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.xl) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                sessionSection
                VStack(alignment: .leading, spacing: 2) {
                    Text("Protein \(proteinHave) / \(proteinGoal) g")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .monospacedDigit()
                    VitalProgressBar(fraction: proteinFraction, tint: Theme.Colors.accent, height: 6)
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
                    Image(systemName: "dumbbell.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                    Text(session.title)
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(2)
                    Spacer(minLength: Theme.Spacing.sm)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("today.muscleHero.session")
        } else {
            Text(MuscleHeroLogic.restDayText)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        if let session {
            parts.append(session.title)
        } else {
            parts.append(MuscleHeroLogic.restDayText)
        }
        parts.append("Protein \(proteinHave) of \(proteinGoal) grams")
        return parts.joined(separator: ". ")
    }
}
