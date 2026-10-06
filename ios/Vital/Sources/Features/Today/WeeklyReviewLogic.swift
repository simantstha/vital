import SwiftUI

/// Pure decisions + copy for the Weekly Review card (Today), the detail sheet
/// and the Trends row (v5 Wave 3, docs/roadmap-v5-goal-progress.md). No view
/// code here so it is unit-testable (`WeeklyReviewLogicTests`). Verdict
/// labels / tones come from `GoalProgressLogic` — one vocabulary app-wide.
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

    static func verdictLabel(_ review: WeeklyReviewDTO) -> String? {
        isNotEnoughData(review) ? nil : GoalProgressLogic.label(for: review.verdict)
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
