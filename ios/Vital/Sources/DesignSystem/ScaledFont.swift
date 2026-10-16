import SwiftUI
import UIKit

// MARK: - Scaling math (pure)

/// Dynamic Type for the app's point-size type ramp.
///
/// The design is specified in fixed points (`.system(size: 14, weight: …)`),
/// and SwiftUI's `Font.system(size:)` never scales — so every point size is
/// scaled here along a text style's Dynamic Type curve instead. The curve is
/// Apple's published per-style point-size table (Human Interface Guidelines →
/// Typography → "Dynamic Type sizes", iOS/iPadOS), and a token scales by the
/// same ratio the system font for that style does:
///
///     scaled = base × styleSize(category) ÷ styleSize(.large)
///
/// At `.large`, the system default, the result is exactly the specified size:
/// a migrated call site renders identically at the default size (the CI
/// screenshot baselines) and grows/shrinks with the user's text-size setting
/// everywhere else. Below `.large` nothing ever grows — the small sizes of
/// the footnote/caption styles are flat in Apple's table, so those tokens
/// simply stay at their base size.
///
/// This deliberately does not use `UIFontMetrics.scaledValue(for:)`: it does
/// not reproduce the preferred-font table (a 17pt body token came out up to
/// 5pt smaller than `UIFont.preferredFont(forTextStyle: .body)` at the larger
/// sizes, and sub-body tokens *grew* at `.xSmall`). A static table is exact,
/// needs no UIKit trait plumbing, and is unit-testable anywhere.
///
/// Prefer the `.scaledFont(...)` view modifiers below over calling this
/// directly; they read `\.dynamicTypeSize` from the environment, so the view
/// re-renders live when the setting changes and honors any
/// `.dynamicTypeSize(...)` cap applied above it.
enum DynamicTypeScaling {

    /// `base` points scaled for `dynamicTypeSize` along `textStyle`'s curve.
    /// Returns `base` unchanged at `.large`.
    static func scaledSize(
        _ base: CGFloat,
        relativeTo textStyle: Font.TextStyle,
        at dynamicTypeSize: DynamicTypeSize
    ) -> CGFloat {
        guard dynamicTypeSize != .large else { return base }
        let sizes = appleSizes[textStyle] ?? bodySizes
        return base * sizes[tableIndex(for: dynamicTypeSize)] / sizes[largeIndex]
    }

    // MARK: Apple's Dynamic Type size table

    /// Column of `appleSizes` rows for `.large` (the default size).
    private static let largeIndex = 3

    /// Column of `appleSizes` rows for `dynamicTypeSize`.
    private static func tableIndex(for dynamicTypeSize: DynamicTypeSize) -> Int {
        switch dynamicTypeSize {
        case .xSmall: return 0
        case .small: return 1
        case .medium: return 2
        case .large: return largeIndex
        case .xLarge: return 4
        case .xxLarge: return 5
        case .xxxLarge: return 6
        case .accessibility1: return 7
        case .accessibility2: return 8
        case .accessibility3: return 9
        case .accessibility4: return 10
        case .accessibility5: return 11
        @unknown default: return largeIndex
        }
    }

    /// Body's row — also the fallback for text styles this table doesn't list
    /// (e.g. visionOS-only extra-large titles).
    private static let bodySizes: [CGFloat] = [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53]

    /// Point size of each text style at every Dynamic Type size, from
    /// Apple's HIG "Dynamic Type sizes" tables (iOS, iPadOS). Columns:
    /// xSmall, small, medium, **large**, xLarge, xxLarge, xxxLarge, then
    /// accessibility1 … accessibility5.
    private static let appleSizes: [Font.TextStyle: [CGFloat]] = [
        .largeTitle:  [31, 32, 33, 34, 36, 38, 40, 44, 48, 52, 56, 60],
        .title:       [25, 26, 27, 28, 30, 32, 34, 38, 43, 48, 53, 58],
        .title2:      [19, 20, 21, 22, 24, 26, 28, 34, 39, 44, 50, 56],
        .title3:      [17, 18, 19, 20, 22, 24, 26, 31, 37, 43, 49, 55],
        .headline:    [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53],
        .body:        bodySizes,
        .callout:     [13, 14, 15, 16, 18, 20, 22, 26, 32, 38, 44, 51],
        .subheadline: [12, 13, 14, 15, 17, 19, 21, 25, 30, 36, 42, 49],
        .footnote:    [12, 12, 12, 13, 15, 17, 19, 23, 27, 33, 38, 44],
        .caption:     [11, 11, 11, 12, 14, 16, 18, 22, 26, 32, 37, 43],
        .caption2:    [11, 11, 11, 11, 13, 15, 17, 20, 24, 29, 34, 40],
    ]

    // MARK: Mapping helpers

    /// The text style whose default (`.large`) point size is closest to
    /// `size` — the curve a fixed size follows when the call site doesn't
    /// name one. Defaults at `.large`: caption2 11, caption 12, footnote 13,
    /// subheadline 15, callout 16, body 17, title3 20, title2 22, title 28,
    /// largeTitle 34.
    static func textStyle(forPointSize size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<11.5: return .caption2
        case ..<12.5: return .caption
        case ..<13.5: return .footnote
        case ..<15.5: return .subheadline
        case ..<16.5: return .callout
        case ..<18.5: return .body
        case ..<21: return .title3
        case ..<25: return .title2
        case ..<31: return .title
        default: return .largeTitle
        }
    }

    /// The `UIContentSizeCategory` equivalent of `dynamicTypeSize` — for
    /// building a `UITraitCollection` (the screenshot harness, and tests that
    /// compare against `UIFont.preferredFont(forTextStyle:compatibleWith:)`).
    static func contentSizeCategory(for dynamicTypeSize: DynamicTypeSize) -> UIContentSizeCategory {
        switch dynamicTypeSize {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

// MARK: - Token

/// A point-size type token (`Theme.Typography.*`): the size/weight/design the
/// design specifies at the default text size, plus the text style whose
/// Dynamic Type curve it follows. Apply with `.scaledFont(token)`.
struct ScaledFontToken {
    /// Point size at the default (`.large`) text size.
    let pointSize: CGFloat
    let fontWeight: Font.Weight?
    let fontDesign: Font.Design?
    /// The Dynamic Type curve `pointSize` follows.
    let textStyle: Font.TextStyle

    init(size: CGFloat, weight: Font.Weight? = nil, design: Font.Design? = nil, relativeTo textStyle: Font.TextStyle? = nil) {
        self.pointSize = size
        self.fontWeight = weight
        self.fontDesign = design
        self.textStyle = textStyle ?? DynamicTypeScaling.textStyle(forPointSize: size)
    }

    /// The same token with a different weight (mirrors `Font.weight(_:)`,
    /// e.g. `Theme.Typography.bodyMedium.weight(.semibold)`).
    func weight(_ weight: Font.Weight) -> ScaledFontToken {
        ScaledFontToken(size: pointSize, weight: weight, design: fontDesign, relativeTo: textStyle)
    }

    /// Point size at `dynamicTypeSize` (exactly `pointSize` at `.large`).
    func scaledSize(at dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        DynamicTypeScaling.scaledSize(pointSize, relativeTo: textStyle, at: dynamicTypeSize)
    }

    /// The concrete font at `dynamicTypeSize` — for the rare place that needs
    /// a `Font` value rather than a view modifier (an `AttributedString` run,
    /// a `Text` that must stay a `Text`). Read `dynamicTypeSize` from
    /// `@Environment(\.dynamicTypeSize)` in the calling view so it updates live.
    func font(scaledFor dynamicTypeSize: DynamicTypeSize) -> Font {
        .system(size: scaledSize(at: dynamicTypeSize), weight: fontWeight, design: fontDesign)
    }
}

// MARK: - View modifiers

private struct ScaledFontModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let token: ScaledFontToken

    func body(content: Content) -> some View {
        content.font(token.font(scaledFor: dynamicTypeSize))
    }
}

extension View {
    /// Drop-in replacement for `.font(.system(size:weight:design:))` that
    /// scales with Dynamic Type: exactly `size` at the default text size,
    /// following `textStyle`'s curve (default: the text style closest to
    /// `size`, see `DynamicTypeScaling.textStyle(forPointSize:)`) elsewhere.
    func scaledFont(
        size: CGFloat,
        weight: Font.Weight? = nil,
        design: Font.Design? = nil,
        relativeTo textStyle: Font.TextStyle? = nil
    ) -> some View {
        modifier(ScaledFontModifier(token: ScaledFontToken(size: size, weight: weight, design: design, relativeTo: textStyle)))
    }

    /// Applies a `Theme.Typography` token, scaled with Dynamic Type.
    func scaledFont(_ token: ScaledFontToken) -> some View {
        modifier(ScaledFontModifier(token: token))
    }
}
