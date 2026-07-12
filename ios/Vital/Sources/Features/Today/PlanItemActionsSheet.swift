import SwiftUI

/// Bottom-sheet content presented when a `PlanTimelineView` row is tapped.
/// Mirrors the mock's `ItemActionsSheet`: header (icon + title + time) then a
/// card of filtered actions (mark done / skip / mark not done / remove), plus
/// an extra "View meal" row (not in the mock) that opens `MealDetailView` for
/// meal-kind items so the existing suggest/log flow isn't lost.
///
/// Presented inside a `VitalSheet` by the caller (see `TodayView`).
struct PlanItemActionsSheet: View {
    let item: PlanItem
    var onMarkDone: () -> Void
    var onSkip: () -> Void
    var onMarkNotDone: () -> Void
    var onRemove: () -> Void
    /// Non-nil only for meal-kind items with an attached `MealRow`.
    var onViewMeal: (() -> Void)?
    var onCancel: () -> Void

    private struct Action {
        let label: String
        let icon: String
        let danger: Bool
        let handler: () -> Void
    }

    private var actions: [Action] {
        var acts: [Action] = []

        if let onViewMeal {
            acts.append(Action(label: "View meal", icon: "fork.knife", danger: false, handler: onViewMeal))
        }
        if item.status != .done {
            acts.append(Action(label: "Mark done", icon: "checkmark", danger: false, handler: onMarkDone))
        }
        if item.status != .skipped && item.status != .done {
            acts.append(Action(label: "Skip today", icon: "circle.slash", danger: false, handler: onSkip))
        }
        if item.status == .done || item.status == .skipped {
            acts.append(Action(label: "Mark not done", icon: "arrow.counterclockwise", danger: false, handler: onMarkNotDone))
        }
        acts.append(Action(label: "Remove from today", icon: "trash", danger: true, handler: onRemove))

        return acts
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            header

            VitalCard(padding: 0, cornerRadius: Theme.Radius.xl) {
                VStack(spacing: 0) {
                    ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                        Button(action: action.handler) {
                            HStack(spacing: Theme.Spacing.md + 2) {
                                Image(systemName: action.icon)
                                    .font(.system(size: 17, weight: .medium))
                                    .foregroundStyle(action.danger ? Theme.Colors.alert : Theme.Colors.textSecondary)
                                Text(action.label)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(action.danger ? Theme.Colors.alert : Theme.Colors.textPrimary)
                                Spacer()
                            }
                            .padding(.horizontal, Theme.Spacing.lg)
                            .padding(.vertical, Theme.Spacing.lg)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
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

            Button(action: onCancel) {
                Text("Cancel")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md + 2)
                    .background(Capsule().fill(Theme.Colors.glassFill))
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.xxl)
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            IconBadge(systemName: item.sfSymbol, style: .soft)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 16, weight: .bold))
                    .tracking(-0.2)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(item.timeLabel + (item.source == .calendar ? " · from calendar" : ""))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer()
        }
    }
}
