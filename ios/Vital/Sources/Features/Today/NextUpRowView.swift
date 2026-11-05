import SwiftUI

/// "Rest of today" — Today's plan as one connected line (owner decision,
/// 2026-09-23 replaced the full plan list; refreshed 2026-11-04 into a
/// timeline): up to a few upcoming items, each a dot on a vertical connector
/// with its title, detail and a chevron, plus a "See full plan" action that
/// opens the existing `PlanTimelineView` in a sheet. Applies to every goal.
///
/// `items` may be empty — callers show this view whenever the plan has ANY
/// items (`!planItems.isEmpty`), so "See full plan" stays reachable once
/// everything remaining today has passed `WeightHeroLogic.upcomingItems`'
/// grace window. The "Rest of today" label is hidden then, rather than
/// labelling nothing.
struct NextUpRowView: View {
    let items: [PlanItem]
    var onTap: (PlanItem) -> Void
    var onSeeFullPlan: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private let dotSize: CGFloat = 12
    private let connectorWidth: CGFloat = 1.5
    /// Gap above each dot, so it sits on the title's first line.
    private let dotTopInset: CGFloat = Theme.Spacing.md

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                row(item, isFirst: index == 0, isLast: index == items.count - 1)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.sm) {
            if !items.isEmpty {
                Text("Rest of today")
                    .scaledFont(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Button(action: onSeeFullPlan) {
                Text("See full plan")
                    .scaledFont(Theme.Typography.bodySmall.weight(.semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func row(_ item: PlanItem, isFirst: Bool, isLast: Bool) -> some View {
        let detail = WeightHeroLogic.timelineDetail(subtitle: item.subtitle, timeLabel: item.timeLabel)
        let lineLimit = dynamicTypeSize.isAccessibilitySize ? 4 : 2
        return Button {
            onTap(item)
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                marker(isFirst: isFirst)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(lineLimit)
                    Text(detail.asMarkdown)
                        .scaledFont(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(lineLimit)
                }
                .multilineTextAlignment(.leading)
                .padding(.vertical, Theme.Spacing.sm)

                Spacer(minLength: Theme.Spacing.sm)

                Image(systemName: "chevron.right")
                    .scaledFont(size: 13, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .padding(.top, Theme.Spacing.md)
            }
            .frame(minHeight: 44, alignment: .top)
            .background(alignment: .topLeading) {
                if !isLast { connector }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.title), \(detail)")
        .accessibilityAddTraits(.isButton)
    }

    /// The row's dot. The first dot is the accent (the one "now" stop); the
    /// rest are rings.
    private func marker(isFirst: Bool) -> some View {
        Group {
            if isFirst {
                Circle().fill(Theme.Colors.accent)
            } else {
                Circle().strokeBorder(Theme.Colors.textTertiary, lineWidth: 1.5)
            }
        }
        .frame(width: dotSize, height: dotSize)
        .padding(.top, dotTopInset)
        .accessibilityHidden(true)
    }

    /// The connector from this row's dot down to the next row's dot, drawn as
    /// the row's background so it always spans the row's real height (the row
    /// grows with Dynamic Type) and reaches the next dot.
    private var connector: some View {
        Rectangle()
            .fill(Theme.Colors.textTertiary.opacity(0.45))
            .frame(width: connectorWidth)
            .padding(.top, dotTopInset + dotSize + Theme.Spacing.xs)
            // Rows butt together; the next dot sits `dotTopInset` below this
            // row's bottom edge, so run the line down to just above it.
            .padding(.bottom, -(dotTopInset - Theme.Spacing.xs))
            .padding(.leading, (dotSize - connectorWidth) / 2)
            .accessibilityHidden(true)
    }
}
