import SwiftUI

/// Detail screen for a `coach_nudge` notification — the real destination a
/// tap on that push (or a row in `NotificationsView`) opens, replacing the
/// old invisible-sheet hack in `RootTabView` that jumped straight to the
/// Coach tab with a hardcoded message and no way to see what the nudge
/// actually said.
///
/// `openFromNudge(findingId:)` (not `router.coachContext`, which
/// `AnalysisView` uses) is what `CoachViewModel` needs here — it threads the
/// finding id to the backend so the coach turn is grounded in this specific
/// finding, not just a copy-pasted string. `coachVM` + `switchToCoachTab` are
/// passed in rather than read off `RootTabView` directly so this view works
/// identically whether it's presented from the push-tap route (`RootTabView`)
/// or from a row tap inside `NotificationsView` (presented from `TodayView`,
/// which already holds the same shared `coachVM`).
struct NudgeDetailView: View {
    let id: String
    @ObservedObject var coachVM: CoachViewModel
    let switchToCoachTab: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var nudge: NudgeDetailResponse?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()
                Group {
                    if loading {
                        ProgressView().motionTransition(.fade)
                    } else if let nudge {
                        content(nudge).motionTransition(.fade)
                    } else {
                        ContentUnavailableView(
                            "Nudge unavailable",
                            systemImage: "bell.slash",
                            description: Text(error ?? "This nudge is no longer available.")
                        )
                        .motionTransition(.fade)
                    }
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
    }

    private func content(_ value: NudgeDetailResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Chip(text: "COACH NUDGE", icon: "bubble.left.fill", isAccent: true)

                Text(Self.formattedTimestamp(value.createdAt))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textTertiary)

                Text(value.title)
                    .font(Theme.Typography.titleLarge)
                    .foregroundStyle(Theme.Colors.textPrimary)

                Text(value.body)
                    .font(.system(size: 15.5))
                    .lineSpacing(4)
                    .foregroundStyle(Theme.Colors.textPrimary.opacity(0.9))

                // TODO: render a "What this is based on" evidence block once
                // GET /api/nudges/{id} returns the finding payload backing
                // this nudge (sleep/HRV deltas, etc.) — omitted for now since
                // the endpoint doesn't return that data yet.

                Spacer(minLength: Theme.Spacing.xxl)

                Button {
                    coachVM.openFromNudge(findingId: id)
                    switchToCoachTab()
                    dismiss()
                } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        Text("Discuss with Coach")
                        Image(systemName: "arrow.right")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.Colors.accent)
                .foregroundStyle(Theme.Colors.onAccent)
            }
            .padding(Theme.Spacing.xl)
        }
    }

    private func load() async {
        do {
            nudge = try await APIClient.shared.fetchNudge(id: id)
        } catch {
            self.error = UserFacingError.message(for: error, context: .read, tag: "fetchNudge")
        }
        withAnimation(Theme.Motion.appear) { loading = false }
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    private static func formattedTimestamp(_ date: Date) -> String {
        let calendar = Calendar.current
        let time = timeFormatter.string(from: date)
        if calendar.isDateInToday(date) { return "Today, \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday, \(time)" }
        return "\(dateFormatter.string(from: date)), \(time)"
    }
}
