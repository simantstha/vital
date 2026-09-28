import XCTest
import SwiftUI
import UIKit
@testable import Vital

/// Decode + render regression coverage for the analysis-v2 fixtures,
/// independent of (and much cheaper than) the UI test's tap-and-wait
/// choreography:
///
/// 1. The sleep fixture bytes must decode into `AnalysisResponse` with the
///    exact decoder `APIClient.fetchAnalysis` uses (`JSONDecoder.vital`) —
///    `testSleepFixtureDecodes` fails loudly here if that ever regresses,
///    instead of silently in the UI test.
/// 2. `SleepAnalysisContent`'s `body` must not throw/trap while laying out
///    that decoded data — `testSleepAnalysisContentLaysOutWithoutCrashing`
///    forces a real layout+render pass via `ImageRenderer`.
///
/// The workout fixture/content is exercised identically as the control.
@MainActor
final class AnalysisFixtureRenderTests: XCTestCase {

    // MARK: - Decoding

    /// Fetches straight from `FixtureData.response` — the exact bytes
    /// `FixtureURLProtocol` would serve for this path/method, decoded with
    /// the same `JSONDecoder.vital` `APIClient.fetchAnalysis` uses. This
    /// does NOT go through `URLSession`/`FixtureURLProtocol` at all (this
    /// test process never sets `-VitalFixture`, so `FixtureMode.isActive`
    /// is false and that interception wouldn't fire) — it calls the fixture
    /// builder directly, which is enough to isolate "does this exact JSON
    /// decode" from "does the network/presentation plumbing work".
    private func fixtureResponse(path: String) throws -> AnalysisResponse {
        let (status, data) = FixtureData.response(
            scenario: .weightLoss, method: "GET", path: path, query: ""
        )
        XCTAssertEqual(status, 200, "fixture route \(path) did not return 200")
        return try JSONDecoder.vital.decode(AnalysisResponse.self, from: data)
    }

    func testSleepFixtureDecodes() throws {
        let value = try fixtureResponse(path: "/api/sleep-analyses/fixture-sleep-analysis")
        XCTAssertEqual(value.id, "fixture-sleep-analysis")
        XCTAssertFalse(value.result.headline.isEmpty)
        let metrics = try XCTUnwrap(value.metrics, "sleep fixture should carry metrics")
        XCTAssertNotNil(metrics.minutes)
        XCTAssertNotNil(metrics.stages)
        let context = try XCTUnwrap(value.context, "sleep fixture should carry a context")
        XCTAssertNotNil(context.goalMinutes)
        XCTAssertNotNil(context.sleepUsual)
        XCTAssertNotNil(context.timing)
        XCTAssertNotNil(context.week)
    }

    /// Control: the workout fixture, known-good per the passing UI test
    /// capture, decoded the same way.
    func testWorkoutFixtureDecodes() throws {
        let value = try fixtureResponse(path: "/api/workout-analyses/fixture-workout-analysis")
        XCTAssertEqual(value.id, "fixture-workout-analysis")
        XCTAssertFalse(value.result.headline.isEmpty)
        let metrics = try XCTUnwrap(value.metrics, "workout fixture should carry metrics")
        XCTAssertNotNil(metrics.distanceM)
        let context = try XCTUnwrap(value.context, "workout fixture should carry a context")
        XCTAssertNotNil(context.usual)
        XCTAssertNotNil(context.effort)
    }

    // MARK: - Layout

    func testSleepAnalysisContentLaysOutWithoutCrashing() throws {
        let value = try fixtureResponse(path: "/api/sleep-analyses/fixture-sleep-analysis")
        let image = renderToImage(
            SleepAnalysisContent(value: value, doneAction: {}, kind: .sleep)
                .environmentObject(AppRouter.shared)
        )
        XCTAssertNotNil(image, "SleepAnalysisContent should render an image for the sleep fixture")
    }

    /// Control: the workout content view, same rendering path.
    func testWorkoutAnalysisContentLaysOutWithoutCrashing() throws {
        let value = try fixtureResponse(path: "/api/workout-analyses/fixture-workout-analysis")
        let image = renderToImage(
            WorkoutAnalysisContent(value: value, doneAction: {}, kind: .workout)
                .environmentObject(AppRouter.shared)
        )
        XCTAssertNotNil(image, "WorkoutAnalysisContent should render an image for the workout fixture")
    }

    /// Forces a real SwiftUI layout + draw pass off-screen via
    /// `ImageRenderer` — accessing `.uiImage` is what actually triggers it
    /// (a lazily-constructed `ImageRenderer` alone lays out nothing).
    /// `nil` back means SwiftUI itself gave up on rendering this view tree,
    /// which is a real signal, not just "this helper is unreliable" — this
    /// same technique is what `.snapshot()`-style SwiftUI test helpers use.
    private func renderToImage<V: View>(_ view: V, width: CGFloat = 390, height: CGFloat = 4000) -> UIImage? {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
        renderer.scale = 1
        return renderer.uiImage
    }
}
