import AuthenticationServices
import Foundation

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

    private let decoder = JSONDecoder()

    init() {
        isAuthenticated = KeychainStore.loadSessionToken() != nil
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

        guard let url = URL(string: "\(AppConfig.apiBaseURL)/api/auth/apple") else {
            errorMessage = "Invalid backend URL."
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        struct Body: Encodable { let identityToken: String }
        request.httpBody = try? JSONEncoder().encode(Body(identityToken: identityToken))

        await send(request)
    }

    func signOut() {
        KeychainStore.deleteSessionToken()
        isAuthenticated = false
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
            isAuthenticated = true
        } catch {
            errorMessage = "Sign-in failed: \(error.localizedDescription)"
        }
    }
}
