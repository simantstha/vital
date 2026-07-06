import SwiftUI

struct ProfileView: View {
    @StateObject private var vm = ProfileViewModel()
    @EnvironmentObject private var authViewModel: AuthViewModel
    @State private var showSignOutConfirm = false

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
        }
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
