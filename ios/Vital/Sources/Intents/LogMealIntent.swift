import AppIntents

/// "Log a meal" — the "quick log" slice 1 entry point for Siri, Shortcuts,
/// Spotlight and the Action Button. "Hey Siri, log a meal in Vital" →
/// "What did you eat?" → free text → an instant, undo-able log with no
/// coach reaction (see `POST /api/meals/quick`'s doc comment).
///
/// Runs headless (`openAppWhenRun = false`) — the whole point is 2 taps or
/// fewer, never opening the app — and requires the device to be unlocked
/// (`authenticationPolicy`) before it can touch the user's data.
struct LogMealIntent: AppIntent {
    static var title: LocalizedStringResource = "Log a meal"
    static var description = IntentDescription("Log a meal you just ate, e.g. \"two eggs and toast\".")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Meal", requestValueDialog: "What did you eat?")
    var text: String

    /// Injected for tests. `nil` (the default the system uses when it
    /// constructs this intent for Siri/Shortcuts) resolves to
    /// `LiveQuickLogService()` inside `perform()` — a default *argument*
    /// that constructed a `@MainActor` live service here wouldn't compile
    /// (default-argument expressions are evaluated in a nonisolated
    /// context), so this is a plain optional resolved in the body instead.
    var service: QuickLogServicing?

    init() {}

    init(service: QuickLogServicing) {
        self.service = service
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LogMealIntentError.emptyText }

        let resolvedService = service ?? LiveQuickLogService()
        do {
            let result = try await resolvedService.quickLog(text: trimmed)
            return .result(
                dialog: IntentDialog(stringLiteral: Self.confirmationDialog(name: result.name, kcal: result.kcal)),
                view: QuickLogSnippetView(id: result.id, name: result.name, kcal: result.kcal)
            )
        } catch let error as APIError {
            switch error {
            case .serverError(401): throw LogMealIntentError.notSignedIn
            case .mealNotFound:     throw LogMealIntentError.notFound
            default:                throw error
            }
        }
    }

    /// Pure, testable formatter for the success dialog — e.g.
    /// `confirmationDialog(name: "2 eggs and toast", kcal: 320)` →
    /// `"Logged 2 eggs and toast, 320 kcal"`.
    static func confirmationDialog(name: String, kcal: Int) -> String {
        "Logged \(name), \(kcal) kcal"
    }
}

/// Errors `LogMealIntent.perform()` throws for its three known non-success
/// outcomes — `errorDescription` is what Siri speaks / Shortcuts shows.
enum LogMealIntentError: LocalizedError, Equatable {
    case emptyText
    case notSignedIn
    case notFound

    var errorDescription: String? {
        switch self {
        case .emptyText:   return "Tell me what you ate."
        case .notSignedIn: return "Open Vital to sign in first."
        case .notFound:    return "I couldn't find that food. Try being more specific."
        }
    }
}
