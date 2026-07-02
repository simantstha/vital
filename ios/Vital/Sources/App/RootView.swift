import SwiftUI

/// Top-level gate: renders the tab UI once authenticated, otherwise the
/// sign-in screen. `AuthViewModel.isAuthenticated` is seeded synchronously
/// from Keychain at launch, so this never flashes the wrong state.
struct RootView: View {
    @StateObject private var authViewModel = AuthViewModel()

    /// Drives the one-time 365-day HealthKit backfill once signed in. Kept
    /// silent in the UI for now (no progress screen yet — that lands with
    /// Phase 5's onboarding Calibrating step); published state is exposed via
    /// environmentObject so any view can observe it once that UI exists.
    @StateObject private var backfillCoordinator = BackfillCoordinator()

    var body: some View {
        Group {
            if authViewModel.isAuthenticated {
                RootTabView()
                    .environmentObject(backfillCoordinator)
                    .task {
                        await backfillCoordinator.startIfNeeded()
                    }
            } else {
                SignInView()
            }
        }
        .environmentObject(authViewModel)
    }
}
