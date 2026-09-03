import SwiftUI

/// The Today-screen hero: a single card timeline of the day's meals,
/// movement, rest and calendar events. Mirrors the mock's `DailyPlan`
/// component (header row + card of rows + footer caption).
struct PlanTimelineView: View {
    let items: [PlanItem]
    /// Row tap (anywhere except the inline Log button) — opens the actions sheet.
    var onItemTap: (PlanItem) -> Void
    /// Inline "Log" pill tap — logs the item directly without opening the sheet.
    var onLogItem: (PlanItem) -> Void
    /// "+" button tap — opens the add-item sheet.
    var onOpenAdd: () -> Void
    /// Non-nil only when calendar authorization is undetermined — shows a
    /// tappable "Sync your calendar" row in place of the caption. Pass `nil`
    /// once the user has answered the system prompt (granted or denied) so
    /// the footer never nags again (Phase 8).
    var onSyncCalendar: (() -> Void)? = nil

    /// `true` when there's nothing to show — e.g. `/api/today` returned an
    /// empty `plan` and no calendar/local items merged in. Exposed so
    /// callers embedding this view in a spaced stack (see `TodayView`) can
    /// skip it entirely instead of leaving an empty card shell (or a
    /// floating gap where one would have been).
    var isEmpty: Bool { items.isEmpty }

    var body: some View {
        if isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                header

                VitalCard(padding: 0, cornerRadius: Theme.Radius.xl) {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            Button {
                                onItemTap(item)
                            } label: {
                                PlanRowView(item: item, onLogItem: onLogItem)
                            }
                            .buttonStyle(.vital)
                            .overlay(alignment: .top) {
                                if index > 0 {
                                    Rectangle()
                                        .fill(Theme.Colors.glassBorder)
                                        .frame(height: 0.5)
                                }
                            }
                        }
                    }
                }

                if let onSyncCalendar {
                    syncCalendarRow(action: onSyncCalendar)
                } else {
                    caption
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            Text("Today's plan")
                .font(.system(size: 20, weight: .bold))
                .tracking(-0.3)
                .foregroundStyle(Theme.Colors.textPrimary)

            Spacer()

            HStack(spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.xxs) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                    Text("Built for you")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Button(action: onOpenAdd) {
                    ZStack {
                        Circle()
                            .fill(Theme.Colors.accent)
                            .frame(width: 32, height: 32)
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Theme.Colors.onAccent)
                    }
                }
                .accessibilityLabel("Add to today's plan")
            }
        }
        .padding(.horizontal, Theme.Spacing.xxs)
    }

    private var caption: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "calendar")
                .font(.system(size: 11, weight: .semibold))
            Text("Synced with your calendar · tap any item to complete, skip or remove")
        }
        .font(.system(size: 12))
        .foregroundStyle(Theme.Colors.textTertiary)
        .padding(.horizontal, Theme.Spacing.xxs)
    }

    /// Tappable footer row shown instead of `caption` while calendar
    /// authorization is undetermined — see `onSyncCalendar`.
    private func syncCalendarRow(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "calendar.badge.plus")
                    .font(.system(size: 11, weight: .semibold))
                Text("Sync your calendar")
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(Theme.Colors.accentContent)
            .padding(.horizontal, Theme.Spacing.xxs)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Row

private struct PlanRowView: View {
    let item: PlanItem
    let onLogItem: (PlanItem) -> Void

    /// Flips on every "Log" pill tap — drives the commit haptic below.
    /// `onLogItem` is a caller-owned closure with no observable state of its
    /// own, so this local toggle is the state the tap "mutates" for
    /// `.sensoryFeedback(trigger:)` purposes.
    @State private var logTapped = false

    private var isNow: Bool { item.status == .now }
    private var isDone: Bool { item.status == .done }
    private var isSkipped: Bool { item.status == .skipped }

    private var badgeStyle: IconBadge.Style {
        if isNow { return .accent }
        if item.source == .calendar { return .neutral }
        return .soft
    }

    private var statusColor: Color {
        switch item.status {
        case .done:    return Theme.Colors.textTertiary
        case .now:     return Theme.Colors.accentContent
        case .next:    return Theme.Colors.textSecondary
        case .later:   return Theme.Colors.textTertiary
        case .skipped: return Theme.Colors.alert
        }
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.md + 2) {
            IconBadge(systemName: item.sfSymbol, style: badgeStyle)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Spacing.sm) {
                    Text(item.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .strikethrough(isSkipped)
                        .lineLimit(1)

                    Text(item.status.label.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.8)
                        .foregroundStyle(statusColor)
                }

                HStack(spacing: Theme.Spacing.xs) {
                    Text(item.subtitle.asMarkdown)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(1)

                    if item.source == .calendar {
                        HStack(spacing: 3) {
                            Image(systemName: "calendar")
                                .font(.system(size: 9, weight: .semibold))
                            Text("Calendar")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Theme.Colors.glassFill))
                    }
                }
            }

            Spacer(minLength: Theme.Spacing.sm)

            trailing
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md + 2)
        .contentShape(Rectangle())
        .background(isNow ? Theme.Colors.accentSoft.opacity(0.6) : Color.clear)
        .opacity(isDone ? 0.6 : (isSkipped ? 0.5 : 1.0))
    }

    @ViewBuilder
    private var trailing: some View {
        if isDone {
            Image(systemName: "checkmark")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Theme.Colors.accentContent)
        } else if isSkipped {
            Image(systemName: "xmark")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.Colors.alert.opacity(0.7))
        } else if let actionLabel = item.actionLabel, isNow {
            Button {
                logTapped.toggle()
                onLogItem(item)
            } label: {
                Text(actionLabel)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.Colors.card)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background(Capsule().fill(Theme.Colors.textPrimary))
            }
            .buttonStyle(.vital(scale: 1.0))
            .sensoryFeedback(Theme.Haptics.commit, trigger: logTapped)
        } else {
            Text(item.timeLabel)
                .font(.system(size: 12))
                .foregroundStyle(Theme.Colors.textTertiary)
                .monospacedDigit()
        }
    }
}
