import SwiftUI
import UIKit

// MARK: - Scaling math (pure)

/// Dynamic Type for the app's point-size type ramp.
///
/// The design is specified in fixed points (`.system(size: 14, weight: …)`),
/// and SwiftUI's `Font.system(size:)` never scales — so every point size is
/// scaled here along a text style's Dynamic Type curve (`UIFontMetrics`)
/// instead. At `.large`, the system default, the result is exactly the
/// specified size: a migrated call site renders identically at the default
/// size (the CI screenshot baselines) and grows/shrinks with the user's
/// text-size setting everywhere else.
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
        let metrics = UIFontMetrics(forTextStyle: uiTextStyle(for: textStyle))
        let traits = UITraitCollection(preferredContentSizeCategory: contentSizeCategory(for: dynamicTypeSize))
        return metrics.scaledValue(for: base, compatibleWith: traits)
    }

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

    static func uiTextStyle(for textStyle: Font.TextStyle) -> UIFont.TextStyle {
        switch textStyle {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .body: return .body
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        default: return .body
        }
    }

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
