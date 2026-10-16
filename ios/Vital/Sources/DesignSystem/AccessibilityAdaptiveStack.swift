import SwiftUI

/// A row that is a plain `HStack` at standard text sizes and a leading-aligned
/// `VStack` at accessibility text sizes (`DynamicTypeSize.isAccessibilitySize`),
/// where side-by-side label / value / pill rows run out of width and would
/// otherwise truncate.
///
/// The standard-size branch is exactly `HStack(alignment:spacing:)` with the
/// same children, so layout at the default text size (and every CI screenshot
/// baseline) is unchanged. A `Spacer` child becomes a vertical spacer in the
/// stacked branch — keep any `minLength` small.
struct AccessibilityAdaptiveStack<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private let alignment: VerticalAlignment
    private let spacing: CGFloat?
    private let stackedAlignment: HorizontalAlignment
    private let stackedSpacing: CGFloat?
    private let content: Content

    init(
        alignment: VerticalAlignment = .center,
        spacing: CGFloat? = nil,
        stackedAlignment: HorizontalAlignment = .leading,
        stackedSpacing: CGFloat? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.alignment = alignment
        self.spacing = spacing
        self.stackedAlignment = stackedAlignment
        self.stackedSpacing = stackedSpacing
        self.content = content()
    }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: stackedAlignment, spacing: stackedSpacing ?? spacing) { content }
        } else {
            HStack(alignment: alignment, spacing: spacing) { content }
        }
    }
}
