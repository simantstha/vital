import XCTest
@testable import Vital

@MainActor
final class LogsPagerTests: XCTestCase {

    // MARK: - Test fixtures

    /// A fixed "today" — 2026-07-12 (Sunday), noon local time — so the 7-day
    /// window mapping is deterministic regardless of when the suite runs.
    private static let fixedToday: Date = {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 7; comps.day = 12
        comps.hour = 12
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal.date(from: comps)!
    }()

    private static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal
    }

    /// A `Date` `offsetFromToday` days before `fixedToday`, at `hour:minute`
    /// local time (defaults to noon, matching `fixedToday` itself).
    private func date(offsetFromToday: Int, hour: Int = 12, minute: Int = 0) -> Date {
        let cal = Self.calendar
        let day = cal.date(byAdding: .day, value: offsetFromToday, to: cal.startOfDay(for: Self.fixedToday))!
        return cal.date(bySettingHour: hour, minute: minute, second: 0, of: day)!
    }

    private func item(
        id: String = UUID().uuidString,
        type: String = "meal_logged",
        offsetFromToday: Int = 0,
        hour: Int = 12,
        minute: Int = 0,
        kcal: Double? = nil,
        km: Double? = nil,
        sleepMs: Double? = nil
    ) -> LogDisplayItem {
        let d = date(offsetFromToday: offsetFromToday, hour: hour, minute: minute)
        return LogDisplayItem(
            id: id,
            type: type,
            title: "Title",
            subtitle: "Subtitle",
            date: d,
            sfSymbol: "circle.fill",
            thumbnail: nil,
            meta: LogsPagerSummary.metaLabel(type: type, date: d),
            kcal: kcal,
            km: km,
            sleepMs: sleepMs
        )
    }

    // MARK: - bucketDays

    func testBucketDaysProducesSevenSlotsWithTodayYesterdayAndWeekdayLabels() {
        let items = [item(offsetFromToday: 0), item(offsetFromToday: -1)]

        let days = LogsPagerSummary.bucketDays(items: items, today: Self.fixedToday, calendar: Self.calendar)

        XCTAssertEqual(days.count, 7)
        XCTAssertEqual(days[0].label, "Today")
        XCTAssertEqual(days[1].label, "Yesterday")
        // 2026-07-12 is a Sunday, so 6 days back (offset -6) is Monday 2026-07-06.
        XCTAssertEqual(days[6].label, "Monday")
    }

    func testBucketDaysDropsItemsOutsideTheSevenDayWindow() {
        let items = [
            item(id: "old", offsetFromToday: -30),
            item(id: "future", offsetFromToday: 1),
            item(id: "in-window", offsetFromToday: -2),
        ]

        let days = LogsPagerSummary.bucketDays(items: items, today: Self.fixedToday, calendar: Self.calendar)

        let allIds = days.flatMap { $0.items.map(\.id) }
        XCTAssertEqual(allIds, ["in-window"])
    }

    func testBucketDaysKeepsEmptySlotsForDaysWithNoItems() {
        let items = [item(offsetFromToday: 0)]

        let days = LogsPagerSummary.bucketDays(items: items, today: Self.fixedToday, calendar: Self.calendar)

        XCTAssertEqual(days.count, 7)
        XCTAssertEqual(days[0].items.count, 1)
        for day in days[1...] {
            XCTAssertTrue(day.items.isEmpty)
        }
    }

    // MARK: - summaryLine

    func testSummaryLineReportsNoEntriesWhenEmpty() {
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: []), "No entries")
    }

    func testSummaryLineUsesSingularEntryForExactlyOneItem() {
        let items = [item()]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "1 entry")
    }

    func testSummaryLineUsesPluralEntriesForMultipleItems() {
        let items = [item(id: "a"), item(id: "b"), item(id: "c")]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "3 entries")
    }

    func testSummaryLineAppendsKcalWhenPresent() {
        let items = [item(id: "a", kcal: 640)]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "1 entry · 640 kcal")
    }

    func testSummaryLineAppendsKmWhenPresent() {
        let items = [item(id: "a", type: "workout_completed", km: 2.4)]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "1 entry · 2.4 km")
    }

    func testSummaryLineOrdersEntriesThenKcalThenKm() {
        let items = [
            item(id: "meal", kcal: 640),
            item(id: "walk", type: "workout_completed", km: 2.4),
        ]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "2 entries · 640 kcal · 2.4 km")
    }

    func testSummaryLineFallsBackToSleepOnlyWhenNoKcalOrKmPresent() {
        let items = [item(id: "a", type: "sleep_session", sleepMs: (6 * 3_600_000) + (6 * 60_000))]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "1 entry · 6h 6m sleep")
    }

    func testSummaryLineOmitsSleepWhenKcalOrKmAlreadyFired() {
        let items = [
            item(id: "meal", kcal: 300),
            item(id: "sleep", type: "sleep_session", sleepMs: 6 * 3_600_000),
        ]
        XCTAssertEqual(LogsPagerSummary.summaryLine(items: items), "2 entries · 300 kcal")
    }

    // MARK: - metaLabel

    func testMetaLabelIsAutoForSleepAndHRVTypesEvenWhenTimeIsInexact() {
        let d = date(offsetFromToday: 0)
        XCTAssertEqual(LogsPagerSummary.metaLabel(type: "sleep_session", date: d, hasExactTime: false), "auto")
        XCTAssertEqual(LogsPagerSummary.metaLabel(type: "hrv_reading", date: d, hasExactTime: false), "auto")
    }

    func testMetaLabelIsAbsoluteLocalTimeForExactWorkout() {
        let d = date(offsetFromToday: -1, hour: 19, minute: 41)
        let expectedFormatter: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "h:mm a"
            f.locale = Locale(identifier: "en_US")
            return f
        }()

        XCTAssertEqual(
            LogsPagerSummary.metaLabel(type: "workout_completed", date: d, hasExactTime: true),
            expectedFormatter.string(from: d)
        )
    }

    func testMetaLabelIsSyncedForInexactWorkout() {
        let d = date(offsetFromToday: -1, hour: 12)

        XCTAssertEqual(
            LogsPagerSummary.metaLabel(type: "workout_completed", date: d, hasExactTime: false),
            "Synced"
        )
    }

    func testMetaLabelRetainsLocalTimeWhenPrecisionFieldIsAbsent() {
        let d = date(offsetFromToday: -1, hour: 19, minute: 41)
        let expectedFormatter: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "h:mm a"
            f.locale = Locale(identifier: "en_US")
            return f
        }()

        XCTAssertEqual(
            LogsPagerSummary.metaLabel(type: "meal_logged", date: d),
            expectedFormatter.string(from: d)
        )
    }

    func testLogItemWithoutHasExactTimeDecodesForBackwardCompatibility() throws {
        let json = #"""
        {
          "id": "workout-1",
          "type": "workout_completed",
          "timestamp": "2026-07-11T19:41:00.000Z",
          "title": "Running",
          "subtitle": "Workout tracked",
          "imageThumb": null,
          "kcal": 420,
          "km": 5.2,
          "sleepMs": null
        }
        """#.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(LogItem.self, from: json)

        XCTAssertNil(decoded.hasExactTime)
    }

    // MARK: - dietDayData

    func testDietDayDataSumsMacrosAcrossMultipleEntries() {
        let goal = DietBudgetDTO(mode: "auto", goal: "general", targetKcal: 2014, protein: 150, carbs: 220, fat: 65, tdee: 2200)
        let entries = [
            MealLogEntryDTO(id: "1", name: "Lunch", kcal: 640, protein: 40, carbs: 60, fat: 20, slot: "lunch", loggedAt: "2026-07-11T12:00:00.000Z"),
            MealLogEntryDTO(id: "2", name: "Dinner", kcal: 640, protein: 46, carbs: 58, fat: 20, slot: "dinner", loggedAt: "2026-07-11T19:41:00.000Z"),
        ]

        let data = LogsPagerSummary.dietDayData(entries: entries, goal: goal)

        XCTAssertEqual(data.targetKcal, 2014)
        XCTAssertEqual(data.eatenKcal, 1280)
        XCTAssertEqual(data.remaining, 734)
        XCTAssertEqual(data.protein.current, 86)
        XCTAssertEqual(data.carbs.current, 118)
        XCTAssertEqual(data.fat.current, 40)
        XCTAssertEqual(data.protein.target, 150)
    }

    func testDietDayDataClampsRemainingAtZeroWhenEatenExceedsTarget() {
        let goal = DietBudgetDTO(mode: "auto", goal: "general", targetKcal: 1000, protein: 100, carbs: 100, fat: 50, tdee: 1800)
        let entries = [
            MealLogEntryDTO(id: "1", name: "Feast", kcal: 1500, protein: 80, carbs: 200, fat: 60, slot: nil, loggedAt: "2026-07-11T12:00:00.000Z"),
        ]

        let data = LogsPagerSummary.dietDayData(entries: entries, goal: goal)

        XCTAssertEqual(data.eatenKcal, 1500)
        XCTAssertEqual(data.remaining, 0)
    }
}
