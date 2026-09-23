import SwiftUI

/// One-tap-adjacent manual weigh-in sheet (§5.3): a `numericHero`-style
/// value pre-filled with the last weight, a 0.1-step ±control, and
/// `[Log <value> <unit>]` — 2 taps total from the hero chip. The very first
/// weigh-in ever (`prefillKg == nil`) opens with the field empty and the
/// keyboard focused instead of a pre-filled value, per spec.
struct WeighInSheet: View {
    let prefillKg: Double?
    /// Current trend weight (kg), if any — backs the plausibility-bounds
    /// >3%-from-trend confirm (dietitian review, 2026-09-23). `nil` when
    /// there's no trend yet to compare against (never confirms in that case).
    let currentTrendKg: Double?
    let system: UnitSystem
    let isSaving: Bool
    var onSave: (Double) -> Void
    var onCancel: () -> Void

    @State private var text: String
    /// Set once the user has already seen and dismissed the >3%-from-trend
    /// confirm for the value currently in `text` — a second tap of Save then
    /// actually saves. Reset whenever `text` changes (a re-check is needed).
    @State private var confirmedDelta = false
    @FocusState private var fieldFocused: Bool

    init(
        prefillKg: Double?,
        currentTrendKg: Double?,
        system: UnitSystem,
        isSaving: Bool,
        onSave: @escaping (Double) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.prefillKg = prefillKg
        self.currentTrendKg = currentTrendKg
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

    /// `enteredValue` converted to kg regardless of `system`, for the
    /// plausibility-bounds and trend-delta checks (both defined in kg).
    private var enteredValueKg: Double? {
        guard let value = enteredValue else { return nil }
        return system == .metric ? value : UnitConvert.lbToKg(value)
    }

    /// Dietitian-review bounds (§ plausibility, 2026-09-23): a typed value
    /// outside 25–350 kg is rejected with inline copy rather than silently
    /// accepted — catches unit mix-ups and stray digits before they corrupt
    /// the trend.
    private var boundsErrorText: String? {
        guard let kg = enteredValueKg, !WeightHeroLogic.isPlausibleWeight(kg: kg) else { return nil }
        let lo = UnitFormat.weight(kg: WeightHeroLogic.minPlausibleWeightKg, system)
        let hi = UnitFormat.weight(kg: WeightHeroLogic.maxPlausibleWeightKg, system)
        return "Enter a weight between \(lo) and \(hi)."
    }

    /// The one-line ">3% from trend" confirm text, or `nil` when the entry
    /// is close enough to the current trend (or there's no trend yet).
    private var deltaConfirmText: String? {
        guard let kg = enteredValueKg,
              WeightHeroLogic.exceedsTrendDeltaThreshold(enteredKg: kg, currentTrendKg: currentTrendKg),
              let currentTrendKg
        else { return nil }
        let diff = UnitFormat.weight(kg: abs(kg - currentTrendKg), system)
        return "That's \(diff) from your trend — save anyway?"
    }

    private var canSave: Bool {
        guard let value = enteredValue, value > 0 else { return false }
        return boundsErrorText == nil
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

            if let boundsErrorText {
                Text(boundsErrorText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Colors.alert)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("weighIn.boundsError")
            } else if confirmedDelta == false, let deltaConfirmText {
                // Neutral styling (dietitian review, 2026-09-23) — this is an
                // honest "does that look right?" prompt, not a warning.
                Text(deltaConfirmText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("weighIn.deltaConfirm")
            }

            HStack(spacing: Theme.Spacing.xxl) {
                stepButton(systemName: "minus", delta: -0.1, accessibilityLabel: "Decrease by 0.1")
                stepButton(systemName: "plus", delta: 0.1, accessibilityLabel: "Increase by 0.1")
            }

            Button {
                guard let value = enteredValue, canSave else { return }
                // A pending, not-yet-acknowledged >3%-from-trend confirm gets
                // one tap to surface the copy above, and a second to proceed
                // — logging never silently overrides an unusual entry, but it
                // also never hard-blocks it (§5.5: never "are you sure?").
                if !confirmedDelta, deltaConfirmText != nil {
                    confirmedDelta = true
                    return
                }
                onSave(value)
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    if isSaving {
                        ProgressView().tint(Theme.Colors.onAccent)
                    }
                    Text(saveButtonTitle)
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
        .onChange(of: text) { _, _ in
            // A changed value needs its own bounds/delta re-check.
            confirmedDelta = false
        }
    }

    private var saveButtonTitle: String {
        if isSaving { return "Saving…" }
        // Only after the first tap has acknowledged the delta confirm (the
        // inline "That's … from your trend" text is now hidden) does the
        // button itself say "Save anyway" — the next tap actually saves.
        if confirmedDelta, deltaConfirmText != nil { return "Save anyway" }
        return "Log \(text.isEmpty ? "0" : text) \(system.weightUnit)"
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
