import SwiftUI

/// Pushed from Profile → "Devices" (`NavigationStack` push, not a sheet).
/// Apple Watch's connected state is passed in from `ProfileView`, which
/// derives it from `vm.integrations` — the backend only tracks one combined
/// HealthKit integration ("Apple Health"), which is also the channel Apple
/// Watch data flows through, so there's no separate watch-specific status to
/// read. WHOOP has a real OAuth connect flow on this screen — the app never
/// sees WHOOP tokens: `whoopAuthorizeURL()` fetches the authorize URL from
/// the backend, `ASWebAuthenticationSession` runs the WHOOP login/consent
/// page, and the backend callback does the code-for-token exchange
/// server-side. Oura/Garmin remain non-functional stubs per the redesign-v3
/// mock — tapping "Connect" never fakes a connection, it only reveals a
/// small "Coming soon" footnote.
struct DevicesView: View {
    let appleWatchConnected: Bool

    @State private var tappedStub: String? = nil
    @StateObject private var whoopVM = WhoopConnectViewModel()

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
                        whoopRow
                        stubRow(icon: "circle.circle", name: "Oura")
                        stubRow(icon: "location.fill", name: "Garmin")
                    }

                    if case .error(let message) = whoopVM.state {
                        Text(message)
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.alert)
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
        .task { await whoopVM.load() }
        .onReceive(NotificationCenter.default.publisher(for: .vitalWhoopCallbackReceived)) { _ in
            Task { await whoopVM.refreshStatus() }
        }
        .confirmationDialog(
            "Disconnect WHOOP?",
            isPresented: $whoopVM.showDisconnectConfirm,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await whoopVM.disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Vital will stop syncing new WHOOP data. Data already synced stays in your history.")
        }
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

    private var whoopRow: some View {
        VitalCard {
            HStack(spacing: Theme.Spacing.md) {
                IconBadge(systemName: "waveform.path.ecg", style: .soft)

                VStack(alignment: .leading, spacing: 2) {
                    Text("WHOOP")
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(whoopSubtitle)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(whoopSubtitleColor)
                }

                Spacer()

                whoopTrailingControl
            }
        }
    }

    private var whoopSubtitle: String {
        switch whoopVM.state {
        case .loading:                    return "Checking connection…"
        case .notConnected:                return "Not connected"
        case .connecting:                  return "Connecting…"
        case .connected(let lastSyncedAt): return WhoopConnectViewModel.lastSyncedLabel(lastSyncedAt)
        case .needsReconnect:              return "Connection needs attention"
        case .error:                       return "Not connected"
        }
    }

    private var whoopSubtitleColor: Color {
        switch whoopVM.state {
        case .connected:      return Theme.Colors.positive
        case .needsReconnect: return Theme.Colors.alert
        default:              return Theme.Colors.textSecondary
        }
    }

    @ViewBuilder
    private var whoopTrailingControl: some View {
        switch whoopVM.state {
        case .loading:
            ProgressView()

        case .connecting:
            ProgressView()

        case .notConnected, .error:
            Button {
                Task { await whoopVM.connect() }
            } label: {
                Text("Connect")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs)
                    .background(Capsule().fill(Theme.Colors.accentSoft))
            }
            .buttonStyle(.plain)

        case .needsReconnect:
            Button {
                Task { await whoopVM.connect() }
            } label: {
                Text("Reconnect")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.alert)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs)
                    .background(Capsule().fill(Theme.Colors.alert.opacity(0.12)))
            }
            .buttonStyle(.plain)

        case .connected:
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(Theme.Colors.accent)

                Button("Disconnect", role: .destructive) {
                    whoopVM.showDisconnectConfirm = true
                }
                .font(.system(size: 13, weight: .semibold))
                .buttonStyle(.plain)
                .foregroundStyle(Theme.Colors.alert)
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
