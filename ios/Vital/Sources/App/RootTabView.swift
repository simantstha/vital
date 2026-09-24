import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var router: AppRouter
    @Environment(\.scenePhase) private var scenePhase
    private enum Tab: Int, CaseIterable {
        case today, coach, trends, logs, profile

        var label: String {
            switch self {
            case .today:   return "Today"
            case .coach:   return "Coach"
            case .trends:  return "Trends"
            case .logs:    return "Logs"
            case .profile: return "Profile"
            }
        }

        var icon: String {
            switch self {
            case .today:   return "sun.max"
            case .coach:   return "message"
            case .trends:  return "chart.xyaxis.line"
            case .logs:    return "list.clipboard"
            case .profile: return "person"
            }
        }
    }

    @State private var selected: Tab = .today

    /// Owned here (not by `CoachView`) so Today's voice FAB can send a
    /// transcript into the same conversation the Coach tab renders — see
    /// `CoachView.init(vm:)` and `CoachViewModel.sendExternalVoiceTranscript`.
    /// Lifting this was flagged in the Phase 0/1 changelog entries in
    /// `docs/redesign-v3-plan.md` as the mechanism Phase 4 would need.
    @StateObject private var coachVM = CoachViewModel()

    var body: some View {
        TabView(selection: $selected) {
            TodayView(
                coachVM: coachVM,
                switchToCoachTab: { withAnimation(Theme.Motion.standard) { selected = .coach } }
            )
            .tabItem { Label(Tab.today.label, systemImage: Tab.today.icon) }
            .tag(Tab.today)

            CoachView(vm: coachVM)
            .tabItem { Label(Tab.coach.label, systemImage: Tab.coach.icon) }
            .tag(Tab.coach)

            TrendsView()
            .tabItem { Label(Tab.trends.label, systemImage: Tab.trends.icon) }
            .tag(Tab.trends)

            LogsView()
            .tabItem { Label(Tab.logs.label, systemImage: Tab.logs.icon) }
            .tag(Tab.logs)

            ProfileView(
                switchToCoachTab: { withAnimation(Theme.Motion.standard) { selected = .coach } }
            )
            .tabItem { Label(Tab.profile.label, systemImage: Tab.profile.icon) }
            .tag(Tab.profile)
        }
        .tint(Theme.Colors.accentContent)
        // Spec §3.2, V5: "app backgrounded > 10 s" ends conversation mode —
        // wired here rather than `CoachView`/`VoiceFABView` since this is
        // always mounted regardless of which tab is active, and a
        // FAB-started conversation can still be mid-first-listen when the
        // app backgrounds, before its `onSent` has switched to the Coach
        // tab. Both hooks are no-ops outside conversation mode.
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                coachVM.voiceController.appDidBecomeActive()
            } else if newPhase == .background {
                coachVM.voiceController.appDidEnterBackground()
            }
        }
        .onChange(of: router.coachContext) { _, value in
            if let value {
                coachVM.input = value
                selected = .coach
            }
        }
        .sheet(item: $router.route) { route in
            switch route {
            case .workoutAnalysis(let id): WorkoutAnalysisView(id: id)
            case .sleepAnalysis(let id): SleepAnalysisView(id: id)
            case .morningBrief(let id):
                if let id { MorningBriefView(id: id) }
                else { Color.clear.onAppear { selected = .today; router.route = nil } }
            case .coachNudge(let id):
                NudgeDetailView(id: id, coachVM: coachVM, switchToCoachTab: {
                    withAnimation(Theme.Motion.standard) { selected = .coach }
                })
            }
        }
    }
}
