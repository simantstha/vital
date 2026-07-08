import SwiftUI

/// Meal-detail modal presented when a Today "plan" row is tapped.
///
/// Lets the user auto-see macros, tweak the meal in natural language, pull a
/// recipe on demand, and log it directly. Styled to match `TodayView`'s
/// Liquid Glass system. `onLogged` is called after a successful log so the
/// parent can refresh the diet budget.
struct MealDetailView: View {
    @StateObject private var vm: MealDetailViewModel
    @Environment(\.dismiss) private var dismiss
    let onLogged: () -> Void

    init(meal: MealRow, onLogged: @escaping () -> Void) {
        _vm = StateObject(wrappedValue: MealDetailViewModel(meal: meal))
        self.onLogged = onLogged
    }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header
                    macros
                    if !vm.reason.isEmpty { whyLine }
                    modifyField
                    recipeSection
                    Spacer(minLength: Theme.Spacing.sm)
                    footer
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.xl)
                .padding(.bottom, Theme.Spacing.xl)
            }
            .scrollIndicators(.hidden)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { await vm.estimateOnOpen() }
    }
}

// MARK: - Sections

private extension MealDetailView {

    var header: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                    .fill(Theme.Colors.accent.opacity(0.15))
                    .frame(width: 46, height: 46)
                Image(systemName: mealIcon(for: vm.name))
                    .font(.system(size: 20))
                    .foregroundStyle(Theme.Colors.accentContent)
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(vm.name)
                    .font(Theme.Typography.titleMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Lunch · plan")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            Spacer(minLength: Theme.Spacing.sm)

            VStack(alignment: .trailing, spacing: 0) {
                Text("\(vm.kcal)")
                    .font(Theme.Typography.numericSmall(21))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .monospacedDigit()
                Text("KCAL")
                    .font(Theme.Typography.labelSmall)
                    .tracking(0.6)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }

    var macros: some View {
        HStack(spacing: Theme.Spacing.sm) {
            MacroChip(label: "Protein", grams: vm.protein, color: Theme.Colors.accentContent, ready: vm.macrosReady)
            MacroChip(label: "Carbs",   grams: vm.carbs,   color: Theme.Colors.indigo,        ready: vm.macrosReady)
            MacroChip(label: "Fat",     grams: vm.fat,     color: Theme.Colors.alert,         ready: vm.macrosReady)
        }
    }

    var whyLine: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(Theme.Colors.accentContent.opacity(0.5))
                .frame(width: 2)
            Text(vm.reason.asMarkdown)
                .font(Theme.Typography.bodySmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    var modifyField: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("MAKE IT YOURS")
                .font(Theme.Typography.labelSmall)
                .tracking(0.8)
                .foregroundStyle(Theme.Colors.textSecondary)

            HStack(spacing: Theme.Spacing.sm) {
                TextField("Replace an ingredient, change portion…", text: $vm.instruction)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .submitLabel(.send)
                    .onSubmit { Task { await vm.applyModification() } }

                Button {
                    Task { await vm.applyModification() }
                } label: {
                    ZStack {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(Theme.Colors.accent)
                            .frame(width: 32, height: 32)
                        if vm.isModifying {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.Colors.onAccent)
                        } else {
                            Image(systemName: "arrow.right")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(Theme.Colors.onAccent)
                        }
                    }
                }
                .disabled(vm.instruction.trimmingCharacters(in: .whitespaces).isEmpty || vm.isModifying)
            }
            .padding(Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                    )
            )
        }
    }

    var recipeSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button {
                Task { await vm.toggleRecipe() }
            } label: {
                HStack(spacing: Theme.Spacing.md) {
                    Image(systemName: "book.pages")
                        .font(.system(size: 17))
                        .foregroundStyle(Theme.Colors.accentContent)
                    Text("How to make it")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Spacer()
                    if vm.isLoadingRecipe {
                        ProgressView().controlSize(.small).tint(Theme.Colors.textSecondary)
                    } else {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(vm.recipeExpanded ? Theme.Colors.accentContent : Theme.Colors.textSecondary)
                            .rotationEffect(.degrees(vm.recipeExpanded ? 180 : 0))
                    }
                }
                .padding(Theme.Spacing.md)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .fill(vm.recipeExpanded ? Theme.Colors.accent.opacity(0.06) : Theme.Colors.glassFill)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                                .strokeBorder(
                                    vm.recipeExpanded ? Theme.Colors.accentContent.opacity(0.35) : Theme.Colors.glassBorder,
                                    lineWidth: 1)
                        )
                )
            }

            if vm.recipeExpanded && !vm.recipe.isEmpty {
                MarkdownText(markdown: vm.recipe)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .padding(Theme.Spacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .fill(Theme.Colors.glassFill)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                                    .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                            )
                    )
            }
        }
    }

    @ViewBuilder
    var footer: some View {
        if let reaction = vm.coachReaction, vm.didLog {
            // Logged — surface the coach reaction, then let the user dismiss.
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Theme.Colors.accentContent)
                    Text(reaction)
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button { finishLogging() } label: {
                    Text("Done").primaryActionLabel()
                }
            }
        } else {
            Button {
                Task {
                    await vm.logIt()
                    // No coach reaction to show → dismiss immediately.
                    if vm.didLog && vm.coachReaction == nil { finishLogging() }
                }
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    if vm.isLogging {
                        ProgressView().controlSize(.small).tint(Theme.Colors.onAccent)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 15, weight: .bold))
                    }
                    Text(vm.isLogging ? "Logging…" : "Log it")
                }
                .primaryActionLabel()
            }
            .disabled(vm.isLogging || !vm.macrosReady)
        }
    }

    func finishLogging() {
        onLogged()
        dismiss()
    }

    /// Same icon heuristic used by the Today plan rows.
    func mealIcon(for name: String) -> String {
        let lower = name.lowercased()
        if lower.contains("breakfast") || lower.contains("oat") || lower.contains("egg") { return "sunrise.fill" }
        if lower.contains("lunch") || lower.contains("chicken") || lower.contains("bowl") { return "fork.knife" }
        if lower.contains("snack") || lower.contains("yogurt") || lower.contains("fruit") { return "leaf.fill" }
        if lower.contains("dinner") || lower.contains("salmon") || lower.contains("pasta") { return "moon.fill" }
        if lower.contains("run") || lower.contains("recovery") || lower.contains("post") { return "figure.run" }
        return "fork.knife"
    }
}

// MARK: - Supporting views

/// A single macro chip (label + colored dot + grams), redacted until macros load.
private struct MacroChip: View {
    let label: String
    let grams: Int
    let color: Color
    let ready: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(label.uppercased())
                    .font(.system(size: 10, weight: .medium))
                    .tracking(0.4)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Text(ready ? "\(grams)g" : "00g")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .monospacedDigit()
                .redacted(reason: ready ? [] : .placeholder)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm + 1)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                .fill(Theme.Colors.glassFill)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .strokeBorder(Theme.Colors.glassBorder, lineWidth: 1)
                )
        )
    }
}

private extension View {
    /// Shared lime primary-button label styling used by the modal footer.
    func primaryActionLabel() -> some View {
        self
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Theme.Colors.onAccent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Theme.Colors.accent)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
    }
}
