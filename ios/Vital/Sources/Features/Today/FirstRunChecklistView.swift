import SwiftUI

/// New-user first-run checklist (§4.2): replaces the three empty biometric
/// tiles until real data exists — each row is directly actionable. Returns
/// to the ordinary `metricsGrid` the moment any biometric reading lands
/// (see `TodayViewModel.showFirstRunChecklist`).
struct FirstRunChecklistView: View {
    /// "weight_loss" | "muscle" | "endurance" | "general" — picks the third
    /// row's copy/action (§4.2: "weigh-in for weight_loss/general, first
    /// workout for muscle/endurance").
    let goal: String
    let mealLogged: Bool
    let secondItemLogged: Bool
    let healthConnected: Bool
    var onLogMeal: () -> Void
    var onLogSecondItem: () -> Void
    var onConnectHealth: () -> Void

    private var wantsWorkout: Bool { goal == "muscle" || goal == "endurance" }
    private var secondItemLabel: String { wantsWorkout ? "Log your first workout" : "Add today's weight" }
    private var secondItemActionTitle: String { wantsWorkout ? "Log" : "Add" }

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.xl) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("Let's get your baseline")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)

                VStack(spacing: 0) {
                    row(
                        title: "Connect Apple Health",
                        done: healthConnected,
                        actionTitle: "Connect",
                        action: onConnectHealth,
                        showsDivider: false
                    )
                    row(
                        title: "Log your first meal",
                        done: mealLogged,
                        actionTitle: "Log",
                        action: onLogMeal,
                        showsDivider: true
                    )
                    row(
                        title: secondItemLabel,
                        done: secondItemLogged,
                        actionTitle: secondItemActionTitle,
                        action: onLogSecondItem,
                        showsDivider: true
                    )
                }
            }
        }
    }

    private func row(
        title: String,
        done: Bool,
        actionTitle: String,
        action: @escaping () -> Void,
        showsDivider: Bool
    ) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            // Icon + title combined into one VoiceOver element; the action
            // button (when present) stays outside so it remains its own
            // focusable element (same split as `WeightHeroView`'s chip).
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(done ? Theme.Colors.accentContent : Theme.Colors.textTertiary)

                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(done ? Theme.Colors.textSecondary : Theme.Colors.textPrimary)
                    .strikethrough(done)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(title), \(done ? "done" : "not done")")

            Spacer(minLength: Theme.Spacing.sm)

            if !done {
                Button(actionTitle, action: action)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs + 2)
                    .background(Capsule().fill(Theme.Colors.accentSoft))
                    .buttonStyle(.vital(scale: 0.94))
                    .accessibilityLabel("\(actionTitle) \(title)")
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
        .overlay(alignment: .top) {
            if showsDivider {
                Rectangle()
                    .fill(Theme.Colors.glassBorder)
                    .frame(height: 0.5)
            }
        }
    }
}
