import Foundation

/// Parsed `vital://log` deep link — the "quick log" entry points that need
/// to open the Diet sheet: Siri/App Intents' "Open Vital to sign in first"
/// fallback and its snippet's "Edit in Vital" button, the Home Screen quick
/// action, and (indirectly, via `LogMealIntent`) Shortcuts/Spotlight/the
/// Action Button. Two shapes:
///
///   - `vital://log?mode=voice|text` — open the Diet sheet, then
///     immediately present `LogMealView` in that input method (the Home
///     Screen quick action and a bare "log a meal" tap use `.text`; a voice
///     dictation affordance would use `.voice`).
///   - `vital://log?event=<id>` — open the Diet sheet only, so the user can
///     see/edit the meal `id` refers to (no auto-presented LogMealView).
///
/// Pure parsing (mirrors `WhoopCallbackResult`'s init?(url:) pattern in
/// `WhoopConnectViewModel.swift`) so it's unit-testable without a URL scheme
/// handler or a live app.
enum LogDeepLinkRoute: Equatable, Identifiable {
    case compose(MealInputMethod)
    case event(String)

    var id: String {
        switch self {
        case .compose(let method): return "compose:\(method.rawValue)"
        case .event(let id):       return "event:\(id)"
        }
    }

    /// nil for any URL that isn't a recognized `vital://log` deep link
    /// (wrong scheme/host, or neither/an unrecognized `mode`/an empty
    /// `event`).
    init?(url: URL) {
        guard url.scheme == "vital", url.host == "log" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }

        if let mode = value("mode") {
            switch mode {
            case "voice": self = .compose(.voice)
            case "text":  self = .compose(.text)
            default:      return nil
            }
            return
        }
        if let eventId = value("event"), !eventId.isEmpty {
            self = .event(eventId)
            return
        }
        return nil
    }
}
