import SwiftUI

/// Pushed from Profile → "Connected apps" (`NavigationStack` push, matching
/// `DevicesView`). Currently a single WHOOP row — the only third-party data
/// source with a real OAuth connect flow; `DevicesView`'s Whoop/Oura/Garmin
/// rows remain non-functional stubs for the others. The app never sees WHOOP
/// tokens: `whoopAuthorizeURL()` fetches the authorize URL from the backend,
/// `ASWebAuthenticationSession` runs the WHOOP login/consent page, and the
/// backend callback does the code-for-token exchange server-side.
struct ConnectedAppsView: View {
    @StateObject private var vm = WhoopConnectViewModel()

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    Text("Connected Apps")
                        .screenTitleStyle()
                        .foregroundStyle(Theme.Colors.textPrimary)

                    whoopRow

                    if case .error(let message) = vm.state {
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
        .task { await vm.load() }
        .onReceive(NotificationCenter.default.publisher(for: .vitalWhoopCallbackReceived)) { _ in
            Task { await vm.refreshStatus() }
        }
        .confirmationDialog(
            "Disconnect WHOOP?",
            isPresented: $vm.showDisconnectConfirm,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await vm.disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Vital will stop syncing new WHOOP data. Data already synced stays in your history.")
        }
    }

    // MARK: - WHOOP row

    private var whoopRow: some View {
        VitalCard {
            HStack(spacing: Theme.Spacing.md) {
                IconBadge(systemName: "waveform.path.ecg", style: .soft)

                VStack(alignment: .leading, spacing: 2) {
                    Text("WHOOP")
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(subtitle)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(subtitleColor)
                }

                Spacer()

                trailingControl
            }
        }
    }

    private var subtitle: String {
        switch vm.state {
        case .loading:                    return "Checking connection…"
        case .notConnected:                return "Not connected"
        case .connecting:                  return "Connecting…"
        case .connected(let lastSyncedAt): return WhoopConnectViewModel.lastSyncedLabel(lastSyncedAt)
        case .needsReconnect:              return "Connection needs attention"
        case .error:                       return "Not connected"
        }
    }

    private var subtitleColor: Color {
        switch vm.state {
        case .connected:      return Theme.Colors.positive
        case .needsReconnect: return Theme.Colors.alert
        default:              return Theme.Colors.textSecondary
        }
    }

    @ViewBuilder
    private var trailingControl: some View {
        switch vm.state {
        case .loading:
            ProgressView()

        case .connecting:
            ProgressView()

        case .notConnected, .error:
            Button {
                Task { await vm.connect() }
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
                Task { await vm.connect() }
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
                    vm.showDisconnectConfirm = true
                }
                .font(.system(size: 13, weight: .semibold))
                .buttonStyle(.plain)
                .foregroundStyle(Theme.Colors.alert)
            }
        }
    }
}
