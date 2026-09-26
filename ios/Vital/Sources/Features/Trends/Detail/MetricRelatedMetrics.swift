import Foundation

/// Which other metrics are worth showing alongside a given one — the
/// "Moves with it" section's row list, and (for HRV/resting HR) the
/// "agrees"/"disagrees" corroboration `MetricMeaning` looks for. A small,
/// hand-curated table rather than anything derived, since "related" is a
/// physiological judgment, not a statistical one.
enum MetricRelatedMetrics {
    /// Up to 3 related keys, in display order. Empty for a metric with no
    /// sensible pairing (e.g. body weight) — the "Moves with it" section
    /// hides itself when this is empty.
    static func relatedKeys(for metricKey: String) -> [String] {
        table[metricKey] ?? []
    }

    /// The single related metric `MetricMeaning` treats as corroborating —
    /// the first entry in `relatedKeys`, when one is meaningful for the
    /// "what it means today" rule. `nil` when this metric has no
    /// corroborating counterpart.
    static func primaryRelated(for metricKey: String) -> String? {
        switch metricKey {
        case "hrv_sdnn": return "resting_hr"
        case "whoop_hrv_rmssd": return "whoop_resting_hr"
        case "resting_hr": return "hrv_sdnn"
        case "whoop_resting_hr": return "whoop_hrv_rmssd"
        default: return nil
        }
    }

    private static let table: [String: [String]] = [
        "hrv_sdnn": ["resting_hr", "sleep_minutes"],
        "whoop_hrv_rmssd": ["whoop_resting_hr", "whoop_sleep_min"],
        "resting_hr": ["hrv_sdnn", "sleep_minutes"],
        "whoop_resting_hr": ["whoop_hrv_rmssd", "whoop_sleep_min"],
        "sleep_minutes": ["hrv_sdnn", "resting_hr"],
        "whoop_sleep_min": ["whoop_hrv_rmssd", "whoop_recovery"],
        "steps": ["active_energy_kcal", "exercise_min"],
        "exercise_min": ["steps", "active_energy_kcal"],
        "active_energy_kcal": ["steps", "exercise_min"],
        "whoop_recovery": ["whoop_hrv_rmssd", "whoop_sleep_min"],
        "whoop_day_strain": ["whoop_recovery", "whoop_sleep_min"],
        "vo2_max": ["resting_hr", "exercise_min"],
        "body_mass_kg": [],
        "hr_avg": ["resting_hr"],
        "flights": ["steps"],
        "basal_energy_kcal": ["active_energy_kcal"],
        "whoop_spo2": ["whoop_recovery"],
        "whoop_skin_temp": ["whoop_recovery"],
    ]

    /// Where today's reading sits relative to "normal" — the same shape of
    /// judgment the hero delta pill renders, reduced to just the direction
    /// so `coachQuestions` can pick a chip that doesn't contradict it.
    /// `.unknown` covers both "still calibrating" and "no data": there's no
    /// verdict to be directional about, so chips must not assume one.
    enum Direction {
        case above, below, normal, unknown
    }

    /// Suggested "Ask your coach" question chips for a metric — 3 short,
    /// tappable prompts that pre-fill the Coach input via
    /// `AppRouter.shared.coachContext`. `direction` gates any chip that
    /// asserts "higher"/"lower"/"up"/"down" so it never contradicts the
    /// screen's own verdict (e.g. offering "Why is my HRV lower than
    /// usual?" while HRV reads above normal).
    static func coachQuestions(for metricKey: String, displayName: String, direction: Direction) -> [String] {
        switch metricKey {
        case "hrv_sdnn", "whoop_hrv_rmssd":
            let directional: String
            switch direction {
            case .below:   directional = "Why is my HRV lower than usual?"
            case .above:   directional = "Why is my HRV higher than usual?"
            case .normal, .unknown: directional = "What affects my HRV?"
            }
            return [
                directional,
                "What can I do to improve my HRV?",
                "Is today a good day to train hard?",
            ]
        case "resting_hr", "whoop_resting_hr":
            let directional: String
            switch direction {
            case .above:   directional = "Why is my resting heart rate up today?"
            case .below:   directional = "Why is my resting heart rate lower today?"
            case .normal, .unknown: directional = "What affects my resting heart rate?"
            }
            return [
                directional,
                "Should I be worried about my resting HR?",
                "How does sleep affect my resting heart rate?",
            ]
        case "sleep_minutes", "whoop_sleep_min":
            let directional = direction == .below
                ? "Why did I sleep less last night?"
                : "What affects how much I sleep?"
            return [
                "How can I sleep more consistently?",
                directional,
                "What's a good sleep goal for me?",
            ]
        case "steps":
            let directional = direction == .below
                ? "Why is my step count down this week?"
                : "What affects my step count?"
            return [
                "How many steps should I aim for?",
                directional,
                "Does step count matter on strength days?",
            ]
        default:
            return [
                "What does this trend in \(displayName) mean?",
                "Is my \(displayName) normal for me?",
                "What could be driving this change?",
            ]
        }
    }
}
