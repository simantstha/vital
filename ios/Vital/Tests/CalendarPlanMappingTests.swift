import XCTest
@testable import Vital

final class CalendarPlanMappingTests: XCTestCase {

    // MARK: - Test fixtures

    private var calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    /// 2026-07-13 at the given hour/minute, UTC — deterministic regardless of
    /// where the test suite runs.
    private func time(_ hour: Int, _ minute: Int = 0) -> Date {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 7; comps.day = 13
        comps.hour = hour; comps.minute = minute
        comps.timeZone = calendar.timeZone
        return calendar.date(from: comps)!
    }

    // MARK: - planItemFields

    func testPlanItemFieldsMapsATimedEvent() {
        let fields = CalendarPlanMapping.planItemFields(
            eventIdentifier: "abc123",
            title: "Team sync",
            start: time(9, 30),
            end: time(10, 0),
            isAllDay: false,
            calendarTitle: nil,
            calendar: calendar
        )

        XCTAssertNotNil(fields)
        XCTAssertEqual(fields?.id, "cal-abc123")
        XCTAssertEqual(fields?.timeMinutes, 9 * 60 + 30)
        XCTAssertEqual(fields?.title, "Team sync")
        XCTAssertEqual(fields?.subtitle, "9:30 AM\u{2013}10:00 AM")
    }

    func testPlanItemFieldsReturnsNilForAllDayEvents() {
        let fields = CalendarPlanMapping.planItemFields(
            eventIdentifier: "abc123",
            title: "Company holiday",
            start: time(0, 0),
            end: time(23, 59),
            isAllDay: true,
            calendarTitle: nil,
            calendar: calendar
        )

        XCTAssertNil(fields)
    }

    // MARK: - minutesFromMidnight

    func testMinutesFromMidnightAtMidnightIsZero() {
        XCTAssertEqual(CalendarPlanMapping.minutesFromMidnight(time(0, 0), calendar: calendar), 0)
    }

    func testMinutesFromMidnightForAfternoonTime() {
        // 2:15 PM = 14:15 = 855 minutes
        XCTAssertEqual(CalendarPlanMapping.minutesFromMidnight(time(14, 15), calendar: calendar), 855)
    }

    // MARK: - subtitle formatting

    func testSubtitleFormatsPlainTimeRangeWithoutCalendarName() {
        let subtitle = CalendarPlanMapping.subtitle(
            start: time(9, 0),
            end: time(9, 30),
            calendarTitle: nil,
            calendar: calendar
        )
        XCTAssertEqual(subtitle, "9:00 AM\u{2013}9:30 AM")
    }

    func testSubtitleAppendsShortCalendarName() {
        let subtitle = CalendarPlanMapping.subtitle(
            start: time(9, 0),
            end: time(9, 30),
            calendarTitle: "Work",
            calendar: calendar
        )
        XCTAssertEqual(subtitle, "9:00 AM\u{2013}9:30 AM · Work")
    }

    func testSubtitleOmitsLongCalendarName() {
        let subtitle = CalendarPlanMapping.subtitle(
            start: time(9, 0),
            end: time(9, 30),
            calendarTitle: "A very long shared family calendar name",
            calendar: calendar
        )
        XCTAssertEqual(subtitle, "9:00 AM\u{2013}9:30 AM")
    }

    func testSubtitleOmitsEmptyCalendarName() {
        let subtitle = CalendarPlanMapping.subtitle(
            start: time(9, 0),
            end: time(9, 30),
            calendarTitle: "",
            calendar: calendar
        )
        XCTAssertEqual(subtitle, "9:00 AM\u{2013}9:30 AM")
    }

    func testSubtitleCrossesNoonBoundary() {
        let subtitle = CalendarPlanMapping.subtitle(
            start: time(11, 45),
            end: time(12, 15),
            calendarTitle: nil,
            calendar: calendar
        )
        XCTAssertEqual(subtitle, "11:45 AM\u{2013}12:15 PM")
    }

    // MARK: - merge

    private func planItem(id: String, minutes: Int, source: PlanItem.Source = .coach) -> PlanItem {
        PlanItem(
            id: id,
            timeMinutes: minutes,
            title: id,
            subtitle: "",
            sfSymbol: "circle",
            status: .later,
            source: source,
            kind: .other
        )
    }

    func testMergeSortsServerAndCalendarItemsByTime() {
        let server = [planItem(id: "server-late", minutes: 20 * 60)]
        let calendarItems = [planItem(id: "cal-early", minutes: 8 * 60, source: .calendar)]

        let merged = CalendarPlanMapping.merge(
            serverItems: server,
            calendarItems: calendarItems,
            hiddenCalendarItemIDs: []
        )

        XCTAssertEqual(merged.map(\.id), ["cal-early", "server-late"])
    }

    func testMergeDropsHiddenCalendarItems() {
        let server = [planItem(id: "server-1", minutes: 9 * 60)]
        let calendarItems = [
            planItem(id: "cal-visible", minutes: 10 * 60, source: .calendar),
            planItem(id: "cal-hidden", minutes: 11 * 60, source: .calendar),
        ]

        let merged = CalendarPlanMapping.merge(
            serverItems: server,
            calendarItems: calendarItems,
            hiddenCalendarItemIDs: ["cal-hidden"]
        )

        XCTAssertEqual(merged.map(\.id), ["server-1", "cal-visible"])
    }

    func testMergeProducesNoDuplicatesWhenCalendarListIsEmpty() {
        let server = [planItem(id: "server-1", minutes: 9 * 60), planItem(id: "server-2", minutes: 10 * 60)]

        let merged = CalendarPlanMapping.merge(
            serverItems: server,
            calendarItems: [],
            hiddenCalendarItemIDs: []
        )

        XCTAssertEqual(merged.map(\.id), ["server-1", "server-2"])
    }

    func testMergeReturnsEmptyWhenBothSourcesAreEmpty() {
        let merged = CalendarPlanMapping.merge(serverItems: [], calendarItems: [], hiddenCalendarItemIDs: [])
        XCTAssertTrue(merged.isEmpty)
    }
}
