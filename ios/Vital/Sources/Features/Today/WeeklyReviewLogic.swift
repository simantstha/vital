import SwiftUI

/// Pure decisions + copy for the Weekly Review card (Today), the detail sheet
/// and the Trends row (v5 Wave 3, docs/roadmap-v5-goal-progress.md). No view
/// code here so it is unit-testable (`WeeklyReviewLogicTests`). Verdict
/// tones come from `GoalProgressLogic`; the pill wording is week-scoped.
enum WeeklyReviewLogic {

    // MARK: - When the Today card shows

    /// The Today card is a Monday-to-Wednesday moment: the review's week
    /// ended on the Sunday before, so it shows from 1 to 3 days after
    /// `weekEnd`. After that it lives in Trends only.
    static let cardWindowDays = 1...3

    /// `ignoreWindow` is for the screenshot harness, where the wall clock is
    /// arbitrary (never set in a real build).
    static func shouldShowCard(
        _ response: WeeklyReviewResponse?,
        now: Date,
        calendar: Calendar = .current,
        ignoreWindow: Bool = false
    ) -> Bool {
        guard let response, !response.isSeen else { return false }
        // A "log a bit more" nudge isn't a review: showing a card whose only
        // action leads to the same nudge is noise for a brand-new user. Trends'
        // row says when the first real review lands instead.
        guard !isNotEnoughData(response.review) else { return false }
        if ignoreWindow { return true }
        guard let ended = daysSinceWeekEnd(response.review, now: now, calendar: calendar) else { return false }
        return cardWindowDays.contains(ended)
    }

    /// Whole calendar days from the review's `weekEnd` (Sunday) to `now`, in
    /// the device calendar. `nil` when `weekEnd` isn't a "YYYY-MM-DD" date.
    static func daysSinceWeekEnd(_ review: WeeklyReviewDTO, now: Date, calendar: Calendar = .current) -> Int? {
        guard let end = date(fromDay: review.weekEnd, calendar: calendar) else { return nil }
        return calendar.dateComponents([.day], from: end, to: calendar.startOfDay(for: now)).day
    }

    /// True only in the DEBUG screenshot harness (fixture clock is arbitrary).
    static var windowBypassedForFixtures: Bool {
        #if DEBUG
        return FixtureMode.isActive
        #else
        return false
        #endif
    }

    // MARK: - Content decisions

    /// True when the server only had a "log a bit more" nudge: no stats grid,
    /// no verdict chip, no win/slip rows.
    static func isNotEnoughData(_ review: WeeklyReviewDTO) -> Bool {
        !review.sufficient || review.stats.isEmpty
    }

    /// The next Monday strictly after `now` (reviews are generated for the
    /// week that just ended, on Monday).
    static func nextMonday(after now: Date, calendar: Calendar = .current) -> Date {
        let weekday = calendar.component(.weekday, from: now) // Sunday = 1 ... Monday = 2
        var ahead = (2 - weekday + 7) % 7
        if ahead == 0 { ahead = 7 }
        let start = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: ahead, to: start) ?? start
    }

    /// Trends row subtitle while there isn't enough data: "First review on
    /// Mon Oct 12". Honest about timing — the review needs a few logged days
    /// in the week before it, so the copy says so.
    static func firstReviewText(now: Date, calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "EEE MMM d"
        return "First review on \(f.string(from: nextMonday(after: now, calendar: calendar))) — log a few days before then"
    }

    /// Week-scoped pill word. Deliberately NOT the goal-status vocabulary
    /// ("On track" etc.) so the weekly card's pill never looks identical to
    /// the goal pill elsewhere (persona review). `nil` when not enough data.
    ///
    /// The pill rates THE REVIEWED WEEK, so it comes from the server's
    /// `weekRating` (that week's own stats). The review's `verdict` is the
    /// 4-week goal verdict and must not drive it ("Sessions behind" over four
    /// weeks sits right above a "Good week" otherwise). Only reviews stored
    /// before `weekRating` existed fall back to the old verdict mapping; a
    /// review that carries the key — even as `null` ("can't rate this week") —
    /// never does, and shows no pill when there is no rating.
    static func verdictLabel(_ review: WeeklyReviewDTO) -> String? {
        guard !isNotEnoughData(review) else { return nil }
        if review.hasWeekRating { return review.weekRating.map { weekLabel(for: $0) } }
        return weekLabel(for: review.verdict)
    }

    static func weekLabel(for rating: WeekRating) -> String {
        switch rating {
        case .good:  return "Good week"
        case .mixed: return "Mixed week"
        case .tough: return "Tough week"
        case .light: return "Lighter week"
        }
    }

    /// Legacy mapping, used only for reviews without a `weekRating`.
    static func weekLabel(for verdict: GoalVerdict) -> String {
        switch verdict {
        case .onTrack, .ahead, .progressing, .building: return "Good week"
        case .behind, .holding:              return "Mixed week"
        case .stalled, .tooFast:             return "Tough week"
        case .needsTarget:                   return "Set a target"
        case .insufficientData:              return "Early days"
        }
    }

    /// Chip tint for the week pill: follows the same source as the label —
    /// good green, tough amber (never red: a slow week isn't a failure),
    /// mixed / lighter gray. Legacy reviews use the goal verdict's tone.
    static func tone(for review: WeeklyReviewDTO) -> GoalProgressLogic.Tone {
        guard review.hasWeekRating else { return GoalProgressLogic.tone(for: review.verdict) }
        switch review.weekRating {
        case .some(.good):  return .good
        case .some(.tough): return .watch
        case .some(.mixed), .some(.light), .none: return .neutral
        }
    }

    static func color(for tone: GoalReasonTone) -> Color {
        GoalProgressLogic.color(for: GoalProgressLogic.tone(for: tone))
    }

    /// "Sep 28 – Oct 4" (or "Dec 29 – Jan 4" across a year), nil when either
    /// day can't be parsed.
    static func rangeText(_ review: WeeklyReviewDTO, calendar: Calendar = .current) -> String? {
        guard let start = date(fromDay: review.weekStart, calendar: calendar),
              let end = date(fromDay: review.weekEnd, calendar: calendar) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "MMM d"
        return "\(f.string(from: start)) – \(f.string(from: end))"
    }

    /// The rows under the stats grid, in display order. A row with no text
    /// is omitted — never an empty "Win".
    enum RowKind: Equatable { case win, slip, next }

    struct Row: Equatable, Identifiable {
        let kind: RowKind
        let title: String
        let text: String
        var id: RowKind { kind }
    }

    static func rows(_ review: WeeklyReviewDTO) -> [Row] {
        var out: [Row] = []
        if !isNotEnoughData(review) {
            if let win = nonEmpty(review.win) { out.append(Row(kind: .win, title: "Win", text: win)) }
            if let slip = nonEmpty(review.slip) { out.append(Row(kind: .slip, title: "Slip", text: slip)) }
        }
        if let next = nonEmpty(review.nextWeek) {
            out.append(Row(kind: .next, title: isNotEnoughData(review) ? "To get started" : "Next week", text: next))
        }
        return out
    }

    static func rowIcon(_ kind: RowKind) -> String {
        switch kind {
        case .win:  return "checkmark.circle.fill"
        case .slip: return "exclamationmark.circle.fill"
        case .next: return "arrow.forward.circle.fill"
        }
    }

    static func rowColor(_ kind: RowKind) -> Color {
        switch kind {
        case .win:  return Theme.Colors.positive
        case .slip: return Theme.Colors.caution
        case .next: return Theme.Colors.accentContent
        }
    }

    /// One VoiceOver phrase per stat tile: "Days in budget, 5 of 7, 6 days logged".
    static func accessibilityLabel(for stat: WeeklyReviewStatDTO) -> String {
        let value = stat.value.replacingOccurrences(of: "/", with: " of ")
        if let comparison = nonEmpty(stat.comparison) { return "\(stat.label), \(value), \(comparison)" }
        return "\(stat.label), \(value)"
    }

    // MARK: - Helpers

    private static func nonEmpty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// "YYYY-MM-DD" -> start of that day in `calendar` (no DateFormatter, so a
    /// locale / calendar quirk can't shift the day).
    static func date(fromDay day: String, calendar: Calendar) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var comps = DateComponents()
        comps.year = parts[0]
        comps.month = parts[1]
        comps.day = parts[2]
        return calendar.date(from: comps).map { calendar.startOfDay(for: $0) }
    }
}
