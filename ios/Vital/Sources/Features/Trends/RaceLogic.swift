import Foundation

/// Pure helpers for the optional endurance race (Profile → Goal editor,
/// Today hero countdown, goal card row). Ranges and labels mirror
/// lib/goalTarget.ts (race date: today…+2 years; distance: 1–250 km) and
/// lib/goalProgress.ts (`raceLabel`). No SwiftUI, no networking.
enum RaceLogic {

    // MARK: - Ranges (mirror lib/goalTarget.ts)

    static let maxRaceYears = 2
    static let minDistanceKm = 1.0
    static let maxDistanceKm = 250.0

    struct Preset: Equatable, Identifiable {
        let km: Double
        /// Short segmented-control title.
        let title: String
        var id: Double { km }
    }

    /// The segmented picker: 5K / 10K / Half / Marathon.
    static let presets: [Preset] = [
        Preset(km: 5, title: "5K"),
        Preset(km: 10, title: "10K"),
        Preset(km: 21.1, title: "Half"),
        Preset(km: 42.2, title: "Marathon"),
    ]

    static let defaultDistanceKm = 21.1

    // MARK: - Validation

    /// Distance rounded to 0.1 km, or nil outside the backend's 1–250 range.
    static func validDistanceKm(_ km: Double?) -> Double? {
        guard let km, km.isFinite, km >= minDistanceKm, km <= maxDistanceKm else { return nil }
        return (km * 10).rounded() / 10
    }

    /// Today through two years out — what the server accepts (race day itself is valid).
    static func dateRange(from now: Date = Date(), calendar: Calendar = .current) -> ClosedRange<Date> {
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .year, value: maxRaceYears, to: start) ?? start
        return start...max(start, end)
    }

    // MARK: - Labels

    /// Mirrors the server's `raceLabel`: "Half marathon", "Marathon", "10K", "5K", "<n> km race", or "Race".
    /// The custom-distance form joins the number to "km" with U+00A0 (the
    /// server's `withUnit` does too), so a narrow row never strands "km race".
    static func label(forKm km: Double?) -> String {
        guard let km else { return "Race" }
        if abs(km - 21.1) < 0.05 { return "Half marathon" }
        if abs(km - 42.2) < 0.05 { return "Marathon" }
        if km == 10 { return "10K" }
        if km == 5 { return "5K" }
        let n = km.rounded() == km ? String(Int(km)) : String(format: "%.1f", km)
        return "\(n)\(UnitFormat.nbsp)km race"
    }

    /// The preset matching `km` (within 0.05), or nil for a custom distance.
    static func preset(forKm km: Double?) -> Preset? {
        guard let km else { return nil }
        return presets.first { abs($0.km - km) < 0.05 }
    }

    /// "12 weeks to go" / "1 week to go" / "5 days to go" / "Race day".
    /// Race week (weeksToGo 0) reads in days.
    static func countdownText(weeksToGo: Int, daysToGo: Int) -> String {
        if daysToGo <= 0 { return "Race day" }
        if weeksToGo <= 0 { return "\(daysToGo) \(daysToGo == 1 ? "day" : "days") to go" }
        return "\(weeksToGo) \(weeksToGo == 1 ? "week" : "weeks") to go"
    }

    // MARK: - Race lifecycle (phase)

    /// Recovery week (1 or 2) for the days since race day: days 1-7 are week 1,
    /// 8-14 week 2 (mirrors lib/enduranceProgression.ts `recoveryWeek`). A
    /// server that sent no `daysSince` reads as week 1.
    static func recoveryWeek(daysSince: Int?) -> Int {
        (daysSince ?? 1) <= 7 ? 1 : 2
    }

    /// True once the race is done and the 14-day recovery is under way.
    static func isRecovery(_ race: GoalProgressDTO.Race?) -> Bool {
        race?.phase == .recovery
    }

    /// The post-race call to action: it opens the goal editor
    /// (`.vitalOpenGoalEditor`) so the runner can set a new race, a weekly
    /// distance target, or switch to maintenance.
    static let nextGoalTitle = "Set your next goal"

    /// "Race done · recovery week 1".
    static func recoveryText(daysSince: Int?) -> String {
        "Race done \u{00B7} recovery week \(recoveryWeek(daysSince: daysSince))"
    }

    /// Today hero line, by race phase:
    ///  - build (or an older server with no phase): "Half marathon · 12 weeks to go", plus the
    ///    long-run progress when the response carries a long run with a target:
    ///    "Half marathon · 12 weeks to go · long run 14/18 km" (`longRunProgressText`);
    ///  - taper: "Half marathon · taper · 2 weeks to go" (no long-run tail: the build-up is over);
    ///  - race week: "Race week · Dec 31" ("Race day · Dec 31" on the day);
    ///  - recovery: "Race done · recovery week 1".
    static func heroLine(
        _ race: GoalProgressDTO.Race, longRun: GoalProgressDTO.LongRun? = nil, system: UnitSystem = .metric,
        calendar: Calendar = .current
    ) -> String {
        switch race.phase {
        case .taper:
            return "\(race.displayLabel) \u{00B7} taper \u{00B7} \(countdownText(weeksToGo: race.weeksToGo, daysToGo: race.daysToGo))"
        case .raceWeek:
            var parts = [race.daysToGo <= 0 ? "Race day" : "Race week"]
            if let day = GoalTargetLogic.date(fromDay: race.date, calendar: calendar) {
                parts.append(monthDay(day, calendar: calendar))
            }
            return parts.joined(separator: " \u{00B7} ")
        case .recovery:
            return recoveryText(daysSince: race.daysSince)
        case .build, .none:
            var line = "\(race.displayLabel) · \(countdownText(weeksToGo: race.weeksToGo, daysToGo: race.daysToGo))"
            if let longRun, let progress = longRunProgressText(longRun, system) {
                line += " · \(progress)"
            }
            return line
        }
    }

    /// "long run 14/18 km" (imperial: "long run 8.7/11.2 mi"; the number and
    /// unit are joined by `UnitFormat.nbsp`) — the most recent
    /// long run against the peak long run to build to. Falls back to the
    /// 28-day peak when there is no recent long run. `nil` without a target (a
    /// race with no distance has none) or without any long-run distance, so the
    /// hero never invents a goal.
    static func longRunProgressText(_ longRun: GoalProgressDTO.LongRun, _ system: UnitSystem) -> String? {
        guard let target = longRun.targetPeakKm, target > 0,
              let done = longRun.lastKm ?? longRun.peakKm else { return nil }
        let doneText = GoalProgressLogic.distanceAmount(km: done, system)
        let targetText = GoalProgressLogic.distanceAmount(km: target, system)
        return "long run \(doneText)/\(targetText)\(UnitFormat.nbsp)\(system.distanceUnit)"
    }

    /// Goal sheet race row, with the phase: "Half marathon · Dec 30 · 12 wk" (build),
    /// "… · taper · 2 wk", "… · race week · 5 d" (race day: "race week · today"),
    /// "… · recovery week 1" once the race is done.
    static func rowText(_ race: GoalProgressDTO.Race, calendar: Calendar = .current) -> String {
        var parts = [race.displayLabel]
        if let d = GoalTargetLogic.date(fromDay: race.date, calendar: calendar) {
            parts.append(monthDay(d, calendar: calendar))
        }
        switch race.phase {
        case .recovery:
            parts.append("recovery week \(recoveryWeek(daysSince: race.daysSince))")
        case .taper:
            parts.append("taper")
            parts.append(race.weeksToGo <= 0 ? "\(max(race.daysToGo, 0)) d" : "\(race.weeksToGo) wk")
        case .raceWeek:
            parts.append("race week")
            parts.append(race.daysToGo <= 0 ? "today" : "\(race.daysToGo) d")
        case .build, .none:
            if race.daysToGo <= 0 {
                parts.append("today")
            } else if race.weeksToGo <= 0 {
                parts.append("\(race.daysToGo) d")
            } else {
                parts.append("\(race.weeksToGo) wk")
            }
        }
        return parts.joined(separator: " · ")
    }

    /// Separator between the segments of the Profile Goal row ("Half marathon
    /// · Dec 30 · 30 km/wk"): a normal space BEFORE the middle dot and a
    /// non-breaking space AFTER it. The dot is bound to the segment that
    /// FOLLOWS it, so a narrow row can only wrap before a "·" ("Half marathon
    /// · Dec 30" / "· 30 km/wk") and never leaves one dangling at the end of
    /// a line. Shared with `ProfileViewModel.goalRowLabel`.
    static let goalRowSeparator = " \u{00B7}\u{00A0}"

    /// Profile Goal row race part: "Half marathon · Dec 30" (the Goal row leads
    /// with it, so the race name and day are what survives a narrow row; the
    /// segments are joined by `goalRowSeparator`). `nil`
    /// without a race date, with one that does not parse, or once the race day
    /// has passed (after it the goal editor and Today carry the recovery state
    /// and the "Set your next goal" call to action instead).
    static func goalRowSuffix(
        raceDate: String?, distanceKm: Double?, now: Date = Date(), calendar: Calendar = .current
    ) -> String? {
        guard let raceDate,
              let day = GoalTargetLogic.date(fromDay: raceDate, calendar: calendar),
              day >= calendar.startOfDay(for: now) else { return nil }
        return "\(label(forKm: distanceKm))\(goalRowSeparator)\(monthDay(day, calendar: calendar))"
    }

    // MARK: - Long run (goal detail row)

    /// Goal detail "Long run" row value: "14 km · peak target 18 km" (the last
    /// long run, then the peak to build to; imperial users get miles). With no
    /// last long run it leads with the peak ("peak 16 km · peak target 18 km");
    /// `nil` when the response carries neither distance.
    static func longRunRowText(_ longRun: GoalProgressDTO.LongRun, _ system: UnitSystem) -> String? {
        var parts: [String] = []
        if let last = longRun.lastKm {
            parts.append(UnitFormat.distance(km: last, system))
        } else if let peak = longRun.peakKm {
            parts.append("peak \(UnitFormat.distance(km: peak, system))")
        } else {
            return nil
        }
        if let target = longRun.targetPeakKm {
            parts.append("peak target \(UnitFormat.distance(km: target, system))")
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    private static func monthDay(_ date: Date, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    // MARK: - Visibility

    /// Race editing is endurance-only (onboarding ids and canonical ids both accepted).
    static func showsRace(goal: String) -> Bool {
        GoalTargetLogic.showsWeeklyDistance(goal: goal)
    }
}
