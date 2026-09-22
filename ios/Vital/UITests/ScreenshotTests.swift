import XCTest

/// Screenshot harness (see docs/CI-TESTFLIGHT.md — "iOS screenshot harness").
///
/// Launches the app once per `FixtureMode.Scenario` × appearance (light/dark)
/// with `-VitalFixture <scenario>` (and `-AppleInterfaceStyle Dark` for the
/// dark pass), which puts the DEBUG-only fixture harness in
/// `ios/Vital/Sources/Fixtures/` in control: real auth/onboarding is skipped,
/// every system permission prompt is suppressed, and every network response
/// comes from a bundled fixture — see `FixtureMode.swift` for exactly what
/// each scenario represents.
///
/// Navigates to every main tab (Today, Coach, Trends, Logs, Profile) plus the
/// diet logging sheet opened from Today, and attaches a PNG for each as an
/// `XCTAttachment` (`lifetime = .keepAlways`, named
/// `<scenario>__<screen>__<light|dark>`) so the `ios-screenshots` PR-checks
/// job can export and publish them.
///
/// Runs only via the dedicated `VitalScreenshots` scheme — never part of the
/// `Vital` scheme's fast unit-test pass (`xcodebuild test -scheme Vital`).
final class ScreenshotTests: XCTestCase {

    override func setUpWithError() throws {
        // A best-effort wait that times out is not itself a hard failure —
        // this harness's job is to capture whatever state the app is
        // actually in, not to assert every fixture wired through correctly.
        continueAfterFailure = true
    }

    // MARK: - One XCTest method per scenario (both appearances)

    func test_newUser() { runScreenshots(scenario: "new_user") }
    func test_weightLoss() { runScreenshots(scenario: "weight_loss") }
    func test_muscle() { runScreenshots(scenario: "muscle") }
    func test_endurance() { runScreenshots(scenario: "endurance") }
    func test_serverError() { runScreenshots(scenario: "server_error") }
    func test_onboarding() { runScreenshots(scenario: "onboarding") }

    // MARK: - Driver

    private func runScreenshots(scenario: String) {
        for appearance in ["light", "dark"] {
            let app = launch(scenario: scenario, dark: appearance == "dark")

            if scenario == "onboarding" {
                captureOnboarding(app, scenario: scenario, appearance: appearance)
            } else {
                captureToday(app, scenario: scenario, appearance: appearance)
                captureDietSheet(app, scenario: scenario, appearance: appearance)
                captureCoach(app, scenario: scenario, appearance: appearance)
                captureTrends(app, scenario: scenario, appearance: appearance)
                captureLogs(app, scenario: scenario, appearance: appearance)
                captureProfile(app, scenario: scenario, appearance: appearance)
            }

            app.terminate()
        }
    }

    private func launch(scenario: String, dark: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        var args = ["-VitalFixture", scenario]
        if dark {
            // Standard simulator/XCUITest trick (also used by fastlane
            // `snapshot`) for forcing dark mode without touching the
            // simulator's own system-wide appearance setting.
            args += ["-AppleInterfaceStyle", "Dark"]
        }
        app.launchArguments = args
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Best-effort wait for any `staticText` whose label contains
    /// `substring` (case-insensitive) — used instead of an exact string match
    /// where the rendered text might be wrapped by a Markdown-rendering view.
    @discardableResult
    private func waitForText(_ app: XCUIApplication, containing substring: String, timeout: TimeInterval = 15) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", substring)
        return app.staticTexts.matching(predicate).firstMatch.waitForExistence(timeout: timeout)
    }

    // MARK: - Screens

    private func captureToday(_ app: XCUIApplication, scenario: String, appearance: String) {
        if scenario == "server_error" {
            _ = app.staticTexts["Couldn't load today's data"].waitForExistence(timeout: 15)
        } else {
            // Only rendered once TodayViewModel.loadState == .loaded — a
            // reliable "today's data actually arrived" signal.
            _ = app.buttons["today.fuelStrip"].waitForExistence(timeout: 15)
        }
        capture(app, name: "\(scenario)__today__\(appearance)")
    }

    /// Opens the diet logging sheet from Today's fuel strip. No-op (no
    /// screenshot) when Today itself failed to load (server_error) — there's
    /// no fuel strip to tap.
    private func captureDietSheet(_ app: XCUIApplication, scenario: String, appearance: String) {
        let fuelStrip = app.buttons["today.fuelStrip"]
        guard fuelStrip.waitForExistence(timeout: 5) else { return }
        fuelStrip.tap()

        // DietSheetView's header renders immediately (it isn't gated on its
        // own network load), so this just confirms the sheet is up.
        _ = app.staticTexts["Diet budget"].waitForExistence(timeout: 10)
        capture(app, name: "\(scenario)__dietSheet__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
        }
    }

    private func captureCoach(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Coach"]
        guard tab.waitForExistence(timeout: 10) else { return }
        tab.tap()

        // The fixture always seeds a restored transcript for every scenario
        // except server_error, where every endpoint 500s and
        // CoachViewModel.loadOpener() falls back to its own hardcoded
        // greeting — either way the Coach tab never stays empty once its
        // `.task` resolves.
        if scenario == "server_error" {
            waitForText(app, containing: "Ask me anything about your health trends")
        } else {
            waitForText(app, containing: "what would you like to dig into")
        }
        capture(app, name: "\(scenario)__coach__\(appearance)")
    }

    private func captureTrends(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Trends"]
        guard tab.waitForExistence(timeout: 10) else { return }
        tab.tap()

        if scenario == "server_error" {
            _ = app.staticTexts["Couldn't load your trends"].waitForExistence(timeout: 15)
        } else {
            // A metric tile's display name — only rendered once the batch
            // fetch resolves (loading shows skeleton placeholders instead).
            _ = app.staticTexts["HRV"].waitForExistence(timeout: 15)
        }
        capture(app, name: "\(scenario)__trends__\(appearance)")
    }

    private func captureLogs(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Logs"]
        guard tab.waitForExistence(timeout: 10) else { return }
        tab.tap()

        if scenario == "server_error" {
            _ = app.staticTexts["Couldn't load your logs"].waitForExistence(timeout: 15)
        } else {
            // The "LOG ENTRIES" section header only renders once /api/logs
            // resolves and the day-pager has a current day to show.
            _ = app.staticTexts["LOG ENTRIES"].waitForExistence(timeout: 15)
        }
        capture(app, name: "\(scenario)__logs__\(appearance)")
    }

    private func captureProfile(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Profile"]
        guard tab.waitForExistence(timeout: 10) else { return }
        tab.tap()

        if scenario == "server_error" {
            _ = app.staticTexts["Couldn't load profile"].waitForExistence(timeout: 15)
        } else {
            // The fixture's account name — only rendered once /api/profile
            // resolves (a ProgressView shows until then).
            _ = app.staticTexts[profileName(for: scenario)].waitForExistence(timeout: 15)
        }
        capture(app, name: "\(scenario)__profile__\(appearance)")
    }

    private func captureOnboarding(_ app: XCUIApplication, scenario: String, appearance: String) {
        _ = app.staticTexts["Meet your coach"].waitForExistence(timeout: 15)
        capture(app, name: "\(scenario)__onboarding__\(appearance)")
    }

    /// Mirrors `FixtureData`'s per-scenario `Profile.name` — kept in sync by
    /// hand since the harness (an app target) and this test target
    /// (VitalUITests) don't share fixture code.
    private func profileName(for scenario: String) -> String {
        switch scenario {
        case "new_user":    return "Jordan Lee"
        case "weight_loss": return "Alex Rivera"
        case "muscle":      return "Sam Okafor"
        case "endurance":   return "Priya Nandy"
        default:            return "Jordan Lee"
        }
    }
}
