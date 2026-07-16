import SwiftUI

/// Top-level gate: unauthenticated → SignInView; authenticated but not yet
/// onboarded → OnboardingFlowView; else the tab UI. Both `isAuthenticated`
/// and `onboarded` are seeded synchronously from Keychain/UserDefaults at
/// launch, so this never flashes the wrong state.
struct RootView: View {
    @StateObject private var authViewModel = AuthViewModel()
    @Environment(\.scenePhase) private var scenePhase

    /// Drives the one-time 365-day HealthKit backfill. Owned here (rather
    /// than by RootTabView or OnboardingFlowView) so the same instance and
    /// its published progress survive the Onboarding → RootTabView
    /// transition — the Calibrating step kicks it off, RootTabView's own
    /// `.task` is a safe no-op resume if it's still running.
    @StateObject private var backfillCoordinator = BackfillCoordinator()

    var body: some View {
        Group {
            if !authViewModel.isAuthenticated {
                SignInView()
            } else if !authViewModel.onboarded {
                OnboardingFlowView()
                    .environmentObject(backfillCoordinator)
            } else {
                RootTabView()
                    .environmentObject(backfillCoordinator)
                    .task {
                        await backfillCoordinator.startIfNeeded()
                        // Idempotent (guarded internally) — covers a user who
                        // signed in this session, since the AppDelegate path
                        // only registers observers at cold launch.
                        await HealthSyncCoordinator.shared.registerBackgroundDelivery()
                        // Rolling reminder window (D1) — recomputed from
                        // scratch every time this runs; no-op if permission
                        // hasn't been granted.
                        await ReminderScheduler.shared.resync()
                        await PushNotificationService.shared.hydratePreferences()
                        // No-ops until the user has granted calendar access
                        // (CalendarEventsProvider gate) — covers the case
                        // where access was already granted in a prior
                        // session, so the coach has fresh blocks without
                        // waiting on the next foreground.
                        await CalendarSyncCoordinator.shared.syncNow()
                    }
            }
        }
        .environmentObject(authViewModel)
        .onChange(of: scenePhase) { _, newPhase in
            // Catches the return trip from Settings after a permission
            // grant/deny, and generally keeps the rolling window fresh
            // without waiting on a cold launch.
            guard newPhase == .active else { return }
            Task {
                await NotificationManager.shared.refreshPermissionState()
                await ReminderScheduler.shared.resync()
                if authViewModel.isAuthenticated {
                    await PushNotificationService.shared.hydratePreferences()
                    await CalendarSyncCoordinator.shared.syncNow()
                }
            }
        }
    }
}
