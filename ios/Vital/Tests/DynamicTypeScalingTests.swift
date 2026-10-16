import XCTest
import SwiftUI
import UIKit
@testable import Vital

/// `DynamicTypeScaling` / `ScaledFontToken` (ScaledFont.swift): the point
/// sizes the design specifies must render unchanged at the default text size
/// (the CI screenshot baselines) and grow with the user's Dynamic Type
/// setting everywhere else.
final class DynamicTypeScalingTests: XCTestCase {

    private let allStyles: [Font.TextStyle] = [
        .largeTitle, .title, .title2, .title3, .headline, .subheadline,
        .body, .callout, .footnote, .caption, .caption2,
    ]

    /// Every point size the app passes to `.scaledFont(size:)` today, plus
    /// the token defaults.
    private let sizes: [CGFloat] = [9, 10, 10.5, 11, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 20, 22, 24, 28, 30, 34, 38, 40]

    private let largeAndUp: [DynamicTypeSize] = [
        .large, .xLarge, .xxLarge, .xxxLarge,
        .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5,
    ]

    // MARK: - Default size is the design

    func testDefaultSizeReturnsTheSpecifiedSizeExactly() {
        for style in allStyles {
            for size in sizes {
                XCTAssertEqual(
                    DynamicTypeScaling.scaledSize(size, relativeTo: style, at: .large), size,
                    "\(size)pt relative to \(style) must be unchanged at the default text size"
                )
            }
        }
    }

    func testTokensKeepTheirDesignSizeAtTheDefaultTextSize() {
        let tokens: [(ScaledFontToken, CGFloat)] = [
            (Theme.Typography.bodyLarge, 17), (Theme.Typography.bodyMedium, 15),
            (Theme.Typography.bodySmall, 13), (Theme.Typography.labelMedium, 12),
            (Theme.Typography.labelSmall, 11), (Theme.Typography.titleLarge, 28),
            (Theme.Typography.titleMedium, 22), (Theme.Typography.screenTitle, 34),
            (Theme.Typography.numericHero(), 40), (Theme.Typography.numericLarge(), 28),
            (Theme.Typography.numericSmall(), 17), (Theme.Typography.numericLarge(22), 22),
        ]
        for (token, size) in tokens {
            XCTAssertEqual(token.pointSize, size)
            XCTAssertEqual(token.scaledSize(at: .large), size)
        }
    }

    func testTokensKeepTheirDesignWeightAndDesign() {
        XCTAssertEqual(Theme.Typography.bodyMedium.fontWeight, .regular)
        XCTAssertNil(Theme.Typography.bodyMedium.fontDesign)
        XCTAssertEqual(Theme.Typography.labelSmall.fontWeight, .medium)
        XCTAssertEqual(Theme.Typography.titleLarge.fontWeight, .bold)
        XCTAssertEqual(Theme.Typography.titleMedium.fontWeight, .semibold)
        XCTAssertEqual(Theme.Typography.numericHero().fontWeight, .bold)
        XCTAssertEqual(Theme.Typography.numericHero().fontDesign, .rounded)
        XCTAssertEqual(Theme.Typography.numericSmall().fontWeight, .medium)
    }

    func testWeightOverrideKeepsSizeAndCurve() {
        let token = Theme.Typography.bodyMedium.weight(.semibold)
        XCTAssertEqual(token.pointSize, 15)
        XCTAssertEqual(token.fontWeight, .semibold)
        XCTAssertEqual(token.textStyle, .subheadline)
        XCTAssertEqual(token.scaledSize(at: .large), 15)
    }

    // MARK: - Larger sizes are larger

    func testSizesGrowMonotonicallyFromDefaultThroughAccessibility5() {
        for style in allStyles {
            for size in [CGFloat(11), 13, 15, 17, 20, 34] {
                let scaled = largeAndUp.map { DynamicTypeScaling.scaledSize(size, relativeTo: style, at: $0) }
                for (smaller, larger) in zip(scaled, scaled.dropFirst()) {
                    XCTAssertGreaterThanOrEqual(larger, smaller, "\(size)pt / \(style) shrank going up a size: \(scaled)")
                }
                XCTAssertGreaterThan(DynamicTypeScaling.scaledSize(size, relativeTo: style, at: .xxxLarge), size,
                                     "\(size)pt / \(style) should grow at xxxLarge")
                XCTAssertGreaterThan(DynamicTypeScaling.scaledSize(size, relativeTo: style, at: .accessibility3),
                                     DynamicTypeScaling.scaledSize(size, relativeTo: style, at: .xxxLarge),
                                     "\(size)pt / \(style) should grow again at accessibility sizes")
            }
        }
    }

    func testSmallerSizesNeverGrow() {
        for style in allStyles {
            for size in sizes {
                XCTAssertLessThanOrEqual(DynamicTypeScaling.scaledSize(size, relativeTo: style, at: .xSmall), size + 0.001,
                                         "\(size)pt / \(style) should not grow below the default text size")
            }
        }
    }

    /// The curve is the system's: a 17pt body token tracks
    /// `UIFont.preferredFont(forTextStyle: .body)` at every size.
    func testBodyCurveMatchesTheSystemBodyFont() {
        for dynamicTypeSize in largeAndUp {
            let traits = UITraitCollection(
                preferredContentSizeCategory: DynamicTypeScaling.contentSizeCategory(for: dynamicTypeSize)
            )
            let system = UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
            XCTAssertEqual(DynamicTypeScaling.scaledSize(17, relativeTo: .body, at: dynamicTypeSize), system,
                           accuracy: 0.5, "body at \(dynamicTypeSize)")
        }
    }

    // MARK: - Mapping helpers

    func testDefaultCurveIsTheClosestTextStyle() {
        let expected: [(CGFloat, Font.TextStyle)] = [
            (9, .caption2), (10.5, .caption2), (11, .caption2),
            (12, .caption), (12.5, .footnote), (13, .footnote),
            (14, .subheadline), (15, .subheadline), (16, .callout),
            (17, .body), (18, .body), (20, .title3),
            (22, .title2), (24, .title2), (28, .title), (30, .title),
            (34, .largeTitle), (40, .largeTitle),
        ]
        for (size, style) in expected {
            XCTAssertEqual(DynamicTypeScaling.textStyle(forPointSize: size), style, "\(size)pt")
        }
    }

    func testContentSizeCategoryMappingIsOneToOne() {
        let categories = DynamicTypeSize.allCases.map { DynamicTypeScaling.contentSizeCategory(for: $0) }
        XCTAssertEqual(Set(categories.map(\.rawValue)).count, DynamicTypeSize.allCases.count)
        XCTAssertEqual(DynamicTypeScaling.contentSizeCategory(for: .large), .large)
        // The screenshot harness's AX capture launches with
        // `UICTContentSizeCategoryAccessibilityL`, i.e. AX2.
        XCTAssertEqual(DynamicTypeScaling.contentSizeCategory(for: .accessibility2).rawValue,
                       "UICTContentSizeCategoryAccessibilityL")
        XCTAssertEqual(DynamicTypeScaling.contentSizeCategory(for: .accessibility5), .accessibilityExtraExtraExtraLarge)
    }
}
