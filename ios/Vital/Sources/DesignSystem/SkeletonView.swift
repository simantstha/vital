import SwiftUI

/// Placeholder tile geometry for the Trends grid loading state — a single
/// metric tile's shape with `.redacted(reason: .placeholder)` applied. No
/// shimmer, no animation, no `repeatForever` loop: the motion policy
/// (`Theme.Motion` doc comment) forbids ambient loops, and a redacted static
/// shape communicates "loading" without one. Not yet consumed by any screen.
struct SkeletonView: View {
    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Metric")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text("00")
                    .font(Theme.Typography.numericLarge(24))
                    .foregroundStyle(Theme.Colors.textPrimary)
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Theme.Colors.chartMuted)
                    .frame(height: 32)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .redacted(reason: .placeholder)
    }
}

#Preview {
    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
        SkeletonView()
        SkeletonView()
    }
    .padding()
    .background(Theme.Colors.canvas)
}
