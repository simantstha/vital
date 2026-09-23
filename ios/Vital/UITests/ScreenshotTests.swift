import XCTest

/// Screenshot harness (see docs/CI-TESTFLIGHT.md — "iOS screenshot harness").
///
/// Launches the app once per `FixtureMode.Scenario` × appearance (light/dark)
/// with `-VitalFixture <scenario>` and `-VitalAppearance light|dark` (the
/// latter is what actually forces the scheme — see `FixtureMode.appearance` —
/// since XCUITest's usual `-AppleInterfaceStyle Dark`, also passed for the
/// dark pass, is not reliably honored on iOS 26 simulators), which puts the
/// DEBUG-only fixture harness in `ios/Vital/Sources/Fixtures/` in control:
/// real auth/onboarding is skipped,
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
/// Every screen also asserts on fixture-unique content (an insight/persona
/// string, a tile label, the fixture account name, …) before capturing, and
/// asserts the matching error card is absent — this is deliberate: a
/// FixtureURLProtocol regression that stops intercepting APIClient's
/// requests (as happened once — the app then hits real, absent-in-CI
/// networking and every screen quietly renders its "offline"/error state
/// instead) must fail this test, not just produce a wrong-looking but
/// "passing" screenshot.
///
/// Runs only via the dedicated `VitalScreenshots` scheme — never part of the
/// `Vital` scheme's fast unit-test pass (`xcodebuild test -scheme Vital`).
final class ScreenshotTests: XCTestCase {

    override func setUpWithError() throws {
        // Keep going past an assertion failure — a missed screen shouldn't
        // abort the rest of the scenario, and the screenshot right after a
        // failed assertion is often the most useful debugging artifact. This
        // does NOT make failures silent: an `XCTAssert*` failure still fails
        // the test method (and so the CI job) regardless of this setting —
        // see the `XCTAssertTrue`/`XCTFail` calls below, which exist
        // specifically so a fixture that silently fails to load (as
        // FixtureURLProtocol once did) fails the test instead of quietly
        // producing a wrong-looking screenshot.
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
        // `-AppleInterfaceStyle Dark` is the standard simulator/XCUITest
        // trick (also used by fastlane `snapshot`) for forcing dark mode
        // without touching the simulator's own system-wide appearance
        // setting — kept here since it's harmless when honored — but it is
        // NOT reliably honored on iOS 26 simulators, which produced
        // `__dark` screenshots that actually rendered light. `-VitalAppearance`
        // is the authoritative fix: FixtureMode (DEBUG-only) parses it and
        // forces the scheme itself via `.preferredColorScheme` +
        // `overrideUserInterfaceStyle`, so pass it on every launch.
        var args = ["-VitalFixture", scenario, "-VitalAppearance", dark ? "dark" : "light"]
        if dark {
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
        let errorCard = app.staticTexts["Couldn't load today's data"]
        if scenario == "server_error" {
            XCTAssertTrue(errorCard.waitForExistence(timeout: 15),
                           "server_error should show Today's error card [\(scenario)/\(appearance)]")
        } else {
            // Only rendered once TodayViewModel.loadState == .loaded — a
            // reliable "today's data actually arrived" signal.
            XCTAssertTrue(app.buttons["today.fuelStrip"].waitForExistence(timeout: 15),
                           "Today should finish loading (fuel strip) [\(scenario)/\(appearance)]")
            // The fixture's insight text — only ever populated from a
            // successfully-decoded /api/today response, so this fails loudly
            // if FixtureURLProtocol ever again silently stops intercepting
            // APIClient's requests (as happened once — real, absent-in-CI
            // networking then produces the "You're offline" error card
            // instead of this).
            XCTAssertTrue(app.staticTexts[insight(for: scenario)].waitForExistence(timeout: 10),
                           "Today should show the \(scenario) fixture's insight text [\(appearance)] — "
                           + "if this fails, fixtures likely aren't being intercepted")
            XCTAssertFalse(errorCard.exists,
                            "Today should not show its error card once fixtures load [\(scenario)/\(appearance)]")
        }
        capture(app, name: "\(scenario)__today__\(appearance)")
    }

    /// Opens the diet logging sheet from Today's fuel strip. Not attempted
    /// for `server_error` — there's no fuel strip to tap there, and Today's
    /// own assertion above already covers that failure mode.
    private func captureDietSheet(_ app: XCUIApplication, scenario: String, appearance: String) {
        guard scenario != "server_error" else { return }

        let fuelStrip = app.buttons["today.fuelStrip"]
        guard fuelStrip.waitForExistence(timeout: 10) else {
            XCTFail("today.fuelStrip missing — can't open the diet sheet [\(scenario)/\(appearance)]")
            return
        }
        fuelStrip.tap()

        // DietSheetView's header renders immediately (it isn't gated on its
        // own network load), so this just confirms the sheet actually opened.
        XCTAssertTrue(app.staticTexts["Diet budget"].waitForExistence(timeout: 10),
                       "Diet sheet should open from the fuel strip [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__dietSheet__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
        }
    }

    private func captureCoach(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Coach"]
        guard tab.waitForExistence(timeout: 10) else {
            XCTFail("Coach tab bar button never appeared [\(scenario)/\(appearance)]")
            return
        }
        tab.tap()

        // The fixture always seeds a restored transcript for every scenario
        // except server_error, where every endpoint 500s and
        // CoachViewModel.loadOpener() falls back to its own hardcoded
        // greeting — either way the Coach tab never stays empty once its
        // `.task` resolves, so this is fixture-driven either way.
        if scenario == "server_error" {
            XCTAssertTrue(waitForText(app, containing: "Ask me anything about your health trends"),
                           "Coach should fall back to its hardcoded opener when every endpoint 500s [\(appearance)]")
        } else {
            XCTAssertTrue(waitForText(app, containing: "what would you like to dig into"),
                           "Coach should show the fixture-seeded restored message [\(scenario)/\(appearance)]")
        }
        capture(app, name: "\(scenario)__coach__\(appearance)")
    }

    private func captureTrends(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Trends"]
        guard tab.waitForExistence(timeout: 10) else {
            XCTFail("Trends tab bar button never appeared [\(scenario)/\(appearance)]")
            return
        }
        tab.tap()

        if scenario == "server_error" {
            XCTAssertTrue(app.staticTexts["Couldn't load your trends"].waitForExistence(timeout: 15),
                           "server_error should show Trends' error card [\(appearance)]")
        } else {
            // A metric tile's display name — only rendered once the batch
            // fetch resolves (loading shows skeleton placeholders instead).
            XCTAssertTrue(app.staticTexts["HRV"].waitForExistence(timeout: 15),
                           "Trends should render its metric tiles [\(scenario)/\(appearance)]")
        }
        capture(app, name: "\(scenario)__trends__\(appearance)")
    }

    private func captureLogs(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Logs"]
        guard tab.waitForExistence(timeout: 10) else {
            XCTFail("Logs tab bar button never appeared [\(scenario)/\(appearance)]")
            return
        }
        tab.tap()

        if scenario == "server_error" {
            XCTAssertTrue(app.staticTexts["Couldn't load your logs"].waitForExistence(timeout: 15),
                           "server_error should show Logs' error card [\(appearance)]")
        } else {
            // The "LOG ENTRIES" section header only renders once /api/logs
            // resolves and the day-pager has a current day to show.
            XCTAssertTrue(app.staticTexts["LOG ENTRIES"].waitForExistence(timeout: 15),
                           "Logs should render its day-pager [\(scenario)/\(appearance)]")
        }
        capture(app, name: "\(scenario)__logs__\(appearance)")
    }

    private func captureProfile(_ app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons["Profile"]
        guard tab.waitForExistence(timeout: 10) else {
            XCTFail("Profile tab bar button never appeared [\(scenario)/\(appearance)]")
            return
        }
        tab.tap()

        if scenario == "server_error" {
            XCTAssertTrue(app.staticTexts["Couldn't load profile"].waitForExistence(timeout: 15),
                           "server_error should show Profile's error card [\(appearance)]")
        } else {
            // The fixture's account name — only rendered once /api/profile
            // resolves (a ProgressView shows until then).
            XCTAssertTrue(app.staticTexts[profileName(for: scenario)].waitForExistence(timeout: 15),
                           "Profile should show the \(scenario) fixture's name [\(appearance)]")
        }
        capture(app, name: "\(scenario)__profile__\(appearance)")
    }

    private func captureOnboarding(_ app: XCUIApplication, scenario: String, appearance: String) {
        // OnboardingFlowView's Basics step title (subtitle: "This helps your
        // coach personalize everything that follows.") — not "Meet your
        // coach", which is the later CoachIntro step this harness never reaches.
        XCTAssertTrue(app.staticTexts["Let's get to know you"].waitForExistence(timeout: 15),
                       "Onboarding's Basics step should render [\(appearance)]")
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

    /// Mirrors `FixtureData`'s per-scenario `Profile.insight` verbatim — see
    /// `profileName(for:)`'s doc comment for why this is hand-duplicated
    /// rather than shared.
    private func insight(for scenario: String) -> String {
        switch scenario {
        case "new_user":
            return "Keep logging — a few more days and I'll start spotting real patterns."
        case "weight_loss":
            return "You're down 1.2kg this week and sleep is holding steady — keep the deficit gentle through the weekend."
        case "muscle":
            return "Protein's on target four days running and yesterday's lift was a PR on squat volume — stay the course."
        case "endurance":
            return "This week's long run held goal pace with a lower average HR than last week — aerobic base is building nicely."
        default:
            return ""
        }
    }
}
