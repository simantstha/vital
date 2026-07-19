import SwiftUI

struct ProfileView: View {
    @StateObject private var vm = ProfileViewModel()
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var backfillCoordinator: BackfillCoordinator
    @ObservedObject private var notificationManager = NotificationManager.shared
    @State private var showSignOutConfirm = false
    @State private var showBudgetEditor = false
    @State private var showNotificationSettings = false
    @State private var isResyncing = false

    @AppStorage(NotificationPrefsKeys.briefEnabled) private var notifBriefEnabled = true
    @AppStorage(NotificationPrefsKeys.mealsEnabled) private var notifMealsEnabled = true
    @AppStorage(NotificationPrefsKeys.weighinEnabled) private var notifWeighinEnabled = true

    /// Switches the root TabView to the Coach tab — threaded down from
    /// `RootTabView` (same closure Today's voice FAB uses) so GoalDetailView's
    /// "Talk it through with your coach" button can land in the conversation.
    private let switchToCoachTab: () -> Void

    init(switchToCoachTab: @escaping () -> Void = {}) {
        self.switchToCoachTab = switchToCoachTab
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                        headerSection

                        // Gate on load so a fresh launch shows a spinner, not an
                        // empty "?" avatar and blank stats.
                        if vm.isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(.top, 80)
                        } else if let errorMessage = vm.errorMessage {
                            errorState(message: errorMessage)
                        } else {
                            avatarSection

                            if vm.calibration?.status == "calibrating" {
                                calibratingBanner
                            }

                            settingsCard
                            activitySection
                            accountSection
                            versionFooter
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.lg)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await vm.load() }
        .sheet(isPresented: $showBudgetEditor, onDismiss: { Task { await vm.loadBudget() } }) {
            DietBudgetEditorView()
        }
        .sheet(isPresented: $showNotificationSettings) {
            NotificationSettingsView()
        }
        .confirmationDialog(
            "Sign out of Vital?",
            isPresented: $showSignOutConfirm,
            titleVisibility: .visible
        ) {
            Button("Sign Out", role: .destructive) { authViewModel.signOut() }
            Button("Cancel", role: .cancel) {}
        }
    }
}

// MARK: - Private sub-views

private extension ProfileView {

    // ── Screen title ─────────────────────────────────────────────────────

    var headerSection: some View {
        Text("Profile")
            .screenTitleStyle()
            .foregroundStyle(Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── Avatar + name ──────────────────────────────────────────────────────

    var avatarSection: some View {
        ZStack(alignment: .topTrailing) {
            VitalCard {
                VStack(spacing: Theme.Spacing.md) {
                    Circle()
                        .fill(Theme.Colors.accent)
                        .frame(width: 88, height: 88)
                        .overlay(
                            Text(vm.avatarInitial)
                                .font(.system(size: 38, weight: .bold, design: .rounded))
                                .foregroundStyle(Theme.Colors.onAccent)
                        )

                    VStack(spacing: 2) {
                        Text(vm.name)
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)

                        if let memberSince = vm.memberSince {
                            Text(memberSince)
                                .font(Theme.Typography.bodySmall)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }

            profileMenu
                .padding(.top, Theme.Spacing.xs)
                .padding(.trailing, Theme.Spacing.xs)
        }
    }

    // ── Calibration banner (title row + progress bar, per the mock) ─────────

    var calibratingBanner: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Calibrating your baselines")
                    .font(Theme.Typography.bodySmall)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text("\(vm.calibrationPercent)%")
                    .font(Theme.Typography.bodySmall)
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.accentContent)
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.Colors.textPrimary.opacity(0.08))
                    Capsule()
                        .fill(Theme.Colors.accent)
                        .frame(width: geo.size.width * CGFloat(max(vm.calibrationPercent, 1)) / 100)
                }
            }
            .frame(height: 3)
        }
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Theme.Colors.accentSoft)
        )
    }

    // ── Grouped settings card (mock's single six-row list) ──────────────────

    var settingsCard: some View {
        VitalCard(padding: 0) {
            VStack(spacing: 0) {
                settingsLink(index: 0, icon: "person", title: "Personal details", value: "Name, age, weight") {
                    PersonalDetailsView(profileVM: vm)
                }

                settingsLink(index: 1, icon: "target", title: "Goal", value: vm.budgetGoalLabel) {
                    GoalDetailView(switchToCoachTab: switchToCoachTab)
                        .onDisappear { Task { await vm.loadBudget() } }
                }

                settingsButton(index: 2, icon: "flame", title: "Daily budget",
                               value: vm.budgetKcal.map { "\($0) kcal" } ?? "--") {
                    showBudgetEditor = true
                }

                settingsLink(index: 3, icon: "moon", title: "Sleep goal", value: vm.sleepGoalSummary) {
                    SleepGoalView(profileVM: vm)
                }

                settingsLink(index: 4, icon: "applewatch", title: "Devices",
                             value: appleWatchConnected ? "Apple Watch · synced" : "Not connected") {
                    DevicesView(appleWatchConnected: appleWatchConnected)
                }

                settingsLink(index: 5, icon: "link", title: "Connected apps", value: "WHOOP") {
                    ConnectedAppsView()
                }

                settingsButton(index: 6, icon: "bell", title: "Notifications", value: notificationsSubtitle) {
                    showNotificationSettings = true
                }
            }
        }
    }

    func settingsLink<Destination: View>(
        index: Int, icon: String, title: String, value: String,
        @ViewBuilder destination: @escaping () -> Destination
    ) -> some View {
        NavigationLink { destination() } label: {
            settingsRowContent(icon: icon, title: title, value: value)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { if index > 0 { rowHairline } }
    }

    func settingsButton(
        index: Int, icon: String, title: String, value: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            settingsRowContent(icon: icon, title: title, value: value)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { if index > 0 { rowHairline } }
    }

    var rowHairline: some View {
        Rectangle()
            .fill(Theme.Colors.glassBorder)
            .frame(height: 0.5)
    }

    func settingsRowContent(icon: String, title: String, value: String) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            IconBadge(systemName: icon, style: .neutral, size: 36, cornerRadius: 12)

            Text(title)
                .font(Theme.Typography.bodyMedium)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.textPrimary)

            Spacer(minLength: Theme.Spacing.sm)

            Text(value)
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(1)

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .contentShape(Rectangle())
    }

    // ── Notifications subtitle ────────────────────────────────────────────

    var notificationsSubtitle: String {
        guard notificationManager.permissionState == .authorized else { return "Off" }
        let enabledCount = [notifBriefEnabled, notifMealsEnabled, notifWeighinEnabled].filter { $0 }.count
        return enabledCount > 0 ? "On · \(enabledCount) reminders" : "Off"
    }

    // ── Devices connectivity ──────────────────────────────────────────────

    /// The backend only tracks one combined HealthKit integration ("Apple
    /// Health") — that's also the channel Apple Watch data flows through, so
    /// it doubles as the connectivity signal for the mock's "Apple Watch" row.
    var appleWatchConnected: Bool {
        vm.integrations.contains { $0.status.lowercased() == "connected" }
    }

    // ── Activity stats ────────────────────────────────────────────────────

    var activitySection: some View {
        statSection(title: "Activity", cells: vm.activityStats)
    }

    func statSection(title: String, cells: [ProfileStatCell]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: title)

            let columns = [GridItem(.flexible(), spacing: Theme.Spacing.sm),
                           GridItem(.flexible(), spacing: Theme.Spacing.sm)]

            LazyVGrid(columns: columns, spacing: Theme.Spacing.sm) {
                ForEach(cells) { cell in
                    VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            HStack {
                                Image(systemName: cell.sfSymbol)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.Colors.accentContent)
                                Spacer()
                            }
                            Text(cell.value)
                                .font(Theme.Typography.numericLarge(24))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(cell.label)
                                .font(Theme.Typography.labelSmall)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // ── Overflow menu ─────────────────────────────────────────────────────

    var profileMenu: some View {
        Menu {
            Button {} label: {
                Label("Apple Health: \(healthStatusLabel)", systemImage: "heart.fill")
            }
            .disabled(true)

            Divider()

            Button {
                resyncHealthHistory()
            } label: {
                Label(
                    isResyncing ? "Importing health history…" : "Re-sync Health History",
                    systemImage: isResyncing ? "arrow.triangle.2.circlepath" : "arrow.clockwise"
                )
            }
            .disabled(isResyncing)

            if isResyncing {
                Label("\(backfillCoordinator.daysUploaded) days imported", systemImage: "clock")
                    .disabled(true)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Profile options")
    }

    var healthStatusLabel: String {
        let isConnected = vm.integrations.contains {
            $0.name == "Apple Health" && $0.status.lowercased() == "connected"
        }
        return isConnected ? "Connected" : "Disconnected"
    }

    func resyncHealthHistory() {
        guard !isResyncing else { return }

        Task {
            isResyncing = true
            defer { isResyncing = false }
            await backfillCoordinator.resync()
        }
    }

    // ── Recoverable load error ─────────────────────────────────────────────

    func errorState(message: String) -> some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
            HStack(alignment: .center, spacing: Theme.Spacing.md) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.alert)

                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text("Couldn't load profile")
                        .font(Theme.Typography.bodySmall)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(message)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(2)
                }

                Spacer(minLength: Theme.Spacing.sm)

                Button {
                    Task {
                        vm.errorMessage = nil
                        await vm.load()
                    }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                        .font(Theme.Typography.labelMedium)
                        .foregroundStyle(Theme.Colors.accentContent)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // ── Account ────────────────────────────────────────────────────────────

    var accountSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Account")

            Button {
                showSignOutConfirm = true
            } label: {
                VitalCard {
                    HStack(spacing: Theme.Spacing.md) {
                        ZStack {
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(Theme.Colors.alert.opacity(0.12))
                                .frame(width: 36, height: 36)
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .font(.system(size: 15))
                                .foregroundStyle(Theme.Colors.alert)
                        }

                        Text("Sign Out")
                            .font(Theme.Typography.bodySmall)
                            .fontWeight(.medium)
                            .foregroundStyle(Theme.Colors.alert)

                        Spacer()
                    }
                    .padding(.vertical, Theme.Spacing.xs)
                }
            }
            .buttonStyle(.plain)
        }
    }

    // ── Version footer ─────────────────────────────────────────────────────

    var versionFooter: some View {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        return Text("Vital · v\(version)")
            .font(.system(size: 12))
            .foregroundStyle(Theme.Colors.textTertiary)
            .frame(maxWidth: .infinity, alignment: .center)
    }

}
