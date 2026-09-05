import Foundation

/// Whether the operation that failed could have changed something on the
/// server. A failed *read* can safely be framed as "nothing changed" — the
/// user's existing data is untouched. A failed *write* must never be framed
/// that way: the request may have committed before the failure occurred, so
/// claiming "your data is safe" (or, just as bad, implying it *wasn't*
/// saved when it actually was) is an assertion we cannot back up. That
/// fabricated-certainty gap is the release-blocking bug class this mapping
/// exists to close — see `docs/superpowers/plans/2026-09-05-user-facing-error-copy.md`.
enum ErrorContext {
    case read
    case write
}

/// Single mapping from any `Error` to short, plain, user-safe copy.
///
/// Before this, 27 call sites across `Features/` piped `error.localizedDescription`
/// straight into UI — which surfaces things like `"Server returned HTTP 500."`
/// or Apple's `"The data couldn't be read because it isn't in the correct
/// format."` to someone who just wanted to see their sleep score. Call sites
/// now go through `UserFacingError.message(for:context:tag:)` instead of
/// hand-writing copy, so the wording for "you're offline" or "our server is
/// down" stays consistent and a future call site can't reintroduce a leak by
/// improvising a new string.
///
/// Four situations get distinct copy because the user's next action
/// differs — collapsing them into one generic string would make a fixable
/// problem (airplane mode) look identical to an outage:
///  - **Offline** — the user can fix this themselves; say so.
///  - **Our server failing (5xx)** — not the user's fault; a retry may work
///    shortly.
///  - **Session expired (401/403)** — retry is a dead end; they need to sign
///    in again, not tap a button that will 401 a second time.
///  - **Everything else** (decoding failures, unrecognized errors) — a bug
///    on our side. Copy stays generic, but the raw error is still logged in
///    full so this stays debuggable in production.
///
/// A handful of `APIError` cases (`.barcodeNotFound`, `.whoopAuthorizeURLMissing`,
/// `.whoopConnectFailed`) are already written for humans — those pass
/// through unchanged rather than being flattened to the generic bucket.
/// `.coachStreamError`'s payload is server-supplied text and is never shown
/// verbatim: treat backend text as untrusted for presentation.
enum UserFacingError {
    /// Logs the full untouched error (so production never gets harder to
    /// debug) and returns the copy safe to show the user. `tag` identifies
    /// the call site in the log line, matching the existing
    /// `print("[Vital] <tag> failed: ...")` convention used across the app.
    /// `log` defaults to `print` and exists as a seam for tests to capture
    /// the logged detail without shadowing stdout globally.
    static func message(
        for error: Error,
        context: ErrorContext,
        tag: String,
        log: (String) -> Void = { print($0) }
    ) -> String {
        log("[Vital] \(tag) failed: \(String(describing: error))")
        return copy(for: error, context: context)
    }

    /// Pure mapping (no logging side effect) so tests can assert on the copy
    /// in isolation.
    static func copy(for error: Error, context: ErrorContext) -> String {
        if isOffline(error) {
            return "You're offline — check your connection and try again."
        }

        if let apiError = error as? APIError {
            switch apiError {
            case .serverError(let code):
                if code == 401 || code == 403 {
                    return "Your session expired — sign in again to continue."
                }
                if (500...599).contains(code) {
                    return context == .write
                        ? "Couldn't save — something went wrong on our end. Try again shortly."
                        : "Couldn't load — something went wrong on our end. Try again shortly."
                }
                return generic(context)
            case .invalidURL:
                return generic(context)
            case .coachStreamError:
                // Server-supplied text — never trusted for presentation,
                // regardless of what it says.
                return generic(context)
            case .barcodeNotFound, .whoopAuthorizeURLMissing, .whoopConnectFailed:
                // Already human-safe copy — pass through unchanged.
                return apiError.errorDescription ?? generic(context)
            }
        }

        // DecodingError and anything else unrecognized: a bug on our side.
        // Copy stays generic; `message(for:context:tag:)` already logged the
        // full detail above.
        return generic(context)
    }

    private static func generic(_ context: ErrorContext) -> String {
        context == .write
            ? "Couldn't save — try again."
            : "Couldn't load — try again."
    }

    private static func isOffline(_ error: Error) -> Bool {
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
             .cannotFindHost, .dataNotAllowed, .internationalRoamingOff,
             .dnsLookupFailed, .timedOut:
            return true
        default:
            return false
        }
    }
}
