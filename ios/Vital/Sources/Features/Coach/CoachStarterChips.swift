import Foundation

/// Goal-aware starter chips shown above the Coach composer before the user
/// sends their first message this session (roadmap 1.1, ux-spec-v4 §10 row
/// P1). Vital is a general fitness coach now, not a marathon app, so the
/// chips are no longer static — they're picked from the user's diet goal
/// (`/api/diet-goal`'s `current.goal`, the same `weight_loss | muscle |
/// endurance | general` vocabulary `DietBudgetDTO.goal` already uses).
///
/// Kept as a pure function (no view/view-model dependency) so it can be unit
/// tested directly — see `CoachStarterChipsTests`.
enum CoachStarterChips {
    /// Three starter prompts for the given goal. An unrecognized or nil goal
    /// (new user, not-yet-loaded, or a future goal value this client doesn't
    /// know about) falls back to `general` rather than showing nothing.
    static func chips(for goal: String?) -> [String] {
        switch goal {
        case "weight_loss":
            return [
                "How am I tracking this week?",
                "What should I eat for dinner?",
                "Log my weigh-in",
            ]
        case "muscle":
            return [
                "What should I train today?",
                "Am I eating enough protein?",
                "Log my workout",
            ]
        case "endurance":
            return [
                "Plan tomorrow's session",
                "Am I recovered?",
                "How was my week?",
            ]
        default:
            return [
                "How am I doing today?",
                "What should I eat for dinner?",
                "Give me a quick win",
            ]
        }
    }
}
