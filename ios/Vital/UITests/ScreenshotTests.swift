import XCTest
import CoreGraphics

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

        // System alerts (permission prompts, Apple Intelligence sheets, ...)
        // that appear over the app. Prefer dismiss-style buttons: the harness
        // never wants to grant or follow anything.
        addUIInterruptionMonitor(withDescription: "System alert") { alert in
            for label in ["Not Now", "Don't Allow", "Later", "Close", "Dismiss", "Cancel", "OK"] {
                let button = alert.buttons[label]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
    }

    /// Simulator notification banners (e.g. "Apple Intelligence") draw over
    /// the app in screenshots and are not UI interruptions XCTest reports.
    /// Swipe any visible banner up and wait (at most `timeout`) for it to go
    /// away. Best-effort: never fails the test, no-op without a banner.
    private func dismissSystemBanners(timeout: TimeInterval = 3) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.otherElements["NotificationShortLookView"].firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        while banner.exists && Date() < deadline {
            // Dragging the banner up off the top edge dismisses it.
            let start = banner.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let end = banner.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: -1.5))
            start.press(forDuration: 0.05, thenDragTo: end)
            Thread.sleep(forTimeInterval: 0.4)
        }
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
                captureLiftLogger(app, scenario: scenario, appearance: appearance)
                captureCoach(app, scenario: scenario, appearance: appearance)
                captureTrends(app, scenario: scenario, appearance: appearance)
                captureGoalProgress(app, scenario: scenario, appearance: appearance)
                captureWeeklyReview(app, scenario: scenario, appearance: appearance)
                captureLogs(app, scenario: scenario, appearance: appearance)
                captureProfile(app, scenario: scenario, appearance: appearance)
                captureMemory(app, scenario: scenario, appearance: appearance)
                captureDevices(app, scenario: scenario, appearance: appearance)
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
        dismissSystemBanners()
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

    /// Top clearance used only for elements inside scrolled main content
    /// (roughly the status bar height). Sheet / nav-bar buttons never go
    /// through this check — see `tapWhenHittable`'s direct-tap path.
    private static let topChromeMargin: CGFloat = 54

    /// Bottom limit for content: just above the tab bar (8pt margin) when one
    /// exists, else 80% of the screen height.
    private func bottomChromeLimit(app: XCUIApplication) -> CGFloat {
        let tabBar = app.tabBars.firstMatch
        return tabBar.exists ? tabBar.frame.minY - 8 : app.frame.maxY * 0.8
    }

    /// True when `element`'s frame sits fully between the top margin (status
    /// bar, 54pt) and the bottom chrome (see `bottomChromeLimit`).
    private func isClearOfChrome(_ element: XCUIElement, app: XCUIApplication) -> Bool {
        let frame = element.frame
        return frame.minY >= app.frame.minY + Self.topChromeMargin
            && frame.maxY <= bottomChromeLimit(app: app)
    }

    /// Find-by-scrolling: if `element` is not in the accessibility hierarchy
    /// (lazy containers don't build rows until they're near the viewport),
    /// drag the content up in small steps, checking existence after each,
    /// up to `maxSwipes`. Returns whether the element exists.
    @discardableResult
    private func scrollUntilExists(_ element: XCUIElement, app: XCUIApplication, maxSwipes: Int = 6) -> Bool {
        if element.exists || element.waitForExistence(timeout: 2) { return true }
        var swipes = 0
        while swipes < maxSwipes {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: end)
            swipes += 1
            if element.waitForExistence(timeout: 1) { return true }
        }
        return element.exists
    }

    /// Scrolls just far enough to put `element` mid-screen, correcting in
    /// either direction (so it never overshoots off the top and stays there),
    /// until it is hittable and clear of both the top and bottom chrome.
    /// If the element isn't in the hierarchy yet it is first found by
    /// scrolling (`scrollUntilExists`). Returns whether it got there within
    /// `maxSwipes` drags.
    @discardableResult
    private func scrollIntoComfortableView(_ element: XCUIElement, app: XCUIApplication, maxSwipes: Int = 5) -> Bool {
        guard scrollUntilExists(element, app: app) else { return false }
        var swipes = 0
        while !(element.isHittable && isClearOfChrome(element, app: app)) && swipes < maxSwipes {
            let screenHeight = max(app.frame.height, 1)
            // Move the element's centre toward 45% of the screen height; the
            // drag distance is capped so a single nudge can't fling it past.
            let delta = (screenHeight * 0.45 - element.frame.midY) / screenHeight
            let clamped = min(max(delta, -0.3), 0.3)
            let sign: CGFloat = clamped < 0 ? -1 : 1
            // Always drag by at least 0.1 so a near-miss still moves.
            let move = sign * max(abs(clamped), 0.1)
            let startY: CGFloat = 0.55
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY + move))
            start.press(forDuration: 0.05, thenDragTo: end)
            swipes += 1
        }
        return element.isHittable && isClearOfChrome(element, app: app)
    }

    /// True when `element` is hittable, fully inside the app window, and
    /// clear of the bottom chrome. No extra top margin, so sheet / nav-bar
    /// buttons (Done / Close, y of roughly 60-110) qualify.
    private func isDirectlyTappable(_ element: XCUIElement, app: XCUIApplication) -> Bool {
        guard element.exists, element.isHittable else { return false }
        let frame = element.frame
        return app.frame.contains(frame) && frame.maxY <= bottomChromeLimit(app: app)
    }

    /// Taps `element` once it is safely tappable — never a bare `.tap()` on a
    /// coordinate that might be off-screen or obscured. `isHittable` only
    /// means the centre point is on screen; on iOS 26 the floating Liquid
    /// Glass tab bar (and Today's mic FAB) overlay the scroll content, so an
    /// element just above/under that chrome can report `isHittable` while the
    /// tap is absorbed by whatever is layered on top.
    ///
    /// 1. Direct path: if the element already exists, is hittable, fully
    ///    inside the app window and above the tab bar (8pt margin), tap it
    ///    immediately. This is what sheet / nav-bar buttons take.
    /// 2. Otherwise find it by scrolling (lazy content), then nudge it into
    ///    comfortable view (top margin 54pt, bottom tab-bar clearance) with
    ///    bounded, gentle drags (never a full `swipeUp()`, which can
    ///    overshoot), and tap.
    /// Fails with a `description`-labeled message if it never appears or
    /// never becomes tappable.
    private func tapWhenHittable(
        _ element: XCUIElement,
        app: XCUIApplication,
        maxSwipes: Int = 3,
        timeout: TimeInterval = 10,
        description: String
    ) {
        // Sheets animate in, so give the direct path a short grace window.
        if element.waitForExistence(timeout: 2), isDirectlyTappable(element, app: app) {
            tapAvoidingFab(element)
            return
        }

        guard scrollUntilExists(element, app: app) || element.waitForExistence(timeout: timeout) else {
            XCTFail("\(description) never appeared to tap")
            return
        }

        if isDirectlyTappable(element, app: app) {
            tapAvoidingFab(element)
            return
        }

        guard scrollIntoComfortableView(element, app: app, maxSwipes: maxSwipes), element.isHittable else {
            XCTFail("\(description) exists but never became hittable and fully on screen "
                     + "(clear of the tab bar) after \(maxSwipes) scroll attempts")
            return
        }

        tapAvoidingFab(element)
    }

    /// Wide elements (full-width rows) can sit under Today's floating mic FAB
    /// (bottom-right, ~60pt), which absorbs a centre/right tap. Tap those at
    /// 25% of their width instead; small elements (sheet buttons) tap direct.
    private func tapAvoidingFab(_ element: XCUIElement) {
        if element.frame.width > 200 {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).tap()
        } else {
            element.tap()
        }
    }

    /// Waits for an element to exist and become hittable with a stable frame
    /// across a 0.5s window. XCUITest cannot detect opacity changes, so when
    /// the app's `Theme.Motion.appear` fade animation (0.25s `easeOut`) is
    /// cross-fading content at this element, a frame-stability check cannot
    /// distinguish mid-fade from fully-faded. This 0.5s window (double the
    /// fade duration) ensures cross-faded content has finished appearing by
    /// the time the method returns. If `Theme.Motion.appear` is increased,
    /// raise this window accordingly.
    ///
    /// Fails the test with a clear message if the element never settles
    /// within the timeout.
    private func waitForSettled(
        _ element: XCUIElement,
        timeout: TimeInterval = 5.0,
        description: String
    ) {
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("\(description) never appeared to settle")
            return
        }

        let deadline: Date = Date(timeIntervalSinceNow: timeout)
        var previousFrame: CGRect? = nil
        let pollInterval: TimeInterval = 0.5

        while Date.now < deadline {
            guard element.isHittable else {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: pollInterval))
                continue
            }

            let currentFrame: CGRect = element.frame
            if let prev = previousFrame, prev == currentFrame {
                // Frame is stable — element has settled
                return
            }

            previousFrame = currentFrame
            RunLoop.current.run(until: Date(timeIntervalSinceNow: pollInterval))
        }

        XCTFail("\(description) never settled within \(timeout)s "
                + "— either it never became hittable or its frame kept changing")
    }

    /// Taps the named tab bar button and waits until it actually reports
    /// `isSelected` before returning — a bare `.tap()` can be swallowed
    /// (e.g. absorbed by a sheet still mid-dismiss animation, PR #208's
    /// `captureCoach` failure) and XCUITest doesn't fail on that by itself,
    /// so the next screen's assertions silently run against whatever tab was
    /// already showing instead. Retries the tap exactly once if the first
    /// one didn't register, then fails loudly (naming the tab and the
    /// scenario/appearance) if it still isn't selected.
    private func switchToTab(_ name: String, app: XCUIApplication, scenario: String, appearance: String) {
        let tab = app.tabBars.buttons[name]
        guard tab.waitForExistence(timeout: 10) else {
            XCTFail("\(name) tab bar button never appeared [\(scenario)/\(appearance)]")
            return
        }

        func waitUntilSelected() -> Bool {
            let selected = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "isSelected == true"),
                object: tab
            )
            return XCTWaiter().wait(for: [selected], timeout: 5) == .completed
        }

        tab.tap()
        if waitUntilSelected() { return }

        // The first tap may have been absorbed by something still animating
        // off screen (a dismissing sheet, a transition) — one retry covers
        // that without masking a real failure to switch tabs at all.
        tab.tap()
        guard waitUntilSelected() else {
            XCTFail("\(name) tab never became selected after tapping it twice [\(scenario)/\(appearance)]")
            return
        }
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
            XCTAssertTrue(waitForText(app, containing: insight(for: scenario), timeout: 10),
                           "Today should show the \(scenario) fixture's insight text [\(appearance)] — "
                           + "if this fails, fixtures likely aren't being intercepted")
            XCTAssertFalse(errorCard.exists,
                            "Today should not show its error card once fixtures load [\(scenario)/\(appearance)]")

            if scenario == "weight_loss" {
                // The weight_loss hero (§4.1) — a fixture-unique trend delta
                // string, only ever produced once `/api/weight-log` decodes
                // and `WeightHeroLogic.weeklyChangeText` computes it, so this
                // fails loudly the same way the insight assertion above does
                // if that endpoint's fixture interception ever regresses.
                XCTAssertTrue(waitForText(app, containing: "0.6 kg/wk over 4 weeks"),
                               "Today's weight_loss hero should show the established trend's weekly change [\(appearance)]")
                XCTAssertTrue(app.buttons["today.weighInChip"].waitForExistence(timeout: 10),
                               "Today's weight_loss hero should show the weigh-in chip [\(appearance)]")
            }

            if scenario == "muscle" {
                // The muscle hero (§4.1) — today's move-kind plan item's
                // title plus the protein have/goal line, both fixture-unique
                // (`FixtureData.muscle`'s "Lower-body strength" row and
                // 158/190 protein numbers) and only rendered once `/api/plan`
                // and `/api/today` both decode.
                XCTAssertTrue(waitForText(app, containing: "Lower-body strength"),
                               "Today's muscle hero should show today's strength session [\(appearance)]")
                XCTAssertTrue(waitForText(app, containing: "Protein 158 / 190 g"),
                               "Today's muscle hero should show the protein have/goal line [\(appearance)]")
                // The "last time" lift line — fixture-unique "3×5" set/rep
                // count (`FixtureData.trainingSummary`'s squat lastLift),
                // only rendered once `/api/training/summary` decodes
                // (#202) — fails loudly if that endpoint's fixture
                // interception ever regresses.
                XCTAssertTrue(waitForText(app, containing: "3×5"),
                               "Today's muscle hero should show the last-lift set×rep line [\(appearance)]")
                XCTAssertTrue(waitForText(app, containing: "140 kg"),
                               "Today's muscle hero should show the last-lift weight [\(appearance)]")
                // "This week" — 2 of 4 planned sessions (fixture-unique).
                XCTAssertTrue(waitForText(app, containing: "2 of 4 sessions this week"),
                               "Today's muscle hero should show the this-week session count [\(appearance)]")
                // The goal line under the hero: the fixture's verdict is
                // `behind` (adherence 9 of 16), so it leads with the cause and
                // the next step instead of "1 of 4 kg gained · Squat …". The hero
                // above shows "2 of 4 sessions this week", so the next step is the
                // concrete remainder: "2 more by Sun" (not the generic "aim for 4").
                let goalLine = app.descendants(matching: .any).matching(identifier: "goalProgress.todayLine").firstMatch
                XCTAssertTrue(goalLine.waitForExistence(timeout: 10),
                               "Today's muscle hero should show the goal-progress line [\(appearance)]")
                func goalLineLabel() -> String { goalLine.label.replacingOccurrences(of: "\u{00A0}", with: " ") }
                // The training summary can land a beat after the goal line; poll briefly.
                let goalLineDeadline = Date().addingTimeInterval(10)
                while !goalLineLabel().contains("2 more by Sun") && Date() < goalLineDeadline {
                    Thread.sleep(forTimeInterval: 0.3)
                }
                let goalLineText = goalLineLabel()
                XCTAssertTrue(goalLineText.contains("9 of 16 sessions in 4 wk · 2 more by Sun"),
                               "Muscle goal line should lead with the sessions-behind cause and the remaining sessions, got \"\(goalLineText)\" [\(appearance)]")
            }

            if scenario == "endurance" {
                // The endurance hero (§4.1) — the readiness word (deterministic
                // from the fixture's flat `trendsBatch` baseline: every
                // metric lands `.normal`, a net-0 score, which reads as
                // "Good to train" — see `EnduranceHeroLogic.readinessWord`'s
                // doc comment; the fixture's late hard run can also push HRV
                // low enough for "Recover today", so every word the app can
                // produce is accepted) and today's move-kind session title.
                let readinessWords = ["Ready to push", "Good to train", "Keep it easy", "Recover today"]
                XCTAssertTrue(readinessWords.contains { waitForText(app, containing: $0, timeout: 3) },
                               "Today's endurance hero should show a readiness word (one of \(readinessWords)) [\(appearance)]")
                XCTAssertTrue(waitForText(app, containing: "10km tempo run"),
                               "Today's endurance hero should show today's session [\(appearance)]")
                // Sessions line now shows session count only (e.g., "3 sessions this week"),
                // while distance appears in a separate progress line.
                XCTAssertTrue(waitForText(app, containing: "sessions"),
                               "Today's endurance hero should show the sessions line [\(appearance)]")
                // Distance progress line in the format "X.X of 30 km this week"
                // (fixture's stable target: 30 km/week; weekday-dependent value: X.X km done).
                XCTAssertTrue(waitForText(app, containing: "of 30 km this week"),
                               "Today's endurance hero should show distance progress with the weekly target [\(appearance)]")
                // Race countdown line ("Half marathon · 12 weeks to go") from the fixture's race.
                XCTAssertTrue(waitForText(app, containing: "Half marathon"),
                               "Today's endurance hero should show the race countdown [\(appearance)]")
                // ...followed by the long-run build ("· long run 14/18 km"), from the same payload.
                XCTAssertTrue(waitForText(app, containing: "long run 14/18 km"),
                               "Today's endurance hero race line should carry the long-run progress [\(appearance)]")
            }

            if scenario == "new_user" {
                // First-run checklist (§4.2) — replaces the three empty
                // biometric tiles for a fresh, still-calibrating account.
                XCTAssertTrue(waitForText(app, containing: "Let's get your baseline"),
                               "Today should show the new-user first-run checklist [\(appearance)]")
            }
        }
        capture(app, name: "\(scenario)__today__\(appearance)")
    }

    /// Opens the diet logging sheet from Today's fuel strip. Not attempted
    /// for `server_error` — there's no fuel strip to tap there, and Today's
    /// own assertion above already covers that failure mode.
    private func captureDietSheet(_ app: XCUIApplication, scenario: String, appearance: String) {
        guard scenario != "server_error" else { return }

        let fuelStrip = app.buttons["today.fuelStrip"]
        tapWhenHittable(
            fuelStrip, app: app,
            description: "today.fuelStrip [\(scenario)/\(appearance)]"
        )

        // DietSheetView's header renders immediately (it isn't gated on its
        // own network load), so this just confirms the sheet actually opened.
        // A silent no-op tap (fuelStrip hittable but the sheet never
        // presented — e.g. something else absorbed the touch) must fail
        // loudly here rather than fall through to capturing Today itself
        // relabeled as the diet sheet.
        var sheetOpened = app.staticTexts["Diet budget"].waitForExistence(timeout: 10)
        if !sheetOpened {
            // One retry: if Today's layout shifted under the first tap (late
            // content such as the streak chip), re-resolve the strip and tap
            // it again once it is hittable.
            let retryStrip = app.buttons["today.fuelStrip"]
            if retryStrip.waitForExistence(timeout: 5) {
                let hittable = NSPredicate(format: "isHittable == true")
                let exp = XCTNSPredicateExpectation(predicate: hittable, object: retryStrip)
                _ = XCTWaiter().wait(for: [exp], timeout: 5)
                if retryStrip.isHittable { retryStrip.tap() }
            }
            sheetOpened = app.staticTexts["Diet budget"].waitForExistence(timeout: 10)
        }
        guard sheetOpened else {
            XCTFail("Diet sheet never opened after tapping today.fuelStrip — "
                     + "the tap likely missed or was absorbed by another view "
                     + "[\(scenario)/\(appearance)]")
            return
        }
        capture(app, name: "\(scenario)__dietSheet__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
            // Wait out the dismiss animation before returning — a caller
            // that immediately taps a tab bar button while the sheet is
            // still animating away can have that tap absorbed by the
            // dismissing sheet instead of reaching the tab bar (2026-09-24,
            // PR #208: the endurance/light run's "Coach" tap landed while
            // the Diet sheet was still closing, and `captureCoach` went on
            // to assert against Today, which was still on screen).
            guard app.staticTexts["Diet budget"].waitForNonExistence(timeout: 5) else {
                XCTFail("Diet sheet never finished dismissing after tapping Close "
                         + "[\(scenario)/\(appearance)]")
                return
            }
        }
    }

    /// Opens the "Log lift" sheet from Today's muscle hero (muscle scenario
    /// only — it's the one goal whose Today carries the "Log lift" button and
    /// the one fixture with a last session to repeat). Screen name
    /// `liftLogger`.
    private func captureLiftLogger(_ app: XCUIApplication, scenario: String, appearance: String) {
        guard scenario == "muscle" else { return }

        let logLift = app.buttons["today.muscleHero.logLift"]
        tapWhenHittable(
            logLift, app: app,
            description: "today.muscleHero.logLift [\(scenario)/\(appearance)]"
        )

        // The repeat-last-session note only renders once `/api/workouts/last`
        // has decoded and pre-filled the form — a fixture-unique signal that
        // fails loudly if that endpoint's interception ever regresses (the
        // sheet would otherwise open to its empty "No previous session"
        // form and still look plausible).
        guard waitForText(app, containing: "Repeating your last session") else {
            XCTFail("Lift logger never showed its pre-filled last session after tapping "
                     + "today.muscleHero.logLift [\(scenario)/\(appearance)]")
            return
        }
        XCTAssertTrue(app.buttons["liftLogger.save"].waitForExistence(timeout: 10),
                       "Lift logger should show its Save button [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__liftLogger__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
            // Same dismiss-animation wait as `captureDietSheet`: a following
            // tab-bar tap can be absorbed by a sheet still animating away.
            guard waitForTextToDisappear(app, containing: "Repeating your last session") else {
                XCTFail("Lift logger never finished dismissing after tapping Close [\(scenario)/\(appearance)]")
                return
            }
        }
    }

    /// Polls until no `staticText` label contains `substring` (or `timeout`).
    private func waitForTextToDisappear(_ app: XCUIApplication, containing substring: String, timeout: TimeInterval = 5) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", substring)
        return app.staticTexts.matching(predicate).firstMatch.waitForNonExistence(timeout: timeout)
    }

    private func captureCoach(_ app: XCUIApplication, scenario: String, appearance: String) {
        switchToTab("Coach", app: app, scenario: scenario, appearance: appearance)

        // The fixture seeds a restored transcript for every *established*
        // scenario except server_error, where every endpoint 500s and
        // CoachViewModel.loadOpener() falls back to its own hardcoded
        // greeting. `new_user` seeds no history on purpose (see
        // `FixtureData.coachRestoration`), so it falls through to the
        // fixture's `/api/coach/opener` response instead — the new-user
        // copy, not the returning-user "Nice work…" praise, since there's no
        // history yet to praise. Either way the Coach tab never stays empty
        // once its `.task` resolves, so this is fixture-driven either way.
        if scenario == "server_error" {
            XCTAssertTrue(waitForText(app, containing: "Ask me anything about your health trends"),
                           "Coach should fall back to its hardcoded opener when every endpoint 500s [\(appearance)]")
            XCTAssertTrue(waitForText(app, containing: "Coach is offline"),
                           "Coach should say it is offline when its load failed [\(appearance)]")
        } else if scenario == "new_user" {
            XCTAssertTrue(waitForText(app, containing: "Your goal is to lose weight"),
                           "Coach should show the new-user opener, not returning-user praise [\(appearance)]")
            XCTAssertFalse(app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] %@", "Nice work staying consistent")
            ).firstMatch.exists,
                            "new_user's coach screen must not praise history the user doesn't have [\(appearance)]")
            // The centered empty-state anchor (§3 of the coach-first-impression
            // fix) — shown only while the transcript is nothing but the
            // opener, which is exactly new_user's state here.
            XCTAssertTrue(waitForText(app, containing: "Tap the mic and just talk"),
                           "Coach's empty state should show its calm mic-prompt line [\(appearance)]")
        } else {
            XCTAssertTrue(waitForText(app, containing: "what would you like to dig into"),
                           "Coach should show the fixture-seeded restored message [\(scenario)/\(appearance)]")
            // The fixture's first exchange ("Why am I so tired this week?")
            // carries an `activity` array (chat-activity-contract.md §3), so
            // its restored turn should render as a folded receipt pill —
            // `CoachReceiptPill`'s "coach.receiptPill" identifier.
            let pill = app.descendants(matching: .any).matching(identifier: "coach.receiptPill").firstMatch
            XCTAssertTrue(pill.waitForExistence(timeout: 15),
                           "Coach should show a receipt pill for the fixture's tool-call activity [\(scenario)/\(appearance)]")
            captureCoachReceipt(app, pill: pill, scenario: scenario, appearance: appearance)
        }
        capture(app, name: "\(scenario)__coach__\(appearance)")
    }

    /// Taps the receipt pill and captures the expanded detail (K3) — screen
    /// segment must stay letters-only to match CI's export regex
    /// (`^[a-z_]+__[A-Za-z]+__(light|dark)\.png$`), hence "coachReceipt" with
    /// no separating punctuation.
    private func captureCoachReceipt(_ app: XCUIApplication, pill: XCUIElement, scenario: String, appearance: String) {
        tapWhenHittable(pill, app: app, description: "Coach receipt pill [\(scenario)/\(appearance)]")
        // "Manage memory" renders as a `Button`, not a `staticText` —
        // `waitForText` only searches static text, so check the button
        // directly; its own text label is a reliable proxy for
        // `CoachReceiptDetail` having actually expanded.
        let manageMemoryLink = app.buttons["Manage memory"]
        XCTAssertTrue(manageMemoryLink.waitForExistence(timeout: 10),
                       "Tapping the receipt pill should expand the detail with its Manage memory link [\(scenario)/\(appearance)]")
        // `CoachReceiptDetail`'s own identifier — waited on directly (rather
        // than relying on "Manage memory" alone) so the detail wait below,
        // after collapsing, checks the same element.
        let detail = app.descendants(matching: .any).matching(identifier: "coach.receiptDetail").firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 10),
                       "Receipt detail should exist once expanded [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__coachReceipt__\(appearance)")
        // Collapse it again so the rest of this scenario's Coach assertions
        // (and the plain `__coach__` capture right after this call returns)
        // see the same collapsed state every run — wait for the fold-out
        // animation to fully finish so `__coach__` doesn't catch a ghost of
        // the detail mid-collapse.
        tapWhenHittable(pill, app: app, description: "Coach receipt pill (collapse) [\(scenario)/\(appearance)]")
        XCTAssertTrue(detail.waitForNonExistence(timeout: 5),
                       "Receipt detail should fully collapse before the next capture [\(scenario)/\(appearance)]")
    }

    /// Opens the goal-progress detail sheet from the "Am I on track?" card at
    /// the top of Trends (weight_loss: on track toward 76 kg; muscle:
    /// progressing on squat/bench; endurance: building toward the half marathon,
    /// with the long-run reason). Screen name `goalProgress`. Only those three
    /// scenarios — the others either have no card worth opening (new_user's
    /// prompt, server_error's hidden card) or aren't part of the ask.
    private func captureGoalProgress(_ app: XCUIApplication, scenario: String, appearance: String) {
        guard scenario == "weight_loss" || scenario == "muscle" || scenario == "endurance" else { return }

        switchToTab("Trends", app: app, scenario: scenario, appearance: appearance)
        // Back to the top of Trends, where the card leads.
        for _ in 0..<4 { app.swipeDown() }

        let card = app.descendants(matching: .any).matching(identifier: "goalProgress.card").firstMatch
        tapWhenHittable(card, app: app, description: "goalProgress.card [\(scenario)/\(appearance)]")

        let title = app.descendants(matching: .any).matching(identifier: "goalProgress.detail.title").firstMatch
        guard title.waitForExistence(timeout: 10) else {
            XCTFail("Goal progress detail sheet never opened after tapping goalProgress.card [\(scenario)/\(appearance)]")
            return
        }
        // Fixture-unique content: the weight_loss primary line is composed from
        // structured fields (never the server's kg headline); muscle falls
        // back to the server headline.
        // (GoalProgressLogic joins value+unit with U+00A0 so lines never wrap mid-value;
        // the "Why" rows run through `GoalProgressLogic.nonBreaking`, which also binds the
        // "153 → 163 kg" arrow pair — a narrow sheet must never wrap as "(153 → / 163 kg)".)
        let expected: String
        switch scenario {
        case "weight_loss":
            expected = "of 7.7\u{00A0}kg lost"
        case "muscle":
            expected = "Squat est. 1RM +10\u{00A0}kg vs 4\u{00A0}weeks ago (153\u{00A0}\u{2192}\u{00A0}163\u{00A0}kg)"
        default:
            // endurance: the long-run build reason (race and week distance precede it).
            expected = "Long run 14\u{00A0}km \u{00B7} build to 18\u{00A0}km"
        }
        XCTAssertTrue(waitForText(app, containing: expected),
                       "Goal progress detail should show the \(scenario) fixture's content [\(appearance)]")
        capture(app, name: "\(scenario)__goalProgress__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
            guard title.waitForNonExistence(timeout: 5) else {
                XCTFail("Goal progress sheet never finished dismissing after tapping Close [\(scenario)/\(appearance)]")
                return
            }
        }
    }

    /// Weekly review (v5 Wave 3): the unseen-review card on Today (fixtures
    /// bypass the Mon-Wed window) and its detail sheet. Screen names
    /// `weeklyReviewCard` (Today) and `weeklyReview` (detail sheet). Only
    /// weight_loss and muscle — their fixture reviews carry the scenario's
    /// numbers (-0.6 kg / 5 of 7 days in budget; sessions / bench 1RM).
    private func captureWeeklyReview(_ app: XCUIApplication, scenario: String, appearance: String) {
        // Endurance has its own review fixture (volume / resting HR / sleep stats):
        // captured by identifier, without pinning its copy.
        if scenario == "endurance" {
            captureEnduranceWeeklyReview(app, appearance: appearance)
            return
        }
        guard scenario == "weight_loss" || scenario == "muscle" else { return }

        switchToTab("Today", app: app, scenario: scenario, appearance: appearance)
        for _ in 0..<4 { app.swipeDown() }

        let card = app.descendants(matching: .any).matching(identifier: "weeklyReview.card").firstMatch
        guard card.waitForExistence(timeout: 15) else {
            XCTFail("Weekly review card never appeared on Today [\(scenario)/\(appearance)]")
            return
        }
        // The compact card sits below the fuel strip / next-up row, so scroll
        // its button fully on screen (clear of top and bottom chrome) before
        // asserting on / capturing it.
        let openButton = app.descendants(matching: .any).matching(identifier: "weeklyReview.open").firstMatch
        // Today's content is lazy, so the button isn't in the hierarchy until
        // scrolled near: find it by scrolling, then centre it.
        XCTAssertTrue(scrollUntilExists(openButton, app: app, maxSwipes: 8),
                       "weeklyReview.open never appeared [\(scenario)/\(appearance)]")
        scrollIntoComfortableView(openButton, app: app, maxSwipes: 8)
        // Fixture-unique headline (FixtureData.weeklyReview).
        let expected = scenario == "weight_loss" ? "Down 0.6 kg, in budget 5 of 7 days" : "3 of 4 sessions, Squat est. 1RM +20 kg over 4 wks"
        XCTAssertTrue(waitForText(app, containing: expected),
                       "Weekly review card should show the \(scenario) fixture's headline [\(appearance)]")
        capture(app, name: "\(scenario)__weeklyReviewCard__\(appearance)")

        let open = app.descendants(matching: .any).matching(identifier: "weeklyReview.open").firstMatch
        tapWhenHittable(open, app: app, maxSwipes: 8, description: "weeklyReview.open [\(scenario)/\(appearance)]")

        let title = app.descendants(matching: .any).matching(identifier: "weeklyReview.detail.title").firstMatch
        guard title.waitForExistence(timeout: 10) else {
            XCTFail("Weekly review detail sheet never opened [\(scenario)/\(appearance)]")
            return
        }
        capture(app, name: "\(scenario)__weeklyReview__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
            guard title.waitForNonExistence(timeout: 5) else {
                XCTFail("Weekly review sheet never finished dismissing after tapping Close [\(scenario)/\(appearance)]")
                return
            }
        }
    }

    /// Endurance weekly review: the unseen-review card on Today (fixtures bypass
    /// the Mon-Wed window) and its detail sheet. Screen names `weeklyReviewCard`
    /// and `weeklyReview`. Follows the muscle / weight_loss flow above but asserts
    /// on identifiers (card, non-empty headline, detail title) rather than the
    /// review's copy, so a copy tweak to the endurance fixture never breaks the harness.
    private func captureEnduranceWeeklyReview(_ app: XCUIApplication, appearance: String) {
        let scenario = "endurance"
        switchToTab("Today", app: app, scenario: scenario, appearance: appearance)
        for _ in 0..<4 { app.swipeDown() }

        let card = app.descendants(matching: .any).matching(identifier: "weeklyReview.card").firstMatch
        guard card.waitForExistence(timeout: 15) else {
            XCTFail("Weekly review card never appeared on Today [\(scenario)/\(appearance)]")
            return
        }
        // Today's content is lazy: find the card's button by scrolling, then centre it.
        let openButton = app.descendants(matching: .any).matching(identifier: "weeklyReview.open").firstMatch
        XCTAssertTrue(scrollUntilExists(openButton, app: app, maxSwipes: 8),
                       "weeklyReview.open never appeared [\(scenario)/\(appearance)]")
        scrollIntoComfortableView(openButton, app: app, maxSwipes: 8)
        let headline = app.descendants(matching: .any).matching(identifier: "weeklyReview.headline").firstMatch
        XCTAssertTrue(headline.waitForExistence(timeout: 10) && !headline.label.isEmpty,
                       "Weekly review card should show a headline [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__weeklyReviewCard__\(appearance)")

        tapWhenHittable(openButton, app: app, maxSwipes: 8, description: "weeklyReview.open [\(scenario)/\(appearance)]")

        let title = app.descendants(matching: .any).matching(identifier: "weeklyReview.detail.title").firstMatch
        guard title.waitForExistence(timeout: 10) else {
            XCTFail("Weekly review detail sheet never opened [\(scenario)/\(appearance)]")
            return
        }
        capture(app, name: "\(scenario)__weeklyReview__\(appearance)")

        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) {
            close.tap()
            guard title.waitForNonExistence(timeout: 5) else {
                XCTFail("Weekly review sheet never finished dismissing after tapping Close [\(scenario)/\(appearance)]")
                return
            }
        }
    }

    private func captureTrends(_ app: XCUIApplication, scenario: String, appearance: String) {
        switchToTab("Trends", app: app, scenario: scenario, appearance: appearance)

        if scenario == "server_error" {
            XCTAssertTrue(app.staticTexts["Couldn't load your trends"].waitForExistence(timeout: 15),
                           "server_error should show Trends' error card [\(appearance)]")
        } else {
            // A metric tile's display name — only rendered once the batch
            // fetch resolves (loading shows skeleton placeholders instead).
            // `.firstMatch` (#200): "HRV" isn't unique on this screen (the
            // "This Week" strip renders its own "hrv" stat too), and this is
            // only an existence check — any match proves the grid loaded.
            //
            // Goal-agnostic, scrolled (#200 round 3): `TrendsGoalOrdering`
            // deliberately puts weight_loss's Weight card + This Week strip
            // ahead of every metric-group section, which pushes the
            // Recovery section's "HRV" tile below the fold — the grid is
            // lazy, so an off-screen tile genuinely isn't in the
            // accessibility hierarchy yet, and waiting on it without
            // scrolling just times out. Scroll (bounded, so a real
            // regression still fails instead of looping) until it appears;
            // this doubles as proof that weight_loss's recovery tiles still
            // exist at all, not just that the fixture batch decoded.
            let recoveryTile = app.staticTexts["HRV"].firstMatch
            var swipesToRecovery = 0
            while !recoveryTile.exists && swipesToRecovery < 4 {
                app.swipeUp()
                swipesToRecovery += 1
            }
            XCTAssertTrue(recoveryTile.waitForExistence(timeout: 15),
                           "Trends should render its metric tiles [\(scenario)/\(appearance)]")

            if scenario == "muscle" {
                // The Strength card leads Trends for the muscle goal
                // (`TrendsGoalOrdering.leadsWithStrength`) — back to the top
                // so it's both asserted and captured, then check its volume
                // row (identifier, not text: the rows are combined/ignored
                // accessibility elements). Only present once
                // `/api/workouts/summary` decodes, so this fails loudly if
                // that fixture's interception ever regresses.
                for _ in 0..<swipesToRecovery { app.swipeDown() }
                let strengthVolume = app.descendants(matching: .any).matching(identifier: "trends.strengthCard.volume").firstMatch
                XCTAssertTrue(strengthVolume.waitForExistence(timeout: 15),
                               "muscle Trends should show the Strength card's weekly volume line [\(appearance)]")
            }

            if scenario == "weight_loss" {
                // Scroll back to the top before the goal-ordering frame
                // assertions below (they need the weight card and This Week
                // strip on-screen, which the scroll above may have carried
                // past the fold) and before this screen's capture() at the
                // bottom of this function (the screenshot should show the
                // top of Trends, not wherever scrolling for "HRV" left off).
                for _ in 0..<swipesToRecovery { app.swipeDown() }

                // Goal-ordered Trends (customer-panel finding, 2026-09-23 —
                // docs/ux-spec-v4.md §9's screenshot acceptance table:
                // "Weight card first"): `trends.weightCard` must exist and
                // sit ABOVE the topmost recovery-related content.
                //
                // NOT `app.staticTexts["HRV"]` here (#200): that label is
                // ambiguous on this screen — it matches both the "This Week"
                // strip's HRV stat and the recovery section's metric tile —
                // and reading `.frame` on an ambiguous query is a hard
                // XCUITest failure that aborted this whole test method, so
                // no weight_loss Trends screenshot was ever captured.
                // `trends.recoveryFirst` (WeeklyHeadlineStrip's own
                // identifier, an `.accessibilityElement(children: .contain)`
                // container so the identifier resolves to exactly that one
                // element rather than propagating to its HRV/sleep/RHR
                // children — #200 round 2) is the topmost recovery content,
                // so comparing against it is the meaningful check.
                //
                // `app.descendants(matching: .any).matching(identifier:)`
                // rather than a typed query (`app.buttons[...]`/
                // `app.otherElements[...]`) so this doesn't silently miss a
                // match (or hard-fail on an unexpected type) if either
                // view's underlying XCUIElementType ever changes —
                // `.firstMatch` on top means neither line can raise the
                // "multiple matching elements" error regardless.
                let weightCard = app.descendants(matching: .any).matching(identifier: "trends.weightCard").firstMatch
                XCTAssertTrue(weightCard.waitForExistence(timeout: 10),
                               "weight_loss Trends should show the weight card [\(appearance)]")
                let recoveryFirst = app.descendants(matching: .any).matching(identifier: "trends.recoveryFirst").firstMatch
                XCTAssertTrue(recoveryFirst.waitForExistence(timeout: 10),
                               "weight_loss Trends should still show the This Week recovery card [\(appearance)]")
                // Both elements are back on-screen after the swipeDown loop
                // above (the weight card and This Week strip are the first
                // two things below the header, so scrolling back to the top
                // brings them both into view together). Compare in the same
                // coordinate space (`XCUIElement.frame` is always screen
                // coordinates) so this holds across appearances.
                XCTAssertLessThan(weightCard.frame.minY, recoveryFirst.frame.minY,
                                   "weight_loss Trends' weight card should appear above the This Week recovery card [\(appearance)]")
            }
        }
        capture(app, name: "\(scenario)__trends__\(appearance)")

        if scenario != "server_error" {
            captureMetricDetail(app, scenario: scenario, appearance: appearance)
        }
    }

    private func captureMetricDetail(_ app: XCUIApplication, scenario: String, appearance: String) {
        // Find and tap the HRV metric tile (the Recovery section's metric card, distinct from the
        // "This Week" strip's lowercase "hrv" stat which is not tappable). Must scroll within
        // a bounded loop before tapping, since the grid may still be scrolled from the assertion above.
        let hrvTile = app.staticTexts["HRV"].firstMatch
        var swipes = 0
        while !hrvTile.exists && swipes < 4 {
            app.swipeUp()
            swipes += 1
        }

        tapWhenHittable(
            hrvTile, app: app,
            description: "HRV metric tile [\(scenario)/\(appearance)]"
        )

        // Wait for MetricDetailView to render — using the detail range switcher's "3 months"
        // button as the stable signal. This button always renders once the screen has loaded,
        // regardless of data availability (unlike section headers like "DISTRIBUTION" which only
        // appear with sufficient data). Assert the detail screen loaded before capturing.
        XCTAssertTrue(app.buttons["3 months"].waitForExistence(timeout: 10),
                       "HRV detail should load [\(scenario)/\(appearance)]")

        // Screen segment must be letters only to match CI export regex: ^[a-z_]+__[A-Za-z]+__(light|dark)\.png$
        capture(app, name: "\(scenario)__hrvDetail__\(appearance)")

        // Scroll down to bring the "What moves your HRV" drivers section
        // (added right after the stats row, before Distribution) on screen —
        // present for weight_loss/muscle/endurance's HRV fixture, empty (and
        // this capture simply shows Distribution/records instead) for
        // new_user, which has no certified drivers.
        app.swipeUp()
        capture(app, name: "\(scenario)__hrvDetailDrivers__\(appearance)")

        // One more scroll to see the rest of the detail view (e.g. the chart, records section, or more).
        app.swipeUp()
        capture(app, name: "\(scenario)__hrvDetailMore__\(appearance)")

        // Navigate back to Trends so later captures still work. Try the navigation bar's back
        // button first (the standard edge-swipe-back and zoom-transition nav pattern); if it
        // doesn't exist, fall back to a right-edge swipe (interactive pop gesture) as a safety net.
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        if backButton.waitForExistence(timeout: 5) {
            backButton.tap()
        } else {
            // Swipe from the left edge to trigger the interactive pop gesture, a fallback when
            // the nav bar button is absent or fails to respond. This keeps the rest of the test
            // flow alive instead of getting stuck in the detail view.
            app.swipeRight()
        }

        // Wait for the detail view to dismiss before returning, so the next test section sees Trends.
        XCTAssertTrue(app.buttons["3 months"].waitForNonExistence(timeout: 5),
                       "HRV metric detail view never finished dismissing [\(scenario)/\(appearance)]")
    }

    private func captureLogs(_ app: XCUIApplication, scenario: String, appearance: String) {
        switchToTab("Logs", app: app, scenario: scenario, appearance: appearance)

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

        if scenario != "server_error" && scenario != "new_user" {
            captureLogsAnalyses(app, scenario: scenario, appearance: appearance)
        }
    }

    /// Reached from Logs: taps the workout row (`logs.workoutRow`) to open
    /// the redesigned workout `AnalysisView`, captures it, dismisses with
    /// "Done", then does the same for the sleep row. Every established
    /// fixture scenario carries both rows with a full-`context` analysis
    /// behind them (`FixtureData.notableRunAnalysis`/`roughNightAnalysis`,
    /// `.muscle`'s workout row instead pointing at the routine variant) —
    /// see `FixtureData.logs`. Screen segments are letters-only
    /// ("workoutAnalysis"/"sleepAnalysis") to match the export regex
    /// `^[a-z_]+__[A-Za-z]+__(light|dark)\.png$`.
    private func captureLogsAnalyses(_ app: XCUIApplication, scenario: String, appearance: String) {
        captureWorkoutAnalysis(app, scenario: scenario, appearance: appearance)
        captureSleepAnalysis(app, scenario: scenario, appearance: appearance)
    }

    private func captureWorkoutAnalysis(_ app: XCUIApplication, scenario: String, appearance: String) {
        // Endurance's workout is last night's late run (20:48 yesterday), so it
        // lives on the previous day's page, not Today's.
        let workoutOnPreviousDay = scenario == "endurance"
        if workoutOnPreviousDay {
            let previousDay = app.buttons["logs.pager.previous"].firstMatch
            XCTAssertTrue(previousDay.waitForExistence(timeout: 10),
                           "Logs should show its previous-day pager button [\(scenario)/\(appearance)]")
            previousDay.tap()
        }
        let workoutRow = app.buttons["logs.workoutRow"].firstMatch
        tapWhenHittable(workoutRow, app: app, maxSwipes: 6, description: "Logs' workout row [\(scenario)/\(appearance)]")
        let workoutHeader = app.descendants(matching: .any).matching(identifier: "analysisWorkout.header").firstMatch
        XCTAssertTrue(workoutHeader.waitForExistence(timeout: 15),
                       "Tapping the workout row should open the workout AnalysisView [\(scenario)/\(appearance)]")
        waitForSettled(workoutHeader, timeout: 5.0, description: "Workout AnalysisView header [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__workoutAnalysis__\(appearance)")

        if scenario == "endurance" {
            captureWorkoutAnalysisWhoopTab(app, scenario: scenario, appearance: appearance)
        }

        let workoutDone = app.buttons["analysis.done"].firstMatch
        tapWhenHittable(workoutDone, app: app, description: "Workout AnalysisView Done button [\(scenario)/\(appearance)]")
        // Wait for the workout sheet to actually finish closing (not just
        // for Logs to reappear underneath it) before touching the next row.
        // `.sheet(item:)` silently drops a presentation requested while the
        // PREVIOUS one is still mid-dismissal, and `analysisTarget` in
        // LogsView flips back to nil well before that close animation
        // finishes — so racing straight into the next tap could land the
        // tap while the new sheet never appears.
        XCTAssertTrue(workoutHeader.waitForNonExistence(timeout: 5),
                       "Workout AnalysisView should fully dismiss before the next tap [\(scenario)/\(appearance)]")
        XCTAssertTrue(app.staticTexts["LOG ENTRIES"].waitForExistence(timeout: 10),
                       "Dismissing the workout analysis should return to Logs [\(scenario)/\(appearance)]")
        if workoutOnPreviousDay {
            // The sleep row (wake time = today) is on Today's page.
            let nextDay = app.buttons["logs.pager.next"].firstMatch
            XCTAssertTrue(nextDay.waitForExistence(timeout: 5),
                           "Logs should show its next-day pager button [\(scenario)/\(appearance)]")
            nextDay.tap()
        }
    }

    /// `endurance`-only: taps the "The data" device switch's WHOOP segment
    /// (`analysis.deviceSwitch.whoop`) and captures the WHOOP tab (phase 2
    /// "both devices" contract, PR C item 5). Runs while still inside the
    /// workout AnalysisView sheet opened by `captureWorkoutAnalysis`, right
    /// after that method's own `analysisWorkout.header` capture — the Apple
    /// Watch tab (the switch's default) is what `endurance__workoutAnalysis`
    /// already shows. Segment name is letters-only ("workoutAnalysisWhoop")
    /// to match the export regex `^[a-z_]+__[A-Za-z]+__(light|dark)\.png$`.
    private func captureWorkoutAnalysisWhoopTab(_ app: XCUIApplication, scenario: String, appearance: String) {
        let whoopSwitch = app.buttons["analysis.deviceSwitch.whoop"].firstMatch
        // "The data" section (and its switch) sits below the fold on first
        // open — scroll it into view the same gentle, bounded way every
        // other off-screen element in this harness does, rather than a bare
        // `swipeUp()` that could overshoot it back off the top of the screen.
        tapWhenHittable(whoopSwitch, app: app, maxSwipes: 6, description: "Workout AnalysisView's WHOOP device switch [\(scenario)/\(appearance)]")
        let workoutHeader = app.descendants(matching: .any).matching(identifier: "analysisWorkout.header").firstMatch
        waitForSettled(workoutHeader, timeout: 5.0, description: "Workout AnalysisView header (WHOOP tab) [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__workoutAnalysisWhoop__\(appearance)")
    }

    private func captureSleepAnalysis(_ app: XCUIApplication, scenario: String, appearance: String) {
        let sleepRow = app.buttons["logs.sleepRow"].firstMatch
        tapWhenHittable(sleepRow, app: app, maxSwipes: 6, description: "Logs' sleep row [\(scenario)/\(appearance)]")
        let sleepHeader = app.descendants(matching: .any).matching(identifier: "analysisSleep.header").firstMatch
        XCTAssertTrue(sleepHeader.waitForExistence(timeout: 15),
                       "Tapping the sleep row should open the sleep AnalysisView [\(scenario)/\(appearance)]")
        waitForSettled(sleepHeader, timeout: 5.0, description: "Sleep AnalysisView header [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__sleepAnalysis__\(appearance)")
        let sleepDone = app.buttons["analysis.done"].firstMatch
        tapWhenHittable(sleepDone, app: app, description: "Sleep AnalysisView Done button [\(scenario)/\(appearance)]")
        XCTAssertTrue(app.staticTexts["LOG ENTRIES"].waitForExistence(timeout: 10),
                       "Dismissing the sleep analysis should return to Logs [\(scenario)/\(appearance)]")
    }

    private func captureProfile(_ app: XCUIApplication, scenario: String, appearance: String) {
        switchToTab("Profile", app: app, scenario: scenario, appearance: appearance)

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

    /// Reached from Profile — `ProfileView.settingsCard`'s "Memory" row
    /// pushes `MemoryView` — so this must run right after `captureProfile`,
    /// which leaves the app on the Profile tab. Not attempted for
    /// `server_error`, whose Profile tab shows only its error card with no
    /// settings rows to tap.
    private func captureMemory(_ app: XCUIApplication, scenario: String, appearance: String) {
        guard scenario != "server_error" else { return }

        let memoryLink = app.staticTexts["Memory"].firstMatch
        tapWhenHittable(
            memoryLink, app: app,
            description: "Profile's Memory settings row [\(scenario)/\(appearance)]"
        )

        if scenario == "new_user" {
            // The fixture serves an empty `/api/memory` for new_user (no
            // established history yet) — the redesigned screen's empty state.
            XCTAssertTrue(waitForText(app, containing: "Nothing learned yet"),
                           "new_user's Memory screen should show its empty state [\(appearance)]")
        } else {
            // Fixture-unique facts (`FixtureData.memoryFacts`) — only ever
            // rendered once `/api/memory` decodes, so this fails loudly if
            // fixture interception ever regresses for this endpoint.
            XCTAssertTrue(waitForText(app, containing: "Peanut allergy"),
                           "\(scenario)'s Memory screen should show the established fixture's facts [\(appearance)]")
            XCTAssertTrue(waitForText(app, containing: "Always avoid"),
                           "\(scenario)'s Memory screen should tag a constraint fact [\(appearance)]")
            XCTAssertTrue(waitForText(app, containing: "Routines & preferences"),
                           "\(scenario)'s Memory screen should group facts into sections [\(appearance)]")
            XCTAssertTrue(app.buttons["memory.goal.edit"].waitForExistence(timeout: 10),
                           "\(scenario)'s Memory screen should show the profile goal read-only [\(appearance)]")
        }
        capture(app, name: "\(scenario)__memory__\(appearance)")

        // Navigate back to Profile so nothing after this in the scenario
        // relies on Memory still being on screen (it's currently last, but
        // this keeps the harness safe if a screen is ever added after it).
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        if backButton.waitForExistence(timeout: 5) {
            backButton.tap()
        } else {
            app.swipeRight()
        }
        XCTAssertTrue(app.staticTexts[profileName(for: scenario)].waitForExistence(timeout: 5),
                       "Memory screen never finished dismissing back to Profile [\(scenario)/\(appearance)]")
    }

    /// Reached from Profile — `ProfileView.settingsCard`'s "Devices" row
    /// pushes `DevicesView` — so this must run after `captureProfile`, same
    /// pattern as `captureMemory` right above it. Not attempted for
    /// `server_error`, whose Profile tab shows only its error card.
    private func captureDevices(_ app: XCUIApplication, scenario: String, appearance: String) {
        guard scenario != "server_error" else { return }

        let devicesLink = app.staticTexts["Devices"].firstMatch
        tapWhenHittable(
            devicesLink, app: app,
            description: "Profile's Devices settings row [\(scenario)/\(appearance)]"
        )

        // Only rendered once the fixture's `/api/devices` resolves — fails
        // loudly if fixture interception for this endpoint ever regresses.
        XCTAssertTrue(waitForText(app, containing: "Primary device for"),
                       "\(scenario)'s Devices screen should show the Primary device for section [\(appearance)]")

        if scenario == "endurance" {
            // `FixtureData.devices` connects WHOOP only for `endurance`, the
            // one scenario with a both-devices story.
            XCTAssertTrue(waitForText(app, containing: "WHOOP"),
                           "endurance's Devices screen should show WHOOP as connected [\(appearance)]")
            XCTAssertTrue(waitForText(app, containing: "merged this month"),
                           "endurance's Devices screen should show a merged-this-month caption [\(appearance)]")
        }

        let primaryDeviceText = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Primary device for")
        ).firstMatch
        waitForSettled(primaryDeviceText, timeout: 5.0, description: "Devices screen content [\(scenario)/\(appearance)]")
        capture(app, name: "\(scenario)__devices__\(appearance)")

        // Navigate back to Profile — same tidy-up `captureMemory` does.
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        if backButton.waitForExistence(timeout: 5) {
            backButton.tap()
        } else {
            app.swipeRight()
        }
        XCTAssertTrue(app.staticTexts[profileName(for: scenario)].waitForExistence(timeout: 5),
                       "Devices screen never finished dismissing back to Profile [\(scenario)/\(appearance)]")
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
        case "weight_loss": return "Sam Rivera"
        case "muscle":      return "Priya Okafor"
        case "endurance":   return "Marcus Nandy"
        default:            return "Jordan Lee"
        }
    }

    /// Mirrors `FixtureData`'s per-scenario `Profile.insight` — see
    /// `profileName(for:)`'s doc comment for why this is hand-duplicated
    /// rather than shared. Verbatim, except the muscle insight: it names the
    /// weekday of the last lift ("Tuesday's squat"), derived from a relative
    /// date so it always matches "Last (Tue)", so only the stable tail is
    /// asserted (matched with `waitForText(containing:)`, not by exact label).
    private func insight(for scenario: String) -> String {
        switch scenario {
        case "new_user":
            return "Keep logging — a few more days and I'll start spotting real patterns."
        case "weight_loss":
            return "You're down 0.6kg this week, but last night's sleep ran short (6h 50m) — keep the deficit gentle and aim for an earlier night."
        case "muscle":
            return "squat was your best in 4 weeks — stay the course."
        case "endurance":
            return "This week's long run held goal pace with a lower average HR than last week — aerobic base is building nicely."
        default:
            return ""
        }
    }
}
