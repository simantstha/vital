import SwiftUI

/// Compact, tappable "fuel strip" — the diet budget summary on Today: kcal
/// left, protein have/goal, and a thin progress bar. Opens the meal-logging
/// sheet.
struct FuelStripView: View {
    let kcalRemaining: Int
    /// Fraction of the day's kcal target already CONSUMED (0...1) —
    /// `TodayDietBudget.kcalFraction`, the same value the weight hero's bar
    /// fills with. The bar grows as you eat; the headline says what's left.
    let kcalFraction: Double
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

    private var proteinText: String { "Protein \(proteinHave) of \(proteinGoal) g" }

    private var attributionText: String? {
        consumedSource == "healthkit" ? HealthAttributionLabel.text(sourceName: consumedSourceName) : nil
    }

    private var accessibilityText: String {
        var parts = ["\(kcalRemaining.formatted()) kilocalories left"]
        if showsProtein { parts.append(proteinText.replacingOccurrences(of: " g", with: " grams")) }
        if let attributionText { parts.append(attributionText) }
        parts.append("Log a meal")
        return parts.joined(separator: ", ")
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .center, spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    AccessibilityAdaptiveStack(
                        alignment: .firstTextBaseline, spacing: Theme.Spacing.sm, stackedSpacing: Theme.Spacing.xxs
                    ) {
                        Text("\(kcalRemaining.formatted()) kcal left")
                            .scaledFont(size: 16, weight: .semibold)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .monospacedDigit()
                            .contentTransition(.numericText(value: Double(kcalRemaining)))
                        Spacer(minLength: Theme.Spacing.sm)
                        if showsProtein {
                            Text(proteinText)
                                .scaledFont(Theme.Typography.bodySmall)
                                .foregroundStyle(Theme.Colors.textSecondary)
                                .monospacedDigit()
                                .contentTransition(.numericText())
                        }
                    }

                    VitalProgressBar(fraction: kcalFraction, tint: Theme.Colors.textPrimary, height: 4)

                    if let attributionText {
                        Text(attributionText)
                            .scaledFont(size: 11)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                }

                Image(systemName: "chevron.right")
                    .scaledFont(size: 14, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(Theme.Spacing.lg)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.card)
                    .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
            )
        }
        .buttonStyle(.pressableCard)
        .accessibilityLabel(accessibilityText)
        // Stable tap/wait target for the screenshot harness (VitalUITests) —
        // the label text above carries a live kcal number, too brittle to
        // match on directly.
        .accessibilityIdentifier("today.fuelStrip")
    }
}
