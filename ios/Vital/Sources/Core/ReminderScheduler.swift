import Foundation

/// Computes and (re)schedules the rolling one-shot local-notification
/// window (D1): the next 7 days of breakfast/lunch/snack/dinner reminders
/// plus the next 4 weekly weigh-ins (~32 requests, well under the
/// 64-pending cap). `resync()` cancels the whole `vital.reminder.*`
/// namespace and recomputes it from scratch every time, so it's idempotent
/// and safe to call on every app foreground — cancelling "just today's
/// lunch" is just removing one identifier from the next resync's output.
///
/// Known trade-off (accepted, D1): if the app isn't opened for 7+ days,
/// reminders stop firing until the next open. A future remote-push upgrade
/// fixes this without touching the identifier scheme.
///
/// Coach-logged meals (the server-side `log_meal` tool, PR2 territory)
/// aren't visible here — only an on-device log via `mealLogged(slot:on:)`
/// (called from `LogMealViewModel`/`MealDetailViewModel`) suppresses
/// today's reminder. A meal logged purely through chat still shows a
/// redundant "log lunch/dinner" reminder until the day rolls over.
@MainActor
final class ReminderScheduler {

    enum LocalReminderKind: Hashable { case morningBrief, meal, weighIn }
    static let localReminderKinds: [LocalReminderKind] = [.meal, .weighIn]

    static let shared = ReminderScheduler()

    private enum Keys {
        // Internal-only markers (not surfaced in NotificationSettingsView)
        // that remember the last day a meal was logged on-device, so a
        // resync later in the same day doesn't resurrect a reminder that
        // was already cancelled by `mealLogged(slot:on:)`.
        static let lastBreakfastLogDay = "notif.internal.lastBreakfastLogDay"
        static let lastLunchLogDay = "notif.internal.lastLunchLogDay"
        static let lastSnackLogDay = "notif.internal.lastSnackLogDay"
        static let lastDinnerLogDay = "notif.internal.lastDinnerLogDay"
    }

    /// One reminder slot's configuration — prefs key to read the fire time
    /// from, the identifier/marker namespace, and the copy to show. Looping
    /// over this array is what lets `scheduleMealWindow`/`mealLogged` treat
    /// all four meal slots identically instead of four copy-pasted blocks.
    private struct MealSlot {
        let dietSlot: DietSlot
        let minutesKey: String
        let lastLogKey: String
        let identifier: (Date) -> String
        let title: String
        let body: String
    }

    private static let mealSlots: [MealSlot] = [
        MealSlot(
            dietSlot: .breakfast, minutesKey: NotificationPrefsKeys.mealsBreakfastMinutes,
            lastLogKey: Keys.lastBreakfastLogDay, identifier: NotificationIdentifiers.mealBreakfast,
            title: "Breakfast", body: "Logged breakfast yet? Takes 10 seconds."
        ),
        MealSlot(
            dietSlot: .lunch, minutesKey: NotificationPrefsKeys.mealsLunchMinutes,
            lastLogKey: Keys.lastLunchLogDay, identifier: NotificationIdentifiers.mealLunch,
            title: "Lunch", body: "Logged lunch yet? Takes 10 seconds."
        ),
        MealSlot(
            dietSlot: .snacks, minutesKey: NotificationPrefsKeys.mealsSnackMinutes,
            lastLogKey: Keys.lastSnackLogDay, identifier: NotificationIdentifiers.mealSnack,
            title: "Snack", body: "Grabbing a snack? Log it here."
        ),
        MealSlot(
            dietSlot: .dinner, minutesKey: NotificationPrefsKeys.mealsDinnerMinutes,
            lastLogKey: Keys.lastDinnerLogDay, identifier: NotificationIdentifiers.mealDinner,
            title: "Dinner", body: "Don't forget to log dinner."
        ),
    ]

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
        scheduleMealWindow(from: now)
        scheduleWeighInWindow(from: now)
    }

    // MARK: - Meal-logged suppression

    /// Cancels today's reminder for `slot` and persists a marker (see
    /// `Keys`) so the next `resync()` doesn't re-add it. When the caller has
    /// no slot of its own (neither `LogMealViewModel` nor
    /// `MealDetailViewModel` track a `DietSlot` today) falls back to a
    /// time-of-day bucket: <11a breakfast, 11a-3p lunch, 3p-6p snack, else
    /// dinner.
    func mealLogged(slot: DietSlot? = nil, on date: Date = Date()) {
        let resolvedSlot = slot ?? Self.fallbackSlot(forHour: calendar.component(.hour, from: date))
        guard let mealSlot = Self.mealSlots.first(where: { $0.dietSlot == resolvedSlot }) else { return }
        defaults.set(NotificationIdentifiers.dayString(date), forKey: mealSlot.lastLogKey)
        manager.cancel(ids: [mealSlot.identifier(date)])
    }

    private static func fallbackSlot(forHour hour: Int) -> DietSlot {
        switch hour {
        case ..<11: return .breakfast
        case 11..<15: return .lunch
        case 15..<18: return .snacks
        default: return .dinner
        }
    }

    /// Cancels a legacy locally scheduled brief after Today has loaded. This
    /// is migration-only; new morning briefs are server-scheduled remote push.
    func briefViewed(at date: Date) {
        manager.cancel(ids: [NotificationIdentifiers.brief(date)])
    }

    // MARK: - Meals

    private func scheduleMealWindow(from now: Date) {
        guard defaults.bool(forKey: NotificationPrefsKeys.mealsEnabled) else { return }

        for mealSlot in Self.mealSlots {
            let minutes = defaults.integer(forKey: mealSlot.minutesKey)
            let lastLog = defaults.string(forKey: mealSlot.lastLogKey)

            for offset in 0..<7 {
                guard let day = calendar.date(byAdding: .day, value: offset, to: now) else { continue }
                let dayKey = NotificationIdentifiers.dayString(day)

                if let fireDate = date(onDay: day, minutesSinceMidnight: minutes),
                   fireDate > now, lastLog != dayKey {
                    schedule(
                        id: mealSlot.identifier(day),
                        title: mealSlot.title,
                        body: mealSlot.body,
                        fireDate: fireDate
                    )
                }
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
