import SwiftUI

// MARK: - Shared body

/// Headline + verdict chip + stats grid + win / slip / next-week rows. Used
/// by the Today card and the detail sheet so they can never drift apart.
struct WeeklyReviewContent: View {
    let review: WeeklyReviewDTO
    var headlineSize: CGFloat = 20
    /// Compact (Today card): label + range + verdict chip and a headline capped
    /// at 2 lines. The stats grid and win / slip / next rows only render in the
    /// full variant (the detail sheet).
    var compact = false

    /// 2-up rows built by hand (not `LazyVGrid`, which sizes each cell to its
    /// own content): the `fixedSize(vertical:)` HStack gives both tiles in a
    /// row the taller one's height. An odd last tile keeps half width.
    private var statsGrid: some View {
        let pairs = stride(from: 0, to: review.stats.count, by: 2).map { i in
            Array(review.stats[i..<min(i + 2, review.stats.count)])
        }
        return VStack(spacing: Theme.Spacing.md) {
            ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                HStack(alignment: .top, spacing: Theme.Spacing.md) {
                    ForEach(pair) { stat in
                        WeeklyReviewStatTile(stat: stat)
                    }
                    if pair.count == 1 { Color.clear.frame(maxWidth: .infinity) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            // Label + range on one line, the verdict chip on its own line
            // below, leading-aligned. It used to sit at the header's trailing
            // edge, which is exactly where Today's floating voice FAB (60pt +
            // 20pt margin) rests and covered it.
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.sm) {
                    Text("YOUR WEEK")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    if let range = WeeklyReviewLogic.rangeText(review) {
                        Text(range)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    Spacer(minLength: 0)
                }
                if let weekWord = WeeklyReviewLogic.verdictLabel(review) {
                    Chip(
                        text: weekWord,
                        tint: GoalProgressLogic.color(for: WeeklyReviewLogic.tone(for: review))
                    )
                }
            }

            Text(review.headline)
                .font(.system(size: headlineSize, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineLimit(compact ? 2 : nil)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
                // Compact card lives on Today, where the trailing voice FAB
                // (60pt + 20pt margin) floats over the last card at rest —
                // leave room so the headline never sits underneath it.
                .padding(.trailing, compact ? 48 : 0)
                .accessibilityIdentifier("weeklyReview.headline")

            if !compact, !WeeklyReviewLogic.isNotEnoughData(review) {
                statsGrid
                    .accessibilityIdentifier("weeklyReview.stats")
            }

            let rows = compact ? [] : WeeklyReviewLogic.rows(review)
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(rows) { row in
                        WeeklyReviewRowView(row: row)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WeeklyReviewStatTile: View {
    let stat: WeeklyReviewStatDTO

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(stat.label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(stat.value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(stat.tone == .neutral ? Theme.Colors.textPrimary : WeeklyReviewLogic.color(for: stat.tone))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let comparison = stat.comparison, !comparison.isEmpty {
                Text(comparison)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(2)
            }
        }
        .padding(Theme.Spacing.md)
        // `maxHeight: .infinity` + the grid rows' shared height (see
        // `WeeklyReviewContent.statsGrid`) keeps both tiles in a row equal
        // even when only one has a comparison line.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Colors.glassFill)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WeeklyReviewLogic.accessibilityLabel(for: stat))
    }
}

private struct WeeklyReviewRowView: View {
    let row: WeeklyReviewLogic.Row

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            Image(systemName: WeeklyReviewLogic.rowIcon(row.kind))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WeeklyReviewLogic.rowColor(row.kind))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text(row.text)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Today card

/// Unseen-review card on Today (Mon-Wed), below the fuel strip / next-up
/// row. Compact on purpose: label + range + verdict chip and the headline.
/// "See your week" opens the full detail sheet (stats + win / slip / next);
/// "Got it" marks the review seen (`onGotIt`) and hides the card. Both buttons
/// sit on the leading side so Today's trailing voice FAB never covers them.
struct WeeklyReviewCard: View {
    let response: WeeklyReviewResponse
    var onOpen: () -> Void
    var onGotIt: () -> Void

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                WeeklyReviewContent(review: response.review, compact: true)

                HStack(spacing: Theme.Spacing.sm) {
                    Button(action: onOpen) {
                        HStack(spacing: Theme.Spacing.xs) {
                            Text("See your week")
                                .font(.system(size: 14, weight: .semibold))
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .foregroundStyle(Theme.Colors.accentContent)
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.vertical, Theme.Spacing.sm)
                        .background(Capsule().fill(Theme.Colors.accentSoft))
                    }
                    .buttonStyle(.vital(scale: 0.96))
                    .accessibilityHint("Opens your weekly review")
                    .accessibilityIdentifier("weeklyReview.open")

                    Button(action: onGotIt) {
                        Text("Got it")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .padding(.horizontal, Theme.Spacing.lg)
                            .padding(.vertical, Theme.Spacing.sm)
                    }
                    .buttonStyle(.vital(scale: 0.96))
                    .accessibilityIdentifier("weeklyReview.gotIt")

                    Spacer(minLength: 0)
                }
            }
        }
        // Keep child identifiers (buttons/title) addressable; without this
        // SwiftUI propagates this identifier onto descendants.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("weeklyReview.card")
    }
}

// MARK: - Trends row

/// "Weekly review" row in Trends (below the goal card): reopens the latest
/// review any time, seen or not.
struct WeeklyReviewRow: View {
    let response: WeeklyReviewResponse
    var onTap: () -> Void

    /// True for reviews with nothing substantive to celebrate (not enough
    /// data, or no target set) — the unseen dot renders grey for those.
    static func unseenDotIsNeutral(_ review: WeeklyReviewDTO) -> Bool {
        !review.sufficient || review.verdict == .insufficientData || review.verdict == .needsTarget
    }

    var body: some View {
        Button(action: onTap) {
            VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
                HStack(spacing: Theme.Spacing.md) {
                    Image(systemName: "calendar.badge.checkmark")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Weekly review")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text(WeeklyReviewLogic.isNotEnoughData(response.review)
                             ? WeeklyReviewLogic.firstReviewText(now: AppClock.now)
                             : response.review.headline)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: Theme.Spacing.sm)
                    if !response.isSeen {
                        // Green "new" dot only when there is a real review to
                        // read; an insufficient-data / needs-target nudge gets
                        // a neutral grey dot so it never reads as good news.
                        Circle()
                            .fill(WeeklyReviewRow.unseenDotIsNeutral(response.review)
                                  ? Theme.Colors.textTertiary : Theme.Colors.accent)
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
        }
        .buttonStyle(.pressableCard)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens your weekly review")
        .accessibilityIdentifier("weeklyReview.trendsRow")
    }
}

// MARK: - Detail sheet

/// Full review in a `VitalSheet`. Shows "Got it" while the review is unseen
/// (marks it seen and dismisses), otherwise just closes.
struct WeeklyReviewDetailView: View {
    let response: WeeklyReviewResponse
    var onGotIt: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                HStack {
                    Text("Weekly review")
                        .font(.system(size: 18, weight: .bold))
                        .tracking(-0.2)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .accessibilityIdentifier("weeklyReview.detail.title")
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        ZStack {
                            Circle().fill(Theme.Colors.glassFill).frame(width: 36, height: 36)
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
                }

                WeeklyReviewContent(review: response.review, headlineSize: 24)

                if !response.isSeen {
                    Button {
                        onGotIt()
                        dismiss()
                    } label: {
                        Text("Got it")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.Colors.accentContent)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, Theme.Spacing.md)
                            .background(Capsule().fill(Theme.Colors.accentSoft))
                    }
                    .buttonStyle(.vital(scale: 0.97))
                    .accessibilityIdentifier("weeklyReview.detail.gotIt")
                }
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.top, Theme.Spacing.md)
            .padding(.bottom, Theme.Spacing.xxxl)
        }
        .scrollIndicators(.hidden)
        // Keep child identifiers (buttons/title) addressable; without this
        // SwiftUI propagates this identifier onto descendants.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("weeklyReview.detail")
    }
}

// MARK: - Push deep link destination

/// Destination for a tapped `weekly_review` push (`PushRoute.weeklyReview`).
/// Uses the shared store's review when it matches the pushed id, otherwise
/// reloads (the push may arrive on a cold launch).
struct WeeklyReviewPushView: View {
    let id: String
    @ObservedObject private var store = WeeklyReviewStore.shared
    @State private var didAttemptLoad = false

    var body: some View {
        Group {
            if let latest = store.latest {
                WeeklyReviewDetailView(response: latest, onGotIt: { store.markSeen() })
            } else if didAttemptLoad {
                Text("Your weekly review isn't available right now.")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .padding(Theme.Spacing.xl)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.canvas)
        .task {
            if store.latest?.id != id { await store.load() }
            didAttemptLoad = true
        }
    }
}
