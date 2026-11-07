import SwiftUI

/// Today's endurance goal context, now a flat block (no card): the race line,
/// a rest-day note when nothing is planned, the readiness-vs-plan
/// reconciliation, and the "this week" row. The readiness WORD is the page
/// title and the reason line is the recovery strip, so neither is repeated
/// here (only the "Calibrating" override still renders). Today's session is
/// the first stop of the "Rest of today" timeline. Weekly volume and the
/// session dots are fed by `GET /api/training/summary` (#202,
/// `TodayViewModel.trainingSummary`) and hidden whenever that data is absent
/// — never fabricated (P4). Renders nothing when it has nothing to say.
struct EnduranceHeroView: View {
    /// "Calibrating · day X of 14" — `nil` once calibrated. While it is set
    /// the page title stays the greeting (no readiness word from possibly
    /// ungated verdicts), so this line is the only readiness-ish text.
    let calibratingText: String?
    /// "Half marathon · 12 weeks to go · long run 14/18 km" — only when a race
    /// is set (the long-run tail only when the race has a long-run target).
    var raceText: String? = nil
    /// True while the race line is still loading (goal progress pending, race
    /// not ruled out): reserves exactly one line of height so the block doesn't
    /// jump when the race text arrives. Ignored once `raceText` is set, and
    /// never makes an otherwise-empty block render.
    var reserveRaceLine = false

    /// Today's move-kind plan item, or `nil` for a rest day (the rest-day note
    /// shows only then; a session lives in the timeline below).
    let session: PlanItem?
    /// Done/total for the "● ● ○ ○" dot row — same rule and source data as
    /// the muscle hero (`TodayViewModel.trainingSessionDots`).
    var sessionDots: (done: Int, total: Int)? = nil
    /// Combined "3 sessions · 24.5 km this week" line — combines both
    /// sessions and weekly volume into one display. `nil` hides the line.
    var weeklyOverviewText: String? = nil
    /// "24.5 of 30 km this week" + bar fraction (0...1) — only when the user
    /// has a weekly distance target and a measured distance (the same text the
    /// goal card/sheet shows). `nil` hides the bar.
    var distanceProgress: (text: String, fraction: Double)? = nil

    /// "Your body says recover — swap to an easy 30 min or rest?" — shown
    /// under a hard planned session when readiness says to back off. `nil`
    /// hides it.
    var reconciliationText: String? = nil
    var onTapReconciliation: () -> Void = {}

    /// Today's session when the "Rest of today" timeline no longer lists it
    /// (done, or past its time window) — `EnduranceHeroLogic.sessionOutsideTimeline`.
    /// `nil` hides the row.
    var sessionOutsideTimeline: PlanItem? = nil
    var onTapSession: (PlanItem) -> Void = { _ in }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var showsWeekRow: Bool {
        sessionDots != nil || weeklyOverviewText != nil || distanceProgress != nil
    }

    private var hasContent: Bool {
        EnduranceHeroLogic.hasHeroContent(
            calibratingText: calibratingText, raceText: raceText, hasSession: session != nil,
            reconciliationText: reconciliationText, hasWeekRow: showsWeekRow,
            sessionOutsideTimeline: sessionOutsideTimeline
        )
    }

    var body: some View {
        if hasContent {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if let raceText {
                    Text(raceText)
                        .scaledFont(size: 12, weight: .semibold)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        // One line, like the blank line reserved for it: the
                        // long-run tail makes this the longest string here, so
                        // it shrinks a little before it ever truncates.
                        // Accessibility text sizes get a second line instead —
                        // shrinking 75% of an AX size still truncates.
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .minimumScaleFactor(dynamicTypeSize.isAccessibilitySize ? 1 : 0.75)
                        .accessibilityIdentifier("today.raceCountdown")
                } else if reserveRaceLine {
                    // Same font as the race line, so the blank line is exactly as tall.
                    Text(" ")
                        .scaledFont(size: 12, weight: .semibold)
                        .accessibilityHidden(true)
                }

                if let calibratingText {
                    Text(calibratingText)
                        .scaledFont(Theme.Typography.bodyMedium.weight(.semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }

                if session == nil {
                    Text(EnduranceHeroLogic.restDayText)
                        .scaledFont(Theme.Typography.bodyMedium.weight(.semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }

                if let reconciliationText {
                    Button(action: onTapReconciliation) {
                        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
                            Text(reconciliationText)
                                .scaledFont(size: 13)
                                .foregroundStyle(Theme.Colors.caution)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: "bubble.left")
                                .scaledFont(size: 12, weight: .semibold)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the coach")
                    .accessibilityIdentifier("today.enduranceHero.reconcile")
                }

                if let sessionOutsideTimeline {
                    sessionRow(sessionOutsideTimeline)
                }

                if showsWeekRow {
                    weekRow
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
        }
    }

    /// Today's session, shown here only when the timeline has dropped it.
    @ViewBuilder
    private func sessionRow(_ item: PlanItem) -> some View {
        let trailing = item.status == .done ? "Done" : item.timeLabel
        Button {
            onTapSession(item)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Image(systemName: "figure.run")
                    .scaledFont(size: 15, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text(item.title)
                    .scaledFont(size: 15, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(trailing)
                    .scaledFont(size: 13)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .monospacedDigit()
                Image(systemName: "chevron.right")
                    .scaledFont(size: 12, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.title), \(trailing)")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("today.enduranceHero.session")
    }

    /// Dot row (if plan data exists) or combined overview line.
    @ViewBuilder
    private var weekRow: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if let distanceProgress {
                Text(distanceProgress.text)
                    .scaledFont(size: 14, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .monospacedDigit()
                    .accessibilityIdentifier("today.enduranceHero.distanceText")
                VitalProgressBar(fraction: distanceProgress.fraction, tint: Theme.Colors.textPrimary, height: 6)
            }
            AccessibilityAdaptiveStack(spacing: Theme.Spacing.sm, stackedSpacing: Theme.Spacing.xs) {
                if let sessionDots {
                    SessionDotsRow(done: sessionDots.done, total: sessionDots.total)
                }
                if let weeklyOverviewText {
                    Text(weeklyOverviewText)
                        .scaledFont(size: 12)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .monospacedDigit()
                }
            }
        }
        .accessibilityIdentifier("today.enduranceHero.weekRow")
    }
}

extension EnduranceHeroLogic {
    /// Whether `EnduranceHeroView` has anything to draw. A rest day always has
    /// its note, so the block is only empty on a planned day with no race,
    /// calibration line, reconciliation or week row. `TodayView` asks this
    /// first so an empty block leaves no gap in the stack.
    static func hasHeroContent(
        calibratingText: String?, raceText: String?, hasSession: Bool,
        reconciliationText: String?, hasWeekRow: Bool,
        sessionOutsideTimeline: PlanItem? = nil
    ) -> Bool {
        raceText != nil || calibratingText != nil || !hasSession
            || reconciliationText != nil || hasWeekRow || sessionOutsideTimeline != nil
    }

    /// Today's session when it is no longer in the "Rest of today" timeline
    /// (`upcoming`), or `nil` when there is no session or the timeline already
    /// shows it. Done and past-window sessions are dropped from `upcoming`, so
    /// this is how they stay visible on the hero.
    static func sessionOutsideTimeline(session: PlanItem?, upcoming: [PlanItem]) -> PlanItem? {
        guard let session, !upcoming.contains(where: { $0.id == session.id }) else { return nil }
        return session
    }
}
