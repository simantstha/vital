import SwiftUI

/// One-tap-adjacent manual weigh-in sheet (§5.3): a `numericHero`-style
/// value pre-filled with the last weight, a 0.1-step ±control, and
/// `[Log <value> <unit>]` — 2 taps total from the hero chip. The very first
/// weigh-in ever (`prefillKg == nil`) opens with the field empty and the
/// keyboard focused instead of a pre-filled value, per spec.
struct WeighInSheet: View {
    let prefillKg: Double?
    let system: UnitSystem
    let isSaving: Bool
    var onSave: (Double) -> Void
    var onCancel: () -> Void

    @State private var text: String
    @FocusState private var fieldFocused: Bool

    init(
        prefillKg: Double?,
        system: UnitSystem,
        isSaving: Bool,
        onSave: @escaping (Double) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.prefillKg = prefillKg
        self.system = system
        self.isSaving = isSaving
        self.onSave = onSave
        self.onCancel = onCancel
        _text = State(initialValue: UnitFormat.weightEntryText(kg: prefillKg, system))
    }

    /// The raw typed number, already in `system`'s unit (never converted —
    /// the caller passes it straight through to `TodayViewModel.logManualWeighIn`).
    private var enteredValue: Double? {
        Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }

    private var canSave: Bool {
        guard let value = enteredValue else { return false }
        return value > 0
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.xl) {
            HStack {
                Spacer()
                Text("Weigh in")
                    .font(Theme.Typography.titleMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
            }
            .overlay(alignment: .trailing) {
                Button(action: onCancel) {
                    ZStack {
                        Circle()
                            .fill(Theme.Colors.glassFill)
                            .frame(width: 32, height: 32)
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }

            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                TextField("0", text: $text)
                    .keyboardType(.decimalPad)
                    .focused($fieldFocused)
                    .font(.system(size: 56, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .multilineTextAlignment(.center)
                    .fixedSize()
                    .accessibilityIdentifier("weighIn.field")

                Text(system.weightUnit)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Weight: \(text.isEmpty ? "0" : text) \(system.weightUnit)")

            HStack(spacing: Theme.Spacing.xxl) {
                stepButton(systemName: "minus", delta: -0.1, accessibilityLabel: "Decrease by 0.1")
                stepButton(systemName: "plus", delta: 0.1, accessibilityLabel: "Increase by 0.1")
            }

            Button {
                guard let value = enteredValue, value > 0 else { return }
                onSave(value)
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    if isSaving {
                        ProgressView().tint(Theme.Colors.onAccent)
                    }
                    Text(isSaving ? "Saving…" : "Log \(text.isEmpty ? "0" : text) \(system.weightUnit)")
                        .font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(Theme.Colors.onAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.md + 2)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(canSave ? Theme.Colors.accent : Theme.Colors.glassFill)
                )
            }
            .buttonStyle(.vital(scale: 0.98))
            .disabled(!canSave || isSaving)
            .accessibilityIdentifier("weighIn.save")

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.top, Theme.Spacing.lg)
        .task {
            // First-ever weigh-in: keyboard focused, nothing pre-filled (spec §5.3).
            if prefillKg == nil { fieldFocused = true }
        }
    }

    /// Current field value in `system`'s unit, falling back to the prefill
    /// (converted) or 0 when the field is empty/unparseable.
    private var currentValue: Double {
        enteredValue ?? prefillKg.map { system == .metric ? $0 : UnitConvert.kgToLb($0) } ?? 0
    }

    private func stepButton(systemName: String, delta: Double, accessibilityLabel: String) -> some View {
        Button {
            let stepped = max(0, currentValue + delta)
            text = String(format: "%.1f", stepped)
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(width: 52, height: 52)
                .background(Circle().fill(Theme.Colors.glassFill))
        }
        .buttonStyle(.vital(scale: 0.9))
        .accessibilityLabel(accessibilityLabel)
        .sensoryFeedback(Theme.Haptics.selection, trigger: text)
    }
}
