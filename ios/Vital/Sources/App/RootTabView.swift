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

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selected) {
                TodayView()
                    .tag(Tab.today)

                CoachView(initialMessage: router.coachContext)
                    .id(router.coachContext)
                    .tag(Tab.coach)

                TrendsView()
                    .tag(Tab.trends)

                LogsView()
                    .tag(Tab.logs)

                ProfileView()
                    .tag(Tab.profile)
            }
            .toolbar(.hidden, for: .tabBar)

            tabBar
        }
        .tint(Theme.Colors.accentContent)
        .onChange(of: router.coachContext) { _, value in if value != nil { selected = .coach } }
        .sheet(item: $router.route) { route in
            switch route {
            case .workoutAnalysis(let id): WorkoutAnalysisView(id: id)
            case .sleepAnalysis(let id): SleepAnalysisView(id: id)
            case .morningBrief:
                Color.clear.onAppear { selected = .today; router.route = nil }
            }
        }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { tab in
                tabButton(for: tab)
            }
        }
        .padding(.horizontal, Theme.Spacing.xs)
        .padding(.vertical, Theme.Spacing.sm)
        .background(
            Capsule()
                .fill(Theme.Colors.card.opacity(0.95))
                .shadow(color: .black.opacity(0.12), radius: 30, x: 0, y: 8)
        )
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.sm)
    }

    private func tabButton(for tab: Tab) -> some View {
        let isActive = selected == tab

        return Button {
            selected = tab
        } label: {
            VStack(spacing: Theme.Spacing.xxs) {
                Image(systemName: tab.icon)
                    .font(.system(size: 21, weight: isActive ? .semibold : .regular))
                Text(tab.label)
                    .font(.system(size: 11, weight: isActive ? .semibold : .medium))
            }
            .foregroundStyle(isActive ? Theme.Colors.accentContent : Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.sm)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(isActive ? Theme.Colors.accentSoft : .clear)
            )
        }
        .buttonStyle(.plain)
    }
}
