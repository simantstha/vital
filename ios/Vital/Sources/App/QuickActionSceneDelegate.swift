import UIKit

/// Shared Home Screen quick-action handling — the "Log a meal" quick action
/// registered by `AppDelegate.application(_:didFinishLaunchingWithOptions:)`
/// and actually delivered to `QuickActionSceneDelegate` below. Factored out
/// so both of that delegate's two delivery points (a cold-launch
/// `connectionOptions.shortcutItem` and a warm/backgrounded
/// `windowScene(_:performActionFor:)` tap) route through one function
/// instead of duplicating the match-and-route logic.
enum QuickActionHandling {
    static let logMealShortcutType = "com.simantstha.vital.quickAction.logMeal"

    /// Routes a matching shortcut item to `AppRouter.logDeepLink` (picked up
    /// by `RootTabView`/`TodayView` — see `LogDeepLinkRoute`). Returns
    /// whether `shortcutItem` matched, mirroring
    /// `windowScene(_:performActionFor:completionHandler:)`'s `Bool`
    /// contract (`true` = handled).
    @discardableResult
    @MainActor
    static func handle(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        guard shortcutItem.type == logMealShortcutType else { return false }
        AppRouter.shared.logDeepLink = .compose(.text)
        return true
    }
}

/// The Home Screen quick action's actual delivery point in a SwiftUI
/// (scene-based) app lifecycle.
///
/// SwiftUI's `App`/`WindowGroup` runs on the modern scene lifecycle, and
/// `UIApplicationDelegate`'s legacy `application(_:performActionFor:
/// completionHandler:)` plus `launchOptions[.shortcutItem]` in
/// `didFinishLaunchingWithOptions` are pre-scenes API that are simply never
/// invoked once the app is scene-based — an earlier version of
/// `AppDelegate` here claimed the opposite ("no custom UIWindowSceneDelegate
/// is registered, so UIKit forwards this to the app delegate"), which was
/// wrong and meant the Home Screen quick action silently did nothing beyond
/// opening the app. Quick actions are delivered to the SCENE delegate
/// instead:
///   - a cold launch's shortcut item arrives via `scene(_:willConnectTo:
///     options:)`'s `connectionOptions.shortcutItem` — `launchOptions
///     [.shortcutItem]` in `AppDelegate` is ALWAYS nil for this, even on a
///     genuine quick-action cold launch;
///   - a warm/backgrounded tap arrives via `windowScene(_:performActionFor:
///     completionHandler:)`.
///
/// `AppDelegate.application(_:configurationForConnecting:options:)` installs
/// this as the connecting scene's delegate class. SwiftUI still owns and
/// manages the actual `UIWindow` for this scene — this type deliberately
/// never creates or assigns a `window`, it only observes the quick-action
/// delivery points above and routes them through `QuickActionHandling`.
@MainActor
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        if let shortcutItem = connectionOptions.shortcutItem {
            QuickActionHandling.handle(shortcutItem)
        }
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(QuickActionHandling.handle(shortcutItem))
    }
}
