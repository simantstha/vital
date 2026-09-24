import SwiftUI

/// Compact, tappable "fuel strip" — the shrunk-down diet budget summary that
/// replaces the old full diet card on Today. Opens the meal-logging sheet.
/// Mirrors the mock's `FuelStrip` (the full `DietSheet` is Phase 3).
struct FuelStripView: View {
    let kcalRemaining: Int
    let proteinHave: Int
    let proteinGoal: Int
    /// False only for the muscle goal, whose hero (`MuscleHeroView`) already
    /// shows a "Protein have/goal" line and bar above this strip — coaching
    /// review, 2026-09-23: without this, Today repeated the same protein
    /// numbers twice back to back. Every other goal still shows it here
    /// (endurance's hero doesn't repeat it, and weight_loss/general never
    /// show this strip's protein line elsewhere).
    var showsProtein: Bool = true
    /// "logged" | "healthkit" | "none" — see `TodayDietBudget.consumedSource`.
    var consumedSource: String? = nil
    var consumedSourceName: String? = nil
    var onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: Theme.Spacing.md + 2) {
                IconBadge(systemName: "flame", style: .soft)

                VStack(alignment: .leading, spacing: 2) {
                    Text("\(kcalRemaining.formatted()) kcal left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .monospacedDigit()
                    Text(showsProtein ? "Protein \(proteinHave)/\(proteinGoal)g · tap to log a meal" : "tap to log a meal")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .monospacedDigit()
                    if consumedSource == "healthkit" {
                        Text(HealthAttributionLabel.text(sourceName: consumedSourceName))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                }

                Spacer(minLength: Theme.Spacing.sm)

                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md + 2)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Colors.card)
                    .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
            )
        }
        .buttonStyle(.plain)
        // Stable tap/wait target for the screenshot harness (VitalUITests) —
        // the label text above carries a live kcal number, too brittle to
        // match on directly.
        .accessibilityIdentifier("today.fuelStrip")
    }
}
