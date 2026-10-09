import Foundation

/// Pure helpers shared by the onboarding Goal step and Profile → Goal editor:
/// which target fields a goal shows, validation matching the backend
/// (lib/goalTarget.ts: 30–300 kg, 1–14 sessions/week, 1–300 km/week), and the "healthy
/// pace" estimate. No SwiftUI, no networking — unit-tested directly.
enum GoalTargetLogic {

    // MARK: - Ranges (mirror lib/goalTarget.ts)

    static let minTargetKg = 30.0
    static let maxTargetKg = 300.0
    static let minWeeklySessions = 1
    static let maxWeeklySessions = 14
    static let minWeeklyDistanceKm = 1.0
    static let maxWeeklyDistanceKm = 300.0

    /// A commonly recommended sustainable loss rate.
    static let healthyKgPerWeek = 0.5
    /// Above this the pace hint warns that the date is aggressive.
    static let aggressiveKgPerWeek = 1.0
    /// Fraction of current bodyweight beyond which a loss target gets a gentle warning.
    static let largeLossFraction = 0.25

    // MARK: - Which fields a goal shows

    /// Onboarding goal ids (`lose_fat` …) and canonical DietGoal ids
    /// (`weight_loss` …) are both accepted so Profile can reuse this.
    static func showsTargetWeight(goal: String) -> Bool {
        ["lose_fat", "weight_loss", "build_muscle", "muscle"].contains(goal)
    }

    static func showsWeeklySessions(goal: String) -> Bool {
        ["build_muscle", "muscle", "improve_endurance", "endurance"].contains(goal)
    }

    /// Endurance goals get an optional weekly distance target (km on the wire,
    /// shown in the user's unit) — the measurable target the goal card tracks.
    static func showsWeeklyDistance(goal: String) -> Bool {
        ["improve_endurance", "endurance"].contains(goal)
    }

    static func isLossGoal(_ goal: String) -> Bool {
        goal == "lose_fat" || goal == "weight_loss"
    }

    static func defaultWeeklySessions(goal: String) -> Int {
        ["build_muscle", "muscle"].contains(goal) ? 4 : 3
    }

    // MARK: - Validation

    /// Target in kg rounded to 0.1, or nil when outside the backend's 30–300 range.
    static func validTargetKg(_ kg: Double?) -> Double? {
        guard let kg, kg.isFinite, kg >= minTargetKg, kg <= maxTargetKg else { return nil }
        return (kg * 10).rounded() / 10
    }

    /// Weekly distance in km rounded to 0.1, or nil when outside the backend's 1–300 range.
    static func validWeeklyDistanceKm(_ km: Double?) -> Double? {
        guard let km, km.isFinite, km >= minWeeklyDistanceKm, km <= maxWeeklyDistanceKm else { return nil }
        return (km * 10).rounded() / 10
    }

    static func clampSessions(_ n: Int) -> Int {
        min(max(n, minWeeklySessions), maxWeeklySessions)
    }

    // MARK: - Dates

    /// Backend's cap on how far out a target date may be (lib/goalTarget.ts).
    static let maxTargetYears = 3

    /// 'YYYY-MM-DD' for the user's local calendar day. A DatePicker value is
    /// local, so formatting it in UTC could shift the day for users east of UTC.
    static func dayString(from date: Date, calendar: Calendar = .current) -> String {
        dayFormatter(calendar).string(from: date)
    }

    static func date(fromDay day: String, calendar: Calendar = .current) -> Date? {
        dayFormatter(calendar).date(from: day)
    }

    private static func dayFormatter(_ calendar: Calendar) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f
    }

    /// Tomorrow through three years out — what the server accepts.
    static func targetDateRange(from now: Date = Date(), calendar: Calendar = .current) -> ClosedRange<Date> {
        let start = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        let end = calendar.date(byAdding: .year, value: maxTargetYears, to: now) ?? start
        return start...max(start, end)
    }

    /// "Started at 82 kg on Sep 15" (imperial: "180 lb"). Degrades to
    /// "Started Sep 15" / "Started at 82 kg" when one half is missing; nil
    /// when both are.
    static func startedLine(
        weightKg: Double?,
        startedAtISO: String?,
        units: UnitSystem,
        calendar: Calendar = .current
    ) -> String? {
        let when = startedAtISO.flatMap(parseISO).map { dateText($0, calendar: calendar) }
        let weight = weightKg.map { UnitFormat.weight(kg: $0, units) }
        switch (weight, when) {
        case let (w?, d?): return "Started at \(w) on \(d)"
        case let (w?, nil): return "Started at \(w)"
        case let (nil, d?): return "Started \(d)"
        default: return nil
        }
    }

    private static func parseISO(_ iso: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return withFractional.date(from: iso) ?? plain.date(from: iso)
    }

    // MARK: - Pace

    /// Date the user would reach `targetKg` from `currentKg` at `kgPerWeek`.
    /// Nil unless the target is strictly below the current weight.
    static func paceEstimateDate(
        currentKg: Double,
        targetKg: Double,
        kgPerWeek: Double = healthyKgPerWeek,
        from now: Date = Date(),
        calendar: Calendar = .current
    ) -> Date? {
        guard kgPerWeek > 0, targetKg < currentKg else { return nil }
        let days = Int((((currentKg - targetKg) / kgPerWeek) * 7).rounded(.up))
        return calendar.date(byAdding: .day, value: days, to: now)
    }

    /// Weekly loss (kg) needed to hit `targetKg` by `date`; nil when not a
    /// loss target or the date isn't in the future.
    static func impliedKgPerWeek(
        currentKg: Double,
        targetKg: Double,
        by date: Date,
        from now: Date = Date()
    ) -> Double? {
        guard targetKg < currentKg, date > now else { return nil }
        let weeks = date.timeIntervalSince(now) / (7 * 86_400)
        guard weeks > 0 else { return nil }
        return (currentKg - targetKg) / weeks
    }

    private static func dateText(_ date: Date, calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    /// "At ~0.5 kg/week that's around Dec 12" (imperial: "~1 lb/week"); the
    /// value and unit are joined by `UnitFormat.nbsp`.
    /// Nil when there's nothing sensible to say (not a loss target).
    static func paceHint(
        currentKg: Double?,
        targetKg: Double?,
        units: UnitSystem,
        from now: Date = Date(),
        calendar: Calendar = .current
    ) -> String? {
        guard let currentKg, let targetKg = validTargetKg(targetKg),
              let date = paceEstimateDate(currentKg: currentKg, targetKg: targetKg, from: now, calendar: calendar)
        else { return nil }
        let rate = units == .metric
            ? "0.5\(UnitFormat.nbsp)kg"
            : "\(Int(UnitConvert.kgToLb(healthyKgPerWeek).rounded()))\(UnitFormat.nbsp)lb"
        return "At ~\(rate)/week that's around \(dateText(date, calendar: calendar))"
    }

    /// Gentle sanity warnings; nil when the target looks reasonable.
    static func sanityWarning(
        goal: String,
        currentKg: Double?,
        targetKg: Double?,
        targetDate: Date?,
        units: UnitSystem,
        from now: Date = Date()
    ) -> String? {
        guard let currentKg, let target = validTargetKg(targetKg) else { return nil }
        if isLossGoal(goal) {
            if target >= currentKg { return "Your target should be below your current weight." }
            if (currentKg - target) / currentKg > largeLossFraction {
                return "That's a big change. Consider a closer first target."
            }
            if let targetDate,
               let rate = impliedKgPerWeek(currentKg: currentKg, targetKg: target, by: targetDate, from: now),
               rate > aggressiveKgPerWeek {
                let shown = units == .metric
                    ? String(format: "%.1f\(UnitFormat.nbsp)kg", rate)
                    : String(format: "%.1f\(UnitFormat.nbsp)lb", UnitConvert.kgToLb(rate))
                return "That date needs about \(shown)/week, faster than a healthy pace."
            }
        } else if target <= currentKg {
            return "Your target should be above your current weight."
        }
        return nil
    }

    // MARK: - Missing-target nudge

    /// One-line, non-blocking nudge shown on the onboarding Goal step when a
    /// loss goal has no (valid) target weight yet. The target stays optional.
    static func missingTargetNudge(goal: String, targetKg: Double?) -> String? {
        guard isLossGoal(goal), validTargetKg(targetKg) == nil else { return nil }
        return "Add a target to see how far you have to go"
    }
}

/// Copy for the onboarding flow's status lines, kept pure so it's testable.
enum OnboardingCopy {
    /// The Calibrating step's completion line — the real number the backfill
    /// uploaded, never a hardcoded count. Neutral copy when nothing was
    /// uploaded (e.g. no HealthKit data / permission skipped).
    static func importSummary(daysUploaded: Int) -> String {
        guard daysUploaded > 0 else { return "Your health history is up to date." }
        return "Imported \(daysUploaded) \(daysUploaded == 1 ? "day" : "days") of health history."
    }
}
