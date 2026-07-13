import Foundation
import EventKit

/// Pure mapping from calendar-event fields → `PlanItem` fields, and the
/// server/calendar merge for the Today plan timeline (Phase 8). Kept free of
/// `EventKit` types (takes plain values) so it's unit-testable without an
/// `EKEventStore` — see `Tests/CalendarPlanMappingTests.swift`. Mirrors the
/// house convention of a pure, testable helper enum alongside its feature
/// (`TrendsSummary`, `LogsPagerSummary`).
enum CalendarPlanMapping {

    struct PlanItemFields: Equatable {
        let id: String
        let timeMinutes: Int
        let title: String
        let subtitle: String
    }

    /// Builds the fields for a single (non-all-day) calendar event. Returns
    /// `nil` for all-day events — they don't anchor to a time-of-day slot in
    /// the timeline, so they're dropped rather than mis-plotted at midnight.
    static func planItemFields(
        eventIdentifier: String,
        title: String,
        start: Date,
        end: Date,
        isAllDay: Bool,
        calendarTitle: String?,
        calendar: Calendar = .current
    ) -> PlanItemFields? {
        guard !isAllDay else { return nil }

        return PlanItemFields(
            id: "cal-" + eventIdentifier,
            timeMinutes: minutesFromMidnight(start, calendar: calendar),
            title: title,
            subtitle: subtitle(start: start, end: end, calendarTitle: calendarTitle, calendar: calendar)
        )
    }

    /// Minutes elapsed since local midnight, e.g. 9:30 AM → 570.
    static func minutesFromMidnight(_ date: Date, calendar: Calendar = .current) -> Int {
        let comps = calendar.dateComponents([.hour, .minute], from: date)
        return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    }

    /// "H:MM AM–H:MM PM" time range (+ " · <calendar name>" appended only
    /// when the calendar's title is short enough not to crowd the row's
    /// single-line subtitle).
    static func subtitle(
        start: Date,
        end: Date,
        calendarTitle: String?,
        calendar: Calendar = .current
    ) -> String {
        let range = "\(timeLabel(start, calendar: calendar))\u{2013}\(timeLabel(end, calendar: calendar))"
        if let calendarTitle, !calendarTitle.isEmpty, calendarTitle.count <= 20 {
            return "\(range) · \(calendarTitle)"
        }
        return range
    }

    /// "9:30 AM"-style 12h label, matching `PlanItem.timeLabel`'s format.
    static func timeLabel(_ date: Date, calendar: Calendar = .current) -> String {
        let comps = calendar.dateComponents([.hour, .minute], from: date)
        let hour24 = comps.hour ?? 0
        let minute = comps.minute ?? 0
        let period = hour24 >= 12 ? "PM" : "AM"
        let hour12raw = hour24 % 12
        let hour12 = hour12raw == 0 ? 12 : hour12raw
        return String(format: "%d:%02d %@", hour12, minute, period)
    }

    // MARK: - Merge (server plan items ∪ calendar items)

    /// Merges server-tracked plan items with locally-fetched calendar items:
    /// drops hidden calendar ids (session-local removals — see
    /// `TodayViewModel.removeItem`), unions with the server items, and sorts
    /// by time-of-day. Pure, and independent of which source produced
    /// `serverItems` — safe to call after either the `/api/plan` path or the
    /// Phase 1 fallback resolves.
    static func merge(
        serverItems: [PlanItem],
        calendarItems: [PlanItem],
        hiddenCalendarItemIDs: Set<String>
    ) -> [PlanItem] {
        let visibleCalendarItems = calendarItems.filter { !hiddenCalendarItemIDs.contains($0.id) }
        return (serverItems + visibleCalendarItems).sorted { $0.timeMinutes < $1.timeMinutes }
    }
}

/// Read-only EventKit access for merging today's calendar into the plan
/// timeline (Phase 8). Wraps a single `EKEventStore`; events are only ever
/// read on-device and mapped into `PlanItem`s here — never sent to the
/// backend (privacy decision, `docs/redesign-v3-plan.md` §4.5). Access is
/// never requested automatically; `TodayViewModel.syncCalendar()` only calls
/// `requestAccess()` in response to an explicit user tap.
@MainActor
final class CalendarEventsProvider {

    private let store = EKEventStore()

    /// Current authorization for calendar (event) read access.
    var authorizationStatus: EKAuthorizationStatus {
        EKEventStore.authorizationStatus(for: .event)
    }

    /// Requests full calendar read access (iOS 17+ API — deployment target
    /// is iOS 26). Returns whether access was granted.
    func requestAccess() async -> Bool {
        do {
            return try await store.requestFullAccessToEvents()
        } catch {
            print("[Vital] EKEventStore.requestFullAccessToEvents failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Fetches the local calendar day containing `now`, skipping all-day and
    /// declined events, and maps each remaining event to a `PlanItem`.
    /// Returns `[]` when not authorized — callers should still gate on
    /// `authorizationStatus` themselves to decide whether to show the "Sync
    /// your calendar" affordance.
    func fetchTodayPlanItems(now: Date = Date()) -> [PlanItem] {
        guard authorizationStatus == .fullAccess else { return [] }

        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: now)
        guard let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay) else { return [] }

        let predicate = store.predicateForEvents(withStart: startOfDay, end: endOfDay, calendars: nil)
        let events = store.events(matching: predicate)

        return events.compactMap { event -> PlanItem? in
            guard event.status != .canceled else { return nil }
            // Cheap declined-event check — attendee data is already bundled
            // with events fetched via the predicate above, no extra fetch.
            if let attendees = event.attendees,
               let selfAttendee = attendees.first(where: { $0.isCurrentUser }),
               selfAttendee.participantStatus == .declined {
                return nil
            }

            guard let fields = CalendarPlanMapping.planItemFields(
                eventIdentifier: event.eventIdentifier ?? event.calendarItemIdentifier,
                title: event.title?.isEmpty == false ? event.title! : "Untitled event",
                start: event.startDate,
                end: event.endDate,
                isAllDay: event.isAllDay,
                calendarTitle: event.calendar?.title
            ) else { return nil }

            return PlanItem(
                id: fields.id,
                timeMinutes: fields.timeMinutes,
                title: fields.title,
                subtitle: fields.subtitle,
                sfSymbol: "calendar",
                status: .later, // TodayViewModel.computeStatuses fixes this from the clock
                source: .calendar,
                kind: .other
            )
        }
    }
}
