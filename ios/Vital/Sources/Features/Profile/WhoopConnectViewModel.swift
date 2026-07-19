import AuthenticationServices
import Foundation
import UIKit

// MARK: - Connection state

/// Connection state for the WHOOP row on `ConnectedAppsView`. `.loading` and
/// `.connecting` are client-only phases; the rest mirror
/// `whoop_connections.status` ("active" | "revoked" | "error") as reported by
/// `GET /api/whoop/status` — `.notConnected` covers both "never connected"
/// and "revoked", which the server (and this screen) don't distinguish.
enum WhoopConnectionState: Equatable {
    case loading
    case notConnected
    case connecting
    case connected(lastSyncedAt: Date?)
    case needsReconnect
    case error(String)
}

extension Notification.Name {
    /// Posted by `RootView.onOpenURL` when the system routes a
    /// `vital://whoop?...` callback directly to the app instead of through
    /// `ASWebAuthenticationSession`'s own completion handler (which normally
    /// consumes it first) — e.g. the session was already dismissed when
    /// WHOOP redirected. `ConnectedAppsView` observes this to refresh status
    /// on that fallback path.
    static let vitalWhoopCallbackReceived = Notification.Name("vitalWhoopCallbackReceived")
}

// MARK: - Callback parsing

/// Pure parse of the `vital://whoop?status=...` deep link
/// `ASWebAuthenticationSession` hands back on completion. Factored out of the
/// view model so the one part of the connect flow that doesn't need a live
/// network/UI is unit-testable.
enum WhoopCallbackResult: Equatable {
    case connected
    case error

    /// nil for any URL that isn't a recognized `vital://whoop` callback
    /// (wrong scheme/host, or a missing/unknown `status` value) so callers
    /// can distinguish "not our callback" from "callback reported failure".
    init?(url: URL) {
        guard url.scheme == "vital", url.host == "whoop" else { return nil }
        let status = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == "status" }?
            .value
        switch status {
        case "connected": self = .connected
        case "error": self = .error
        default: return nil
        }
    }
}

// MARK: - ViewModel

@MainActor
final class WhoopConnectViewModel: NSObject, ObservableObject {
    @Published var state: WhoopConnectionState = .loading
    @Published var showDisconnectConfirm = false

    private let apiClient: APIClient
    /// Retained for the lifetime of the login sheet — `ASWebAuthenticationSession`
    /// does not retain itself, so a local-only reference would be torn down
    /// (and the sheet dismissed) as soon as `connect()` suspends.
    private var webAuthSession: ASWebAuthenticationSession?

    init(apiClient: APIClient = .shared) {
        self.apiClient = apiClient
    }

    func load() async {
        state = .loading
        await refreshStatus()
    }

    func refreshStatus() async {
        do {
            let response = try await apiClient.whoopStatus()
            state = Self.state(from: response)
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    /// Fetches the authorize URL, runs the WHOOP login/consent flow in
    /// `ASWebAuthenticationSession`, then refreshes status from the server —
    /// the app never sees the code or tokens; the backend callback does that
    /// work and the session only ever reports back `vital://whoop?status=...`.
    func connect() async {
        state = .connecting
        do {
            let authorizeURL = try await apiClient.whoopAuthorizeURL()
            try await runWebAuthSession(authorizeURL: authorizeURL)
            await refreshStatus()
        } catch is CancellationError {
            // User dismissed the sheet — friendly error, not a hard failure.
            state = .error("WHOOP connection was cancelled.")
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func disconnect() async {
        do {
            try await apiClient.whoopDisconnect()
            state = .notConnected
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    private func runWebAuthSession(authorizeURL: URL) async throws {
        try await withCheckedThrowingContinuation { [weak self] (continuation: CheckedContinuation<Void, Error>) in
            guard let self else {
                continuation.resume(throwing: CancellationError())
                return
            }
            let session = ASWebAuthenticationSession(
                url: authorizeURL,
                callbackURLScheme: "vital"
            ) { callbackURL, error in
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        continuation.resume(throwing: error)
                    }
                    return
                }
                guard let callbackURL, let result = WhoopCallbackResult(url: callbackURL) else {
                    continuation.resume(throwing: APIError.whoopConnectFailed)
                    return
                }
                switch result {
                case .connected: continuation.resume()
                case .error:     continuation.resume(throwing: APIError.whoopConnectFailed)
                }
            }
            session.presentationContextProvider = self
            // WHOOP login cookies persist across sessions, so a user already
            // signed into WHOOP elsewhere isn't forced to re-enter credentials
            // every time they (re)connect.
            session.prefersEphemeralWebBrowserSession = false
            self.webAuthSession = session
            session.start()
        }
    }

    // MARK: - Pure formatting helpers (testable)

    static func state(from response: WhoopStatusResponse) -> WhoopConnectionState {
        guard response.connected else { return .notConnected }
        if response.status == "error" { return .needsReconnect }
        return .connected(lastSyncedAt: parseISODate(response.lastSyncedAt))
    }

    /// "Last synced 3 hours ago" — nil `date` (never synced) reads as a
    /// distinct neutral label rather than a bogus relative time.
    static func lastSyncedLabel(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "Not yet synced" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return "Last synced \(formatter.localizedString(for: date, relativeTo: now))"
    }

    /// Same dual-format ISO-8601 parse as `ProfileViewModel.memberSinceLabel`
    /// (with and without fractional seconds) — Postgres timestamps round-trip
    /// through the API either way depending on the driver.
    static func parseISODate(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return withFractional.date(from: iso) ?? plain.date(from: iso)
    }
}

// MARK: - Presentation anchor

extension WhoopConnectViewModel: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}
