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
                    } else {
                        avatarSection
                        nutritionSection
                        notificationsSection
                        statsGrid
                        integrationsSection
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
    }

    // ── Nutrition (diet budget entry point) ──────────────────────────────────

    var nutritionSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Nutrition")

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

    // ── Stats grid ─────────────────────────────────────────────────────────

    var statsGrid: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Stats")

            let columns = [GridItem(.flexible(), spacing: Theme.Spacing.sm),
                           GridItem(.flexible(), spacing: Theme.Spacing.sm)]

            LazyVGrid(columns: columns, spacing: Theme.Spacing.sm) {
                ForEach(vm.stats) { cell in
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

    // ── Integrations ───────────────────────────────────────────────────────

    var integrationsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Integrations")

            GlassCard {
                VStack(spacing: 0) {
                    ForEach(Array(vm.integrations.enumerated()), id: \.offset) { index, integration in
                        if index > 0 {
                            Rectangle()
                                .fill(Theme.Colors.glassBorder)
                                .frame(height: 0.5)
                        }

                        IntegrationRowView(integration: integration)
                    }
                }
            }

            resyncButton
        }
    }

    // ── Re-sync Health History ───────────────────────────────────────────────
    // Recovery for accounts whose one-time backfill self-completed early (before
    // the empty-run fix) and never imported their year of history. Re-runs the
    // 365-day backfill; server ingest is an idempotent upsert.

    var resyncButton: some View {
        Button {
            Task {
                isResyncing = true
                await backfillCoordinator.resync()
                isResyncing = false
            }
        } label: {
            GlassCard {
                HStack(spacing: Theme.Spacing.md) {
                    ZStack {
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(Theme.Colors.glassFill)
                            .frame(width: 36, height: 36)
                        if isResyncing {
                            ProgressView().tint(Theme.Colors.accentContent)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 15))
                                .foregroundStyle(Theme.Colors.accentContent)
                        }
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(isResyncing ? "Importing health history…" : "Re-sync Health History")
                            .font(Theme.Typography.bodySmall)
                            .fontWeight(.medium)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text(isResyncing
                             ? "\(backfillCoordinator.daysUploaded) days imported"
                             : "Re-import up to a year from Apple Health")
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }

                    Spacer()
                }
                .padding(.vertical, Theme.Spacing.xs)
            }
        }
        .buttonStyle(.plain)
        .disabled(isResyncing)
    }
}

// MARK: - Integration row

private struct IntegrationRowView: View {
    let integration: ProfileIntegration

    private var isConnected: Bool { integration.status == "connected" }
    private var icon: String {
        switch integration.name {
        case "Apple Health": return "heart.fill"
        default:             return "link"
        }
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                    .frame(width: 36, height: 36)
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            Text(integration.name)
                .font(Theme.Typography.bodySmall)
                .fontWeight(.medium)
                .foregroundStyle(Theme.Colors.textPrimary)

            Spacer()

            HStack(spacing: Theme.Spacing.xs) {
                Circle()
                    .fill(isConnected ? Theme.Colors.accent : Theme.Colors.textSecondary)
                    .frame(width: 7, height: 7)
                Text(isConnected ? "Connected" : "Disconnected")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(isConnected ? Theme.Colors.accent : Theme.Colors.textSecondary)
            }
        }
        .padding(.vertical, Theme.Spacing.md)
    }
}
