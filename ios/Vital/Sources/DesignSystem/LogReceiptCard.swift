import SwiftUI

/// The card the Coach transcript shows for every `log_*` tool result —
/// icon, title, a detail line ("520 kcal · 32 g protein", "82.4 kg"), a
/// timestamp, and Undo/Edit. §5.5: "Undo stays available for 10 minutes."
/// Pure view — no networking, no state beyond what's passed in; the caller
/// owns the underlying log entry and supplies `onUndo`/`onEdit`.
struct LogReceiptCard: View {
    /// One row of a receipt's per-item breakdown, shown under the
    /// title/total when present. Mirrors `MealReceiptRow.Item`.
    struct ItemRow: Identifiable, Equatable {
        var id: String { food }
        let food: String
        let grams: Int
        let kcal: Int
        let confidence: String
    }

    /// Max item rows shown before collapsing the rest into "+N more".
    static let maxVisibleItems = 4

    enum State: Equatable {
        /// The normal, actionable state — Undo/Edit both shown (`onEdit`
        /// only if the caller passed one).
        case normal
        /// Undo fired — struck-through, faded, "Undone" replaces the buttons.
        case undone
        /// Analyzing (e.g. a photo meal still awaiting the AI estimate) —
        /// static redacted placeholder, no shimmer/loop (see
        /// `SkeletonView`'s doc comment: the motion policy forbids
        /// `repeatForever` loops, even for loading states).
        case pending
        /// Undo tapped, request in flight — the button becomes non-tappable
        /// text so a second tap can't fire a second delete.
        case undoing
        /// The Undo request failed — an inline message replaces the detail
        /// line and the card keeps its Undo button so the user can retry.
        case undoFailed(String)
    }

    /// One quick portion-correction chip — ½×, 1×, 1.5×, or 2× the logged
    /// amount. `POST /api/meals/scale` (see `CoachViewModel.scaleMealLog`)
    /// applies the multiplier and remembers the resulting portion for next
    /// time (see that endpoint's doc comment). `1×` is shown but disabled
    /// (nothing to change) so the row always reads as a complete ½·1·1.5·2
    /// scale rather than three unexplained buttons.
    static let scaleFactors: [Double] = [0.5, 1.0, 1.5, 2.0]

    let icon: String
    let title: String
    /// e.g. "520 kcal · 32 g protein" or "82.4 kg".
    let detail: String
    /// Preformatted, e.g. "2:14 PM" — callers own locale/relative-time
    /// formatting rather than this view guessing at it.
    let timestamp: String
    var state: State = .normal
    var onUndo: (() -> Void)?
    var onEdit: (() -> Void)?
    /// Portion-chip action: `nil` hides the chip row entirely (e.g. a
    /// weigh-in receipt, or once the card is `.undone`). Non-nil shows the
    /// ½×/1×/1.5×/2× row in `.normal` state only.
    var onScale: ((Double) -> Void)?
    /// Per-item breakdown — empty hides the item rows entirely (a weigh-in
    /// receipt, a flat/legacy log with no items, or once `.undone`).
    var items: [ItemRow] = []
    /// Per-item fix action: `(food, newGrams)`. `nil` makes item rows
    /// non-interactive (still shown, just not tappable).
    var onScaleItem: ((String, Int) -> Void)?

    @State private var editingItem: ItemRow?

    var body: some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.md) {
                    IconBadge(systemName: icon, style: state == .undone ? .neutral : .soft)

                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .strikethrough(state == .undone)
                            .lineLimit(1)

                        Text(detailText)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(isUndoError ? Theme.Colors.alert : Theme.Colors.textSecondary)
                            .lineLimit(1)

                        Text(timestamp)
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }

                    Spacer(minLength: Theme.Spacing.sm)

                    trailing
                }

                if state == .normal, !items.isEmpty {
                    itemRows
                }

                if state == .normal, let onScale {
                    scaleChips(onScale)
                }
            }
        }
        .opacity(state == .undone ? 0.55 : 1.0)
        .redacted(reason: state == .pending ? .placeholder : [])
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .sheet(item: $editingItem) { item in
            MealItemStepperSheet(item: item) { newGrams in
                onScaleItem?(item.food, newGrams)
                editingItem = nil
            }
        }
    }

    /// The item breakdown: max `maxVisibleItems` rows, then "+N more". The
    /// lowest-confidence/biggest item is marked "biggest guess" — see
    /// `MealReceiptRow.biggestGuess(items:)`, which this view calls with its
    /// own `ItemRow`s reduced to the same shape it needs.
    private var itemRows: some View {
        let visible = Array(items.prefix(Self.maxVisibleItems))
        let hiddenCount = items.count - visible.count
        let biggestGuessFood = Self.biggestGuessFood(items)

        return VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            ForEach(visible) { item in
                Button {
                    guard onScaleItem != nil else { return }
                    editingItem = item
                } label: {
                    HStack(spacing: Theme.Spacing.xs) {
                        Text(Self.itemLine(item))
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineLimit(1)
                        if item.food == biggestGuessFood {
                            Text("biggest guess")
                                .font(Theme.Typography.labelSmall)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                        Spacer(minLength: Theme.Spacing.xs)
                        if onScaleItem != nil {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(onScaleItem == nil)
                .accessibilityLabel(Self.itemLine(item) + (item.food == biggestGuessFood ? ", biggest guess" : ""))
                .accessibilityHint(onScaleItem != nil ? "Double tap to adjust the portion" : "")
            }
            if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(.leading, Theme.Spacing.xxs)
    }

    /// "White rice, cooked · 450 g · 585" — one item's compact row text.
    private static func itemLine(_ item: ItemRow) -> String {
        "\(titleCase(item.food)) · \(item.grams) g · \(item.kcal)"
    }

    private static func titleCase(_ s: String) -> String {
        s.split(separator: " ")
            .map { word -> String in
                guard let first = word.first else { return String(word) }
                return String(first).uppercased() + word.dropFirst()
            }
            .joined(separator: " ")
    }

    /// Lowest-confidence item, tie-broken by largest kcal — same rule as
    /// `MealReceiptRow.biggestGuess(items:)`, duplicated here in terms of
    /// `ItemRow` so this view has no dependency on the Coach feature module.
    private static func biggestGuessFood(_ items: [ItemRow]) -> String? {
        let confidenceRank: [String: Int] = ["low": 0, "med": 1, "high": 2]
        return items.min { a, b in
            let rankA = confidenceRank[a.confidence] ?? 1
            let rankB = confidenceRank[b.confidence] ?? 1
            if rankA != rankB { return rankA < rankB }
            return a.kcal > b.kcal
        }?.food
    }

    private func scaleChips(_ onScale: @escaping (Double) -> Void) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(Self.scaleFactors, id: \.self) { factor in
                Button {
                    onScale(factor)
                } label: {
                    Text(Self.scaleLabel(factor))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(factor == 1.0 ? Theme.Colors.textTertiary : Theme.Colors.textSecondary)
                        .padding(.horizontal, Theme.Spacing.sm)
                        .padding(.vertical, Theme.Spacing.xxs)
                        .background(Capsule().fill(Theme.Colors.glassFill))
                }
                .disabled(factor == 1.0)
                .accessibilityLabel("Scale portion to \(Self.scaleLabel(factor))")
            }
        }
        .buttonStyle(.plain)
    }

    private static func scaleLabel(_ factor: Double) -> String {
        factor == factor.rounded() ? "\(Int(factor))×" : "\(factor)×"
    }

    /// The detail line's text: the analyzing placeholder, the failed-Undo
    /// message, or the normal macro summary.
    private var detailText: String {
        switch state {
        case .pending: return "Analyzing…"
        case .undoFailed(let message): return message
        default: return detail
        }
    }

    private var isUndoError: Bool {
        if case .undoFailed = state { return true }
        return false
    }

    @ViewBuilder
    private var trailing: some View {
        switch state {
        case .pending:
            EmptyView()

        case .undone:
            Text("Removed")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textTertiary)

        case .undoing:
            ProgressView()
                .controlSize(.mini)

        case .normal, .undoFailed:
            HStack(spacing: Theme.Spacing.sm) {
                if let onEdit {
                    Button("Edit", action: onEdit)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                if let onUndo {
                    Button("Undo", action: onUndo)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(state == .normal ? Theme.Colors.accentContent : Theme.Colors.alert)
                }
            }
            .buttonStyle(.vital(scale: 1.0))
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .pending: return "\(title), analyzing"
        case .undone:  return "\(title), \(detail), undone"
        case .undoing: return "\(title), \(detail), removing"
        case .undoFailed(let message): return "\(title), \(detail), \(message)"
        case .normal:  return "\(title), \(detail), logged \(timestamp)"
        }
    }
}

/// The per-item fix sheet a `LogReceiptCard` item row opens: −/+ in 25 g
/// steps, plus ½×/1×/1.5× presets against the item's ORIGINAL grams (the
/// value it opened with, not whatever the stepper currently reads — so
/// repeated presets stay predictable rather than compounding).
private struct MealItemStepperSheet: View {
    let item: LogReceiptCard.ItemRow
    let onConfirm: (Int) -> Void

    @State private var grams: Int
    @Environment(\.dismiss) private var dismiss

    static let step = 25
    static let presets: [(label: String, factor: Double)] = [("½×", 0.5), ("1×", 1.0), ("1.5×", 1.5)]

    init(item: LogReceiptCard.ItemRow, onConfirm: @escaping (Int) -> Void) {
        self.item = item
        self.onConfirm = onConfirm
        _grams = State(initialValue: item.grams)
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Text(item.food.prefix(1).uppercased() + item.food.dropFirst())
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .multilineTextAlignment(.center)
                .padding(.top, Theme.Spacing.lg)

            HStack(spacing: Theme.Spacing.xl) {
                stepperButton("minus.circle.fill") {
                    grams = max(Self.step, grams - Self.step)
                }
                Text("\(grams) g")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .frame(minWidth: 110)
                    .accessibilityLabel("\(grams) grams")
                stepperButton("plus.circle.fill") {
                    grams += Self.step
                }
            }

            HStack(spacing: Theme.Spacing.sm) {
                ForEach(Self.presets, id: \.label) { preset in
                    Button(preset.label) {
                        grams = max(Self.step, Int((Double(item.grams) * preset.factor).rounded()))
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs)
                    .background(Capsule().fill(Theme.Colors.glassFill))
                }
            }
            .buttonStyle(.plain)

            Button("Update") {
                onConfirm(grams)
                dismiss()
            }
            .buttonStyle(.vital(scale: 1.0))
            .frame(maxWidth: .infinity)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .presentationDetents([.height(280)])
        .presentationDragIndicator(.visible)
    }

    private func stepperButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 32))
                .foregroundStyle(Theme.Colors.accentContent)
        }
        .buttonStyle(.plain)
    }
}

#Preview("LogReceiptCard — light") {
    LogReceiptCardPreviewList()
        .preferredColorScheme(.light)
}

#Preview("LogReceiptCard — dark") {
    LogReceiptCardPreviewList()
        .preferredColorScheme(.dark)
}

private struct LogReceiptCardPreviewList: View {
    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                LogReceiptCard(
                    icon: "fork.knife",
                    title: "Chicken bowl",
                    detail: "520 kcal · 32 g protein",
                    timestamp: "2:14 PM",
                    onUndo: {},
                    onEdit: {},
                    onScale: { _ in }
                )
                LogReceiptCard(
                    icon: "scalemass",
                    title: "Weigh-in",
                    detail: "82.4 kg",
                    timestamp: "7:02 AM",
                    onUndo: {}
                )
                LogReceiptCard(
                    icon: "fork.knife",
                    title: "Greek yogurt",
                    detail: "180 kcal · 18 g protein",
                    timestamp: "9:40 AM",
                    state: .undone
                )
                LogReceiptCard(
                    icon: "camera",
                    title: "Analyzing your meal…",
                    detail: "",
                    timestamp: "12:01 PM",
                    state: .pending
                )
            }
            .padding()
        }
        .background(Theme.Colors.canvas)
    }
}
