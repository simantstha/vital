#if DEBUG
import Foundation
import SwiftUI
import UIKit

/// Debug-only screenshot-harness support (see `VitalUITests`). Active only
/// when the app is launched with `-VitalFixture <scenario>` — never true for
/// a real user, a TestFlight build, or the ordinary `VitalTests` unit-test
/// run, since this whole file (and everything that reads it) compiles out of
/// Release entirely.
///
/// When active, `AuthViewModel` skips real Sign in with Apple / dev sign-in
/// and lands straight on the tab UI (or the onboarding flow, for the
/// `onboarding` scenario), every system permission prompt that could
/// otherwise block `XCUIScreen.main.screenshot()` is skipped (see the
/// `requestAuthorization`/`requestPermission`/`requestAccess`/
/// `requestPermissions` guards in `HealthKitManager`, `NotificationManager`,
/// `CalendarEventsProvider`, and `SpeechTranscriber`), and every network
/// response is served by `FixtureURLProtocol` from `FixtureData` instead of
/// hitting a real backend — see docs/CI-TESTFLIGHT.md.
enum FixtureMode {
    enum Scenario: String, CaseIterable {
        /// Fresh account, nothing synced yet — Today shows the calibrating
        /// state and an empty plan/insight.
        case newUser = "new_user"
        /// Established weight-loss account: a week of logged meals, a
        /// downward weight trend, a full plan, and a brief coach insight.
        case weightLoss = "weight_loss"
        /// Established muscle-gain account.
        case muscle = "muscle"
        /// Established endurance account, with logged runs.
        case endurance = "endurance"
        /// Every fixture endpoint responds 500 — exercises every screen's
        /// error state.
        case serverError = "server_error"
        /// Signed in but not yet onboarded — lands on the onboarding
        /// questionnaire instead of the tab UI.
        case onboarding = "onboarding"
    }

    /// Parsed once from the process's launch arguments. `nil` under any
    /// normal launch (a real user, TestFlight, `xcodebuild test -scheme
    /// Vital`) — nothing ever passes `-VitalFixture` outside
    /// `VitalUITests`/`VitalScreenshots`.
    static let scenario: Scenario? = {
        let args = ProcessInfo.processInfo.arguments
        guard let flagIndex = args.firstIndex(of: "-VitalFixture"),
              args.indices.contains(flagIndex + 1)
        else { return nil }
        return Scenario(rawValue: args[flagIndex + 1])
    }()

    static var isActive: Bool { scenario != nil }

    /// A stable stand-in session token — every code path that merely checks
    /// "is a session present" (APIClient's Authorization header,
    /// KeychainStore, AppRouter's session scoping) behaves exactly like a
    /// real signed-in session. It's never sent anywhere real: every request
    /// in fixture mode is caught by `FixtureURLProtocol` before it reaches
    /// the network.
    static let fakeSessionToken = "vital-fixture-session-token"

    /// Registers `FixtureURLProtocol` on a specific `URLSessionConfiguration`.
    ///
    /// `URLProtocol.registerClass` (called from `AppDelegate`) is documented
    /// to affect `NSURLConnection` and sessions built from the *default*
    /// configuration — in practice that reliably covers `URLSession.shared`,
    /// but a `URLSession(configuration:)` built from its own
    /// `URLSessionConfiguration.default` copy (as `APIClient` does, so it can
    /// attach a redirect-guarding delegate) does **not** reliably pick up the
    /// process-wide registration. Every call site that constructs its own
    /// `URLSessionConfiguration` must call this immediately after creating it
    /// — a no-op outside fixture mode, and compiled out of Release entirely.
    static func apply(to config: URLSessionConfiguration) {
        guard isActive else { return }
        config.protocolClasses = [FixtureURLProtocol.self] + (config.protocolClasses ?? [])
    }

    /// Parsed once from `-VitalAppearance dark|light`, which `ScreenshotTests`
    /// passes on every launch. `nil` (system default) under any normal
    /// launch. Exists because XCUITest's usual `-AppleInterfaceStyle Dark`
    /// launch argument is not reliably honored by iOS 26 simulators — CI was
    /// producing `__dark` screenshots that rendered light (several were
    /// byte-identical to their `__light` pair). Forcing the scheme ourselves
    /// from a fixture-only launch arg sidesteps that entirely.
    static let appearance: ColorScheme? = {
        let args = ProcessInfo.processInfo.arguments
        guard let flagIndex = args.firstIndex(of: "-VitalAppearance"),
              args.indices.contains(flagIndex + 1)
        else { return nil }
        switch args[flagIndex + 1] {
        case "dark": return .dark
        case "light": return .light
        default: return nil
        }
    }()

    /// UIKit mirror of `appearance`. `.preferredColorScheme` on the root view
    /// covers ordinary SwiftUI content, but sheets/popovers are sometimes
    /// hosted by a separate `UIWindow`/presentation context that doesn't
    /// reliably re-derive its trait collection from it — `overrideUserInterfaceStyle`
    /// set directly on every window is the belt-and-suspenders fix so every
    /// captured screen (including the diet-logging sheet) matches.
    static var interfaceStyle: UIUserInterfaceStyle {
        switch appearance {
        case .dark: return .dark
        case .light: return .light
        case nil: return .unspecified
        @unknown default: return .unspecified
        }
    }

    /// Applies `interfaceStyle` to every window of every connected scene.
    /// No-op outside `-VitalAppearance` mode. Safe (and cheap) to call
    /// repeatedly — call it again whenever a new window/sheet may have
    /// appeared, since `overrideUserInterfaceStyle` only affects windows that
    /// already exist at the time it's set.
    @MainActor
    static func applyInterfaceStyleToWindows() {
        guard appearance != nil else { return }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                window.overrideUserInterfaceStyle = interfaceStyle
            }
        }
    }
}
#endif
