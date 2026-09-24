import AppIntents

/// Exposes `LogMealIntent` to Siri/Shortcuts/Spotlight — the "quick log"
/// PRD's "Hey Siri, log a meal in Vital" entry point.
///
/// App Shortcut phrases can't carry a free-form String parameter, so
/// something like "Hey Siri, log two eggs and toast in Vital" can never
/// match directly — `LogMealIntent`'s `@Parameter(requestValueDialog:)` two-
/// step flow ("What did you eat?") is the correct design for that, not a
/// phrase-matching problem to solve here. What IS worth improving is how
/// many natural ways there are to *trigger* that first step, since Siri
/// only offers the intent for phrases it actually recognizes — hence the
/// wider set below (rather than the original 3) covering "log"/"track"/
/// "add", "meal"/"food"/"snack", and "in"/"with \(.applicationName)".
///
/// Every phrase here MUST contain `\(.applicationName)` — App Intents'
/// build-time metadata extraction step fails the build otherwise. Apple
/// allows roughly 10 phrases per shortcut; this uses 9, kept short and
/// natural rather than padding to the limit.
struct VitalShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LogMealIntent(),
            phrases: [
                "Log a meal in \(.applicationName)",
                "Log food with \(.applicationName)",
                "Log a meal with \(.applicationName)",
                "Log what I ate in \(.applicationName)",
                "Log food in \(.applicationName)",
                "Track a meal in \(.applicationName)",
                "Add a meal to \(.applicationName)",
                "Log my meal in \(.applicationName)",
                "Log a snack in \(.applicationName)",
            ],
            shortTitle: "Log a meal",
            systemImageName: "fork.knife"
        )
    }
}
