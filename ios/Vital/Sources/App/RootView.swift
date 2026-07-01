import SwiftUI

/// Top-level gate: renders the tab UI once authenticated, otherwise the
/// sign-in screen. `AuthViewModel.isAuthenticated` is seeded synchronously
/// from Keychain at launch, so this never flashes the wrong state.
struct RootView: View {
    @StateObject private var authViewModel = AuthViewModel()

    var body: some View {
        Group {
            if authViewModel.isAuthenticated {
                RootTabView()
            } else {
                SignInView()
            }
        }
        .environmentObject(authViewModel)
    }
}
