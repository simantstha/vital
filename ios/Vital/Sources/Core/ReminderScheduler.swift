import Foundation

/// Computes and (re)schedules the rolling one-shot local-notification
/// window (D1): the next 7 days of brief/lunch/dinner reminders plus the
/// next 4 weekly weigh-ins (~25 requests, well under the 64-pending cap).
/// `resync()` cancels the whole `vital.reminder.*` namespace and recomputes
/// it from scratch every time, so it's idempotent and safe to call on every
/// app foreground — cancelling "just today's lunch" is just removing one
/// identifier from the next resync's output.
///
/// Known trade-off (accepted, D1): if the app isn't opened for 7+ days,
/// reminders stop firing until the next open. A future remote-push upgrade
/// fixes this without touching the identifier scheme.
///
/// Coach-logged meals (the server-side `log_meal` tool, PR2 territory)
/// aren't visible here — only an on-device log via `mealLogged(at:)`
/// (called from `LogMealViewModel`/`MealDetailViewModel`) suppresses
/// today's reminder. A meal logged purely through chat still shows a
/// redundant "log lunch/dinner" reminder until the day rolls over.
@MainActor
final class ReminderScheduler {

    static let shared = ReminderScheduler()

    private enum Keys {
        // Internal-only markers (not surfaced in NotificationSettingsView)
        // that remember the last day a meal was logged on-device, so a
        // resync later in the same day doesn't resurrect a reminder that
        // was already cancelled by `mealLogged(at:)`.
        static let lastLunchLogDay = "notif.internal.lastLunchLogDay"
        static let lastDinnerLogDay = "notif.internal.lastDinnerLogDay"
    }

    private let manager = NotificationManager.shared
    private let defaults = UserDefaults.standard

    private var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        return cal
    }

    private init() {}

    // MARK: - Resync (D1)

    func resync() async {
        guard manager.permissionState == .authorized else { return }

        await manager.cancelAll(prefix: NotificationIdentifiers.reminderPrefix)

        let now = Date()
        scheduleBriefWindow(from: now)
        scheduleMealWindow(from: now)
        scheduleWeighInWindow(from: now)
    }

    // MARK: - Meal-logged suppression

    /// Cancels today's lunch reminder if logged before 3pm, else today's
    /// dinner, and persists a marker (see `Keys`) so the next `resync()`
    /// doesn't re-add it.
    func mealLogged(at date: Date) {
        let isLunch = calendar.component(.hour, from: date) < 15
        let key = isLunch ? Keys.lastLunchLogDay : Keys.lastDinnerLogDay
        defaults.set(NotificationIdentifiers.dayString(date), forKey: key)

        let id = isLunch ? NotificationIdentifiers.mealLunch(date) : NotificationIdentifiers.mealDinner(date)
        manager.cancel(ids: [id])
    }

    // MARK: - Brief

    private func scheduleBriefWindow(from now: Date) {
        guard defaults.bool(forKey: NotificationPrefsKeys.briefEnabled) else { return }
        let minutes = defaults.integer(forKey: NotificationPrefsKeys.briefMinutes)
        let fourAM = date(onDay: now, minutesSinceMidnight: 4 * 60) ?? now

        for offset in 0..<7 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: now),
                  let fireDate = date(onDay: day, minutesSinceMidnight: minutes),
                  fireDate > now else { continue }

            // Brief suppression: if it's already between 4am and the brief
            // time on the first day of the window, the user foregrounding
            // the app *is* them checking in — skip today's nudge.
            if offset == 0 && now >= fourAM {
                continue
            }

            schedule(
                id: NotificationIdentifiers.brief(day),
                title: "Morning Brief",
                body: "Your morning brief is ready — see how you recovered overnight.",
                fireDate: fireDate
            )
        }
    }

    // MARK: - Meals

    private func scheduleMealWindow(from now: Date) {
        guard defaults.bool(forKey: NotificationPrefsKeys.mealsEnabled) else { return }
        let lunchMinutes = defaults.integer(forKey: NotificationPrefsKeys.mealsLunchMinutes)
        let dinnerMinutes = defaults.integer(forKey: NotificationPrefsKeys.mealsDinnerMinutes)
        let lastLunchLog = defaults.string(forKey: Keys.lastLunchLogDay)
        let lastDinnerLog = defaults.string(forKey: Keys.lastDinnerLogDay)

        for offset in 0..<7 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: now) else { continue }
            let dayKey = NotificationIdentifiers.dayString(day)

            if let lunchFire = date(onDay: day, minutesSinceMidnight: lunchMinutes),
               lunchFire > now, lastLunchLog != dayKey {
                schedule(
                    id: NotificationIdentifiers.mealLunch(day),
                    title: "Lunch",
                    body: "Logged lunch yet? Takes 10 seconds.",
                    fireDate: lunchFire
                )
            }

            if let dinnerFire = date(onDay: day, minutesSinceMidnight: dinnerMinutes),
               dinnerFire > now, lastDinnerLog != dayKey {
                schedule(
                    id: NotificationIdentifiers.mealDinner(day),
                    title: "Dinner",
                    body: "Don't forget to log dinner.",
                    fireDate: dinnerFire
                )
            }
        }
    }

    // MARK: - Weekly weigh-in

    private func scheduleWeighInWindow(from now: Date) {
        guard defaults.bool(forKey: NotificationPrefsKeys.weighinEnabled) else { return }
        let targetWeekday = defaults.integer(forKey: NotificationPrefsKeys.weighinWeekday) // 1=Sun...7=Sat
        let minutes = defaults.integer(forKey: NotificationPrefsKeys.weighinMinutes)

        var day = now
        var scheduled = 0
        var daysChecked = 0
        while scheduled < 4 && daysChecked < 60 {
            defer {
                daysChecked += 1
                day = calendar.date(byAdding: .day, value: 1, to: day) ?? day
            }
            guard calendar.component(.weekday, from: day) == targetWeekday,
                  let fireDate = date(onDay: day, minutesSinceMidnight: minutes),
                  fireDate > now else { continue }

            schedule(
                id: NotificationIdentifiers.weighIn(day),
                title: "Weekly Weigh-In",
                body: "Weekly weigh-in day — step on the scale before breakfast.",
                fireDate: fireDate
            )
            scheduled += 1
        }
    }

    // MARK: - Helpers

    private func date(onDay day: Date, minutesSinceMidnight minutes: Int) -> Date? {
        let startOfDay = calendar.startOfDay(for: day)
        return calendar.date(byAdding: .minute, value: minutes, to: startOfDay)
    }

    private func schedule(id: String, title: String, body: String, fireDate: Date) {
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: fireDate)
        manager.schedule(
            id: id, title: title, body: body,
            category: NotificationIdentifiers.reminderCategory,
            dateComponents: components
        )
    }
}
