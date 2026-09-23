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
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
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
