import SwiftUI

struct ProfileView: View {
    @StateObject private var vm = ProfileViewModel()
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var backfillCoordinator: BackfillCoordinator
    @ObservedObject private var notificationManager = NotificationManager.shared
    @ObservedObject private var unitPref = UnitPreference.shared
    @State private var showSignOutConfirm = false
    @State private var showDeleteAccountPrompt = false
    @State private var deleteConfirmationText = ""
    @State private var isDeletingAccount = false
    @State private var deleteAccountError: String?
    @State private var showBudgetEditor = false
    @State private var showNotificationSettings = false
    @State private var showUnitsDialog = false
    @State private var isResyncing = false
    @State private var showGoalEditor = false
    /// Highest `goalEditorRequest` already acted on (see `openGoalEditorIfRequested`).
    @State private var handledGoalEditorRequest = 0

    @AppStorage(NotificationPrefsKeys.briefEnabled) private var notifBriefEnabled = true
    @AppStorage(NotificationPrefsKeys.mealsEnabled) private var notifMealsEnabled = true
    @AppStorage(NotificationPrefsKeys.weighinEnabled) private var notifWeighinEnabled = true

    /// Switches the root TabView to the Coach tab — threaded down from
    /// `RootTabView` (same closure Today's voice FAB uses) so GoalDetailView's
    /// "Talk it through with your coach" button can land in the conversation.
    private let switchToCoachTab: () -> Void

    /// Monotonic counter bumped by `RootTabView` each time `.vitalOpenGoalEditor`
    /// arrives (it also switches to this tab). A counter rather than a Bool so
    /// a request made before this tab's first appearance is still honoured.
    private let goalEditorRequest: Int

    init(switchToCoachTab: @escaping () -> Void = {}, goalEditorRequest: Int = 0) {
        self.switchToCoachTab = switchToCoachTab
        self.goalEditorRequest = goalEditorRequest
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
                                .motionTransition(.fade)
                        } else if let errorMessage = vm.errorMessage {
                            ErrorStateContainer(message: errorMessage) {
                                ErrorCard(title: "Couldn't load profile", message: errorMessage) {
                                    Task {
                                        vm.errorMessage = nil
                                        await vm.load()
                                    }
                                }
                            }
                            // Account actions must stay reachable during an
                            // outage — the user can still sign out.
                            accountSection
                            versionFooter
                        } else {
                            Group {
                                avatarSection

                                if vm.calibration?.status == "calibrating" {
                                    calibratingBanner
                                }

                                settingsCard
                                activitySection
                                accountSection
                                versionFooter
                            }
                            .motionTransition(.fade)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.lg)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(isPresented: $showGoalEditor) {
                GoalDetailView(switchToCoachTab: switchToCoachTab)
                    .onDisappear { Task { await vm.refreshGoalRow() } }
            }
        }
        .task { await vm.load() }
        .onAppear { openGoalEditorIfRequested() }
        .onChange(of: goalEditorRequest) { openGoalEditorIfRequested() }
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
        .alert("Delete account?", isPresented: $showDeleteAccountPrompt) {
            TextField("Type DELETE", text: $deleteConfirmationText)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Delete Account", role: .destructive) { confirmDeleteAccount() }
            Button("Cancel", role: .cancel) { deleteConfirmationText = "" }
        } message: {
            Text("This permanently deletes your account and all of your data from Vital: health metrics, workouts, meals, chat history, memory, goals, and connected-device data. This can't be undone. Type DELETE to confirm.")
        }
        .alert(
            "Couldn't delete account",
            isPresented: Binding(
                get: { deleteAccountError != nil },
                set: { if !$0 { deleteAccountError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { deleteAccountError = nil }
        } message: {
            Text(deleteAccountError ?? "")
        }
        .overlay {
            if isDeletingAccount {
                ZStack {
                    Color.black.opacity(0.35).ignoresSafeArea()
                    VStack(spacing: Theme.Spacing.md) {
                        ProgressView()
                        Text("Deleting account…")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textPrimary)
                    }
                    .padding(Theme.Spacing.xl)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Theme.Colors.canvas)
                    )
                }
            }
        }
        .confirmationDialog(
            "Units",
            isPresented: $showUnitsDialog,
            titleVisibility: .visible
        ) {
            ForEach(UnitSystem.allCases, id: \.self) { system in
                Button(system.displayName) { setUnits(system) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

// MARK: - Goal editor deep link

private extension ProfileView {
    func openGoalEditorIfRequested() {
        guard goalEditorRequest > handledGoalEditorRequest else { return }
        handledGoalEditorRequest = goalEditorRequest
        showGoalEditor = true
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
                Text(CalibrationCopy.todayTitle)
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
                        .animation(Theme.Motion.settle, value: vm.calibrationPercent)
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

                settingsLink(index: 1, icon: "target", title: "Goal", value: vm.goalRowLabel) {
                    GoalDetailView(switchToCoachTab: switchToCoachTab)
                        .onDisappear { Task { await vm.refreshGoalRow() } }
                }

                settingsButton(index: 2, icon: "flame", title: "Daily budget",
                               value: UnitFormat.kcal(vm.budgetKcal)) {
                    showBudgetEditor = true
                }

                settingsLink(index: 3, icon: "moon", title: "Sleep goal", value: vm.sleepGoalSummary) {
                    SleepGoalView(profileVM: vm)
                }

                settingsLink(index: 4, icon: "heart.fill", title: "Devices",
                             value: appleHealthConnected ? "Apple Health · connected" : "Not connected") {
                    DevicesView(appleHealthConnected: appleHealthConnected)
                }

                settingsButton(index: 5, icon: "ruler", title: "Units", value: unitPref.current.displayName) {
                    showUnitsDialog = true
                }

                settingsButton(index: 6, icon: "bell", title: "Notifications", value: notificationsSubtitle) {
                    showNotificationSettings = true
                }

                settingsLink(index: 7, icon: "brain.head.profile", title: "Memory", value: "What Vital knows") {
                    MemoryView()
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
        .buttonStyle(.pressableCard)
        .overlay(alignment: .top) { if index > 0 { rowHairline } }
    }

    func settingsButton(
        index: Int, icon: String, title: String, value: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            settingsRowContent(icon: icon, title: title, value: value)
        }
        .buttonStyle(.pressableCard)
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
                // The endurance Goal row can carry race + target ("Half
                // marathon · Dec 30 · 30 km/wk"): wrap onto a second line
                // (trailing-aligned, next to the chevron) rather than shrink
                // or truncate it.
                .lineLimit(2)
                .multilineTextAlignment(.trailing)

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .contentShape(Rectangle())
    }

    // ── Units (optimistic, reverting on failure — same idiom as SleepGoalView) ─

    func setUnits(_ system: UnitSystem) {
        let previous = unitPref.current
        guard system != previous else { return }
        unitPref.set(system)
        Task {
            do {
                try await APIClient.shared.updateProfile(unitSystem: system.rawValue)
            } catch {
                unitPref.set(previous)
            }
        }
    }

    // ── Notifications subtitle ────────────────────────────────────────────

    var notificationsSubtitle: String {
        guard notificationManager.permissionState == .authorized else { return "Off" }
        let enabledCount = [notifBriefEnabled, notifMealsEnabled, notifWeighinEnabled].filter { $0 }.count
        return enabledCount > 0 ? "On · \(enabledCount) reminders" : "Off"
    }

    // ── Devices connectivity ──────────────────────────────────────────────

    /// HealthKit authorization is what we actually know — it says nothing
    /// about *which* device the data came from, so this row must not claim
    /// an Apple Watch is present (an iPhone-only user has HealthKit data
    /// too, e.g. from manual entry or a phone-only workout app). Label it
    /// "Apple Health", the thing we can actually verify.
    var appleHealthConnected: Bool {
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

    // ── Account ────────────────────────────────────────────────────────────

    var accountSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Account")

            VitalCard(padding: 0) {
                VStack(spacing: 0) {
                    Link(destination: AppLinks.privacyPolicy) {
                        accountRowContent(
                            icon: "hand.raised",
                            title: "Privacy policy",
                            tint: Theme.Colors.textPrimary,
                            showsExternalArrow: true
                        )
                    }
                    .buttonStyle(.pressableCard)

                    accountButton(icon: "rectangle.portrait.and.arrow.right", title: "Sign Out") {
                        showSignOutConfirm = true
                    }

                    accountButton(icon: "trash", title: "Delete account") {
                        deleteConfirmationText = ""
                        showDeleteAccountPrompt = true
                    }
                    .disabled(isDeletingAccount)
                }
            }
        }
    }

    func accountButton(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            accountRowContent(icon: icon, title: title, tint: Theme.Colors.alert, showsExternalArrow: false)
        }
        .buttonStyle(.pressableCard)
        .overlay(alignment: .top) { rowHairline }
    }

    func accountRowContent(icon: String, title: String, tint: Color, showsExternalArrow: Bool) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                    .fill(tint.opacity(0.12))
                    .frame(width: 36, height: 36)
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .foregroundStyle(tint)
            }

            Text(title)
                .font(Theme.Typography.bodySmall)
                .fontWeight(.medium)
                .foregroundStyle(tint)

            Spacer()

            if showsExternalArrow {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .contentShape(Rectangle())
    }

    /// Requires the user to have typed DELETE, then calls the API and (on
    /// success) clears local session state via `AuthViewModel.deleteAccount()`,
    /// which flips `isAuthenticated` and returns the app to the auth screen.
    /// Apple sign-in users are first asked to re-confirm with Apple so their
    /// Apple tokens can be revoked; cancelling that sheet cancels the deletion.
    func confirmDeleteAccount() {
        let typed = deleteConfirmationText.trimmingCharacters(in: .whitespacesAndNewlines)
        deleteConfirmationText = ""
        guard typed == "DELETE" else {
            deleteAccountError = "You need to type DELETE exactly to confirm. Your account was not deleted."
            return
        }
        guard !isDeletingAccount else { return }
        isDeletingAccount = true
        Task {
            do {
                try await authViewModel.deleteAccount()
            } catch let error as AccountDeletionError {
                // User declined the Apple confirmation: nothing was deleted.
                isDeletingAccount = false
                deleteAccountError = error.userMessage
            } catch {
                isDeletingAccount = false
                deleteAccountError = UserFacingError.message(for: error, context: .write, tag: "delete-account", includesAction: false)
            }
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
