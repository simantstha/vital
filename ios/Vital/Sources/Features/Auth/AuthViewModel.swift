import AuthenticationServices
import Foundation
import UIKit

/// Response shape shared by /api/auth/dev and /api/auth/apple.
private struct AuthResponse: Decodable {
    let token: String
    let userId: String
    let onboarded: Bool
}

@MainActor
final class AuthViewModel: ObservableObject {
    @Published var isAuthenticated: Bool
    @Published var isLoading = false
    @Published var errorMessage: String?

    /// Mirrors the server's `users.onboarded_at` gate. Seeded from
    /// UserDefaults at launch (alongside the Keychain-seeded
    /// `isAuthenticated`) so RootView never flashes onboarding for an
    /// already-onboarded user, then kept in sync from every auth response
    /// and finalized by `markOnboarded()` at the end of the onboarding flow.
    @Published var onboarded: Bool

    /// Full name from the Sign in with Apple credential, captured on first
    /// authorization (Apple only supplies it once). Used purely as an
    /// onboarding prefill convenience — nil under dev sign-in.
    @Published var appleDisplayName: String?

    private let decoder = JSONDecoder()

    private enum Keys {
        static let onboarded = "user.onboarded"
    }

    init() {
        isAuthenticated = KeychainStore.loadSessionToken() != nil
        onboarded = UserDefaults.standard.bool(forKey: Keys.onboarded)

        // A 401 from any request means the stored token is no longer valid
        // (expired, or signed with a since-rotated secret). Drop the session so
        // RootView returns to SignInView instead of sitting in a broken
        // "signed in" state where every API call silently fails.
        NotificationCenter.default.addObserver(
            forName: .vitalSessionExpired,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isAuthenticated else { return }
                self.signOut()
            }
        }
    }

    /// Called by OnboardingFlowView once the questionnaire submits
    /// successfully and the user taps Continue on the Calibrating screen —
    /// flips the RootView gate over to the main tab UI.
    func markOnboarded() {
        onboarded = true
        UserDefaults.standard.set(true, forKey: Keys.onboarded)
    }

    /// Dev-only sign-in: exchanges the shared API secret for a real session
    /// JWT. Works against the currently deployed backend without needing a
    /// paid Apple Developer account.
    func devSignIn() async {
        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/auth/dev") else {
            errorMessage = "Invalid backend URL."
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(AppSecrets.apiToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        await send(request)
    }

    /// Sign in with Apple: verifies the identity token server-side and
    /// exchanges it for a session JWT.
    func signInWithApple(authorization: ASAuthorization) async {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityTokenData = credential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8)
        else {
            errorMessage = "Could not read Apple identity token."
            return
        }

        // Apple only includes fullName on the very first authorization for
        // this app — capture it now so onboarding can prefill the name field.
        if let components = credential.fullName {
            let formatted = PersonNameComponentsFormatter().string(from: components)
            if !formatted.isEmpty {
                appleDisplayName = formatted
            }
        }

        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/auth/apple") else {
            errorMessage = "Invalid backend URL."
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        // Apple only supplies fullName on the first authorization; forward it
        // so the server can persist a real name instead of the placeholder.
        struct Body: Encodable { let identityToken: String; let name: String? }
        request.httpBody = try? JSONEncoder().encode(Body(identityToken: identityToken, name: appleDisplayName))

        await send(request)
    }

    func signOut() {
        let token = KeychainStore.loadSessionToken()
        Task { await PushNotificationService.shared.invalidate(sessionToken: token) }
        KeychainStore.deleteSessionToken()
        AppRouter.shared.resetSession()
        PushNotificationService.shared.resetSession()
        isAuthenticated = false
        onboarded = false
        UserDefaults.standard.removeObject(forKey: Keys.onboarded)
    }

    // MARK: - Shared request handling

    private func send(_ request: URLRequest) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                errorMessage = "Sign-in failed (HTTP \(http.statusCode))."
                return
            }
            let auth = try decoder.decode(AuthResponse.self, from: data)
            KeychainStore.saveSessionToken(auth.token)
            onboarded = auth.onboarded
            UserDefaults.standard.set(auth.onboarded, forKey: Keys.onboarded)
            isAuthenticated = true
            AppRouter.shared.activateSession(token: auth.token)
            UIApplication.shared.registerForRemoteNotifications()
            await PushNotificationService.shared.hydratePreferences()
        } catch {
            errorMessage = "Sign-in failed: \(error.localizedDescription)"
        }
    }
}
