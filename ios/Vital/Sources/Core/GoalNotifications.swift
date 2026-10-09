import Foundation

extension Notification.Name {
    /// Posted by Profile → Goal after goal targets (target weight / date /
    /// workouts per week) are saved via PATCH /api/profile, so other screens
    /// (Today goal hero, Trends) can refresh their goal-progress data.
    static let vitalGoalTargetsChanged = Notification.Name("vitalGoalTargetsChanged")

    /// Posted by a "Set a target" button on another screen. `RootTabView`
    /// switches to the Profile tab and `ProfileView` pushes the Goal editor.
    static let vitalOpenGoalEditor = Notification.Name("vitalOpenGoalEditor")

    /// Posted after the goal KIND changes outside Profile → Goal (the reached-goal
    /// "Switch to maintenance" button, via PATCH /api/diet-goal), so Today and
    /// Trends re-read the goal and its progress — not just the targets.
    static let vitalGoalKindChanged = Notification.Name("vitalGoalKindChanged")
}
