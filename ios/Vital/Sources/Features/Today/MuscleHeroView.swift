import SwiftUI

/// Today's muscle goal hero (docs/ux-spec-v4.md §4.1): today's strength
/// session from the plan, a "last time" lift line, a "this week" session
/// count, a protein have/goal bar, and a rest-day fallback. "Last time" and
/// "this week" are fed by `GET /api/training/summary` (#202,
/// `TodayViewModel.trainingSummary`) and hidden whenever that data is
/// absent — never fabricated (P4).
struct MuscleHeroView: View {
    /// Today's move-kind plan item, or `nil` for a rest day —
    /// `MuscleHeroLogic.todaySession(from:)`.
    let session: PlanItem?
    let proteinHave: Int
    let proteinGoal: Int

    /// "Last (Mon): Deadlift 2×5 @ 150 kg" — `TodayViewModel
    /// .muscleLastLiftText`. `nil` hides the line entirely.
    var lastLiftText: String? = nil
    /// "2 of 4 sessions" or the no-plan-data "N sessions this week" fallback
    /// — `TodayViewModel.trainingSessionsThisWeekText`. `nil` hides the line.
    var sessionsThisWeekText: String? = nil
    /// Done/total for the "● ● ○ ○" dot row — `nil` when nothing is planned
    /// this week — `TodayViewModel.trainingSessionDots`.
    var sessionDots: (done: Int, total: Int)? = nil

    /// Opens the existing plan-item actions sheet for `session` — the
    /// nearest thing to a "Start" flow this slice has (no dedicated logger
    /// exists yet, per the task's scope note).
    var onTapSession: (PlanItem) -> Void

    private var proteinFraction: Double {
        guard proteinGoal > 0 else { return 0 }
        return min(1.0, Double(proteinHave) / Double(proteinGoal))
    }

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.xl) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                sessionSection
                if let lastLiftText {
                    Text(lastLiftText)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                if sessionDots != nil || sessionsThisWeekText != nil {
                    weekRow
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Protein \(proteinHave) / \(proteinGoal) g")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .monospacedDigit()
                    VitalProgressBar(fraction: proteinFraction, tint: Theme.Colors.accent, height: 6)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    /// "This week" row: the coloured dot chain (done = accent, planned-not-
    /// done = muted, unplanned days simply aren't in the chain at all) plus
    /// the "N of M sessions" / fallback text — either half can be absent.
    @ViewBuilder
    private var weekRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if let sessionDots {
                SessionDotsRow(done: sessionDots.done, total: sessionDots.total)
            }
            if let sessionsThisWeekText {
                Text(sessionsThisWeekText)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .monospacedDigit()
            }
        }
        .accessibilityIdentifier("today.muscleHero.weekRow")
    }

    @ViewBuilder
    private var sessionSection: some View {
        if let session {
            Button { onTapSession(session) } label: {
                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    Image(systemName: "dumbbell.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                    Text(session.title)
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(2)
                    Spacer(minLength: Theme.Spacing.sm)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("today.muscleHero.session")
        } else {
            Text(MuscleHeroLogic.restDayText)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        if let session {
            parts.append(session.title)
        } else {
            parts.append(MuscleHeroLogic.restDayText)
        }
        if let lastLiftText { parts.append(lastLiftText) }
        if let sessionsThisWeekText { parts.append(sessionsThisWeekText) }
        parts.append("Protein \(proteinHave) of \(proteinGoal) grams")
        return parts.joined(separator: ". ")
    }
}

/// "● ● ○ ○"-style row shared by the muscle and endurance heroes — the
/// completed dots colored with the accent, the planned-but-not-done dots
/// muted; unplanned days simply aren't part of the row at all (see
/// `MuscleHeroLogic.sessionsThisWeek`'s doc comment). Renders the same
/// `total` dots `MuscleHeroLogic.sessionDots(done:total:)` formats as text
/// (used for `accessibilityLabel`, never for this view's own visuals, since
/// a plain string can't carry per-dot color).
struct SessionDotsRow: View {
    let done: Int
    let total: Int

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<max(total, 0), id: \.self) { index in
                Circle()
                    .fill(index < done ? Theme.Colors.accentContent : Theme.Colors.textTertiary)
                    .frame(width: 6, height: 6)
            }
        }
        .accessibilityHidden(true) // the parent hero's combined label already states "N of M sessions"
    }
}
