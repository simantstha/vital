import SwiftUI

/// Pushed from Profile → "Devices" (`NavigationStack` push, not a sheet).
/// Apple Watch's connected state is passed in from `ProfileView`, which
/// derives it from `vm.integrations` — the backend only tracks one combined
/// HealthKit integration ("Apple Health"), which is also the channel Apple
/// Watch data flows through, so there's no separate watch-specific status to
/// read. Oura/Garmin are non-functional stubs per the redesign-v3 mock (WHOOP
/// has a real OAuth connect flow under Profile → Connected apps)
/// — tapping "Connect" never fakes a connection, it only reveals a small
/// "Coming soon" footnote.
struct DevicesView: View {
    let appleWatchConnected: Bool

    @State private var tappedStub: String? = nil

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    Text("Devices")
                        .screenTitleStyle()
                        .foregroundStyle(Theme.Colors.textPrimary)

                    VStack(spacing: Theme.Spacing.md) {
                        connectedRow(
                            icon: "applewatch",
                            name: "Apple Watch",
                            connected: appleWatchConnected
                        )
                        stubRow(icon: "circle.circle", name: "Oura")
                        stubRow(icon: "location.fill", name: "Garmin")
                    }

                    Text("More integrations coming soon.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.xl)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        // Pushed screen — the nav bar must stay visible so the system back
        // button (and the interactive swipe-back gesture) keep working.
        // Title stays empty/inline: the v3 idiom keeps the big in-content
        // "Devices" screenTitle above, so a nav-bar title would be redundant.
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
    }

    // MARK: - Rows

    private func connectedRow(icon: String, name: String, connected: Bool) -> some View {
        VitalCard {
            HStack(spacing: Theme.Spacing.md) {
                IconBadge(systemName: icon, style: .soft)

                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(connected ? "Connected · syncs automatically" : "Not connected")
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(connected ? Theme.Colors.positive : Theme.Colors.textSecondary)
                }

                Spacer()

                if connected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
        }
    }

    private func stubRow(icon: String, name: String) -> some View {
        VitalCard {
            HStack(spacing: Theme.Spacing.md) {
                IconBadge(systemName: icon, style: .soft)

                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(tappedStub == name ? "Not connected · Coming soon" : "Not connected")
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { tappedStub = name }
                } label: {
                    Text("Connect")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                        .padding(.horizontal, Theme.Spacing.md)
                        .padding(.vertical, Theme.Spacing.xs)
                        .background(Capsule().fill(Theme.Colors.accentSoft))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
