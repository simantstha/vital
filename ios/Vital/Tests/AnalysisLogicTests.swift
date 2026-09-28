import XCTest
@testable import Vital

/// Coverage for `AnalysisLogic` — all decision/formatting logic behind the
/// redesigned `AnalysisView` (analysis-v2-contract.md §2). Every assertion
/// either compares against a value built with the SAME formatter the logic
/// under test uses, or a fixed-format helper, never a hardcoded
/// locale-shaped string — CI runs en_US, but this must not accidentally
/// depend on it.
final class AnalysisLogicTests: XCTestCase {

    // MARK: - Distance chip

    func testDistanceChipWithinToleranceReadsUsual() {
        let chip = AnalysisLogic.distanceChip(distanceM: 10_100, usualDistanceM: 10_000, unit: .metric)
        XCTAssertEqual(chip, .init(text: "usual", tone: .neutral))
    }

    func testDistanceChipAboveUsualIsNeutralWithPlusSign() {
        let chip = AnalysisLogic.distanceChip(distanceM: 11_400, usualDistanceM: 10_000, unit: .metric)
        XCTAssertEqual(chip.tone, .neutral)
        XCTAssertEqual(chip.text, "+1.4 km")
    }

    func testDistanceChipBelowUsualUsesMinusSign() {
        let chip = AnalysisLogic.distanceChip(distanceM: 8_000, usualDistanceM: 10_000, unit: .metric)
        XCTAssertEqual(chip.text, "\u{2212}2 km")
    }

    func testDistanceChipImperial() {
        let chip = AnalysisLogic.distanceChip(distanceM: 11_400, usualDistanceM: 10_000, unit: .imperial)
        XCTAssertTrue(chip.text.hasSuffix("mi"), "expected a mi-suffixed chip, got \(chip.text)")
        XCTAssertFalse(chip.text.contains("vs usual"), "stats-row chips use the short form, got \(chip.text)")
    }

    // MARK: - Pace chip

    func testPaceChipWithinToleranceReadsUsual() {
        let chip = AnalysisLogic.paceChip(paceMinPerKm: 5.85, usualPaceMinPerKm: 5.90)
        XCTAssertEqual(chip, .init(text: "usual", tone: .neutral))
    }

    func testPaceChipFasterIsGoodTone() {
        // 5:07/km vs a 5:19/km usual — 12s faster.
        let chip = AnalysisLogic.paceChip(paceMinPerKm: 5.0 + 7.0 / 60.0, usualPaceMinPerKm: 5.0 + 19.0 / 60.0)
        XCTAssertEqual(chip.tone, .good)
        XCTAssertEqual(chip.text, "12 s faster")
    }

    func testPaceChipSlowerIsWatchTone() {
        let chip = AnalysisLogic.paceChip(paceMinPerKm: 6.0, usualPaceMinPerKm: 5.5)
        XCTAssertEqual(chip.tone, .watch)
        XCTAssertEqual(chip.text, "30 s slower")
    }

    // MARK: - Avg HR chip

    func testAvgHrChipWithinToleranceReadsUsual() {
        let chip = AnalysisLogic.avgHrChip(avgHr: 145, usualAvgHr: 148)
        XCTAssertEqual(chip.text, "usual")
    }

    func testAvgHrChipDeltaIsNeutral() {
        let chip = AnalysisLogic.avgHrChip(avgHr: 158, usualAvgHr: 140)
        XCTAssertEqual(chip.tone, .neutral)
        XCTAssertEqual(chip.text, "+18 bpm")
    }

    // MARK: - Pace rank phrase

    func testPaceRankPhraseFastest() {
        XCTAssertEqual(AnalysisLogic.paceRankPhrase(rank: 1, previousCount: 7), "Quickest of your last 8 runs.")
    }

    func testPaceRankPhraseSlowest() {
        XCTAssertEqual(AnalysisLogic.paceRankPhrase(rank: 8, previousCount: 7), "Slowest of your last 8 runs.")
    }

    func testPaceRankPhraseMiddle() {
        XCTAssertEqual(AnalysisLogic.paceRankPhrase(rank: 3, previousCount: 7), "3rd fastest of your last 8 runs.")
        XCTAssertEqual(AnalysisLogic.paceRankPhrase(rank: 2, previousCount: 9), "2nd fastest of your last 10 runs.")
        XCTAssertEqual(AnalysisLogic.paceRankPhrase(rank: 11, previousCount: 19), "11th fastest of your last 20 runs.")
    }

    // MARK: - Effort zone

    func testEffortZoneLabels() {
        XCTAssertEqual(AnalysisLogic.effortZoneLabel("easy"), "Easy")
        XCTAssertEqual(AnalysisLogic.effortZoneLabel("steady"), "Steady")
        XCTAssertEqual(AnalysisLogic.effortZoneLabel("hard"), "Hard")
        XCTAssertEqual(AnalysisLogic.effortZoneLabel("max"), "Max")
    }

    func testHeartRateRangeFractionClampsToUnitRange() {
        XCTAssertEqual(AnalysisLogic.heartRateRangeFraction(52, restingHr: 52, maxHr: 188), 0, accuracy: 0.0001)
        XCTAssertEqual(AnalysisLogic.heartRateRangeFraction(188, restingHr: 52, maxHr: 188), 1, accuracy: 0.0001)
        XCTAssertEqual(AnalysisLogic.heartRateRangeFraction(30, restingHr: 52, maxHr: 188), 0, accuracy: 0.0001)
        XCTAssertEqual(AnalysisLogic.heartRateRangeFraction(220, restingHr: 52, maxHr: 188), 1, accuracy: 0.0001)
        // 158 of a 52–188 range: (158-52)/(188-52) = 106/136
        XCTAssertEqual(AnalysisLogic.heartRateRangeFraction(158, restingHr: 52, maxHr: 188), 106.0 / 136.0, accuracy: 0.0001)
    }

    // MARK: - Recovery chip

    func testRecoveryChipHrvAboveIsGood() {
        let chip = AnalysisLogic.recoveryChip(value: 64, unit: "ms", vsNormal: "above", metric: .hrv)
        XCTAssertEqual(chip.tone, .good)
        XCTAssertEqual(chip.text, "64 ms · above normal")
    }

    func testRecoveryChipHrvBelowIsWatch() {
        let chip = AnalysisLogic.recoveryChip(value: 48, unit: "ms", vsNormal: "below", metric: .hrv)
        XCTAssertEqual(chip.tone, .watch)
        XCTAssertEqual(chip.text, "48 ms · below normal")
    }

    func testRecoveryChipRestingHrAboveIsWatch() {
        let chip = AnalysisLogic.recoveryChip(value: 58, unit: "bpm", vsNormal: "above", metric: .restingHr)
        XCTAssertEqual(chip.tone, .watch)
    }

    func testRecoveryChipRestingHrBelowIsGood() {
        let chip = AnalysisLogic.recoveryChip(value: 48, unit: "bpm", vsNormal: "below", metric: .restingHr)
        XCTAssertEqual(chip.tone, .good)
    }

    func testRecoveryChipNormalIsNeutral() {
        let chip = AnalysisLogic.recoveryChip(value: 64, unit: "ms", vsNormal: "normal", metric: .hrv)
        XCTAssertEqual(chip.tone, .neutral)
        XCTAssertEqual(chip.text, "64 ms · normal")
    }

    func testRecoveryChipNoBaselineOmitsComparison() {
        let chip = AnalysisLogic.recoveryChip(value: 64, unit: "ms", vsNormal: nil, metric: .hrv)
        XCTAssertEqual(chip.tone, .neutral)
        XCTAssertEqual(chip.text, "64 ms")
    }

    // MARK: - Sleep usual chip

    func testSleepUsualChipWithinToleranceReadsUsual() {
        let chip = AnalysisLogic.sleepUsualChip(minutes: 465, usualMinutes: 460)
        XCTAssertEqual(chip.text, "usual")
    }

    func testSleepUsualChipUnderIsWatch() {
        // 5h48m (348) vs a 7h20m (440) usual = 1h32m under.
        let chip = AnalysisLogic.sleepUsualChip(minutes: 348, usualMinutes: 440)
        XCTAssertEqual(chip.tone, .watch)
        XCTAssertEqual(chip.text, "1h 32m under your usual")
    }

    func testSleepUsualChipOverIsNeutral() {
        let chip = AnalysisLogic.sleepUsualChip(minutes: 500, usualMinutes: 440)
        XCTAssertEqual(chip.tone, .neutral)
        XCTAssertEqual(chip.text, "1h 0m over your usual")
    }

    // MARK: - Sleep stage tone

    func testSleepStageToneDeepBelow75PercentIsWatch() {
        XCTAssertEqual(AnalysisLogic.sleepStageTone(.deep, minutes: 42, usualMinutes: 70), .watch)
    }

    func testSleepStageToneDeepAt75PercentIsNeutral() {
        XCTAssertEqual(AnalysisLogic.sleepStageTone(.deep, minutes: 52.5, usualMinutes: 70), .neutral)
    }

    func testSleepStageToneRemBelow75PercentIsWatch() {
        XCTAssertEqual(AnalysisLogic.sleepStageTone(.rem, minutes: 64, usualMinutes: 92), .watch)
    }

    func testSleepStageToneAwakeOver150PercentIsWatch() {
        XCTAssertEqual(AnalysisLogic.sleepStageTone(.awake, minutes: 38, usualMinutes: 14), .watch)
    }

    func testSleepStageToneAwakeAt150PercentIsNeutral() {
        XCTAssertEqual(AnalysisLogic.sleepStageTone(.awake, minutes: 21, usualMinutes: 14), .neutral)
    }

    func testSleepStageToneCoreIsAlwaysNeutral() {
        XCTAssertEqual(AnalysisLogic.sleepStageTone(.core, minutes: 10, usualMinutes: 400), .neutral)
    }

    func testSleepStageBarFractionScalesToLargerOfTheTwo() {
        // usual (70) is the larger value here, so 42/(70*1.15) is the bar fraction.
        let fraction = AnalysisLogic.sleepStageBarFraction(minutes: 42, usualMinutes: 70)
        XCTAssertEqual(fraction, 42.0 / (70.0 * 1.15), accuracy: 0.0001)
    }

    func testSleepStageUsualTickFractionIsOneWhenUsualIsTheLarger() {
        let fraction = AnalysisLogic.sleepStageUsualTickFraction(minutes: 42, usualMinutes: 70)
        XCTAssertEqual(fraction, 70.0 / (70.0 * 1.15), accuracy: 0.0001)
    }

    // MARK: - Week strip layout

    func testWeekStripLayoutHeightsAndGoalLine() {
        let nights: [(date: String, minutes: Double)] = [
            ("2026-09-21", 402), ("2026-09-22", 420), ("2026-09-23", 390),
            ("2026-09-24", 432), ("2026-09-25", 408), ("2026-09-26", 414),
            ("2026-09-27", 348),
        ]
        let layout = AnalysisLogic.weekStripLayout(nights: nights, goalMinutes: 450, today: "2026-09-27")
        XCTAssertEqual(layout.bars.count, 7)
        let scale = 450.0 * 1.1 // goal is the max of (max minutes=432, goal=450)
        XCTAssertEqual(layout.bars[0].heightFraction, 402.0 / scale, accuracy: 0.0001)
        XCTAssertEqual(layout.goalLineFraction, 450.0 / scale, accuracy: 0.0001)
        XCTAssertTrue(layout.bars.last!.isToday)
        XCTAssertFalse(layout.bars.first!.isToday)
    }

    func testWeekStripLayoutOmittedNightsShrinkTheBarCount() {
        let nights: [(date: String, minutes: Double)] = [("2026-09-27", 400)]
        let layout = AnalysisLogic.weekStripLayout(nights: nights, goalMinutes: 450, today: "2026-09-27")
        XCTAssertEqual(layout.bars.count, 1)
    }

    func testWeekdayLetterIsLocaleIndependent() {
        // 2026-09-27 is a Sunday.
        XCTAssertEqual(AnalysisLogic.weekdayLetter("2026-09-27"), "S")
        // 2026-09-23 is a Wednesday.
        XCTAssertEqual(AnalysisLogic.weekdayLetter("2026-09-23"), "W")
    }

    // MARK: - Kickers

    func testWorkoutKickerActivityMapping() {
        XCTAssertEqual(AnalysisLogic.workoutKickerActivity(type: "Running"), "RUN")
        XCTAssertEqual(AnalysisLogic.workoutKickerActivity(type: "Cycling"), "RIDE")
        XCTAssertEqual(AnalysisLogic.workoutKickerActivity(type: "Yoga"), "YOGA")
    }

    /// The default `locale` these tests pass explicitly everywhere below —
    /// determinism belongs in the tests, not in production (which defaults
    /// to `.current`, the device's own locale, so a 24-hour-time user sees
    /// "19:41", not "7:41 PM").
    private static let posixLocale = Locale(identifier: "en_US_POSIX")

    func testWorkoutKickerMatchesItsOwnFormatterAndIsFullyUppercased() {
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 26
        components.hour = 7; components.minute = 41
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let date = calendar.date(from: components)!

        let kicker = AnalysisLogic.workoutKicker(
            type: "Running", startTime: date, timeZone: calendar.timeZone, locale: Self.posixLocale
        )
        // Built with the exact same building blocks the logic under test
        // uses (a weekday formatter + the system short time style, both
        // pinned to en_US_POSIX explicitly here), never a hardcoded
        // "RUN · SAT 7:41 AM" — locale-independent because the test pins
        // the locale, not because production does.
        let df = DateFormatter()
        df.locale = Self.posixLocale
        df.timeZone = calendar.timeZone
        df.dateFormat = "EEE"
        let time = date.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened, locale: Self.posixLocale, calendar: .current, timeZone: calendar.timeZone)
        )
        XCTAssertEqual(kicker, "RUN · \(df.string(from: date)) \(time)".uppercased())
        // #249 polish: the kicker is fully uppercased, not just the activity word.
        XCTAssertEqual(kicker, kicker.uppercased())
    }

    func testSleepKickerFormatIsFullyUppercased() {
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 26
        components.hour = 23; components.minute = 52
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let bed = calendar.date(from: components)!
        components.day = 27; components.hour = 6; components.minute = 10
        let wake = calendar.date(from: components)!

        let df = DateFormatter()
        df.locale = Self.posixLocale
        df.timeZone = calendar.timeZone
        df.dateFormat = "EEE"
        let expected = "LAST NIGHT · \(df.string(from: bed)) \u{2192} \(df.string(from: wake))".uppercased()
        let kicker = AnalysisLogic.sleepKicker(bedTime: bed, wakeTime: wake, timeZone: calendar.timeZone, locale: Self.posixLocale)
        XCTAssertEqual(kicker, expected)
        XCTAssertEqual(kicker, kicker.uppercased())
    }

    func testClockTimeUsesSystemShortTimeStyle() {
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 26
        components.hour = 23; components.minute = 52
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = calendar.date(from: components)!

        // Built with the exact same `Date.FormatStyle` the logic under
        // test uses, with the test pinning en_US_POSIX explicitly —
        // locale-independent because the test controls the locale.
        let expected = date.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened, locale: Self.posixLocale, calendar: .current, timeZone: calendar.timeZone)
        )
        XCTAssertEqual(AnalysisLogic.clockTime(date, timeZone: calendar.timeZone, locale: Self.posixLocale), expected)
    }

    /// Production `clockTime` defaults `locale` to `.current` (the device's
    /// own), which is the whole point: a user in a 24-hour-time locale must
    /// see "19:41", never a 12-hour "7:41 PM" forced on them. This asserts
    /// that behavior directly for two real 24-hour locales, building the
    /// expectation with the same `Date.FormatStyle` rather than a
    /// hardcoded string.
    func testClockTimeRespectsA24HourLocaleAndShowsNoAmPm() {
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 26
        components.hour = 19; components.minute = 41
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = calendar.date(from: components)!

        for identifier in ["en_GB", "de_DE"] {
            let locale = Locale(identifier: identifier)
            let expected = date.formatted(
                Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: .current, timeZone: calendar.timeZone)
            )
            let actual = AnalysisLogic.clockTime(date, timeZone: calendar.timeZone, locale: locale)
            XCTAssertEqual(actual, expected, "locale \(identifier)")
            XCTAssertFalse(actual.uppercased().contains("AM"), "\(identifier) is a 24-hour locale and should show no AM/PM, got '\(actual)'")
            XCTAssertFalse(actual.uppercased().contains("PM"), "\(identifier) is a 24-hour locale and should show no AM/PM, got '\(actual)'")
        }
    }

    func testClockTimeAndWorkoutKickerAgreeOnTheSameTimeFormat() {
        // #249 polish: one time format everywhere — the kicker's embedded
        // time must be exactly `clockTime`'s output (just uppercased along
        // with the rest of the kicker), not a separately-formatted value.
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 26
        components.hour = 7; components.minute = 41
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let date = calendar.date(from: components)!

        let kicker = AnalysisLogic.workoutKicker(
            type: "Running", startTime: date, timeZone: calendar.timeZone, locale: Self.posixLocale
        )
        let time = AnalysisLogic.clockTime(date, timeZone: calendar.timeZone, locale: Self.posixLocale)
        XCTAssertTrue(kicker.hasSuffix(time.uppercased()), "expected kicker '\(kicker)' to end with '\(time.uppercased())'")
    }

    // MARK: - Duration formatting

    func testFormatDurationHoursAndMinutes() {
        XCTAssertEqual(AnalysisLogic.formatDuration(348), "5h 48m")
    }

    func testFormatDurationMinutesOnly() {
        XCTAssertEqual(AnalysisLogic.formatDuration(42), "42m")
    }

    func testFormatDurationRoundsToNearestMinute() {
        XCTAssertEqual(AnalysisLogic.formatDuration(42.6), "43m")
    }

    // MARK: - Workout duration label (stopwatch style)

    func testWorkoutDurationLabelUnderAnHour() {
        // 52.23 min = 52 min 13.8 sec, rounds to 52:14 — NOT "0:52", the bug
        // from treating the whole Double as minutes-rounded-to-an-Int.
        XCTAssertEqual(AnalysisLogic.workoutDurationLabel(52.23), "52:14")
    }

    func testWorkoutDurationLabelJustUnderAnHour() {
        // 59.99 min = 59 min 59.4 sec, rounds to 59:59 — still under an hour.
        XCTAssertEqual(AnalysisLogic.workoutDurationLabel(59.99), "59:59")
    }

    func testWorkoutDurationLabelExactlyAnHour() {
        XCTAssertEqual(AnalysisLogic.workoutDurationLabel(60), "1:00:00")
    }

    func testWorkoutDurationLabelOverAnHour() {
        // 81.5 min = 4890 sec = 1h 21m 30s.
        XCTAssertEqual(AnalysisLogic.workoutDurationLabel(81.5), "1:21:30")
    }

    // MARK: - Before-bed window

    func testIsWithinWindowTrueJustInsideBoundary() {
        let bed = Date(timeIntervalSince1970: 10_000)
        let event = bed.addingTimeInterval(-4 * 3600)
        XCTAssertTrue(AnalysisLogic.isWithinWindow(eventTime: event, bedTime: bed, windowHours: 4))
    }

    func testIsWithinWindowFalseOutsideBoundary() {
        let bed = Date(timeIntervalSince1970: 10_000)
        let event = bed.addingTimeInterval(-4.5 * 3600)
        XCTAssertFalse(AnalysisLogic.isWithinWindow(eventTime: event, bedTime: bed, windowHours: 4))
    }

    func testIsWithinWindowFalseAfterBedtime() {
        let bed = Date(timeIntervalSince1970: 10_000)
        let event = bed.addingTimeInterval(600)
        XCTAssertFalse(AnalysisLogic.isWithinWindow(eventTime: event, bedTime: bed, windowHours: 4))
    }

    // MARK: - Devices (phase 2 "both devices" contract, PR C item 4)

    func testDeviceDisplayNameMatchesDevicesLogic() {
        XCTAssertEqual(AnalysisLogic.deviceDisplayName(.apple), "Apple Watch")
        XCTAssertEqual(AnalysisLogic.deviceDisplayName(.whoop), "WHOOP")
    }

    func testDefaultDeviceSelectionIsAlwaysThePrimary() {
        XCTAssertEqual(AnalysisLogic.defaultDeviceSelection(primary: .apple), .apple)
        XCTAssertEqual(AnalysisLogic.defaultDeviceSelection(primary: .whoop), .whoop)
    }

    // MARK: - HR curve points

    func testHrCurvePointsEmptySeriesReturnsNoPoints() {
        XCTAssertEqual(AnalysisLogic.hrCurvePoints(series: []), [])
    }

    func testHrCurvePointsSingleValueReturnsOneCenteredPointWithoutDividingByZero() {
        let points = AnalysisLogic.hrCurvePoints(series: [150])
        XCTAssertEqual(points, [AnalysisLogic.HRPoint(x: 0, y: 0.5)])
    }

    func testHrCurvePointsConstantSeriesReadsAtVerticalCenterWithoutDividingByZero() {
        let points = AnalysisLogic.hrCurvePoints(series: [140, 140, 140, 140])
        XCTAssertEqual(points.count, 4)
        for point in points {
            XCTAssertEqual(point.y, 0.5, accuracy: 0.0001)
        }
        XCTAssertEqual(points.first?.x, 0, accuracy: 0.0001)
        XCTAssertEqual(points.last?.x, 1, accuracy: 0.0001)
    }

    func testHrCurvePointsNormalizesToUnitRange() {
        let points = AnalysisLogic.hrCurvePoints(series: [100, 150, 200])
        XCTAssertEqual(points.count, 3)
        XCTAssertEqual(points[0].x, 0, accuracy: 0.0001)
        XCTAssertEqual(points[0].y, 0, accuracy: 0.0001)
        XCTAssertEqual(points[1].x, 0.5, accuracy: 0.0001)
        XCTAssertEqual(points[1].y, 0.5, accuracy: 0.0001)
        XCTAssertEqual(points[2].x, 1, accuracy: 0.0001)
        XCTAssertEqual(points[2].y, 1, accuracy: 0.0001)
    }

    func testHrSeriesAvgMaxOfEmptySeriesIsNil() {
        XCTAssertNil(AnalysisLogic.hrSeriesAvgMax([]))
    }

    func testHrSeriesAvgMax() throws {
        let stats = try XCTUnwrap(AnalysisLogic.hrSeriesAvgMax([100, 150, 200]))
        XCTAssertEqual(stats.avg, 150, accuracy: 0.0001)
        XCTAssertEqual(stats.max, 200, accuracy: 0.0001)
    }

    // MARK: - Zone bars

    func testZoneBarsEmptyInputReturnsNoBars() {
        XCTAssertEqual(AnalysisLogic.zoneBars(secondsByZone: []), [])
    }

    func testZoneBarsFractionsRelativeToLargestZone() {
        let bars = AnalysisLogic.zoneBars(secondsByZone: [149, 209, 2448, 298, 30])
        XCTAssertEqual(bars.count, 5)
        XCTAssertEqual(bars[2].fraction, 1, accuracy: 0.0001, "the largest zone always fills the bar")
        XCTAssertEqual(bars[0].fraction, 149.0 / 2448.0, accuracy: 0.0001)
        XCTAssertEqual(bars[4].fraction, 30.0 / 2448.0, accuracy: 0.0001)
    }

    func testZoneBarsTimeLabelsAreMinutesSeconds() {
        let bars = AnalysisLogic.zoneBars(secondsByZone: [149, 209])
        XCTAssertEqual(bars[0].timeLabel, "2:29")
        XCTAssertEqual(bars[1].timeLabel, "3:29")
    }

    func testZoneBarsPercentLabelsSumApproximatelyTo100() {
        let bars = AnalysisLogic.zoneBars(secondsByZone: [149, 209, 2448, 298, 30])
        let percents = bars.map { Int($0.percentLabel.dropLast()) ?? 0 }
        let total = percents.reduce(0, +)
        XCTAssertTrue((99...101).contains(total), "rounded percents should sum close to 100, got \(total)")
    }

    func testZoneLabelsReserveBasisUsesZoneNumbers() {
        XCTAssertEqual(AnalysisLogic.zoneLabels(basis: "reserve"), ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"])
        XCTAssertEqual(AnalysisLogic.zoneLabels(basis: nil), ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"])
    }

    func testZoneLabelsMaxHrBasisUsesPercentBands() {
        XCTAssertEqual(AnalysisLogic.zoneLabels(basis: "maxHr"), ["50–60%", "60–70%", "70–80%", "80–90%", "90%+"])
    }

    func testMmssFormatsWholeSeconds() {
        XCTAssertEqual(AnalysisLogic.mmss(149), "2:29")
        XCTAssertEqual(AnalysisLogic.mmss(30), "0:30")
        XCTAssertEqual(AnalysisLogic.mmss(0), "0:00")
    }

    // MARK: - Sleep devices disagreement

    func testSleepDevicesDisagreeAtThresholdIsTrue() {
        XCTAssertTrue(AnalysisLogic.sleepDevicesDisagree(minutesA: 348, minutesB: 358))
    }

    func testSleepDevicesDisagreeJustUnderThresholdIsFalse() {
        XCTAssertFalse(AnalysisLogic.sleepDevicesDisagree(minutesA: 348, minutesB: 357))
    }

    func testSleepDevicesAgreeWithinToleranceIsFalse() {
        XCTAssertFalse(AnalysisLogic.sleepDevicesDisagree(minutesA: 348, minutesB: 350))
    }

    func testSleepDevicesDisagreeIsOrderIndependent() {
        XCTAssertEqual(
            AnalysisLogic.sleepDevicesDisagree(minutesA: 348, minutesB: 370),
            AnalysisLogic.sleepDevicesDisagree(minutesA: 370, minutesB: 348)
        )
    }
}
