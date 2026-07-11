import Foundation
import UserNotifications

// MARK: - Permission state

enum NotificationPermissionState {
    case notDetermined
    case authorized
    case denied
}

// MARK: - Identifiers (D5 — future-push-safe)

/// Local-notification identifier + category constants, namespaced so a
/// future remote-push upgrade (`pending_nudges` → APNs) can reuse the same
/// identifiers without collision. Reminder identifiers embed the calendar
/// day so `ReminderScheduler`'s rolling resync (D1) can replace a single
/// day's request instead of the whole window; the nudge identifier embeds
/// the `pending_nudges` row UUID (PR2) so rescheduling replaces rather than
/// duplicates.
enum NotificationIdentifiers {
    static let reminderPrefix = "vital.reminder."

    static let reminderCategory = "VITAL_REMINDER"
    static let nudgeCategory = "VITAL_NUDGE"

    static func brief(_ day: Date) -> String {
        "vital.reminder.brief.\(dayString(day))"
    }

    static func mealLunch(_ day: Date) -> String {
        "vital.reminder.meal.lunch.\(dayString(day))"
    }

    static func mealDinner(_ day: Date) -> String {
        "vital.reminder.meal.dinner.\(dayString(day))"
    }

    static func weighIn(_ day: Date) -> String {
        "vital.reminder.weighin.\(dayString(day))"
    }

    static func nudge(_ rowUUID: String) -> String {
        "vital.nudge.\(rowUUID)"
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func dayString(_ day: Date) -> String {
        dayFormatter.string(from: day)
    }
}

// MARK: - Preferences (D2 — UserDefaults via @AppStorage, no server copy)

/// `@AppStorage` key + default constants for `NotificationSettingsView`.
/// `ReminderScheduler` reads the same keys directly off `UserDefaults` so
/// the two never drift. Defaults are registered once at launch (see
/// `NotificationManager.init`) so `ReminderScheduler` sees sane values even
/// before `NotificationSettingsView` has ever been opened.
enum NotificationPrefsKeys {
    static let briefEnabled = "notif.brief.enabled"
    static let briefMinutes = "notif.brief.minutes"          // default 450 = 7:30am

    static let mealsEnabled = "notif.meals.enabled"
    static let mealsLunchMinutes = "notif.meals.lunchMinutes"   // default 750 = 12:30pm
    static let mealsDinnerMinutes = "notif.meals.dinnerMinutes"  // default 1170 = 7:30pm

    static let weighinEnabled = "notif.weighin.enabled"
    static let weighinWeekday = "notif.weighin.weekday"       // default 7 = Saturday (Calendar weekday)
    static let weighinMinutes = "notif.weighin.minutes"       // default 480 = 8:00am

    static let registrationDefaults: [String: Any] = [
        briefEnabled: true,
        briefMinutes: 450,
        mealsEnabled: true,
        mealsLunchMinutes: 750,
        mealsDinnerMinutes: 1170,
        weighinEnabled: true,
        weighinWeekday: 7,
        weighinMinutes: 480,
    ]
}

// MARK: - NotificationManager

/// Thin wrapper around `UNUserNotificationCenter` — the permission-manager
/// shape established by `SpeechTranscriber.swift`, adapted for local
/// notification scheduling. Owns the delegate so foreground banners still
/// show (`willPresent`), tracks permission state, and exposes the low-level
/// schedule/cancel primitives. `ReminderScheduler` (and PR2's `NudgeSyncer`)
/// build on top of this — neither talks to `UNUserNotificationCenter`
/// directly.
@MainActor
final class NotificationManager: NSObject, ObservableObject {

    static let shared = NotificationManager()

    @Published var permissionState: NotificationPermissionState = .notDetermined

    private let center = UNUserNotificationCenter.current()

    private override init() {
        super.init()
        UserDefaults.standard.register(defaults: NotificationPrefsKeys.registrationDefaults)
    }

    // MARK: - Permissions

    func refreshPermissionState() async {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional:
            permissionState = .authorized
        case .denied:
            permissionState = .denied
        case .notDetermined, .ephemeral:
            permissionState = .notDetermined
        @unknown default:
            permissionState = .notDetermined
        }
    }

    @discardableResult
    func requestPermission() async -> Bool {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshPermissionState()
        return granted
    }

    // MARK: - Scheduling

    func schedule(id: String, title: String, body: String, category: String, dateComponents: DateComponents) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = category

        let trigger = UNCalendarNotificationTrigger(dateMatching: dateComponents, repeats: false)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        center.add(request)
    }

    /// Schedules a one-shot notification firing `delay` seconds from now
    /// (minimum 1s, per `UNTimeIntervalNotificationTrigger`'s requirement).
    /// Used by `NudgeSyncer` for "dead" nudges — a `scheduled_for` in the
    /// recent past — where a calendar trigger for a past date/time would
    /// never fire.
    func scheduleImmediate(id: String, title: String, body: String, category: String, delay: TimeInterval) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = category

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, delay), repeats: false)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        center.add(request)
    }

    func cancel(ids: [String]) {
        guard !ids.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    /// Cancels every pending request whose identifier starts with `prefix`
    /// (used by `ReminderScheduler` to wipe the `vital.reminder.` namespace
    /// before recomputing it on each resync).
    func cancelAll(prefix: String) async {
        let ids = await pendingIds().filter { $0.hasPrefix(prefix) }
        cancel(ids: ids)
    }

    func pendingIds() async -> [String] {
        await center.pendingNotificationRequests().map(\.identifier)
    }

}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationManager: UNUserNotificationCenterDelegate {
    // UNUserNotificationCenter invokes its delegate off the main actor, so
    // this is `nonisolated` (same pattern as CoachSpeaker's
    // AVAudioPlayerDelegate/AVSpeechSynthesizerDelegate conformances) —
    // it doesn't touch @MainActor state, so no Task hop is needed.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
