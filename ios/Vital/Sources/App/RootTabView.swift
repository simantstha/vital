import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var router: AppRouter
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
                switchToCoachTab: { withAnimation(.easeInOut(duration: 0.25)) { selected = .coach } }
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
                switchToCoachTab: { withAnimation(.easeInOut(duration: 0.25)) { selected = .coach } }
            )
            .tabItem { Label(Tab.profile.label, systemImage: Tab.profile.icon) }
            .tag(Tab.profile)
        }
        .tint(Theme.Colors.accentContent)
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
            case .morningBrief:
                Color.clear.onAppear { selected = .today; router.route = nil }
            }
        }
    }
}
