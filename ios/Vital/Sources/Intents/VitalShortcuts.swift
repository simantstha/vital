import AppIntents

/// Exposes `LogMealIntent` to Siri/Shortcuts/Spotlight — the "quick log"
/// PRD's "Hey Siri, log a meal in Vital" entry point.
///
/// Every phrase here MUST contain `\(.applicationName)` — App Intents'
/// build-time metadata extraction step fails the build otherwise.
struct VitalShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LogMealIntent(),
            phrases: [
                "Log a meal in \(.applicationName)",
                "Log food with \(.applicationName)",
                "Log a meal with \(.applicationName)",
            ],
            shortTitle: "Log a meal",
            systemImageName: "fork.knife"
        )
    }
}
