import Foundation

extension Notification.Name {
    /// Posted by Profile → Goal after goal targets (target weight / date /
    /// workouts per week) are saved via PATCH /api/profile, so other screens
    /// (Today goal hero, Trends) can refresh their goal-progress data.
    static let vitalGoalTargetsChanged = Notification.Name("vitalGoalTargetsChanged")

    /// Posted by a "Set a target" button on another screen. `RootTabView`
    /// switches to the Profile tab and `ProfileView` pushes the Goal editor.
    static let vitalOpenGoalEditor = Notification.Name("vitalOpenGoalEditor")
}
