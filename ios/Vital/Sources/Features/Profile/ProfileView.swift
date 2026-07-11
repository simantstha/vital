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

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(spacing: Theme.Spacing.xl) {
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
                        profileDetailsSection
                        dailyBudgetSection
                        notificationsSection
                        activitySection
                        accountSection
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.xxxl)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
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

    // ── Avatar + name ──────────────────────────────────────────────────────

    var avatarSection: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: Theme.Spacing.md) {
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [Theme.Colors.accent, Theme.Colors.accent.opacity(0.6)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 88, height: 88)
                        .shadow(color: Theme.Colors.accent.opacity(0.35), radius: 16, x: 0, y: 8)

                    Text(vm.avatarInitial)
                        .font(.system(size: 38, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.onAccent)
                }

                Text(vm.name)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            .frame(maxWidth: .infinity)

            profileMenu
        }
        .frame(maxWidth: .infinity)
    }

    // ── Profile details ───────────────────────────────────────────────────

    var profileDetailsSection: some View {
        statSection(title: "Profile Details", cells: vm.profileDetails)
    }

    // ── Daily budget entry point ──────────────────────────────────────────

    var dailyBudgetSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Daily Budget")

            Button { showBudgetEditor = true } label: {
                GlassCard {
                    HStack(spacing: Theme.Spacing.md) {
                        ZStack {
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(Theme.Colors.accent.opacity(0.22))
                                .frame(width: 38, height: 38)
                            Image(systemName: "target")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.Colors.accentContent)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Daily Budget")
                                .font(Theme.Typography.bodyMedium)
                                .fontWeight(.medium)
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(vm.budgetMode == "custom" ? "Custom" : "Auto · \(vm.budgetGoalLabel)")
                                .font(Theme.Typography.labelSmall)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }

                        Spacer()

                        if let kcal = vm.budgetKcal {
                            VStack(alignment: .trailing, spacing: 1) {
                                Text("\(kcal)")
                                    .font(Theme.Typography.numericSmall(17))
                                    .fontWeight(.semibold)
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Text("kcal / day")
                                    .font(Theme.Typography.labelSmall)
                                    .foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }
            .buttonStyle(.plain)
        }
    }

    // ── Notifications ─────────────────────────────────────────────────────

    var notificationsSubtitle: String {
        guard notificationManager.permissionState == .authorized else { return "Off" }
        let enabledCount = [notifBriefEnabled, notifMealsEnabled, notifWeighinEnabled].filter { $0 }.count
        return enabledCount > 0 ? "On · \(enabledCount) reminders" : "Off"
    }

    var notificationsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Notifications")

            Button { showNotificationSettings = true } label: {
                GlassCard {
                    HStack(spacing: Theme.Spacing.md) {
                        ZStack {
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(Theme.Colors.accent.opacity(0.22))
                                .frame(width: 38, height: 38)
                            Image(systemName: "bell.badge")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.Colors.accentContent)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Reminders")
                                .font(Theme.Typography.bodyMedium)
                                .fontWeight(.medium)
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(notificationsSubtitle)
                                .font(Theme.Typography.labelSmall)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }

                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }
            .buttonStyle(.plain)
        }
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
                    GlassCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
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
        GlassCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
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
                GlassCard {
                    HStack(spacing: Theme.Spacing.md) {
                        ZStack {
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(Theme.Colors.glassFill)
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

}
