import SwiftUI

// MARK: - Item

/// A single toast request handed to `ActionToastPresenter`. Distinct from the
/// plain `.toast(message:)` pill (see `Toast.swift`, which stays for
/// non-actionable confirmations at top-center): this one anchors to the
/// bottom, optionally carries a trailing action button ("Undo", "Edit"), and
/// only ever shows one at a time — see §5.5 of `docs/ux-spec-v4.md`.
struct ActionToastItem: Identifiable, Equatable {
    let id: UUID
    let message: String
    let actionTitle: String?
    let action: (() -> Void)?

    /// Drives auto-dismiss timing: 5s (10s under VoiceOver) for an
    /// undoable/actionable toast, 2.4s (matching the plain `Toast`) when
    /// there's no action to reach — table row `toast` in §6.
    var isUndoable: Bool { actionTitle != nil && action != nil }

    init(message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.id = UUID()
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    static func == (lhs: ActionToastItem, rhs: ActionToastItem) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Presenter

/// Owns "what's currently showing" so a feature view model can call
/// `presenter.show(...)` without owning any SwiftUI timer/gesture state
/// itself — mirrors how `Toast.swift`'s callers just set a `@Published`
/// string, except this one also needs replace-newer-wins and duration
/// bookkeeping, so it gets a small presenter instead of a bare `Binding`.
///
/// One toast at a time: a new `show(...)` call always replaces whatever is
/// currently queued or visible (§5.5: "a newer toast replaces the current
/// one"). There is no queue behind it — showing a second toast while a first
/// is up simply discards the first.
@MainActor
final class ActionToastPresenter: ObservableObject {
    @Published private(set) var current: ActionToastItem?

    /// Base auto-dismiss duration before any VoiceOver adjustment, exposed
    /// so the host view and tests can share one source of truth.
    static func baseDuration(isUndoable: Bool) -> TimeInterval {
        isUndoable ? 5.0 : 2.4
    }

    /// VoiceOver runs the toast twice as long, matching the spec's explicit
    /// "10 s under VoiceOver" for the 5s undoable case.
    static func duration(isUndoable: Bool, voiceOverRunning: Bool) -> TimeInterval {
        let base = baseDuration(isUndoable: isUndoable)
        return voiceOverRunning ? base * 2 : base
    }

    func show(message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        current = ActionToastItem(message: message, actionTitle: actionTitle, action: action)
    }

    func show(_ item: ActionToastItem) {
        current = item
    }

    /// Dismisses only if `id` still matches what's showing — guards a stale
    /// timer or gesture callback (from a toast that's already been replaced)
    /// from clearing a newer one.
    func dismiss(id: UUID) {
        if current?.id == id {
            current = nil
        }
    }

    func dismissCurrent() {
        current = nil
    }
}

// MARK: - View

private struct ActionToastView: View {
    let item: ActionToastItem
    let onDismiss: () -> Void
    /// Reports touch start/end so the host can pause auto-dismiss while the
    /// user's finger is on the toast (§5.5: "paused while touched").
    var onTouchChanged: (Bool) -> Void = { _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)

                Text(item.message)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)

            // Left as a plain `Button` (not folded into the combined element
            // above) so VoiceOver keeps it as its own focusable action —
            // "action reachable" per the L1 spec.
            if let actionTitle = item.actionTitle, let action = item.action {
                Spacer(minLength: Theme.Spacing.sm)
                Button(actionTitle) {
                    action()
                    onDismiss()
                }
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.Colors.accentContent)
                .buttonStyle(.vital(scale: 1.0))
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .background(
            Capsule()
                .fill(Color(red: 0.090, green: 0.094, blue: 0.102).opacity(0.94))
        )
        .shadow(color: .black.opacity(0.25), radius: 12, x: 0, y: 6)
        .offset(y: dragOffset)
        .gesture(
            DragGesture(minimumDistance: 8)
                .onChanged { value in
                    // Either direction counts as "swipe to dismiss away from
                    // the pill" — up flicks it off-screen, down follows it
                    // toward the edge it's pinned near.
                    dragOffset = value.translation.height
                }
                .onEnded { value in
                    if abs(value.translation.height) > 24 {
                        onDismiss()
                    } else {
                        withAnimation(reduceMotion ? nil : Theme.Motion.snap) {
                            dragOffset = 0
                        }
                    }
                }
        )
        // A separate, non-exclusive `minimumDistance: 0` recognizer purely
        // for "finger is down" tracking — `.simultaneousGesture` lets it
        // coexist with the swipe gesture above and with the Undo/Edit
        // `Button` below, instead of stealing its taps the way raising the
        // swipe gesture's own `minimumDistance` to 0 would.
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in onTouchChanged(true) }
                .onEnded { _ in onTouchChanged(false) }
        )
        .onTapGesture {
            onDismiss()
        }
    }
}

/// Hosts `presenter.current` as a bottom-pinned pill. Placeholder offset:
/// pinned just above the safe area for now; once the Coach Bar ships (IA1,
/// §2 Option A) this should sit 12pt above it instead (§5.5).
private struct ActionToastHostModifier: ViewModifier {
    @ObservedObject var presenter: ActionToastPresenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @State private var isTouched = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let item = presenter.current {
                    ActionToastView(
                        item: item,
                        onDismiss: {
                            withAnimation(reduceMotion ? nil : Theme.Motion.exit) {
                                presenter.dismiss(id: item.id)
                            }
                        },
                        onTouchChanged: { touched in isTouched = touched }
                    )
                    .padding(.bottom, Theme.Spacing.xxxl)
                    .padding(.horizontal, Theme.Spacing.xl)
                    .motionTransition(.fromBottom)
                    .sensoryFeedback(Theme.Haptics.success, trigger: item.id)
                    .task(id: item.id) {
                        UIAccessibility.post(notification: .announcement, argument: item.message)
                        // Paused while touched (§5.5); re-armed on release.
                        while true {
                            let duration = ActionToastPresenter.duration(
                                isUndoable: item.isUndoable,
                                voiceOverRunning: voiceOverEnabled
                            )
                            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
                            if Task.isCancelled { return }
                            if isTouched {
                                // Keep waiting in short slices until released,
                                // rather than firing mid-touch.
                                try? await Task.sleep(nanoseconds: 200_000_000)
                                continue
                            }
                            withAnimation(reduceMotion ? nil : Theme.Motion.exit) {
                                presenter.dismiss(id: item.id)
                            }
                            return
                        }
                    }
                }
            }
            .animation(reduceMotion ? nil : Theme.Motion.snap, value: presenter.current?.id)
    }
}

extension View {
    /// Attaches the bottom-pinned action toast host, showing whatever
    /// `presenter.current` holds. One at a time — a newer `show(...)` call
    /// replaces whatever's up.
    func actionToastHost(_ presenter: ActionToastPresenter) -> some View {
        modifier(ActionToastHostModifier(presenter: presenter))
    }
}

#Preview("ActionToast — light") {
    ActionToastPreviewHost()
        .preferredColorScheme(.light)
}

#Preview("ActionToast — dark") {
    ActionToastPreviewHost()
        .preferredColorScheme(.dark)
}

private struct ActionToastPreviewHost: View {
    @StateObject private var presenter = ActionToastPresenter()

    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Button("Show plain confirmation") {
                presenter.show(message: "Logged 181.8 lb · trend 182.3 (−0.5/wk)")
            }
            Button("Show with Undo") {
                presenter.show(message: "Logged Chicken bowl · ~620 kcal", actionTitle: "Undo") {}
            }
            Button("Show with Edit") {
                presenter.show(message: "Logged Push day", actionTitle: "Edit") {}
            }
        }
        .buttonStyle(.borderedProminent)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.canvas)
        .actionToastHost(presenter)
    }
}
