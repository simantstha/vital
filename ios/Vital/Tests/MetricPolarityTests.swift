import XCTest
import SwiftUI
import UIKit
@testable import Vital

@MainActor
final class MetricPolarityTests: XCTestCase {

    // MARK: - Resolution per polarity

    func testRisingLowerIsBetterResolvesToUpBad() {
        XCTAssertEqual(TrendDirection.resolve(.lowerIsBetter, rising: true), .upBad)
    }

    func testFallingLowerIsBetterResolvesToDownGood() {
        XCTAssertEqual(TrendDirection.resolve(.lowerIsBetter, rising: false), .downGood)
    }

    func testRisingHigherIsBetterResolvesToUpGood() {
        XCTAssertEqual(TrendDirection.resolve(.higherIsBetter, rising: true), .upGood)
    }

    func testFallingHigherIsBetterResolvesToDownBad() {
        XCTAssertEqual(TrendDirection.resolve(.higherIsBetter, rising: false), .downBad)
    }

    func testRisingNeutralResolvesToUpNeutral() {
        XCTAssertEqual(TrendDirection.resolve(.neutral, rising: true), .upNeutral)
    }

    func testFallingNeutralResolvesToDownNeutral() {
        XCTAssertEqual(TrendDirection.resolve(.neutral, rising: false), .downNeutral)
    }

    // MARK: - Color comparison helpers
    //
    // Every color assertion below resolves through UIKit rather than comparing
    // SwiftUI `Color` values directly. `Theme.Colors.*` are dynamic providers
    // — `Color(uiColor: UIColor { trait in ... })` — and SwiftUI `Color`
    // equality on those is REFERENCE-based, not value-based: two independently
    // constructed providers that resolve to identical RGBA compare unequal
    // (see `testRawColorEqualityIsReferenceBasedNotValueBased`). A bare
    // `XCTAssertNotEqual(a.color, b.color)` would therefore pass even if both
    // rendered the exact same pixel, making the metric-blind regression test
    // below prove nothing. Resolving to concrete RGBA per appearance is the
    // only comparison that reflects what the user actually sees.

    private static let appearances: [(name: String, style: UIUserInterfaceStyle)] = [
        ("dark", .dark), ("light", .light)
    ]

    /// Resolves a (possibly dynamic) `Color` to concrete RGBA components for a
    /// fixed appearance.
    private func rgba(_ color: Color, _ style: UIUserInterfaceStyle) -> [CGFloat] {
        let resolved = UIColor(color)
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        return [r, g, b, a]
    }

    private func assertRendersDifferently(
        _ lhs: Color, _ rhs: Color, _ message: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        for appearance in Self.appearances {
            let l = rgba(lhs, appearance.style)
            let r = rgba(rhs, appearance.style)
            let differs = zip(l, r).contains { abs($0 - $1) > 0.001 }
            XCTAssertTrue(
                differs,
                "\(message) — but both resolve to \(l) in \(appearance.name) mode",
                file: file, line: line
            )
        }
    }

    private func assertRendersIdentically(
        _ lhs: Color, _ rhs: Color, _ message: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        for appearance in Self.appearances {
            let l = rgba(lhs, appearance.style)
            let r = rgba(rhs, appearance.style)
            for (lc, rc) in zip(l, r) {
                XCTAssertEqual(
                    lc, rc, accuracy: 0.001,
                    "\(message) — \(l) vs \(r) in \(appearance.name) mode",
                    file: file, line: line
                )
            }
        }
    }

    // MARK: - Regression: the metric-blind trend chip

    /// A rising HRV (good) and a rising, polarity-neutral metric (e.g. steps)
    /// must not render with the same tint — that was the original bug: the
    /// trend chip colored every "up" the same lime regardless of the metric.
    func testUpGoodRendersDifferentlyFromUpNeutral() {
        assertRendersDifferently(
            TrendDirection.upGood.color, TrendDirection.upNeutral.color,
            "upGood and upNeutral must be visually distinguishable"
        )
    }

    /// Nor should a neutral-metric rise be confused with a "bad" rise (e.g.
    /// rising resting HR).
    func testUpGoodRendersDifferentlyFromUpBad() {
        assertRendersDifferently(
            TrendDirection.upGood.color, TrendDirection.upBad.color,
            "upGood and upBad must be visually distinguishable"
        )
    }

    // MARK: - Neutral polarity never fabricates a judgment color

    func testNeutralDirectionsNeverRenderPositiveOrAlertColor() {
        for direction in [TrendDirection.upNeutral, .downNeutral] {
            assertRendersDifferently(
                direction.color, Theme.Colors.positive,
                "a neutral-polarity metric must never render in the positive tint"
            )
            assertRendersDifferently(
                direction.color, Theme.Colors.alert,
                "a neutral-polarity metric must never render in the alert tint"
            )
        }
    }

    // MARK: - Positive controls for the comparison helper
    //
    // Without these, every `assertRendersDifferently` above could be passing
    // vacuously.

    /// Directions that SHOULD share a tint must compare identical. Proves
    /// `assertRendersDifferently` is not simply always-true.
    func testDirectionsSharingATintRenderIdentically() {
        assertRendersIdentically(
            TrendDirection.upNeutral.color, TrendDirection.neutral.color,
            "upNeutral and neutral both use textSecondary"
        )
        assertRendersIdentically(
            TrendDirection.upGood.color, TrendDirection.downGood.color,
            "upGood and downGood both use positive"
        )
    }

    /// The case raw `Color ==` gets wrong: two independently constructed
    /// dynamic providers with identical resolved values. UIKit resolution sees
    /// them as equal, which is the property that makes the helper trustworthy.
    func testIndependentlyConstructedIdenticalColorsResolveEqual() {
        let a = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .red : .blue })
        let b = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .red : .blue })
        assertRendersIdentically(a, b, "identical dynamic providers must resolve equal")
    }

    /// Documents WHY this file resolves through UIKit instead of comparing
    /// `Color` values. If this test ever fails, SwiftUI made `Color` equality
    /// value-based — good news, and the helpers above can be simplified.
    func testRawColorEqualityIsReferenceBasedNotValueBased() {
        let a = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .red : .blue })
        let b = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .red : .blue })
        XCTAssertNotEqual(
            a, b,
            "SwiftUI Color equality on dynamic providers appears value-based now; "
            + "the UIKit resolution in this file can be simplified"
        )
    }
}
