import Foundation

/// What the user was actually doing, which decides the verb in the copy —
/// and, more importantly, decides what we are allowed to *claim* happened.
///
/// A failed `.read` can safely be framed as "nothing changed" — the user's
/// existing data is untouched. A failed `.write` must never be framed that
/// way: the request may have committed before the failure occurred, so
/// claiming "your data is safe" (or, just as bad, implying it *wasn't* saved
/// when it actually was) is an assertion we cannot back up. That
/// fabricated-certainty gap is the release-blocking bug class this mapping
/// exists to close — see `docs/superpowers/plans/2026-09-05-user-facing-error-copy.md`.
///
/// The same rule is why a fetch that only computes a local estimate is
/// `.read` even though it goes over the network: saying "couldn't save" when
/// no save was attempted is a small false statement about what happened, and
/// it is the same bug class in miniature.
///
/// `.signIn` exists because "save" and "load" are both wrong on the sign-in
/// screen — the user isn't storing or retrieving anything, they're trying to
/// get in.
enum ErrorContext {
    case read
    case write
    case signIn
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
///  - **Offline** — the user can fix this themselves; say so. Checked first,
///    so airplane mode on the sign-in screen still reads as offline.
///  - **Session expired (401/403)** — retry is a dead end; they need to sign
///    in again, not tap a button that will 401 a second time. Deliberately
///    *not* applied to `.signIn`: a rejected credential on the sign-in screen
///    is not an expired session, and "sign in again to continue" there is a
///    loop with no exit.
///  - **Our server failing (5xx)** — not the user's fault; a retry may work
///    shortly.
///  - **Everything else** (decoding failures, unrecognized errors) — a bug
///    on our side. Copy stays generic, but the raw error is still logged in
///    full so this stays debuggable in production.
///
/// A handful of `APIError` cases (`.barcodeNotFound`, `.whoopAuthorizeURLMissing`,
/// `.whoopConnectFailed`, `.mealNotFound`) are already written for humans —
/// those pass through unchanged rather than being flattened to the generic
/// bucket.
/// `.coachStreamError`'s payload is server-supplied text and is never shown
/// verbatim: treat backend text as untrusted for presentation.
enum UserFacingError {
    /// Logs the full untouched error (so production never gets harder to
    /// debug) and returns the copy safe to show the user. `tag` identifies
    /// the call site in the log line, matching the existing
    /// `print("[Vital] <tag> failed: ...")` convention used across the app.
    /// `log` defaults to `print` and exists as a seam for tests to capture
    /// the logged detail without shadowing stdout globally.
    ///
    /// `includesAction` (default `true`) controls whether the message includes
    /// the "Couldn't <verb>" preamble. When `false`, the preamble is omitted,
    /// suitable for display under an ErrorCard title that already names the action.
    static func message(
        for error: Error,
        context: ErrorContext,
        tag: String,
        includesAction: Bool = true,
        log: (String) -> Void = { print($0) }
    ) -> String {
        log("[Vital] \(tag) failed: \(String(describing: error))")
        return copy(for: error, context: context, includesAction: includesAction)
    }

    /// Pure mapping (no logging side effect) so tests can assert on the copy
    /// in isolation.
    ///
    /// `includesAction` (default `true`) controls whether the message includes
    /// the "Couldn't <verb>" preamble. When `false`, the preamble is omitted,
    /// suitable for display under an ErrorCard title that already names the action.
    static func copy(for error: Error, context: ErrorContext, includesAction: Bool = true) -> String {
        if isOffline(error) {
            return "You're offline — check your connection and try again."
        }

        if let apiError = error as? APIError {
            switch apiError {
            case .serverError(let code):
                // `context != .signIn`: a 401/403 while signing in means the
                // credential was rejected, not that a session lapsed. Telling
                // someone already looking at the sign-in screen to "sign in
                // again to continue" sends them nowhere — that case falls
                // through to the sign-in copy below.
                if (code == 401 || code == 403), context != .signIn {
                    return "Your session expired — sign in again to continue."
                }
                if (500...599).contains(code) {
                    if includesAction {
                        return "Couldn't \(verb(context)) — something went wrong on our end. Try again shortly."
                    } else {
                        return "Something went wrong on our end. Try again shortly."
                    }
                }
                return generic(context, includesAction: includesAction)
            case .invalidURL:
                return generic(context, includesAction: includesAction)
            case .coachStreamError:
                // Server-supplied text — never trusted for presentation,
                // regardless of what it says.
                return generic(context, includesAction: includesAction)
            case .barcodeNotFound, .whoopAuthorizeURLMissing, .whoopConnectFailed, .mealNotFound:
                // Already human-safe copy — pass through unchanged.
                return apiError.errorDescription ?? generic(context, includesAction: includesAction)
            }
        }

        // DecodingError and anything else unrecognized: a bug on our side.
        // Copy stays generic; `message(for:context:tag:)` already logged the
        // full detail above.
        return generic(context, includesAction: includesAction)
    }

    private static func generic(_ context: ErrorContext, includesAction: Bool = true) -> String {
        if includesAction {
            return "Couldn't \(verb(context)) — try again."
        } else {
            return "Try again."
        }
    }

    /// The one place the per-context wording lives, so the generic and 5xx
    /// strings can never drift apart when a context is added.
    private static func verb(_ context: ErrorContext) -> String {
        switch context {
        case .read:   return "load"
        case .write:  return "save"
        case .signIn: return "sign in"
        }
    }

    /// Exposed (not `private`) so a caller that needs to *branch* on
    /// connectivity — not just show copy — can reuse the same classification
    /// rather than re-deriving it. `CoachViewModel.send()`'s voice error
    /// path (spec §3.6, delivery slice V5) uses this to pick `.offline` vs
    /// `.requestFailed` when ending a conversation after a failed turn.
    static func isOffline(_ error: Error) -> Bool {
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
