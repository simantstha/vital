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
    static func label(forKm km: Double?) -> String {
        guard let km else { return "Race" }
        if abs(km - 21.1) < 0.05 { return "Half marathon" }
        if abs(km - 42.2) < 0.05 { return "Marathon" }
        if km == 10 { return "10K" }
        if km == 5 { return "5K" }
        let n = km.rounded() == km ? String(Int(km)) : String(format: "%.1f", km)
        return "\(n) km race"
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

    /// Today hero line: "Half marathon · 12 weeks to go".
    static func heroLine(_ race: GoalProgressDTO.Race) -> String {
        "\(race.displayLabel) · \(countdownText(weeksToGo: race.weeksToGo, daysToGo: race.daysToGo))"
    }

    /// Goal card row: "Half marathon · Dec 30 · 12 wk" (race week: "5 d"; race day: "today").
    static func rowText(_ race: GoalProgressDTO.Race, calendar: Calendar = .current) -> String {
        var parts = [race.displayLabel]
        if let d = GoalTargetLogic.date(fromDay: race.date, calendar: calendar) {
            parts.append(monthDay(d, calendar: calendar))
        }
        if race.daysToGo <= 0 {
            parts.append("today")
        } else if race.weeksToGo <= 0 {
            parts.append("\(race.daysToGo) d")
        } else {
            parts.append("\(race.weeksToGo) wk")
        }
        return parts.joined(separator: " · ")
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
