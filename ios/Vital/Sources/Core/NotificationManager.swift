import Foundation
import UserNotifications
import UIKit

// MARK: - Permission state

enum NotificationPermissionState {
    case notDetermined
    case authorized
    case denied
}

enum NotificationDeliveryPolicy {
    enum Interaction { case foregroundReceipt, userResponse, coldLaunchTap }
    static func shouldRoute(_ interaction: Interaction) -> Bool { interaction != .foregroundReceipt }
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
    /// Meal reminders only (not the daily brief / weekly weigh-in, which
    /// stay on `reminderCategory`) — registered with a `UNTextInputNotificationAction`
    /// ("Log what I ate") so the notification itself can quick-log a meal.
    /// See `ReminderScheduler`'s meal-window `schedule` call site and
    /// `NotificationManager.registerCategories()`.
    static let mealReminderCategory = "VITAL_MEAL_REMINDER"
    static let logMealAction = "VITAL_LOG_MEAL_ACTION"

    static func brief(_ day: Date) -> String {
        "vital.reminder.brief.\(dayString(day))"
    }

    static func mealBreakfast(_ day: Date) -> String {
        "vital.reminder.meal.breakfast.\(dayString(day))"
    }

    static func mealLunch(_ day: Date) -> String {
        "vital.reminder.meal.lunch.\(dayString(day))"
    }

    static func mealSnack(_ day: Date) -> String {
        "vital.reminder.meal.snack.\(dayString(day))"
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
    static let workoutEnabled = "notif.workout.enabled"
    static let sleepEnabled = "notif.sleep.enabled"

    static let mealsEnabled = "notif.meals.enabled"
    static let mealsBreakfastMinutes = "notif.meals.breakfastMinutes"  // default 480 = 8:00am
    static let mealsLunchMinutes = "notif.meals.lunchMinutes"   // default 765 = 12:45pm
    static let mealsSnackMinutes = "notif.meals.snackMinutes"   // default 960 = 4:00pm
    static let mealsDinnerMinutes = "notif.meals.dinnerMinutes"  // default 1170 = 7:30pm

    static let weighinEnabled = "notif.weighin.enabled"
    static let weighinWeekday = "notif.weighin.weekday"       // default 7 = Saturday (Calendar weekday)
    static let weighinMinutes = "notif.weighin.minutes"       // default 480 = 8:00am

    static let registrationDefaults: [String: Any] = [
        briefEnabled: true,
        briefMinutes: 450,
        workoutEnabled: true,
        sleepEnabled: true,
        mealsEnabled: true,
        mealsBreakfastMinutes: 480,
        mealsLunchMinutes: 765,
        mealsSnackMinutes: 960,
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
        registerCategories()
    }

    /// Registers the meal-reminder category's "Log what I ate" text-input
    /// action so the notification itself can quick-log a meal without
    /// opening the app (see `didReceive` below → `QuickLogNotificationRouter
    /// .route(response:)`). Other reminder categories (brief, weigh-in) get
    /// no actions — plain-tap only, unchanged.
    private func registerCategories() {
        let logMealAction = UNTextInputNotificationAction(
            identifier: NotificationIdentifiers.logMealAction,
            title: "Log what I ate",
            options: [],
            textInputButtonTitle: "Log",
            textInputPlaceholder: "e.g. two eggs and toast"
        )
        let mealCategory = UNNotificationCategory(
            identifier: NotificationIdentifiers.mealReminderCategory,
            actions: [logMealAction],
            intentIdentifiers: [],
            options: []
        )
        let reminderCategory = UNNotificationCategory(
            identifier: NotificationIdentifiers.reminderCategory,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        let nudgeCategory = UNNotificationCategory(
            identifier: NotificationIdentifiers.nudgeCategory,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([mealCategory, reminderCategory, nudgeCategory])
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
        // Screenshot harness (`-VitalFixture <scenario>`): never show the
        // system notification prompt — a blocking system alert would stall
        // `XCUIScreen.main.screenshot()`. Compiled out of Release entirely.
        #if DEBUG
        guard !FixtureMode.isActive else { return false }
        #endif
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshPermissionState()
        if granted { UIApplication.shared.registerForRemoteNotifications() }
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

    // MARK: - Quick log (meal reminder's "Log what I ate" text action)

    /// `didReceive`'s entry point: wraps `handleQuickLogAction` in a
    /// `beginBackgroundTask`/`endBackgroundTask` pair for the extra runtime
    /// iOS grants a background-launched process doing real work — the
    /// "Log what I ate" text-input action has no `.foreground` option, so
    /// without this the process can be suspended mid-request. Ends the
    /// background task on every path (success, thrown error, or the
    /// system's own expiration handler), and `didReceive` awaits this before
    /// calling `completionHandler()` — see that method's comment.
    func runQuickLogAction(text: String, service: QuickLogServicing = LiveQuickLogService()) async {
        let bgTask = BackgroundTaskGuard()
        bgTask.begin(name: "quickLog")
        defer { bgTask.end() }
        await handleQuickLogAction(text: text, service: service)
    }

    /// Runs `QuickLogNotificationRouter.route(response:)`'s decision: quick-
    /// logs `text` via `QuickLogServicing`, then posts a local confirmation
    /// notification ("Logged X · N kcal"). Best-effort/silent on failure —
    /// a notification action has no UI to show an error in, and quick logs
    /// are meant to never block (see `POST /api/meals/quick`'s doc comment);
    /// the user can always retry from the app. Bounded by
    /// `APIClient.quickLogMeal`'s own 15s `timeoutInterval` (see that
    /// method), so this can't hang indefinitely and outlast the background
    /// task's runtime.
    func handleQuickLogAction(text: String, service: QuickLogServicing = LiveQuickLogService()) async {
        guard let result = try? await service.quickLog(text: text) else { return }
        postQuickLogConfirmation(name: result.name, kcal: result.kcal)
    }

    private func postQuickLogConfirmation(name: String, kcal: Int) {
        let content = UNMutableNotificationContent()
        content.title = Self.quickLogConfirmationTitle(name: name, kcal: kcal)
        content.sound = nil
        let request = UNNotificationRequest(
            identifier: "vital.quicklog.confirm.\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        center.add(request)
    }

    /// Pure, testable formatter for the quick-log confirmation notification's
    /// title — e.g. `quickLogConfirmationTitle(name: "2 eggs and toast", kcal: 320)`
    /// → `"Logged 2 eggs and toast · 320 kcal"`.
    static func quickLogConfirmationTitle(name: String, kcal: Int) -> String {
        "Logged \(name) · \(kcal) kcal"
    }
}

// MARK: - Background task guard

/// Thin `beginBackgroundTask`/`endBackgroundTask` wrapper that guarantees
/// `endBackgroundTask` fires exactly once, however it's triggered — either
/// `end()` (the normal `defer` path in `runQuickLogAction`) or the system's
/// own expiration handler (which UIKit is explicitly documented to be able
/// to invoke on any thread, unlike most `UIApplication` APIs — hence the
/// lock rather than assuming `@MainActor`). Calling `endBackgroundTask`
/// twice for one identifier is a hard crash on-device, so this is not
/// optional belt-and-suspenders — it's the whole point of the type.
private final class BackgroundTaskGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var id: UIBackgroundTaskIdentifier = .invalid
    private var ended = false

    func begin(name: String) {
        let taskId = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.end()
        }
        lock.lock()
        id = taskId
        lock.unlock()
    }

    func end() {
        lock.lock()
        defer { lock.unlock() }
        guard !ended, id != .invalid else { return }
        ended = true
        UIApplication.shared.endBackgroundTask(id)
    }
}

// MARK: - Quick-log notification routing (pure, testable)

/// What `didReceive` should do with a notification response — extracted so
/// the meal-reminder category's "Log what I ate" text-input action can be
/// unit-tested without a live `UNUserNotificationCenter`/`UNNotificationResponse`
/// subclass round-trip.
enum QuickLogNotificationRoute: Equatable {
    case quickLog(text: String)
    case none
}

/// The handful of fields `route` actually needs, lifted out of a live
/// `UNNotificationResponse`/`UNTextInputNotificationResponse` — neither has
/// a public initializer, so the routing *decision* is tested against this
/// plain struct instead (see `route(response:)`'s thin wrapper below, and
/// `QuickLogNotificationRouterTests`).
struct QuickLogNotificationInput: Equatable {
    let categoryIdentifier: String
    let actionIdentifier: String
    /// The typed text, when this response came from a text-input action
    /// (`UNTextInputNotificationResponse.userText`); nil for a plain tap.
    let userText: String?
}

enum QuickLogNotificationRouter {
    /// Only routes the meal-reminder category's `logMealAction` with
    /// non-empty trimmed text — any other category/action/nil text (a plain
    /// tap, a different category's action) is `.none`. Pure + testable.
    static func route(_ input: QuickLogNotificationInput) -> QuickLogNotificationRoute {
        guard input.categoryIdentifier == NotificationIdentifiers.mealReminderCategory,
              input.actionIdentifier == NotificationIdentifiers.logMealAction,
              let userText = input.userText
        else {
            return .none
        }
        let trimmed = userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .none }
        return .quickLog(text: trimmed)
    }

    /// Live entry point — lifts the fields `route(_:)` needs out of a real
    /// `UNNotificationResponse` and delegates to it.
    static func route(response: UNNotificationResponse) -> QuickLogNotificationRoute {
        route(QuickLogNotificationInput(
            categoryIdentifier: response.notification.request.content.categoryIdentifier,
            actionIdentifier: response.actionIdentifier,
            userText: (response as? UNTextInputNotificationResponse)?.userText
        ))
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
        // Refresh the bell badge while the app is foregrounded and a push
        // lands — banner presentation below is unaffected either way.
        Task { @MainActor in await NotificationsViewModel.shared.refresh() }
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Computed synchronously, on this call's thread, BEFORE the Task:
        // `UNNotificationResponse` isn't `Sendable`, so it must not be
        // captured into the Task below. `route(response:)` itself is a pure,
        // nonisolated static function (no actor hop needed for this).
        let info = response.notification.request.content.userInfo
        let route = QuickLogNotificationRouter.route(response: response)

        Task { @MainActor in
            NotificationDelegateRouter.route(info)
            // The "Log what I ate" text-input action has no `.foreground`
            // option, so iOS runs this in the background with no guaranteed
            // extra runtime beyond what `beginBackgroundTask` buys — and
            // critically, `completionHandler()` must NOT fire until the
            // quick-log network call (and its confirmation notification)
            // have actually finished, or iOS can suspend the process the
            // instant this call returns, silently dropping the meal. See
            // `handleQuickLogAction` for the timeout that upper-bounds this.
            if case .quickLog(let text) = route {
                await NotificationManager.shared.runQuickLogAction(text: text)
            }
            completionHandler()
        }
    }
}
