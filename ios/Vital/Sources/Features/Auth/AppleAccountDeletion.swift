import AuthenticationServices
import Foundation
import UIKit

// Sign in with Apple token revocation on account deletion
// (App Store guideline 5.1.1(v)).
//
// We store no Apple tokens, so when a user who signed in with Apple confirms
// "Delete account" we ask Apple for a *fresh* authorization (no scopes) and
// send its one-time `authorizationCode` to DELETE /api/account, which
// exchanges and revokes it server-side (lib/appleRevocation.ts).
//
// Decision logic lives in the pure `AppleDeletionGate`; the real
// ASAuthorizationController lives behind the `AppleAuthorizing` protocol so
// unit tests inject a fake and never present a system sheet.

// MARK: - Sign-in method

/// How the current session was created. Persisted at sign-in because only
/// Apple-signed-in users have anything to revoke (and only they should see the
/// Apple confirmation sheet when deleting their account).
enum SignInMethod: String {
    case apple
    case dev

    /// UserDefaults key holding the raw value of the active session's method.
    static let defaultsKey = "auth.signInMethod"

    /// Resolves the method for the current session. Sessions created before
    /// the method was recorded have no stored value: in a Release build the
    /// only possible sign-in is Sign in with Apple (the dev sign-in button is
    /// compiled out), so default to `.apple`; in Debug default to `.dev` so
    /// simulator/fixture runs never pop an Apple sheet.
    static func resolve(stored: String?, isDebugBuild: Bool) -> SignInMethod {
        if let stored, let method = SignInMethod(rawValue: stored) { return method }
        return isDebugBuild ? .dev : .apple
    }
}

// MARK: - Apple re-authorization

/// Why a fresh Apple authorization produced no code.
enum AppleReauthError: Error, Equatable {
    /// The user dismissed the Apple sheet.
    case cancelled
    /// Anything else: no credential/code, Apple unavailable, not signed in to
    /// an Apple ID on the device, etc.
    case failed

    /// Maps an `ASAuthorizationController` error onto `cancelled`/`failed`.
    static func classify(_ error: Error) -> AppleReauthError {
        isUserCancellation(error) ? .cancelled : .failed
    }

    /// True when `error` means "the user (or a cancelled task) backed out",
    /// as opposed to a failure. Accepts this module's own error, Apple's
    /// `ASAuthorizationError.canceled`, and task cancellation so fakes and the
    /// real authorizer are treated the same.
    static func isUserCancellation(_ error: Error) -> Bool {
        if let reauth = error as? AppleReauthError { return reauth == .cancelled }
        if error.isCancellation { return true }
        return (error as? ASAuthorizationError)?.code == .canceled
    }
}

/// Seam over `ASAuthorizationController` so the deletion decision is testable
/// without presenting a real Apple sheet.
@MainActor
protocol AppleAuthorizing {
    /// Presents a scope-less Sign in with Apple authorization and returns the
    /// fresh one-time authorization code. Throws `AppleReauthError` (or any
    /// error, which `AppleDeletionGate` classifies) on cancel/failure.
    func requestAuthorizationCode() async throws -> String
}

// MARK: - Deletion decision (pure)

/// Thrown by `AuthViewModel.deleteAccount()` when the user declines the Apple
/// confirmation; nothing has been deleted.
enum AccountDeletionError: Error, Equatable {
    case needsAppleConfirmation

    var userMessage: String {
        switch self {
        case .needsAppleConfirmation:
            return "Deletion needs Apple confirmation. Your account was not deleted."
        }
    }
}

enum AppleDeletionDecision: Equatable {
    /// Go ahead and call DELETE /api/account, attaching the code when present.
    case proceed(appleAuthorizationCode: String?)
    /// The user cancelled the Apple sheet: delete nothing.
    case abort
}

enum AppleDeletionGate {
    /// - Not an Apple sign-in: proceed with no code (nothing to revoke).
    /// - Apple returns a code: proceed with it.
    /// - User cancels the Apple sheet: abort (nothing is deleted).
    /// - Apple fails for any other reason: proceed WITHOUT a code — a user
    ///   must never be trapped in an account they asked to delete.
    @MainActor
    static func decide(
        usesAppleSignIn: Bool,
        authorizer: any AppleAuthorizing
    ) async -> AppleDeletionDecision {
        guard usesAppleSignIn else { return .proceed(appleAuthorizationCode: nil) }
        do {
            let code = try await authorizer.requestAuthorizationCode()
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return .proceed(appleAuthorizationCode: code.isEmpty ? nil : code)
        } catch {
            if AppleReauthError.isUserCancellation(error) { return .abort }
            print("[Vital] apple-reauth failed, deleting without revocation code: \(error)")
            return .proceed(appleAuthorizationCode: nil)
        }
    }
}

// MARK: - Real authorizer

/// Production `AppleAuthorizing`: bridges `ASAuthorizationController`'s
/// delegate callbacks to async/await with a single checked continuation.
/// Retained by `AuthViewModel` for the life of the app — the controller only
/// holds its delegate weakly, so this object must outlive the sheet.
@MainActor
final class AppleReauthorizer: NSObject, AppleAuthorizing {
    private var continuation: CheckedContinuation<String, Error>?
    /// Strong reference for the lifetime of the sheet; `performRequests()`
    /// does not retain the controller.
    private var controller: ASAuthorizationController?

    func requestAuthorizationCode() async throws -> String {
        // One sheet at a time; a second concurrent call is a programming error
        // we surface as a (non-cancel) failure rather than crash on.
        guard continuation == nil else { throw AppleReauthError.failed }

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = []   // we only need the authorizationCode

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    /// Resumes the pending continuation exactly once and releases the controller.
    private func finish(_ result: Result<String, Error>) {
        let pending = continuation
        continuation = nil
        controller = nil
        pending?.resume(with: result)
    }
}

extension AppleReauthorizer: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let codeData = credential.authorizationCode,
              let code = String(data: codeData, encoding: .utf8),
              !code.isEmpty
        else {
            finish(.failure(AppleReauthError.failed))
            return
        }
        finish(.success(code))
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        finish(.failure(AppleReauthError.classify(error)))
    }
}

extension AppleReauthorizer: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}
