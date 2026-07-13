import SwiftUI

/// The Logs day-pager's diet-budget card. Same visual language as
/// `DietSheetView`'s header/macro rows, condensed into a single `VitalCard`.
/// Tappable (opens the diet sheet) for today; a plain read-only card for
/// past days, so there's no tap affordance where editing isn't possible.
struct DietBudgetCardView: View {
    let data: DietDayData
    let readOnly: Bool
    var onTap: (() -> Void)? = nil

    var body: some View {
        if readOnly {
            VitalCard { content }
        } else {
            Button {
                onTap?()
            } label: {
                VitalCard { content }
            }
            .buttonStyle(.plain)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("DIET BUDGET")
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(1.3)
                    .foregroundStyle(Theme.Colors.textSecondary)

                Spacer()

                if readOnly {
                    Text("Past day")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                } else {
                    HStack(spacing: 2) {
                        Text("Log food")
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
                }
            }

            HStack(alignment: .firstTextBaseline) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
                    Text("\(data.remaining)")
                        .font(.system(size: 48, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("kcal left")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer()
                Text("\(data.targetKcal)")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.top, Theme.Spacing.sm)

            progressBar(fraction: eatenFraction)
                .padding(.top, Theme.Spacing.lg)

            HStack(spacing: Theme.Spacing.md) {
                macroColumn(label: "Protein", macro: data.protein)
                macroColumn(label: "Carbs", macro: data.carbs)
                macroColumn(label: "Fat", macro: data.fat)
            }
            .padding(.top, Theme.Spacing.xl)
        }
    }

    private var eatenFraction: Double {
        guard data.targetKcal > 0 else { return 0 }
        return min(1.0, Double(data.eatenKcal) / Double(data.targetKcal))
    }

    private func progressBar(fraction: Double) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.Colors.glassFill)
                Capsule()
                    .fill(Theme.Colors.accent)
                    .frame(width: max(0, geo.size.width * fraction))
            }
        }
        .frame(height: 3)
    }

    private func macroColumn(label: String, macro: MacroProgress) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs + 2) {
            HStack {
                Text(label)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Spacer()
                HStack(spacing: 0) {
                    Text("\(macro.current)")
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("/\(macro.target)g")
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
                .font(.system(size: 12, weight: .semibold))
            }
            progressBar(fraction: macro.fraction)
        }
        .frame(maxWidth: .infinity)
    }
}
