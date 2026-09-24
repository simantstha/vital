import SwiftUI
import UIKit
import UserNotifications

/// Registers ongoing background HealthKit sync (`enableBackgroundDelivery` +
/// `HKObserverQuery` per type) before the app finishes launching, as Apple
/// requires for delivery to fire while backgrounded/terminated. Guarded on a
/// signed-in session so it never registers observers for a signed-out user —
/// there's no per-user data to sync yet, and no point spending the
/// background-delivery budget on a fresh install sitting at the sign-in
/// screen.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Home Screen quick action ("quick log" PRD) — registered dynamically
    /// below rather than via a static `UIApplicationShortcutItems` Info.plist
    /// entry, since project.yml/Info.plist changes are out of scope for this
    /// slice. Routes to the same `vital://log?mode=text` flow as
    /// `LogDeepLinkRoute.compose(.text)`.
    static let logMealShortcutType = "com.simantstha.vital.quickAction.logMeal"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        application.shortcutItems = [
            UIApplicationShortcutItem(
                type: Self.logMealShortcutType,
                localizedTitle: "Log a meal",
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "fork.knife")
            ),
        ]
        // Cold launch via a long-press quick action tap — `performActionFor`
        // below only fires for a warm/backgrounded launch, so a cold launch
        // must be handled here instead (returning `true` either way; nothing
        // about this launch depends on suppressing the rest of startup).
        if let shortcutItem = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
            handleQuickAction(shortcutItem)
        }
        // Must run before anything else touches the network: the screenshot
        // harness (VitalUITests/VitalScreenshots) launches with `-VitalFixture
        // <scenario>` and needs every request intercepted before AuthViewModel
        // or RootView's `.task` fire their first ones. No-op (and compiled out
        // entirely in Release) under every normal launch. See
        // Fixtures/FixtureURLProtocol.swift.
        #if DEBUG
        FixtureURLProtocol.registerIfNeeded()
        #endif

        // Must run before any token reader (below, AuthViewModel.init,
        // APIClient): drops a session token inherited from a previous install,
        // since the Keychain survives app deletion but UserDefaults don't.
        KeychainStore.purgeIfFreshInstall()

        UNUserNotificationCenter.current().delegate = NotificationManager.shared
        AppRouter.shared.activateSession(token: KeychainStore.loadSessionToken())
        if let info = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            NotificationDelegateRouter.route(info)
        }
        Task { @MainActor in
            await NotificationManager.shared.refreshPermissionState()
            if NotificationManager.shared.permissionState == .authorized {
                application.registerForRemoteNotifications()
            }
        }

        if KeychainStore.loadSessionToken() != nil {
            Task { @MainActor in
                await HealthSyncCoordinator.shared.registerBackgroundDelivery()
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushNotificationService.shared.register(token: deviceToken) }
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        Task { @MainActor in NotificationDelegateRouter.route(userInfo) }
        completionHandler(.noData)
    }

    /// Warm/backgrounded-launch quick-action tap. No custom
    /// `UIWindowSceneDelegate` is registered, so UIKit forwards this to the
    /// app delegate (see Apple's `performActionFor` doc note on scene-based
    /// apps without one).
    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(handleQuickAction(shortcutItem))
    }

    @discardableResult
    func handleQuickAction(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        guard shortcutItem.type == Self.logMealShortcutType else { return false }
        AppRouter.shared.logDeepLink = .compose(.text)
        return true
    }
}

@main
struct VitalApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var router = AppRouter.shared

    var body: some Scene {
        WindowGroup {
            // No forced color scheme — Vital follows the system appearance so
            // the adaptive Liquid Glass palette renders correctly in light &
            // dark. Except in the DEBUG-only screenshot harness, launched
            // with `-VitalAppearance dark|light`: XCUITest's usual
            // `-AppleInterfaceStyle` launch argument isn't reliably honored
            // by iOS 26 simulators, so the harness forces the scheme itself
            // here instead — see FixtureMode.appearance. `nil` under any
            // normal launch, so this is a no-op otherwise.
            RootView()
                .environmentObject(router)
                #if DEBUG
                .preferredColorScheme(FixtureMode.appearance)
                #endif
        }
    }
}
