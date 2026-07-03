import SwiftUI
import UIKit

/// Registers ongoing background HealthKit sync (`enableBackgroundDelivery` +
/// `HKObserverQuery` per type) before the app finishes launching, as Apple
/// requires for delivery to fire while backgrounded/terminated. Guarded on a
/// signed-in session so it never registers observers for a signed-out user —
/// there's no per-user data to sync yet, and no point spending the
/// background-delivery budget on a fresh install sitting at the sign-in
/// screen.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if KeychainStore.loadSessionToken() != nil {
            Task { @MainActor in
                await HealthSyncCoordinator.shared.registerBackgroundDelivery()
            }
        }
        return true
    }
}

@main
struct VitalApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            // No forced color scheme — Vital follows the system appearance so
            // the adaptive Liquid Glass palette renders correctly in light & dark.
            RootView()
        }
    }
}
