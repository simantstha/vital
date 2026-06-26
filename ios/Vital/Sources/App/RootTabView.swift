import SwiftUI

struct RootTabView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem {
                    Label("Today", systemImage: "sun.max.fill")
                }

            CoachView()
                .tabItem {
                    Label("Coach", systemImage: "message.fill")
                }

            TrendsView()
                .tabItem {
                    Label("Trends", systemImage: "chart.line.uptrend.xyaxis")
                }

            LogsView()
                .tabItem {
                    Label("Logs", systemImage: "list.bullet.clipboard.fill")
                }

            ProfileView()
                .tabItem {
                    Label("Profile", systemImage: "person.fill")
                }
        }
        .tint(Theme.Colors.accent)
    }
}
