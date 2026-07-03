import AuthenticationServices
import SwiftUI

/// Flips on once the paid Apple Developer Program is active and the
/// `com.apple.developer.applesignin` entitlement is added back to
/// `project.yml` / `Vital.entitlements`. Until then the SIWA button is
/// hidden so the app never drives `ASAuthorizationController` without the
/// entitlement (it would fail at request-time, not launch-time — this
/// guard just keeps a dead button off a free-account build).
private let isSignInWithAppleEnabled = false

struct SignInView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            VStack(spacing: Theme.Spacing.xxxl) {
                Spacer()

                brandSection

                Spacer()

                VStack(spacing: Theme.Spacing.md) {
                    if isSignInWithAppleEnabled {
                        SignInWithAppleButton(.signIn) { request in
                            request.requestedScopes = [.fullName]
                        } onCompletion: { result in
                            switch result {
                            case .success(let authorization):
                                Task { await authViewModel.signInWithApple(authorization: authorization) }
                            case .failure(let error):
                                authViewModel.errorMessage = error.localizedDescription
                            }
                        }
                        .signInWithAppleButtonStyle(.white)
                        .frame(height: 50)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                    }

                    #if DEBUG
                    Button {
                        Task { await authViewModel.devSignIn() }
                    } label: {
                        HStack {
                            if authViewModel.isLoading {
                                ProgressView()
                                    .tint(Theme.Colors.onAccent)
                            } else {
                                Text("Dev sign-in")
                                    .font(Theme.Typography.bodyLarge)
                                    .fontWeight(.semibold)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Theme.Colors.accent)
                        .foregroundStyle(Theme.Colors.onAccent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                    }
                    .disabled(authViewModel.isLoading)
                    #endif

                    if let message = authViewModel.errorMessage {
                        Text(message)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.alert)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.bottom, Theme.Spacing.xxxl)
            }
        }
    }
}

// MARK: - Brand

private extension SignInView {
    var brandSection: some View {
        VStack(spacing: Theme.Spacing.lg) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Theme.Colors.accent, Theme.Colors.accent.opacity(0.6)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 96, height: 96)
                    .shadow(color: Theme.Colors.accent.opacity(0.35), radius: 20, x: 0, y: 10)

                Image(systemName: "bolt.heart.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Theme.Colors.onAccent)
            }

            VStack(spacing: Theme.Spacing.sm) {
                Text("Vital")
                    .font(Theme.Typography.titleLarge)
                    .foregroundStyle(Theme.Colors.textPrimary)

                Text("Your health, coached.")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }
}
