import SwiftUI

/// Sheet target for a notification row's detail screen — `item` carries
/// everything needed to route by `type`, mirroring `LogsView`'s
/// `AnalysisSheetTarget`.
private struct NotificationDetailTarget: Identifiable {
    let item: NotificationItemDTO
    var id: String { item.id }
}

/// The notification inbox — reached from the bell in the Today header
/// (`TodayView.bellButton`) and from a cold-launch tap on any push via
/// `RootTabView`. Lists every proactive notification the backend has kept
/// for this user; tapping a row marks it read and opens the matching detail
/// screen.
struct NotificationsView: View {
    /// Shared with the Today bell badge — see `NotificationsViewModel.shared`.
    @ObservedObject private var vm = NotificationsViewModel.shared
    @ObservedObject var coachVM: CoachViewModel
    let switchToCoachTab: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var detailTarget: NotificationDetailTarget?

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            VStack(spacing: 0) {
                navRow
                ScrollView {
                    content
                        .padding(.horizontal, Theme.Spacing.xl)
                        .padding(.top, Theme.Spacing.xs)
                        .padding(.bottom, Theme.Spacing.xl)
                }
                .scrollIndicators(.hidden)
                .refreshable { await vm.load() }
            }
        }
        .task { await vm.load() }
        .sheet(item: $detailTarget) { target in
            detailView(for: target.item)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.loadState {
        case .loading where vm.items.isEmpty:
            HStack {
                Spacer()
                ProgressView().tint(Theme.Colors.accentContent)
                Spacer()
            }
            .padding(.top, 60)
            .motionTransition(.fade)

        case .failed where vm.items.isEmpty:
            ErrorCard(title: "Couldn't load notifications", message: vm.errorMessage ?? "Try again.") {
                Task { await vm.load() }
            }
            .motionTransition(.fade)

        default:
            if vm.items.isEmpty {
                emptyState.motionTransition(.fade)
            } else {
                LazyVStack(spacing: Theme.Spacing.sm) {
                    ForEach(vm.items) { item in
                        Button {
                            Task { await vm.markRead(id: item.id) }
                            detailTarget = NotificationDetailTarget(item: item)
                        } label: {
                            NotificationRowView(item: item)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .motionTransition(.fade)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.md) {
            ZStack {
                Circle().fill(Theme.Colors.glassFill).frame(width: 64, height: 64)
                Image(systemName: "bell")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Text("You're all caught up")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Coach nudges, morning briefs and workout recaps will collect here so you can read them whenever you like.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 100)
    }

    private var navRow: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(width: 44, height: 44, alignment: .leading)
            }

            Spacer()

            Text("Notifications")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)

            Spacer()

            Button {
                Task { await vm.markAllRead() }
            } label: {
                Text("Mark all read")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .frame(width: 44, height: 44, alignment: .trailing)
                    .fixedSize()
            }
            .opacity(vm.unreadCount == 0 ? 0 : 1)
            .disabled(vm.unreadCount == 0)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.xs)
    }

    @ViewBuilder
    private func detailView(for item: NotificationItemDTO) -> some View {
        switch item.type {
        case "workout_analysis": WorkoutAnalysisView(id: item.targetId)
        case "sleep_analysis": SleepAnalysisView(id: item.targetId)
        case "morning_brief": MorningBriefView(id: item.targetId)
        default: NudgeDetailView(id: item.targetId, coachVM: coachVM, switchToCoachTab: switchToCoachTab)
        }
    }
}

// MARK: - Row

private struct NotificationRowView: View {
    let item: NotificationItemDTO

    private var isUnread: Bool { item.readAt == nil }

    private var typeStyle: (icon: String, label: String, fill: Color, foreground: Color) {
        switch item.type {
        case "workout_analysis":
            return ("figure.run", "Workout analysis", Theme.Colors.specialistAccent.opacity(0.15), Theme.Colors.specialistAccent)
        case "sleep_analysis":
            return ("moon.zzz.fill", "Sleep analysis", Theme.Colors.indigo.opacity(0.15), Theme.Colors.indigo)
        case "morning_brief":
            return ("sun.max.fill", "Morning brief", Theme.Colors.cautionSoft, Theme.Colors.caution)
        default:
            return ("bubble.left.fill", "Coach nudge", Theme.Colors.accentSoft, Theme.Colors.accentContent)
        }
    }

    var body: some View {
        let style = typeStyle
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(style.fill)
                Image(systemName: style.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(style.foreground)
            }
            .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.system(size: 14.5, weight: isUnread ? .semibold : .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                Text(item.body)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(2)
                Text(style.label)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .padding(.top, 2)
            }

            Spacer(minLength: Theme.Spacing.sm)

            Text(Self.relativeTime(item.createdAt))
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.vertical, Theme.Spacing.md)
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.leading, isUnread ? Theme.Spacing.xs : 0)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
        )
        .overlay(alignment: .leading) {
            if isUnread {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Theme.Colors.accent)
                    .frame(width: 2)
                    .padding(.vertical, Theme.Spacing.sm)
            }
        }
        .opacity(isUnread ? 1 : 0.7)
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    private static func relativeTime(_ date: Date, now: Date = Date()) -> String {
        relativeFormatter.localizedString(for: date, relativeTo: now)
    }
}
