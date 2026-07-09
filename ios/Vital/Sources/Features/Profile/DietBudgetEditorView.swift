import SwiftUI

/// Editable Daily Budget sheet. Two modes: Auto (calculated from goal + weight)
/// and Custom (user-pinned kcal + macros). Reached from Profile → Nutrition.
struct DietBudgetEditorView: View {
    @StateObject private var vm = DietBudgetViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()

                if vm.isLoading {
                    ProgressView()
                } else {
                    ScrollView {
                        VStack(spacing: Theme.Spacing.lg) {
                            modePicker
                            heroCard
                            splitBar
                            if vm.mode == "custom" {
                                macroEditors
                                resetButton
                            } else {
                                goalCard
                                autoNote
                            }
                            if let msg = vm.errorMessage {
                                Text(msg)
                                    .font(Theme.Typography.bodySmall)
                                    .foregroundStyle(Theme.Colors.alert)
                            }
                        }
                        .padding(.horizontal, Theme.Spacing.xl)
                        .padding(.top, Theme.Spacing.md)
                        .padding(.bottom, 40)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .navigationTitle("Daily Budget")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { vm.commit(); dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .task { await vm.load() }
    }

    // ── Auto / Custom segmented control ───────────────────────────────────────

    private var modePicker: some View {
        Picker("Mode", selection: Binding(get: { vm.mode }, set: { vm.setMode($0) })) {
            Text("Auto").tag("auto")
            Text("Custom").tag("custom")
        }
        .pickerStyle(.segmented)
    }

    // ── Hero: big kcal number (± stepper in custom) ──────────────────────────

    private var heroCard: some View {
        GlassCard(padding: Theme.Spacing.xl) {
            VStack(spacing: Theme.Spacing.sm) {
                Text("DAILY TARGET")
                    .font(Theme.Typography.labelSmall)
                    .tracking(0.8)
                    .foregroundStyle(Theme.Colors.textSecondary)

                if vm.mode == "custom" {
                    HStack(spacing: Theme.Spacing.xl) {
                        stepButton("minus") { vm.adjustKcal(by: -50); vm.commit() }
                        kcalNumber
                        stepButton("plus") { vm.adjustKcal(by: 50); vm.commit() }
                    }
                } else {
                    kcalNumber
                    Text("Calculated from your goal: \(vm.goalDisplay)")
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var kcalNumber: some View {
        HStack(alignment: .lastTextBaseline, spacing: 4) {
            Text("\(vm.targetKcal)")
                .font(Theme.Typography.numericHero(48))
                .foregroundStyle(vm.mode == "custom" ? Theme.Colors.accentContent : Theme.Colors.textPrimary)
            Text("kcal")
                .font(Theme.Typography.numericSmall(18))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .contentTransition(.numericText())
        .animation(.snappy, value: vm.targetKcal)
    }

    private func stepButton(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Theme.Colors.glassFill))
                .overlay(Circle().strokeBorder(Theme.Colors.glassBorder, lineWidth: 1))
        }
    }

    // ── Macro split bar + legend ──────────────────────────────────────────────

    private var splitBar: some View {
        let p = Double(vm.protein * 4), c = Double(vm.carbs * 4), f = Double(vm.fat * 9)
        let total = max(1, p + c + f)
        return VStack(spacing: Theme.Spacing.sm) {
            GeometryReader { geo in
                HStack(spacing: 2) {
                    Capsule().fill(Theme.Colors.accent).frame(width: geo.size.width * p / total)
                    Capsule().fill(Theme.Colors.indigo).frame(width: geo.size.width * c / total)
                    Capsule().fill(Theme.Colors.alert).frame(width: geo.size.width * f / total)
                }
            }
            .frame(height: 10)

            HStack {
                legendItem("Protein", "\(vm.protein)g", Theme.Colors.accent)
                Spacer()
                legendItem("Carbs", "\(vm.carbs)g", Theme.Colors.indigo)
                Spacer()
                legendItem("Fat", "\(vm.fat)g", Theme.Colors.alert)
            }
        }
    }

    private func legendItem(_ label: String, _ value: String, _ color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(Theme.Typography.labelSmall).foregroundStyle(Theme.Colors.textSecondary)
            Text(value).font(Theme.Typography.labelSmall).fontWeight(.semibold).foregroundStyle(Theme.Colors.textPrimary)
        }
    }

    // ── Custom: editable macro rows ────────────────────────────────────────────

    private var macroEditors: some View {
        VStack(spacing: Theme.Spacing.sm) {
            macroRow("Protein", value: Binding(get: { vm.protein }, set: { vm.protein = $0 }), color: Theme.Colors.accent)
            macroRow("Carbs",   value: Binding(get: { vm.carbs },   set: { vm.carbs = $0 }),   color: Theme.Colors.indigo)
            macroRow("Fat",     value: Binding(get: { vm.fat },     set: { vm.fat = $0 }),     color: Theme.Colors.alert)
        }
    }

    private func macroRow(_ label: String, value: Binding<Int>, color: Color) -> some View {
        GlassCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
            HStack {
                Circle().fill(color).frame(width: 10, height: 10)
                Text(label).font(Theme.Typography.bodyMedium).foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                TextField("0", value: value, format: .number)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 64)
                    .font(Theme.Typography.numericSmall(17))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .onSubmit { vm.commit() }
                Text("g").font(Theme.Typography.bodySmall).foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }

    private var resetButton: some View {
        Button { vm.resetToAuto() } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.counterclockwise")
                Text("Reset to auto")
            }
            .font(Theme.Typography.bodySmall)
            .fontWeight(.medium)
            .foregroundStyle(Theme.Colors.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.md)
        }
    }

    // ── Auto: goal picker + note ───────────────────────────────────────────────

    private var goalCard: some View {
        GlassCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
            HStack {
                Text("Goal").font(Theme.Typography.bodyMedium).foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Menu {
                    ForEach(vm.goalOptions) { opt in
                        Button(opt.label) { vm.setGoal(opt.id) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(vm.goalDisplay).fontWeight(.medium)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                    }
                    .foregroundStyle(Theme.Colors.accentContent)
                }
            }
        }
    }

    private var autoNote: some View {
        Text("Vital keeps this target updated automatically as your weight and activity change. Switch to Custom to set your own.")
            .font(Theme.Typography.bodySmall)
            .foregroundStyle(Theme.Colors.textSecondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Theme.Spacing.sm)
    }
}
