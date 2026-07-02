import SwiftUI

/// Top-level gate: unauthenticated → SignInView; authenticated but not yet
/// onboarded → OnboardingFlowView; else the tab UI. Both `isAuthenticated`
/// and `onboarded` are seeded synchronously from Keychain/UserDefaults at
/// launch, so this never flashes the wrong state.
struct RootView: View {
    @StateObject private var authViewModel = AuthViewModel()

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
                    }
            }
        }
        .environmentObject(authViewModel)
    }
}
