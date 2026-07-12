import SwiftUI

/// A top-center dark capsule toast (e.g. "Logged — nice work"), matching the
/// mock's `bg-txt/90` pill with a leading checkmark. Slides + fades in from
/// the top and auto-dismisses after 2.4s.
private struct ToastView: View {
    let message: String

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "checkmark")
                .font(.system(size: 13, weight: .bold))
            Text(message)
                .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm + 2)
        .background(
            Capsule()
                .fill(Color(red: 0.090, green: 0.094, blue: 0.102).opacity(0.9))
        )
        .shadow(color: .black.opacity(0.25), radius: 10, x: 0, y: 6)
    }
}

/// Hosts a toast that appears at the top-center of the view it's attached to.
/// Set `message` to a non-nil string to show it; it auto-clears itself after
/// 2.4s (mirroring the mock's `setTimeout(() => setToast(null), 2400)`).
private struct ToastModifier: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let message {
                    ToastView(message: message)
                        .padding(.top, Theme.Spacing.xxxl)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .allowsHitTesting(false)
                        .task(id: message) {
                            try? await Task.sleep(nanoseconds: 2_400_000_000)
                            withAnimation(.easeOut(duration: 0.2)) {
                                self.message = nil
                            }
                        }
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.8), value: message)
    }
}

extension View {
    /// Shows a top-center dark pill toast whenever `message` is non-nil.
    /// The toast clears `message` itself after ~2.4s.
    func toast(message: Binding<String?>) -> some View {
        modifier(ToastModifier(message: message))
    }
}
