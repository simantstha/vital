import SwiftUI

struct ProfileView: View {
    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.xl) {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.accent)
                        .frame(width: 80, height: 80)
                    Text("S")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.canvas)
                }

                VStack(spacing: Theme.Spacing.sm) {
                    Text("Simant Shrestha")
                        .font(Theme.Typography.titleMedium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("Profile — coming soon")
                        .font(Theme.Typography.bodyMedium)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }
}
