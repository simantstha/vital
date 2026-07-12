import SwiftUI

/// Reusable bottom-sheet scaffold for `.sheet` presentations in the v3 style:
/// canvas background, a hand-drawn top grab handle (the system indicator is
/// hidden so we can control its look), and rounded top corners.
///
/// Usage:
/// ```swift
/// @State private var showSheet = false
/// ...
/// .sheet(isPresented: $showSheet) {
///     VitalSheet {
///         // sheet content
///     }
/// }
/// ```
/// Pass `detents` to override the default `[.large]`.
struct VitalSheet<Content: View>: View {
    var detents: Set<PresentationDetent> = [.large]
    @ViewBuilder var content: () -> Content

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            grabHandle
                .padding(.top, Theme.Spacing.md)
                .padding(.bottom, Theme.Spacing.sm)

            content()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.Colors.canvas)
        .presentationDetents(detents)
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(Theme.Radius.sheet)
    }

    private var grabHandle: some View {
        Capsule()
            .fill(colorScheme == .dark ? Color.white.opacity(0.20) : Color.black.opacity(0.15))
            .frame(width: 36, height: 4)
    }
}
