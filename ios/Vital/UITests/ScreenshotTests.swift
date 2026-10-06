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

    /// Waits for `element` to exist, then taps it once it's both
    /// `isHittable` AND clear of the bottom chrome — never a bare `.tap()`
    /// on a coordinate that might be off-screen or obscured. `isHittable`
    /// only means the element's centre point is on screen; on iOS 26 the
    /// floating Liquid Glass tab bar (and Today's mic FAB) overlay the
    /// scroll content, so an element sitting just above/under that chrome
    /// can report `isHittable` while its tap is still absorbed by whatever
    /// is layered on top. "Clear" means the element's frame sits above the
    /// tab bar (with an 8pt margin) when one exists, or above 80% of the
    /// screen height otherwise.
    ///
    /// Nudges the element into view with a bounded number of gentle,
    /// slow drags (never a full `swipeUp()`, which can overshoot the
    /// element past the top of the screen) rather than sleeping. Fails
    /// with a `description`-labeled message (never XCUITest's own less
    /// legible tap-failure error, and never a dumped element tree) if the
    /// element never appears or never clears the chrome.
    private func tapWhenHittable(
        _ element: XCUIElement,
        app: XCUIApplication,
        maxSwipes: Int = 3,
        timeout: TimeInterval = 10,
        description: String
    ) {
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("\(description) never appeared to tap")
            return
        }

        func isClearOfBottomChrome() -> Bool {
            let tabBar = app.tabBars.firstMatch
            if tabBar.exists {
                return element.frame.maxY <= tabBar.frame.minY - 8
            }
            return element.frame.maxY <= app.frame.maxY * 0.8
        }

        var swipes = 0
        while (!element.isHittable || !isClearOfBottomChrome()) && swipes < maxSwipes {
            // A gentle drag from 70% down the screen to 45% — a smaller,
            // slower nudge than `swipeUp()` so a short scroll distance
            // doesn't overshoot the element off the top of the screen.
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            start.press(forDuration: 0.05, thenDragTo: end)
            swipes += 1
        }

        guard element.isHittable, isClearOfBottomChrome() else {
            XCTFail("\(description) exists but never became hittable and clear of "
                     + "the bottom chrome after \(maxSwipes) scroll attempts")
            return
        }

        element.tap()
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
            XCTAssertTrue(app.staticTexts[insight(for: scenario)].waitForExistence(timeout: 10),
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
                XCTAssertTrue(waitForText(app, containing: "0.6 kg/wk this week"),
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
                XCTAssertTrue(waitForText(app, containing: "2 of 4 sessions"),
                               "Today's muscle hero should show the this-week session count [\(appearance)]")
            }

            if scenario == "endurance" {
                // The endurance hero (§4.1) — the readiness word (deterministic
                // from the fixture's flat `trendsBatch` baseline: every
                // metric lands `.normal`, a net-0 score, which reads as
                // "Good to train" — see `EnduranceHeroLogic.readinessWord`'s
                // doc comment) and today's move-kind session title.
                XCTAssertTrue(waitForText(app, containing: "Good to train"),
                               "Today's endurance hero should show a readiness word [\(appearance)]")
                XCTAssertTrue(waitForText(app, containing: "10km tempo run"),
                               "Today's endurance hero should show today's session [\(appearance)]")
                // Combined line showing sessions and weekly volume:
                // 3 completed sessions, 24.5 km done this week
                // (no plan data for endurance, so no dots).
                XCTAssertTrue(waitForText(app, containing: "3 sessions · 24.5 km this week"),
                               "Today's endurance hero should show sessions and volume combined [\(appearance)]")
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
        guard app.staticTexts["Diet budget"].waitForExistence(timeout: 10) else {
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
        } else if scenario == "new_user" {
            XCTAssertTrue(waitForText(app, containing: "Tell me your goal"),
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
            return "You're down 0.6kg this week and sleep is holding steady — keep the deficit gentle through the weekend."
        case "muscle":
            return "Protein's on target four days running and yesterday's lift was a PR on squat volume — stay the course."
        case "endurance":
            return "This week's long run held goal pace with a lower average HR than last week — aerobic base is building nicely."
        default:
            return ""
        }
    }
}
