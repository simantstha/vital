import AppIntents

/// Undo action for `QuickLogSnippetView`'s "Undo" button — deletes the meal
/// `LogMealIntent` just logged via the same `DELETE /api/meals/log?id=`
/// route the Diet sheet's manual-correction Undo uses (quick logs write
/// `source: 'quick'`, so they're never reachable by the coach's
/// `delete_meal` tool — this button is the only undo path for them).
struct UndoQuickLogIntent: AppIntent {
    static var title: LocalizedStringResource = "Undo meal log"
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Meal log id")
    var id: String

    /// Injected for tests — same reasoning as `LogMealIntent.service`.
    var service: QuickLogServicing?

    init() {}

    init(id: String, service: QuickLogServicing? = nil) {
        self.id = id
        self.service = service
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let resolvedService = service ?? LiveQuickLogService()
        try await resolvedService.undo(id: id)
        return .result(dialog: "Undone.")
    }
}
