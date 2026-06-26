import SwiftUI

struct TrendsView: View {
    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.xl) {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.accent.opacity(0.15))
                        .frame(width: 80, height: 80)
                    Image(systemName: "chart.line.uptrend.xyaxis")
                        .font(.system(size: 32))
                        .foregroundStyle(Theme.Colors.accent)
                }

                VStack(spacing: Theme.Spacing.sm) {
                    Text("Trends")
                        .font(Theme.Typography.titleMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("Coming soon")
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }
}
