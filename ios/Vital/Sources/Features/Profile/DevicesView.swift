import SwiftUI

/// Pushed from Profile → "Devices" (`NavigationStack` push, not a sheet).
/// Apple Health's connected state is passed in from `ProfileView`, which
/// derives it from `vm.integrations` — the backend only tracks one combined
/// HealthKit integration ("Apple Health"). HealthKit authorization says
/// nothing about which physical device produced the data, so this row must
/// not claim an Apple Watch specifically — an iPhone-only user authorizes
/// HealthKit too. WHOOP has a real OAuth connect flow on this screen — the
/// app never sees WHOOP tokens: `whoopAuthorizeURL()` fetches the authorize
/// URL from the backend, `ASWebAuthenticationSession` runs the WHOOP
/// login/consent page, and the backend callback does the code-for-token
/// exchange server-side. Oura/Garmin remain non-functional stubs per the
/// redesign-v3 mock — displayed as non-interactive "Coming soon" chips.
struct DevicesView: View {
    let appleHealthConnected: Bool

    @StateObject private var whoopVM = WhoopConnectViewModel()
    @StateObject private var settingsVM = DevicesSettingsViewModel()

    /// Which metric's picker dialog is presented, if any.
    @State private var pickerMetric: DevicesLogic.Metric?

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    Text("Devices")
                        .screenTitleStyle()
                        .foregroundStyle(Theme.Colors.textPrimary)

                    if let errorMessage = settingsVM.errorMessage {
                        ErrorCard(title: "Couldn't load devices", message: errorMessage) {
                            settingsVM.errorMessage = nil
                            Task { await settingsVM.load() }
                        }
                    } else if !settingsVM.isLoading {
                        primaryDeviceSection
                    }

                    SectionHeader(title: "Connections")

                    VStack(spacing: Theme.Spacing.md) {
                        connectedRow(
                            icon: "heart.fill",
                            name: "Apple Health",
                            connected: appleHealthConnected
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
            // Backs the "Pull to sync" hint on a stale row: re-reads the
            // latest device sync state.
            .refreshable { await settingsVM.load() }
        }
        // Pushed screen — the nav bar must stay visible so the system back
        // button (and the interactive swipe-back gesture) keep working.
        // Title stays empty/inline: the v3 idiom keeps the big in-content
        // "Devices" screenTitle above, so a nav-bar title would be redundant.
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Colors.canvas, for: .navigationBar)
        .task { await whoopVM.load() }
        .task { await settingsVM.load() }
        .onReceive(NotificationCenter.default.publisher(for: .vitalWhoopCallbackReceived)) { _ in
            Task {
                await whoopVM.refreshStatus()
                await settingsVM.load()
            }
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
        .confirmationDialog(
            pickerMetric.map { "Primary device for \($0.title.lowercased())" } ?? "",
            isPresented: Binding(get: { pickerMetric != nil }, set: { if !$0 { pickerMetric = nil } }),
            titleVisibility: .visible
        ) {
            if let pickerMetric {
                ForEach(settingsVM.options(for: pickerMetric), id: \.self) { option in
                    Button(pickerOptionLabel(option)) {
                        settingsVM.select(option, for: pickerMetric)
                        self.pickerMetric = nil
                    }
                }
            }
            Button("Cancel", role: .cancel) { pickerMetric = nil }
        }
        .toast(message: $settingsVM.toastMessage)
    }

    private func pickerOptionLabel(_ option: DevicesLogic.PrimaryOption) -> String {
        switch option {
        case .automatic:        return "Automatic"
        case .device(let kind): return DevicesLogic.deviceName(kind)
        }
    }

    // MARK: - Primary device section (phase 2, mockup D1)

    private var primaryDeviceSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
            VitalCard(padding: 0) {
                VStack(spacing: 0) {
                    deviceStatusRow(kind: .apple, isFirst: true)
                    deviceStatusRow(kind: .whoop, isFirst: false)
                }
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader(title: "Primary device for")
                VitalCard(padding: 0) {
                    VStack(spacing: 0) {
                        primaryMetricRow(.workouts, isFirst: true)
                        primaryMetricRow(.sleep, isFirst: false)
                        primaryMetricRow(.recovery, isFirst: false)
                        stepsActivityRow
                    }
                }
                // Curly quotes match the mockup's copy verbatim.
                Text("Calories and training load come only from the primary device for workouts, so nothing counts twice. Switching recovery to another device restarts \u{201C}learning your normal\u{201D}, because each device measures HRV differently.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader(title: "Duplicates")
                VitalCard {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("When two recordings overlap by more than half, I keep one.")
                            .font(Theme.Typography.bodyMedium)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        if let caption = settingsVM.duplicatesCaption {
                            Text(caption)
                                .font(Theme.Typography.labelSmall)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func deviceStatusRow(kind: DevicesLogic.DeviceKind, isFirst: Bool) -> some View {
        let freshness = settingsVM.syncFreshness(for: kind)
        let dotColor: Color = {
            switch freshness {
            case .disconnected: return Theme.Colors.textTertiary
            case .fresh:        return Theme.Colors.positive
            case .stale:        return Theme.Colors.caution
            case .veryStale:    return Theme.Colors.alert
            }
        }()
        return HStack(spacing: Theme.Spacing.md) {
            IconBadge(systemName: kind == .apple ? "applewatch" : "waveform.path.ecg", style: .soft, size: 36, cornerRadius: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(DevicesLogic.statusRowTitle(kind))
                    .font(Theme.Typography.bodyMedium)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(settingsVM.syncStatusLabel(for: kind))
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) { if !isFirst { Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5) } }
    }

    /// Tappable row that opens the Automatic/Apple Watch/WHOOP picker for
    /// one metric. The accessibility identifier goes on the `Button` itself
    /// (the tappable leaf), never on a container that would swallow it —
    /// same rule `AnalysisHeader`'s "Done" button already follows.
    private func primaryMetricRow(_ metric: DevicesLogic.Metric, isFirst: Bool) -> some View {
        Button {
            pickerMetric = metric
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(metric.title)
                        .font(Theme.Typography.bodyMedium)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(metric.subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(settingsVM.valueLabel(for: metric))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            // #249 lesson: a tappable row needs `.contentShape(Rectangle())`
            // on the label when using `.buttonStyle(.plain)` with Spacers,
            // or the Spacer's empty area doesn't register taps.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { if !isFirst { Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5) } }
        .accessibilityIdentifier("devices.row.\(metric.rawValue)")
    }

    private var stepsActivityRow: some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Steps & activity")
                    .font(Theme.Typography.bodyMedium)
                    .fontWeight(.medium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Only Apple Watch counts steps")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Text("Apple Watch")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) { Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5) }
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
                    Text("Not connected")
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                Spacer()

                Text("Coming soon")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs)
                    .background(Capsule().fill(Theme.Colors.glassFill))
                    .overlay(
                        Capsule()
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                    )
            }
        }
    }
}
