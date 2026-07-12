import SwiftUI

/// Full diet logging / editing sheet — opened from Today's fuel strip.
/// Mirrors the design mock's `DietSheet`: header (remaining vs editable
/// target), a Breakfast/Lunch/Snacks/Dinner slot grid, a quick-log list per
/// slot + custom name/kcal entry, links into the existing photo/barcode/
/// search logging flows, and a "Logged today" list grouped by slot.
///
/// Presented by the caller inside `VitalSheet(detents: [.large])` (see
/// `TodayView`); this view supplies only its own scrolling content.
struct DietSheetView: View {
    @StateObject private var vm: DietSheetViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var showLogMealSheet = false
    @State private var logMealMethod: MealInputMethod = .text
    @FocusState private var targetFieldFocused: Bool

    init(initialTarget: Int, onRefreshToday: @escaping () -> Void) {
        _vm = StateObject(wrappedValue: DietSheetViewModel(initialTarget: initialTarget, onRefreshToday: onRefreshToday))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                header
                remainingRow
                slotGrid
                quickLogSection
                deeperFlowsRow
                loggedTodaySection
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.xxl)
        }
        .task { await vm.load() }
        .toast(message: $vm.toastMessage)
        .sheet(isPresented: $showLogMealSheet) {
            LogMealView(initialMethod: logMealMethod)
        }
        .onChange(of: showLogMealSheet) { _, isPresented in
            // Covers both a completed log and a plain cancel — idempotent.
            if !isPresented {
                Task { await vm.load() }
                vm.onRefreshToday()
            }
        }
    }
}

// MARK: - Sections

private extension DietSheetView {

    var header: some View {
        HStack {
            Text("Diet budget")
                .font(.system(size: 18, weight: .bold))
                .tracking(-0.2)
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            Button {
                dismiss()
            } label: {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.glassFill)
                        .frame(width: 36, height: 36)
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
    }

    var remainingRow: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Text("\(vm.remaining.formatted())")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("kcal left of")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textSecondary)

            if vm.isEditingTarget {
                TextField("", text: $vm.targetInput)
                    .keyboardType(.numberPad)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .multilineTextAlignment(.center)
                    .frame(width: 64)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(Theme.Colors.card)
                            .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
                    )
                    .focused($targetFieldFocused)
                    .onSubmit { commitTargetEdit() }
                    .onChange(of: targetFieldFocused) { _, focused in
                        if !focused, vm.isEditingTarget { commitTargetEdit() }
                    }
                    .onAppear { targetFieldFocused = true }
            } else {
                Button {
                    vm.targetInput = "\(vm.target)"
                    vm.isEditingTarget = true
                } label: {
                    HStack(spacing: 3) {
                        Text(vm.target.formatted())
                            .font(.system(size: 14, weight: .bold))
                        Image(systemName: "pencil")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Colors.accentContent)
                }
                .buttonStyle(.plain)
            }

            Spacer()
        }
    }

    func commitTargetEdit() {
        if let v = Int(vm.targetInput.trimmingCharacters(in: .whitespacesAndNewlines)), v > 0 {
            Task { await vm.updateTarget(v) }
        }
        vm.isEditingTarget = false
    }

    var slotGrid: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ForEach(DietSlot.allCases) { slot in
                let selected = vm.selectedSlot == slot
                Button {
                    vm.selectedSlot = slot
                } label: {
                    VStack(spacing: Theme.Spacing.xs) {
                        Image(systemName: slot.sfSymbol)
                            .font(.system(size: 16, weight: .medium))
                        Text(slot.label)
                            .font(.system(size: 11, weight: .semibold))
                        Text(vm.subtotalLabel(for: slot))
                            .font(.system(size: 10))
                            .monospacedDigit()
                    }
                    .foregroundStyle(selected ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.sm + 2)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                            .fill(selected ? Theme.Colors.accentSoft : Theme.Colors.card)
                            .shadow(color: selected ? .clear : Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    var quickLogSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Quick log · \(vm.selectedSlot.label)")

            VitalCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array((DietSheetViewModel.quickFoods[vm.selectedSlot] ?? []).enumerated()), id: \.element.id) { index, food in
                        quickFoodRow(food, isFirst: index == 0)
                    }
                    customRow
                }
            }
        }
    }

    func quickFoodRow(_ food: QuickFood, isFirst: Bool) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(food.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("\(food.kcal) kcal · P\(food.protein) C\(food.carbs) F\(food.fat)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Button {
                Task { await vm.logQuickFood(food, slot: vm.selectedSlot) }
            } label: {
                Text("Log")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.Colors.onAccent)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Theme.Colors.accent))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
            }
        }
    }

    var customRow: some View {
        let canAdd = !vm.customName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !vm.customKcal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        return HStack(spacing: Theme.Spacing.sm) {
            TextField("Custom \(vm.selectedSlot.label.lowercased())…", text: $vm.customName)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textPrimary)

            TextField("kcal", text: $vm.customKcal)
                .keyboardType(.numberPad)
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(width: 52)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .fill(Theme.Colors.glassFill)
                )

            Button {
                Task { await vm.logCustom() }
            } label: {
                ZStack {
                    Circle()
                        .fill(canAdd ? Theme.Colors.textPrimary : Theme.Colors.glassFill)
                        .frame(width: 32, height: 32)
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(canAdd ? Theme.Colors.card : Theme.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .disabled(!canAdd)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
        }
    }

    var deeperFlowsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            deeperFlowButton(label: "Photo", icon: "photo", method: .photo)
            deeperFlowButton(label: "Barcode", icon: "barcode.viewfinder", method: .barcode)
            deeperFlowButton(label: "Search", icon: "magnifyingglass", method: .text)
        }
    }

    func deeperFlowButton(label: String, icon: String, method: MealInputMethod) -> some View {
        Button {
            logMealMethod = method
            showLogMealSheet = true
        } label: {
            VStack(spacing: Theme.Spacing.xs) {
                Image(systemName: icon)
                    .font(.system(size: 17, weight: .medium))
                Text(label)
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(Theme.Colors.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Colors.card)
                    .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
            )
        }
        .buttonStyle(.plain)
    }

    var loggedTodaySection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title: "Logged today")

            if vm.loggedEntries.isEmpty {
                Text("Nothing logged yet — pick a meal above to add your first food.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textTertiary)
            } else {
                ForEach(vm.loggedGroups) { group in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs + 2) {
                        HStack {
                            HStack(spacing: 5) {
                                Image(systemName: group.sfSymbol)
                                    .font(.system(size: 12, weight: .semibold))
                                Text(group.label)
                                    .font(.system(size: 13, weight: .semibold))
                            }
                            .foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                            Text("\(group.totalKcal) kcal")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }

                        VitalCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(group.entries.enumerated()), id: \.element.id) { index, entry in
                                    loggedEntryRow(entry, isFirst: index == 0)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    func loggedEntryRow(_ entry: MealLogEntryDTO, isFirst: Bool) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("\(entry.kcal) kcal")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Button {
                Task { await vm.removeEntry(entry) }
            } label: {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.glassFill)
                        .frame(width: 32, height: 32)
                    Image(systemName: "trash")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(entry.name)")
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
            }
        }
    }
}
